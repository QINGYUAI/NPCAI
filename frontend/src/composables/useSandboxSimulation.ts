/**
 * [M4.6.0 U-C] Sandbox simulation 状态管理 composable（从 Sandbox.vue 抽出的数据层）
 *
 * 职责（纯数据，无 UI 副作用）：
 *   1. 持有 engineStatus / wsState 两个 reactive ref
 *   2. 暴露 engineRunning / latestMetaWarn 两个 computed 派生
 *   3. 暴露 applyTickEnd / applyMetaWarn 两个 WS 帧 apply 方法
 *   4. 暴露 setEngineStatus / setWsState / reset 三个命令式接口，供 REST 轮询与生命周期清理使用
 *
 * 设计约束：
 *   - **不含 toast 等 UI 副作用**：meta_warn 的"首次展示弹窗"由 Sandbox.vue 自己 watch(latestMetaWarn) 实现
 *   - **每次调用新建独立实例**（与 pinia 单例语义不同），便于单测 / 未来多沙盒同屏
 *   - 与 useSandboxTimeline 的 state **完全不相交**；两者在 Sandbox.vue 顶层并列使用
 *   - tick.end 帧只更新 engineStatus，**不写 timeline**（timeline 行的 duration_ms/ended_at 由 useSandboxTimeline.completeTickRow 处理）
 */
import { computed, ref } from 'vue'
import type {
  EngineStatus,
  MetaWarn,
  WsConnectionState,
  WsMetaWarnMsg,
  WsTickEndMsg,
} from '../types/engine'

export function useSandboxSimulation() {
  /** 最近一次 /api/engine/status 或 WS tick.end 同步后的状态快照 */
  const engineStatus = ref<EngineStatus | null>(null)
  /** /ws/engine 连接态；degraded 时 Sandbox.vue 回落 HTTP 轮询 */
  const wsState = ref<WsConnectionState>('closed')

  const engineRunning = computed(() => engineStatus.value?.running === true)

  /** 最近一次 simulation_meta 越界告警；用于顶栏 ⚠ 标签 + toast watch 源 */
  const latestMetaWarn = computed<MetaWarn | null>(() => {
    const list = engineStatus.value?.meta_warns
    if (!list || list.length === 0) return null
    return list[list.length - 1] ?? null
  })

  /** REST 轮询 / 初始 GET 拿到整包 status 后替换当前值 */
  function setEngineStatus(next: EngineStatus | null) {
    engineStatus.value = next
  }

  function setWsState(s: WsConnectionState) {
    wsState.value = s
  }

  /**
   * WS tick.end 帧 → 仅更新 engineStatus 的几个关键字段，减少 REST 轮询滞后
   * - tick / last_tick_at / last_duration_ms / cost_usd_total（null 时保留旧值）
   * - 不触达 timeline；timeline 行的 duration_ms 由 useSandboxTimeline.completeTickRow 负责
   */
  function applyTickEnd(msg: WsTickEndMsg) {
    const cur = engineStatus.value
    if (!cur) return
    engineStatus.value = {
      ...cur,
      tick: msg.tick,
      last_tick_at: msg.ts,
      last_duration_ms: msg.duration_ms,
      cost_usd_total: msg.cost_usd_total ?? cur.cost_usd_total,
    }
  }

  /**
   * WS meta.warn 帧 → 追加到 engineStatus.meta_warns 尾部；超过 20 条时头部移除
   * - 用户语义：这是"某 NPC 的 simulation_meta 达到软阈值"告警流
   */
  function applyMetaWarn(msg: WsMetaWarnMsg) {
    const cur = engineStatus.value
    if (!cur) return
    const next: MetaWarn = {
      scene_id: msg.scene_id,
      npc_id: msg.npc_id,
      npc_name: msg.npc_name,
      tick: msg.tick,
      bytes: msg.bytes,
      soft_limit: msg.soft_limit,
      at: msg.at,
    }
    const list = (cur.meta_warns || []).slice()
    list.push(next)
    if (list.length > 20) list.splice(0, list.length - 20)
    engineStatus.value = { ...cur, meta_warns: list }
  }

  /** 切场景 / 组件卸载时清空 */
  function reset() {
    engineStatus.value = null
    wsState.value = 'closed'
  }

  return {
    engineStatus,
    wsState,
    engineRunning,
    latestMetaWarn,
    setEngineStatus,
    setWsState,
    applyTickEnd,
    applyMetaWarn,
    reset,
  } as const
}

export type SandboxSimulation = ReturnType<typeof useSandboxSimulation>
