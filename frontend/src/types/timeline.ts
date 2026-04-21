/**
 * [M4.2.1.c] tick 时间线浮窗的内部数据模型
 * - 前端本地聚合 WS 三种事件：tick.start / tick.npc.updated / tick.end
 * - 每个 tick 一个 `TickRow`；NPC 结果按到达顺序追加到 row.npcs[]
 * - 仅在组件生命周期内持有（刷新页面 / 切场景清空），不做持久化
 */

export interface TimelineNpcEntry {
  npc_id: number
  npc_name?: string
  /** success / skipped / error；skipped 表示被预算判定跳过 */
  status: 'success' | 'error' | 'skipped'
  duration_ms?: number
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cost_usd?: number | null
  /** 仅 success 时有值；供展开后显示 */
  latest_say?: string | null
  latest_action?: string | null
  emotion?: string | null
  /** status=error / skipped 时的简要说明 */
  note?: string
}

export interface TimelineTickRow {
  tick: number
  /** tick.start 时记一次（ISO8601）；若 WS 丢 tick.start，则用第一条 npc.updated 的 ts */
  started_at: string
  /** tick.end 时覆盖 */
  ended_at?: string
  duration_ms?: number
  /** 本 tick 累计 tokens（所有 NPC total 之和） */
  tokens_total: number
  /** 本 tick 累计 cost_usd（null 表示至少有一次 LLM 价格未知） */
  cost_usd?: number | null
  /** 到达顺序的 NPC 记录 */
  npcs: TimelineNpcEntry[]
}
