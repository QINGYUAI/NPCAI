/**
 * 引擎模块类型定义
 */

export interface EngineConfig {
  /** tick 间隔 ms */
  interval_ms: number;
  /** 最大 tick 数；达到后自动 stop */
  max_ticks: number | null;
  /** 单 tick 内 NPC 并发推理数 */
  concurrency: number;
  /** 跳过 LLM 调用，仅走图结构（用于自测） */
  dry_run: boolean;
}

export interface EngineStatus {
  scene_id: number;
  running: boolean;
  tick: number;
  started_at: string | null;
  last_tick_at: string | null;
  last_duration_ms: number | null;
  npc_count: number;
  errors_recent: number;
  cost_usd_total: number;
  config: EngineConfig;
  /**
   * [M4.2.0] 最近 N 条 simulation_meta 软阈值越界告警
   * - 仅记录最近 20 条，溢出自动滚动
   * - 有任意一条在最近 5 分钟内写入时，REST 响应会带 `X-Meta-Warn: 1`
   */
  meta_warns: MetaWarn[];
}

/** [M4.2.0] simulation_meta 超软阈值告警记录 */
export interface MetaWarn {
  scene_id: number;
  npc_id: number;
  npc_name?: string;
  tick: number;
  bytes: number;
  soft_limit: number;
  at: string;
}

/** 单次 tick 对某 NPC 的产出，写入 simulation_meta 与 npc_tick_log */
export interface NpcTickOutput {
  npc_id: number;
  status: 'success' | 'error' | 'skipped';
  meta: SimulationMetaV1 | null;
  input_summary: string;
  duration_ms: number;
  error_message?: string;
}

/** simulation_meta v1.0 约定字段 */
export interface SimulationMetaV1 {
  version: '1.0';
  last_tick_at: string;
  latest_say?: string | null;
  latest_action?: string | null;
  emotion?: string | null;
  plan?: string[];
  memory_summary?: string | null;
  relations?: Record<string, string>;
  debug?: Record<string, unknown>;
}

/** 事件总线消息 */
export type TickEvent =
  | { type: 'tick.start'; scene_id: number; tick: number; at: string }
  | { type: 'tick.npc.updated'; scene_id: number; tick: number; npc_id: number; meta: SimulationMetaV1 }
  | { type: 'tick.end'; scene_id: number; tick: number; duration_ms: number }
  | { type: 'error'; scene_id: number; tick: number; npc_id?: number; message: string };

/** 从数据库加载的 NPC 行（推理图节点所需最小集合） */
export interface NpcRow {
  id: number;
  name: string;
  personality: string | null;
  system_prompt: string | null;
  simulation_meta: unknown;
  ai_config_id: number;
}

export interface SceneRow {
  id: number;
  name: string;
  description: string | null;
  width: number;
  height: number;
}
