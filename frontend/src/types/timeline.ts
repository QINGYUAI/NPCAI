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
  /** [M4.3.0] tick 级 trace_id；调试抽屉里以 T:<short> 形式展示（默认隐藏） */
  trace_id?: string | null
  /**
   * [M4.5.1.c] plan 节点四路决策，供时间线徽章展示
   *   - 'event' 紫 / 'goal' 橙 / 'schedule' 青 / 'idle' 灰
   *   - null / undefined（老后端 / 降级）→ 不渲染徽章
   */
  plan_path?: 'event' | 'goal' | 'schedule' | 'idle' | null
  /** [M4.5.1.c] 仅 plan_path='goal' 时的目标 title，徽章后缀显示首 8 字 */
  goal_title?: string | null
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
