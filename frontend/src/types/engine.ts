/**
 * 引擎相关类型（与后端 src/engine/types.ts 保持语义一致）
 */

export interface EngineConfig {
  interval_ms: number
  max_ticks: number | null
  concurrency: number
  dry_run: boolean
}

export interface EngineStatus {
  scene_id: number
  running: boolean
  tick: number
  started_at: string | null
  last_tick_at: string | null
  last_duration_ms: number | null
  npc_count: number
  errors_recent: number
  cost_usd_total: number
  /** 未启动时为 null */
  config: EngineConfig | null
  /** [M4.2.0] 最近 N 条 simulation_meta 软阈值越界记录（滚动窗口） */
  meta_warns?: MetaWarn[]
}

/** [M4.2.0] simulation_meta 软阈值越界告警（滚动窗口条目） */
export interface MetaWarn {
  scene_id: number
  npc_id: number
  npc_name?: string
  tick: number
  bytes: number
  soft_limit: number
  at: string
}

export interface TickLogRow {
  id: number
  scene_id: number
  npc_id: number
  tick: number
  started_at: string
  finished_at: string | null
  status: 'success' | 'error' | 'skipped'
  input_summary: string | null
  output_meta: Record<string, unknown> | null
  duration_ms: number | null
  error_message: string | null
}

export interface StartEngineParams {
  scene_id: number
  interval_ms?: number
  max_ticks?: number | null
  concurrency?: number
  dry_run?: boolean
}
