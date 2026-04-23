/**
 * [M4.4.1.a] 日程解析纯函数（不碰 DB / env）
 *
 * 职责
 *   - 输入 schedule rows（一般由 fetchScheduleForNpc 拉回的 0..24 条）+ 目标 hour
 *   - 输出该 hour 对应的 ScheduledActivity 或 null（未覆盖）
 *   - 多行同 hour 时按 priority DESC 取最高（理论上 uk_npc_hour 保证唯一，此处做保险）
 *
 * 设计要点
 *   - 纯函数、无副作用：单测无需 mock DB
 *   - priority 缺失视为 5（与 DB default 对齐）
 *   - hour 范围校验：[0, 23] 之外直接 null
 */
export interface ScheduleRow {
  /** 0..23 */
  hour: number;
  activity: string;
  location: string | null;
  priority?: number | null;
}

export interface ScheduledActivity {
  activity: string;
  location: string | null;
  priority: number;
}

/**
 * 从 rows 中解析给定 hour 的日程条目。
 * - 无匹配 → null
 * - 多条匹配 → priority 最高的一条（ties 取 location 非空优先，再按数组顺序兜底）
 */
export function resolveScheduledActivity(
  rows: ReadonlyArray<ScheduleRow> | null | undefined,
  hour: number,
): ScheduledActivity | null {
  if (!rows || rows.length === 0) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;

  let best: ScheduleRow | null = null;
  for (const r of rows) {
    if (!r || r.hour !== hour) continue;
    if (!r.activity || !r.activity.trim()) continue;
    if (best == null) {
      best = r;
      continue;
    }
    const bp = typeof best.priority === 'number' ? best.priority : 5;
    const rp = typeof r.priority === 'number' ? r.priority : 5;
    if (rp > bp) {
      best = r;
    } else if (rp === bp && best.location == null && r.location != null) {
      best = r;
    }
  }
  if (!best) return null;
  return {
    activity: best.activity.trim(),
    location: best.location ?? null,
    priority: typeof best.priority === 'number' ? best.priority : 5,
  };
}
