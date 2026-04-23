/**
 * [M4.4.1.a] NPC 日程 DB 访问层（单 hour 查询）
 *
 * 职责
 *   - fetchScheduleForNpc(npc_id, hour)：按 (npc_id, hour) 命中唯一键 uk_npc_hour 取 1 条
 *   - 返回值与 resolve.ScheduleRow 兼容，可直接喂给 resolveScheduledActivity
 *   - 查询失败降级为 null（不抛），上游可直接当"无日程"处理
 *
 * 非职责
 *   - 不做 resolve / 不做 prompt 拼接；仅读 DB
 *   - 不缓存：高频场景由 scheduler 在 tick 级按需拉；后续如需缓存可以在本文件加
 */
import type { RowDataPacket } from 'mysql2';
import { pool } from '../../db/connection.js';
import type { ScheduleRow } from './resolve.js';

interface ScheduleDbRow extends RowDataPacket {
  hour: number;
  activity: string;
  location: string | null;
  priority: number | null;
}

/**
 * 拉取指定 NPC 在指定 hour 的日程条目（单行）
 * - 未命中返回 null
 * - DB 异常吞错 warn + null（降级不阻主 tick）
 */
export async function fetchScheduleForNpc(
  npc_id: number,
  hour: number,
): Promise<ScheduleRow | null> {
  if (!Number.isInteger(npc_id) || npc_id <= 0) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;

  try {
    const [rows] = await pool.query<ScheduleDbRow[]>(
      `SELECT hour, activity, location, priority
         FROM npc_schedule
        WHERE npc_id = ? AND hour = ?
        LIMIT 1`,
      [npc_id, hour],
    );
    if (!rows || rows.length === 0) return null;
    const r = rows[0] as ScheduleDbRow;
    return {
      hour: Number(r.hour),
      activity: String(r.activity),
      location: r.location ?? null,
      priority: r.priority ?? null,
    };
  } catch (e) {
    console.warn('[schedule.fetch] 查询失败，降级为空日程:', (e as Error).message);
    return null;
  }
}
