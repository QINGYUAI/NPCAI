/**
 * [M4.4.1.a] NPC 日程子系统配置与 env 解析（拉票 Q3=a 小时级、Q4=a plan 前置分支）
 *
 * 职责
 *   - 集中解析 SCHEDULE_* 环境变量：
 *       · SCHEDULE_ENABLED    总开关；false 时 scheduler 跳过日程解析，回 M4.4.0 行为
 *       · SCHEDULE_LLM_HINT   true = 并行注入 hint（Q4=b 延后通道）；本批次默认 false = 前置分支
 *   - 提供 resetScheduleConfig() 供单测清缓存
 *
 * 非职责
 *   - 不读表，不拼 prompt；仅配置解析
 */

const DEFAULTS = {
  SCHEDULE_ENABLED: 'true',
  SCHEDULE_LLM_HINT: 'false',
  /** [M4.5.0 U-N] 日程 soft window；整点前 N 分钟按下一时段查。0 = 禁用（等价 M4.4 行为） */
  SCHEDULE_SOFT_WINDOW_MIN: '15',
} as const;

function readStr(key: keyof typeof DEFAULTS): string {
  const v = process.env[key];
  return (v && v.trim()) || DEFAULTS[key];
}

function readBool(key: keyof typeof DEFAULTS): boolean {
  return readStr(key).toLowerCase() === 'true';
}

export interface ScheduleConfig {
  /** false 时 scheduler 不查 npc_schedule 不传 scheduledActivity，等价 M4.4.0 行为 */
  enabled: boolean;
  /** true 时走并行 hint 而非前置分支（Q4=b 预留通道，本 .a 批次仅读不消费） */
  llmHint: boolean;
  /**
   * [M4.5.0 U-N] 整点前 N 分钟按下一时段 hour 查 schedule。合法范围 [0, 30]。
   *   - 0 = 禁用 soft window（整点硬切，回 M4.4.1.b 行为）
   *   - 越界 / 非整数 解析为 0（保守降级）
   */
  softWindowMin: number;
}

let cached: ScheduleConfig | null = null;

/** 解析 SCHEDULE_SOFT_WINDOW_MIN：[0, 30] 以外或非整数回退 0 */
function parseSoftWindowMin(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 30) return 0;
  return n;
}

export function getScheduleConfig(): ScheduleConfig {
  if (cached) return cached;
  cached = {
    enabled: readBool('SCHEDULE_ENABLED'),
    llmHint: readBool('SCHEDULE_LLM_HINT'),
    softWindowMin: parseSoftWindowMin(readStr('SCHEDULE_SOFT_WINDOW_MIN')),
  };
  return cached;
}

export function resetScheduleConfig(): void {
  cached = null;
}
