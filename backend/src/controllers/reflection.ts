/**
 * [M4.2.3.c] 反思相关 REST 控制器
 * POST /api/engine/reflect  { scene_id, npc_id }
 *   - 手动触发某 NPC 的一次反思，同步返回 ReflectionResult
 *   - 忽略 tick % everyN / everyN=0 / dryRun 三大周期判定（force 路径）
 *   - 保留：最近记忆为空 → skipped；LLM/zod/theme 不完备 → failed
 *   - tick 取值策略：
 *       · 引擎运行中 → 使用 scheduler.status().tick
 *       · 引擎未运行 → 取该 NPC 最新 npc_tick_log.tick + 1；若无历史则置 1
 *
 * 设计取舍
 *   - 同步响应：前端按钮会 loading 25~40s 等 LLM，可接受（避免异步入队的复杂度）
 *   - 仍会 emit WS `reflection.created` 事件（复用 bus），前端徽章同步 +1，与周期触发同链路
 *   - 失败不算 HTTP 500：status='failed' 也 200 返回让前端感知，便于调试
 */
import type { Request, Response } from 'express';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../db/connection.js';
import { bus } from '../engine/bus.js';
import { isEngineEnabled } from '../engine/index.js';
import { reflectIfTriggered } from '../engine/reflection/reflect.js';
import { getScheduler } from '../engine/registry.js';
import { generateTraceId } from '../engine/trace.js';
import type { NpcRow, SceneRow, SimulationMetaV1 } from '../engine/types.js';

function err(res: Response, http: number, code: string, message: string) {
  return res.status(http).json({ code: -1, error: code, message });
}

function toPositiveInt(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

/** POST /api/engine/reflect */
export async function reflectOnce(req: Request, res: Response) {
  if (!isEngineEnabled()) {
    return err(res, 503, 'ENGINE_DISABLED', '引擎已被禁用（ENGINE_ENABLED=false）');
  }
  const body = (req.body || {}) as Record<string, unknown>;
  const scene_id = toPositiveInt(body.scene_id);
  const npc_id = toPositiveInt(body.npc_id);
  if (!scene_id) return err(res, 400, 'INVALID_PARAM', 'scene_id 必须为正整数');
  if (!npc_id) return err(res, 400, 'INVALID_PARAM', 'npc_id 必须为正整数');

  try {
    /** 1) 绑定关系校验：scene_npc 必须存在这条关联 */
    const [link] = await pool.query<RowDataPacket[]>(
      'SELECT scene_id FROM scene_npc WHERE scene_id = ? AND npc_id = ? LIMIT 1',
      [scene_id, npc_id],
    );
    if (link.length === 0) {
      return err(res, 404, 'NPC_NOT_IN_SCENE', `NPC ${npc_id} 不在场景 ${scene_id} 中`);
    }

    /** 2) 加载 scene / npc / ai_config（一次性取齐，失败早返回） */
    const [scenes] = await pool.query<RowDataPacket[]>(
      'SELECT id, name, description, width, height FROM scene WHERE id = ?',
      [scene_id],
    );
    if (scenes.length === 0) {
      return err(res, 404, 'SCENE_NOT_FOUND', `scene_id=${scene_id} 不存在`);
    }
    const scene = scenes[0] as unknown as SceneRow;

    const [npcs] = await pool.query<RowDataPacket[]>(
      `SELECT id, name, personality, system_prompt, simulation_meta, ai_config_id
         FROM npc WHERE id = ?`,
      [npc_id],
    );
    if (npcs.length === 0) {
      return err(res, 404, 'NPC_NOT_FOUND', `npc_id=${npc_id} 不存在`);
    }
    const npc = npcs[0] as unknown as NpcRow;

    if (!npc.ai_config_id) {
      return err(
        res,
        422,
        'NPC_AI_CONFIG_MISSING',
        `NPC ${npc.name} 未绑定 ai_config_id，无法执行反思`,
      );
    }
    const [cfgRows] = await pool.query<RowDataPacket[]>(
      `SELECT id, provider, api_key, base_url, model, max_tokens
         FROM ai_config WHERE id = ? AND status = 1`,
      [npc.ai_config_id],
    );
    if (cfgRows.length === 0 || !(cfgRows[0] as { api_key?: string }).api_key) {
      return err(
        res,
        422,
        'AI_CONFIG_INVALID',
        `ai_config_id=${npc.ai_config_id} 不可用（未启用或未设 API Key）`,
      );
    }
    const aiCfg = cfgRows[0] as unknown as {
      id: number;
      provider: string;
      api_key: string;
      base_url: string | null;
      model: string;
      max_tokens: number;
    };

    /** 3) tick 取值 */
    const scheduler = getScheduler(scene_id);
    let tick: number;
    if (scheduler && scheduler.isRunning) {
      const st = scheduler.status();
      tick = Math.max(1, Number(st.tick) || 1);
    } else {
      const [lastRows] = await pool.query<RowDataPacket[]>(
        `SELECT MAX(tick) AS last_tick FROM npc_tick_log WHERE npc_id = ?`,
        [npc_id],
      );
      const lastTick = Number((lastRows[0] as { last_tick: number | null })?.last_tick ?? 0);
      tick = (lastTick || 0) + 1;
    }

    /** 4) prevSummary 从 npc.simulation_meta 解析 */
    const prevMeta = parseMeta(npc.simulation_meta);
    const prevSummary = prevMeta?.memory_summary ?? '';

    /**
     * [M4.3.0] 手动反思也生成一条 trace_id：
     *   - 与 scheduler 驱动的反思走同一套链路（npc_reflection / ai_call_log / 反哺 npc_memory 都带 trace）
     *   - 便于 `/api/engine/trace/:id` 回查「这次手工点击引起了哪些落库」
     *   - TRACE_ID_ENABLED=false 时为 null，保持 M4.2 行为
     */
    const traceId = generateTraceId();

    /** 5) 触发反思（force=true 跳周期判定） */
    const result = await reflectIfTriggered({
      scene,
      npc,
      tick,
      prevSummary,
      aiCfg,
      dryRun: false,
      force: true,
      traceId,
    });

    /** 6) 与周期触发保持一致的 WS 广播：仅 generated 时 emit */
    if (result.status === 'generated') {
      bus.emitEvent({
        type: 'reflection.created',
        scene_id,
        tick,
        npc_id,
        npc_name: npc.name,
        items: result.items,
        reflection_ids: result.reflection_ids,
        source_memory_ids: result.source_memory_ids,
        at: new Date().toISOString(),
        trace_id: traceId,
      });
    }

    return res.json({
      code: 0,
      data: {
        scene_id,
        npc_id,
        npc_name: npc.name,
        tick,
        status: result.status,
        items: result.items,
        reflection_ids: result.reflection_ids,
        source_memory_ids: result.source_memory_ids,
        trace_id: traceId,
      },
    });
  } catch (e) {
    console.error('reflectOnce:', e);
    return err(res, 500, 'INTERNAL', (e as Error).message || '反思触发失败');
  }
}

function parseMeta(raw: unknown): SimulationMetaV1 | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as SimulationMetaV1;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as SimulationMetaV1;
    } catch {
      return null;
    }
  }
  return null;
}

