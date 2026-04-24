/**
 * [M4.5.1.a] 动态目标子系统配置与 env 解析（拉票 Q1=a）
 *
 * 职责
 *   - 集中解析 GOAL_* 环境变量，懒加载 + 缓存
 *   - GOAL_ENABLED：总开关；false 时 scheduler 不查 npc_goal，REST 仍可访问但返回空列表（交由路由层决定）
 *   - GOAL_DEFAULT_TTL_SEC：POST /goals 不传 expires_in_seconds 时的默认 TTL；0 = 永不过期
 *
 * 非职责
 *   - 不读表 / 不查 DB / 不算 priority，仅配置
 */
const DEFAULTS = {
  GOAL_ENABLED: 'true',
  /** 默认 30 分钟 TTL（0 表示永不过期） */
  GOAL_DEFAULT_TTL_SEC: '1800',
} as const;

function readStr(key: keyof typeof DEFAULTS): string {
  const v = process.env[key];
  return (v && v.trim()) || DEFAULTS[key];
}

function readBool(key: keyof typeof DEFAULTS): boolean {
  return readStr(key).toLowerCase() === 'true';
}

/** 解析正整数 TTL；非法回退 0（永不过期） */
function parseTtlSec(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export interface GoalConfig {
  /** false 时 scheduler 不查 goal，plan 回 M4.4 行为；REST 可返 410/空列表（由 controller 决定） */
  enabled: boolean;
  /** POST 不传 expires_in_seconds 时使用；0 = 永不过期 */
  defaultTtlSec: number;
}

let cached: GoalConfig | null = null;

export function getGoalConfig(): GoalConfig {
  if (cached) return cached;
  cached = {
    enabled: readBool('GOAL_ENABLED'),
    defaultTtlSec: parseTtlSec(readStr('GOAL_DEFAULT_TTL_SEC')),
  };
  return cached;
}

export function resetGoalConfig(): void {
  cached = null;
}
