/**
 * 引擎相关类型（与后端 src/engine/types.ts 保持语义一致）
 */
import type { WsReflectionCreatedMsg } from './reflection'
import type { WsSceneEventCreatedMsg } from './event'

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
  /** [M4.2.1.b] WS 订阅路径；无此字段 = WS 关闭 = 前端回落 3s 轮询 */
  ws_endpoint?: string
  /**
   * [M4.2.2.c] 记忆子系统降级窗口：最近 5 分钟内 Qdrant 不可用或 embedding 失败
   * true  → 顶栏亮 🧠 徽章，NPC 仍可对话但回忆降级为 MySQL importance 排序
   * false/undefined → 正常
   */
  memory_degraded?: boolean
}

/** [M4.2.1.b] WS 消息（服务端 → 客户端） */
export interface WsBaseMsg {
  ts: string
  type: string
  scene_id?: number
  tick?: number
}
export interface WsHelloMsg extends WsBaseMsg { type: 'hello'; scene_id: number }
export interface WsTickStartMsg extends WsBaseMsg { type: 'tick.start'; scene_id: number; tick: number; at: string }
export interface WsTickNpcUpdatedMsg extends WsBaseMsg {
  type: 'tick.npc.updated'
  scene_id: number
  tick: number
  npc_id: number
  npc_name?: string
  status: 'success' | 'error' | 'skipped'
  duration_ms?: number
  tokens?: { prompt: number; completion: number; total: number }
  cost_usd?: number | null
  /**
   * [M4.5.1.c] meta_summary 扩 `plan_path` / `active_goal`，时间线徽章消费
   *   - plan_path：`'event' | 'goal' | 'schedule' | 'idle' | null`，null 表示老后端/降级
   *   - active_goal：仅 `plan_path==='goal'` 时非空，供气泡/徽章渲染 title
   */
  meta_summary?: {
    latest_say: string | null
    latest_action: string | null
    emotion: string | null
    plan_path?: 'event' | 'goal' | 'schedule' | 'idle' | null
    active_goal?: { id: number; title: string; priority: number } | null
  }
}
export interface WsTickEndMsg extends WsBaseMsg {
  type: 'tick.end'
  scene_id: number
  tick: number
  duration_ms: number
  cost_usd_total?: number
}
export interface WsErrorMsg extends WsBaseMsg {
  type: 'error'
  scene_id: number
  tick: number
  npc_id?: number
  message: string
}
export interface WsMetaWarnMsg extends WsBaseMsg {
  type: 'meta.warn'
  scene_id: number
  tick: number
  npc_id: number
  npc_name?: string
  bytes: number
  soft_limit: number
  at: string
}
export type WsEngineMsg =
  | WsHelloMsg
  | WsTickStartMsg
  | WsTickNpcUpdatedMsg
  | WsTickEndMsg
  | WsErrorMsg
  | WsMetaWarnMsg
  | WsReflectionCreatedMsg
  | WsSceneEventCreatedMsg
  | (WsBaseMsg & { type: 'ping' | 'pong' })

/** [M4.2.1.b] WS 客户端连接状态 */
export type WsConnectionState = 'connecting' | 'open' | 'closed' | 'degraded'

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
