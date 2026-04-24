/**
 * [M4.6.0 U-C] Sandbox 时间线状态管理 composable（从 Sandbox.vue 抽出的数据层）
 *
 * 职责（纯数据，无 UI 副作用）：
 *   1. 持有 timelineEntries / sessionTokens / sessionCostUsd 三个 reactive ref
 *   2. 暴露 applyTickStart / applyNpcUpdated / completeTickRow 三个 apply 方法
 *   3. 暴露 reset 清理接口
 *
 * 设计约束：
 *   - ring buffer 容量固定 TIMELINE_MAX=20；越过时尾插头删
 *   - **不消费 WS tick.end 帧**：由 useSandboxSimulation.applyTickEnd 处理 engineStatus；
 *     timeline 行的 duration_ms/ended_at 由 Sandbox.vue 顶层在 onTickEnd 里**同时**调用
 *     useSandboxSimulation.applyTickEnd + useSandboxTimeline.completeTickRow（双消费者）
 *   - cost_usd 语义：null 表示至少一次 LLM 价格未知；一旦 null 就"吸收"整个 session/tick 的 cost
 *   - 只累计 status==='success' 的 tokens/cost（skipped/error 不计）
 */
import { ref } from 'vue'
import type {
  WsTickStartMsg,
  WsTickNpcUpdatedMsg,
} from '../types/engine'
import type { TimelineTickRow, TimelineNpcEntry } from '../types/timeline'
import { extractPlanFromMeta } from '../utils/planPath'

export const TIMELINE_MAX = 20

export function useSandboxTimeline() {
  const timelineEntries = ref<TimelineTickRow[]>([])
  /** 本次场景会话 tokens 累计；切场景清零 */
  const sessionTokens = ref(0)
  /** 本次场景会话 cost_usd 累计；null 表示至少一次 LLM 价格未知 */
  const sessionCostUsd = ref<number | null>(0)

  /**
   * WS tick.start 帧 → 新建一行放入 ring buffer 尾部，超过 TIMELINE_MAX 时移除最旧
   */
  function applyTickStart(msg: WsTickStartMsg) {
    const row: TimelineTickRow = {
      tick: msg.tick,
      started_at: msg.ts,
      tokens_total: 0,
      cost_usd: 0,
      npcs: [],
    }
    const next = timelineEntries.value.slice()
    next.push(row)
    if (next.length > TIMELINE_MAX) next.splice(0, next.length - TIMELINE_MAX)
    timelineEntries.value = next
  }

  /**
   * WS tick.npc.updated 帧 → 追加到对应 tick 行
   * - 若该 tick 行尚未建立（丢 start 或 npc 帧先到），即时补建
   * - 同步累计到 tick 行和 session 累计（仅 success 计费；skipped/error 展示但不算）
   */
  function applyNpcUpdated(msg: WsTickNpcUpdatedMsg) {
    const list = timelineEntries.value.slice()
    let row = list.find((r) => r.tick === msg.tick)
    if (!row) {
      row = {
        tick: msg.tick,
        started_at: msg.ts,
        tokens_total: 0,
        cost_usd: 0,
        npcs: [],
      }
      list.push(row)
      if (list.length > TIMELINE_MAX) list.splice(0, list.length - TIMELINE_MAX)
    }
    const status: TimelineNpcEntry['status'] =
      msg.status === 'success' ? 'success' : msg.status === 'skipped' ? 'skipped' : 'error'
    const metaSummary = (msg.meta_summary ?? null) as Record<string, unknown> | null
    const entry: TimelineNpcEntry = {
      npc_id: msg.npc_id,
      npc_name: msg.npc_name,
      status,
      duration_ms: msg.duration_ms,
      prompt_tokens: msg.tokens?.prompt ?? undefined,
      completion_tokens: msg.tokens?.completion ?? undefined,
      total_tokens: msg.tokens?.total ?? undefined,
      cost_usd: msg.cost_usd ?? null,
      latest_say: metaSummary && typeof metaSummary.latest_say === 'string' ? metaSummary.latest_say : null,
      latest_action:
        metaSummary && typeof metaSummary.latest_action === 'string' ? metaSummary.latest_action : null,
      emotion: metaSummary && typeof metaSummary.emotion === 'string' ? metaSummary.emotion : null,
      ...extractPlanFromMeta(metaSummary),
    }
    if (status === 'skipped') entry.note = '超预算，跳过'
    else if (status === 'error') entry.note = '执行出错'
    row.npcs.push(entry)

    if (status === 'success' && msg.tokens?.total) {
      row.tokens_total += msg.tokens.total
      sessionTokens.value += msg.tokens.total
    }
    if (status === 'success' && typeof msg.cost_usd === 'number') {
      row.cost_usd = (row.cost_usd ?? 0) + msg.cost_usd
      if (sessionCostUsd.value !== null) sessionCostUsd.value += msg.cost_usd
    } else if (status === 'success' && msg.cost_usd == null) {
      /** 命中价格未知 → 标记 row / session 的 cost 为 null（未知） */
      row.cost_usd = null
      sessionCostUsd.value = null
    }
    timelineEntries.value = list
  }

  /**
   * 给某个 tick 行补写 duration_ms / ended_at；行已移出 ring buffer 则静默跳过
   * - Sandbox.vue 顶层在 WS onTickEnd 里调用（与 useSandboxSimulation.applyTickEnd 并列调用）
   */
  function completeTickRow(tick: number, duration_ms: number, ended_at: string) {
    const list = timelineEntries.value.slice()
    const row = list.find((r) => r.tick === tick)
    if (!row) return
    row.duration_ms = duration_ms
    row.ended_at = ended_at
    timelineEntries.value = list
  }

  /** 切场景 / 组件卸载时清空 */
  function reset() {
    timelineEntries.value = []
    sessionTokens.value = 0
    sessionCostUsd.value = 0
  }

  return {
    timelineEntries,
    sessionTokens,
    sessionCostUsd,
    applyTickStart,
    applyNpcUpdated,
    completeTickRow,
    reset,
  } as const
}

export type SandboxTimeline = ReturnType<typeof useSandboxTimeline>
