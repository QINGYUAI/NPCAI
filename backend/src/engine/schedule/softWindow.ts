/**
 * [M4.5.0 U-N] 日程 soft window 整点前 N 分钟提前切到下一时段
 *
 * 设计要点
 *   - 纯函数，无副作用：单测无需 mock 时间
 *   - windowMin = 0 时退化为普通整点切换（与 M4.4.1.a 行为一致）
 *   - 跨越 hour=23 → hour=0 的绕环用 (baseHour + 1) % 24 保证
 *   - 非法输入（NaN / 超界）统一回 baseHour，降级不抛
 */
export interface SoftWindowInput {
  /** 当前钟表 hour（0..23） */
  baseHour: number;
  /** 当前钟表 minute（0..59）；非法值按 0 处理 */
  minute: number;
  /** 整点前 N 分钟开始切到下一时段；0 = 关闭 */
  windowMin: number;
}

/**
 * 计算用于查 npc_schedule 的"有效 hour"。
 *
 * 算法：
 *   effective = (60 - minute) <= windowMin ? (baseHour + 1) % 24 : baseHour
 *
 * 例：windowMin = 15
 *   - 10:44 → effective = 10（未进入 soft window）
 *   - 10:45 → effective = 11（切到下一时段）
 *   - 10:59 → effective = 11
 *   - 11:00 → effective = 11（越过整点，minute=0，按下一时段算，逻辑自洽）
 *   - 23:50 → effective = 0（绕环）
 */
export function computeEffectiveHour(input: SoftWindowInput): number {
  const baseHour = Number.isInteger(input.baseHour) ? input.baseHour : -1;
  if (baseHour < 0 || baseHour > 23) return 0;

  const rawMin = Number.isInteger(input.minute) ? input.minute : 0;
  const minute = Math.max(0, Math.min(59, rawMin));

  const rawWin = Number.isInteger(input.windowMin) ? input.windowMin : 0;
  const windowMin = Math.max(0, Math.min(59, rawWin));

  if (windowMin === 0) return baseHour;
  if (60 - minute <= windowMin) {
    return (baseHour + 1) % 24;
  }
  return baseHour;
}

/**
 * 给定当前 Date 和配置，返回有效 hour。
 * - 测试可注入 fake Date / 固定 hour/minute
 * - scheduler 调用时 withNowOverride 可为 null 走真实时钟
 */
export function resolveEffectiveHourFromClock(params: {
  /** 若非 null，优先用此 hour（对应 SIM_CLOCK_HOUR 注入） */
  overrideHour?: number | null;
  /** 若非 null，优先用此 minute（对应 SIM_CLOCK_MINUTE 注入） */
  overrideMinute?: number | null;
  /** 真实 Date；注入 null 时使用 new Date() */
  now?: Date | null;
  windowMin: number;
}): number {
  const now = params.now instanceof Date ? params.now : new Date();
  const baseHour =
    typeof params.overrideHour === 'number' && Number.isInteger(params.overrideHour)
      ? params.overrideHour
      : now.getHours();
  const minute =
    typeof params.overrideMinute === 'number' && Number.isInteger(params.overrideMinute)
      ? params.overrideMinute
      : now.getMinutes();
  return computeEffectiveHour({ baseHour, minute, windowMin: params.windowMin });
}
