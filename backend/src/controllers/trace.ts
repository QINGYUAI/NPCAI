/**
 * [M4.3.0] 运维探针：GET /api/engine/trace/:trace_id
 *
 * 作用
 *   - 按 trace_id 聚合本 tick 在 5 张表的所有写入，供快速排障与对账
 *   - 只读接口，不返回 PII 之外可能泄漏的列（request_content / response_content 仍返回，给 admin 用）
 *
 * 返回结构
 *   {
 *     code: 0,
 *     data: {
 *       trace_id: string,
 *       counts: { npc_tick_log, ai_call_log, scene_event, npc_memory, npc_reflection },
 *       npc_tick_log:   [...最多 20 条最近]
 *       ai_call_log:    [...最多 50 条最近]
 *       scene_event:    [...最多 20 条最近]
 *       npc_memory:     [...最多 50 条最近]
 *       npc_reflection: [...最多 20 条最近]
 *     }
 *   }
 *
 * 错误码
 *   INVALID_PARAM     - trace_id 不是合法 uuid v4 形式
 *   NOT_FOUND         - 5 张表查询均为 0 条
 *   INTERNAL          - DB 异常
 */
import type { Request, Response } from 'express';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../db/connection.js';
import { isValidTraceId } from '../engine/trace.js';

function err(res: Response, http: number, code: string, message: string) {
  return res.status(http).json({ code: -1, error: code, message });
}

/** 单表查询；失败返回空数组，降级单表不影响整体聚合 */
async function safeQuery(sql: string, params: unknown[]): Promise<RowDataPacket[]> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(sql, params);
    return rows;
  } catch (e) {
    console.warn('[trace] 子查询失败，降级为空：', sql.slice(0, 60), (e as Error).message);
    return [];
  }
}

export async function getTraceDetail(req: Request, res: Response) {
  const traceId = String(req.params.trace_id ?? '').trim();
  if (!isValidTraceId(traceId)) {
    return err(res, 400, 'INVALID_PARAM', 'trace_id 必须为 uuid v4 形式（36 字符）');
  }

  try {
    /** 并发查 5 张表，最近优先；每表各自 LIMIT 控制上限，防 OOM */
    const [tickLog, aiLog, sceneEvt, mem, refl] = await Promise.all([
      safeQuery(
        `SELECT id, scene_id, npc_id, tick, status, started_at, finished_at, duration_ms, error_message
           FROM npc_tick_log WHERE trace_id = ? ORDER BY id DESC LIMIT 20`,
        [traceId],
      ),
      safeQuery(
        `SELECT id, ai_config_id, api_type, provider, model, status, duration_ms, prompt_tokens,
                completion_tokens, total_tokens, cost_usd, source, created_at
           FROM ai_call_log WHERE trace_id = ? ORDER BY id DESC LIMIT 50`,
        [traceId],
      ),
      safeQuery(
        `SELECT id, scene_id, type, actor, content, visible_npcs, created_at, consumed_tick
           FROM scene_event WHERE trace_id = ? ORDER BY id DESC LIMIT 20`,
        [traceId],
      ),
      safeQuery(
        `SELECT id, npc_id, scene_id, tick, type, importance, embed_status, created_at
           FROM npc_memory WHERE trace_id = ? ORDER BY id DESC LIMIT 50`,
        [traceId],
      ),
      safeQuery(
        `SELECT id, npc_id, scene_id, tick, theme, content, memory_id, created_at
           FROM npc_reflection WHERE trace_id = ? ORDER BY id DESC LIMIT 20`,
        [traceId],
      ),
    ]);

    const counts = {
      npc_tick_log: tickLog.length,
      ai_call_log: aiLog.length,
      scene_event: sceneEvt.length,
      npc_memory: mem.length,
      npc_reflection: refl.length,
    };
    const total = counts.npc_tick_log + counts.ai_call_log + counts.scene_event + counts.npc_memory + counts.npc_reflection;
    if (total === 0) {
      return err(res, 404, 'NOT_FOUND', `未找到 trace_id=${traceId} 的任何记录`);
    }

    return res.json({
      code: 0,
      data: {
        trace_id: traceId,
        counts,
        npc_tick_log: tickLog,
        ai_call_log: aiLog,
        scene_event: sceneEvt,
        npc_memory: mem,
        npc_reflection: refl,
      },
    });
  } catch (e) {
    console.error('getTraceDetail:', e);
    return err(res, 500, 'INTERNAL', (e as Error).message || 'trace 查询失败');
  }
}
