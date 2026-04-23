/**
 * [M4.2.4.a] 事件总线配置与 env 解析
 *
 * 职责
 * - 集中解析 EVENT_* 环境变量并做类型兜底
 * - 启动期硬校验：lookbackSeconds / maxPerTick 必须为正整数
 * - 提供 `resetEventConfig()` 供测试清缓存，重新解析 env
 *
 * 非职责
 * - 不负责读写数据库 / 注入 prompt；纯配置
 *
 * 为什么不合并到 memory/config.ts
 * - 事件子系统与记忆/反思子系统语义正交：前者读 `scene_event` 表，后者读 `npc_memory`
 * - 维度校验等耦合逻辑仅对 memory 生效，独立文件减少无关 throw 风险
 */

/** 事件子系统默认值（全部可被 env 覆盖） */
const DEFAULTS = {
  /** 总开关：false = event-intake 节点短路，不查库不注入 prompt */
  EVENT_BUS_ENABLED: 'true',
  /**
   * tick 头读「created_at > NOW() - lookbackSeconds」且未被本 NPC 消费的事件
   * - 太大：老事件反复挤占 prompt token；太小：错过上一 tick 刚注入的事件
   * - [M4.4.0 Q2a] 默认从 60 → 120 秒，配合混合窗口解对话链被 budget skip 拉断问题（L-1）
   */
  EVENT_LOOKBACK_SECONDS: '120',
  /**
   * [M4.4.0 Q2a] 混合窗口条数条件：拉"最近 N 条"事件
   * - 与 lookbackSeconds 取并集：时间窗 OR 条数窗，任一满足即返回
   * - 用于在 budget skip 拉长 tick 间隔时仍保住对话链（conv_turn 回看）
   * - 0 = 关闭条数窗，回到纯时间窗（M4.3 行为）
   */
  EVENT_LOOKBACK_COUNT: '50',
  /**
   * 单 tick 单 NPC 最多注入多少事件到 plan prompt
   * - 超出按 created_at DESC 截断，老的丢弃（LLM 关注最新世界状态即可）
   */
  EVENT_MAX_PER_TICK: '10',
} as const;

function readStr(key: keyof typeof DEFAULTS): string {
  const v = process.env[key];
  return (v && v.trim()) || DEFAULTS[key];
}

function readBool(key: keyof typeof DEFAULTS): boolean {
  return readStr(key).toLowerCase() === 'true';
}

function readPositiveInt(key: keyof typeof DEFAULTS): number {
  const raw = readStr(key);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`[event.config] env ${key} 必须是正整数，当前=${raw}`);
  }
  return n;
}

/** [M4.4.0] 允许 0 的非负整数（EVENT_LOOKBACK_COUNT=0 表示关闭条数窗） */
function readNonNegativeInt(key: keyof typeof DEFAULTS): number {
  const raw = readStr(key);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`[event.config] env ${key} 必须是非负整数，当前=${raw}`);
  }
  return n;
}

export interface EventBusConfig {
  /** false = event-intake 节点完全短路（查询跳过 + prompt 注入跳过） */
  enabled: boolean;
  /** event-intake 回看窗口（秒） */
  lookbackSeconds: number;
  /**
   * [M4.4.0] 混合窗口条数条件：查询返回最近 N 条事件（与时间窗取并集）
   * 0 = 关闭条数窗（纯时间窗，回 M4.3 行为）
   */
  lookbackCount: number;
  /** 单 tick 单 NPC 最多消费事件数（按 created_at DESC 截断） */
  maxPerTick: number;
}

let cached: EventBusConfig | null = null;

/**
 * 解析并校验；启动期调用触发校验，后续调用走缓存
 * 测试可 `resetEventConfig()` 刷新；错误 env 启动即抛，不给裸奔机会
 */
export function getEventConfig(): EventBusConfig {
  if (cached) return cached;
  cached = {
    enabled: readBool('EVENT_BUS_ENABLED'),
    lookbackSeconds: readPositiveInt('EVENT_LOOKBACK_SECONDS'),
    lookbackCount: readNonNegativeInt('EVENT_LOOKBACK_COUNT'),
    maxPerTick: readPositiveInt('EVENT_MAX_PER_TICK'),
  };
  return cached;
}

/** 测试专用：清缓存让下次 getEventConfig 重新解析 env */
export function resetEventConfig(): void {
  cached = null;
}
