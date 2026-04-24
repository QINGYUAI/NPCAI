/**
 * [M4.5.1.a] 动态目标 · scheduler 专用读路径
 *
 * 职责
 *   - fetchActiveGoalForNpc(npc_id)：取 status='active' 且未过期的最高优先级 goal（单行）
 *   - 查询异常 / 超时 → 降级为 null（不阻 tick 主链路）
 *   - 本文件不做 UPDATE；过期懒切换由 crud.expireLapsedGoals 负责（list/getById 入口触发）
 *
 * 非职责
 *   - 不做 CRUD；纯 SELECT
 *   - 不做 payload 反序列化复杂逻辑（scheduler 只需 title/priority，已足够）
 */
import type { RowDataPacket } from 'mysql2';
import { pool } from '../../db/connection.js';

export interface ActiveGoalRow {
  id: number;
  title: string;
  priority: number;
  expires_at: string | null;
}

/**
 * 单 NPC 读"当前 active / 未过期 / priority 最高"的目标。
 * - 排除 expires_at 已过去的行（SQL 层过滤，不依赖 crud 的懒切换）
 * - 失败返回 null，调用方应视为"该 NPC 无目标"
 */
export async function fetchActiveGoalForNpc(npc_id: number): Promise<ActiveGoalRow | null> {
  if (!Number.isInteger(npc_id) || npc_id <= 0) return null;
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, title, priority, expires_at
         FROM npc_goal
        WHERE npc_id=?
          AND status='active'
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY priority DESC, created_at DESC
        LIMIT 1`,
      [npc_id],
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    const expiresRaw = r['expires_at'];
    return {
      id: Number(r['id']),
      title: String(r['title']),
      priority: Number(r['priority']),
      expires_at:
        expiresRaw == null
          ? null
          : expiresRaw instanceof Date
            ? expiresRaw.toISOString()
            : String(expiresRaw),
    };
  } catch (e) {
    console.warn('[goal.fetch] fetchActiveGoalForNpc 失败降级:', (e as Error).message);
    return null;
  }
}
