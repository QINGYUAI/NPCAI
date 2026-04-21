/**
 * [M4.2.3.b] 反思节点（engine/reflection/reflect.ts）
 *
 * 定位
 * - memory-summary 节点之后、return 前调用；tick % everyNTick === 0 触发
 * - 产出 3 条固定主题（goal/emotion/relation）的反思 → 写入 npc_reflection
 * - 每条反思再以 type='reflection' 反哺 npc_memory（走 storeMemory 的向量化管线）
 * - 任一环节异常均吞掉（节点内降级），主流程照常返回
 *
 * 失败矩阵
 * - tick 未触发 / everyNTick=0 / dryRun = true               → status='skipped'
 * - LLM 调用或 zod 解析失败（两次重试后）                    → status='failed'
 * - theme 不完备（goal/emotion/relation 没覆盖全）           → status='failed'
 * - INSERT npc_reflection 失败                                → status='failed'
 * - storeMemory 反哺失败不影响本节点 status（仅 memory_id=null）
 *
 * 与 graph/build.ts 的契约
 * - 输入：与 plan/speak 同源 aiCfg + tick + signal + onMetrics
 * - 输出：ReflectionResult，build.ts 把它挂到 GraphOutput.reflection 上
 * - scheduler.ts 看到 result.reflection?.status === 'generated' 时 emit reflection.created 事件
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { z } from 'zod';
import { pool } from '../../db/connection.js';
import { chatCompletion } from '../../utils/llmClient.js';
import { getMemoryConfig } from '../memory/config.js';
import { storeMemory } from '../memory/store.js';
import type { MemoryEntry, MemoryType } from '../memory/types.js';
import type { NpcRow, SceneRow } from '../types.js';
import {
  assertThemesComplete,
  buildReflectionPrompt,
  reflectionResponseSchema,
  type ReflectionResponse,
} from './prompts.js';
import type { ReflectionItem, ReflectionResult } from './types.js';

export interface ReflectInput {
  scene: SceneRow;
  npc: NpcRow;
  /** 本次触发反思的 tick */
  tick: number;
  /** 上一轮 memory_summary；为空字符串亦可 */
  prevSummary: string;
  /** 与 plan/speak 共用的 ai_config 行（含 id/api_key/base_url/provider/model/max_tokens） */
  aiCfg: {
    id: number;
    provider: string;
    api_key: string;
    base_url: string | null;
    model: string;
    max_tokens: number;
  };
  /** dry_run 下恒为 skipped，不调用 LLM */
  dryRun: boolean;
  signal?: AbortSignal;
  onMetrics?: (m: { total_tokens: number; cost_usd: number | null }) => void;
}

const SKIPPED: ReflectionResult = {
  items: [],
  source_memory_ids: [],
  status: 'skipped',
  reflection_ids: [],
};
const FAILED: ReflectionResult = {
  items: [],
  source_memory_ids: [],
  status: 'failed',
  reflection_ids: [],
};

/**
 * 主入口：按触发条件生成反思
 *
 * 执行顺序（失败短路向上返回，不抛错）
 * 1. 触发判定（tick/周期/dry_run）
 * 2. 拉最近 K 条 memory（source_memory_ids 来源）
 * 3. 构建 prompt → chatCompletion → JSON.parse → zod → assertThemesComplete（含重试 1 次）
 * 4. INSERT 3 条 npc_reflection（单 INSERT 多 VALUES）
 * 5. 每条反思再 storeMemory 反哺为 npc_memory（type='reflection'）
 *    成功则 UPDATE npc_reflection.memory_id 双向索引
 */
export async function reflectIfTriggered(input: ReflectInput): Promise<ReflectionResult> {
  if (input.signal?.aborted) return SKIPPED;
  if (input.dryRun) return SKIPPED;

  const cfg = getMemoryConfig();
  const everyN = cfg.reflection.everyNTick;
  if (everyN <= 0) return SKIPPED;
  if (input.tick <= 0 || input.tick % everyN !== 0) return SKIPPED;

  /** 拉最近 K 条 memory；为空即 skipped（避免 LLM 空上下文瞎编） */
  const memories = await fetchRecentMemoriesSafe(input.npc.id, cfg.reflection.recentMemoryK);
  if (memories.length === 0) return SKIPPED;

  const source_memory_ids = memories.map((m) => m.id);

  /** 调 LLM 生成反思（最多 2 次尝试） */
  const resp = await generateReflection(input, memories);
  if (!resp) return FAILED;

  const items: ReflectionItem[] = resp.items;

  /** INSERT 3 条 npc_reflection；失败整体降级 */
  let reflectionIds: number[];
  try {
    reflectionIds = await insertReflections({
      npcId: input.npc.id,
      sceneId: input.scene.id,
      tick: input.tick,
      items,
      sourceMemoryIds: source_memory_ids,
    });
  } catch (e) {
    console.warn(`[reflection] INSERT 失败：${(e as Error).message}`);
    return FAILED;
  }

  /**
   * 反哺 npc_memory：每条反思以 type='reflection' + importance=8 写入
   * - 与 npc_reflection 行 id 一一对应（按顺序回填 memory_id）
   * - 任一写失败不影响整体 status，仅 memory_id 保持 NULL；由后续 cron 可补
   */
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const refId = reflectionIds[i];
    if (!it || !refId) continue;
    try {
      const store = await storeMemory({
        scene: input.scene,
        npc: input.npc,
        tick: input.tick,
        type: 'reflection' as MemoryType,
        content: `[${it.theme}] ${it.content}`,
        importance: 8,
        aiCfg: {
          id: input.aiCfg.id,
          api_key: input.aiCfg.api_key,
          base_url: input.aiCfg.base_url,
          provider: input.aiCfg.provider,
        },
        signal: input.signal,
        onMetrics: input.onMetrics,
      });
      if (store.id) {
        await pool
          .execute(`UPDATE npc_reflection SET memory_id = ? WHERE id = ?`, [store.id, refId])
          .catch((err: unknown) => {
            console.warn(
              `[reflection] 反哺 memory_id 回填失败（reflection_id=${refId}）：${(err as Error).message}`,
            );
          });
      }
    } catch (e) {
      console.warn(
        `[reflection] 反哺 memory 失败（reflection_id=${refId}，theme=${it.theme}）：${(e as Error).message}`,
      );
    }
  }

  return {
    items,
    source_memory_ids,
    status: 'generated',
    reflection_ids: reflectionIds,
  };
}

/**
 * 调 LLM 并做 zod + 主题完备性校验；最多 2 次尝试
 * - parse JSON 宽松化：和 graph/build.ts 一致，去 Markdown 代码块、偏宽松截取
 * - 全部失败返回 null，交由上层记 failed
 */
async function generateReflection(
  input: ReflectInput,
  memories: MemoryEntry[],
): Promise<ReflectionResponse | null> {
  const { system, user } = buildReflectionPrompt({
    scene: input.scene,
    npc: input.npc,
    prevSummary: input.prevSummary,
    memories,
    tick: input.tick,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (input.signal?.aborted) return null;
    try {
      const content = await chatCompletion(
        {
          api_key: input.aiCfg.api_key,
          base_url: input.aiCfg.base_url,
          provider: input.aiCfg.provider,
          model: input.aiCfg.model,
          max_tokens: Math.min(input.aiCfg.max_tokens || 800, 1000),
        },
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        {
          timeout: 30_000,
          logContext: {
            source: 'engine.reflection',
            ai_config_id: input.aiCfg.id,
            context: {
              scene_id: input.scene.id,
              npc_id: input.npc.id,
              tick: input.tick,
              node: 'reflection',
              attempt,
            },
          },
          onMetrics: input.onMetrics,
        },
      );
      const parsed = parseJsonRobust(content);
      if (!parsed) continue;
      const result = reflectionResponseSchema.safeParse(parsed);
      if (!result.success) continue;
      try {
        assertThemesComplete(result.data);
      } catch {
        continue;
      }
      return result.data;
    } catch (e) {
      if (input.signal?.aborted) return null;
      /** 让下一轮重试 */
      void e;
    }
  }
  return null;
}

/** 单 INSERT 多 VALUES；返回 3 条行 id（按 items 顺序，利用 MySQL 连续自增保证顺序） */
async function insertReflections(args: {
  npcId: number;
  sceneId: number;
  tick: number;
  items: ReflectionItem[];
  sourceMemoryIds: number[];
}): Promise<number[]> {
  const { npcId, sceneId, tick, items, sourceMemoryIds } = args;
  if (items.length === 0) return [];
  const placeholders = items.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
  const params: Array<number | string> = [];
  const sourceJson = JSON.stringify(sourceMemoryIds);
  for (const it of items) {
    params.push(npcId, sceneId, tick, it.theme, it.content, sourceJson);
  }
  const [res] = await pool.execute<ResultSetHeader>(
    `INSERT INTO npc_reflection
       (npc_id, scene_id, tick, theme, content, source_memory_ids)
     VALUES ${placeholders}`,
    params,
  );
  const firstId = Number(res.insertId);
  if (!firstId) throw new Error('INSERT npc_reflection 返回 insertId=0');
  return items.map((_, i) => firstId + i);
}

/** 拉最近 K 条 memory；失败静默返回空数组（避免反思阻塞主流程） */
async function fetchRecentMemoriesSafe(npcId: number, k: number): Promise<MemoryEntry[]> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, npc_id, scene_id, tick, type, content, importance, created_at
         FROM npc_memory
        WHERE npc_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
      [npcId, k],
    );
    return (rows as RowDataPacket[]).map((row) => ({
      id: Number(row.id),
      npc_id: Number(row.npc_id),
      scene_id: row.scene_id == null ? null : Number(row.scene_id),
      tick: row.tick == null ? null : Number(row.tick),
      type: String(row.type) as MemoryType,
      content: String(row.content ?? ''),
      importance: Number(row.importance ?? 5),
      created_at:
        row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    }));
  } catch (e) {
    console.warn(`[reflection] 拉取最近记忆失败（npc_id=${npcId}）：${(e as Error).message}`);
    return [];
  }
}

/** 与 graph/build.ts 同款的宽松 JSON 解析；去 Markdown 包裹、截取平衡块 */
function parseJsonRobust(text: string): unknown {
  const trimmed = text.trim();
  const fromBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fromBlock ? fromBlock[1] : trimmed).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 仅暴露给单测：让测试可注入 mock pool/llm 后走完整流程 */
export const __test__ = {
  generateReflection,
  insertReflections,
  fetchRecentMemoriesSafe,
  parseJsonRobust,
};
