<script setup lang="ts">
/**
 * 2D 沙盒（Phaser 3）— 场景布局 MVP
 * - 选择场景 → 加载底图与关联 NPC
 * - 将 NPC 以圆形节点渲染到画布，可拖拽调整位置
 * - 点击「保存布局」写入 scene_npc.pos_x/pos_y
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { toast } from 'vue3-toastify'
import { ElMessageBox } from 'element-plus'
import {
  getSceneList,
  getSceneById,
  updateSceneLayout,
  replaceSceneNpcs,
} from '../api/scene'
import { updateNpc } from '../api/npc'
import {
  startEngine,
  stopEngine,
  stepEngine,
  getEngineStatus,
  openEngineWs,
  reflectOnce,
  createSceneEvent,
  listSceneEvents,
} from '../api/engine'
import type {
  EngineStatus,
  MetaWarn,
  WsConnectionState,
  WsMetaWarnMsg,
  WsTickEndMsg,
  WsTickStartMsg,
  WsTickNpcUpdatedMsg,
} from '../types/engine'
import type { Scene, SceneDetail, SceneNpcLink } from '../types/scene'
import type { TimelineTickRow, TimelineNpcEntry } from '../types/timeline'
import type { ReflectionRingEntry, WsReflectionCreatedMsg } from '../types/reflection'
import type {
  CreateSceneEventBody,
  EventRingEntry,
  SceneEventRow,
  WsSceneEventCreatedMsg,
} from '../types/event'
import { EVENT_PRESETS } from '../types/event'
import SandboxTimeline from './SandboxTimeline.vue'
import SandboxReflections from './SandboxReflections.vue'
import SandboxEvents from './SandboxEvents.vue'
import SandboxEventInjectorDialog from './SandboxEventInjectorDialog.vue'
import SandboxMap from './SandboxMap.vue'
import SandboxToolbar from './SandboxToolbar.vue'
import SandboxAsidePanel from './SandboxAsidePanel.vue'
import { fallbackPosition } from '../utils/sandbox'
import { extractPlanFromMeta } from '../utils/planPath'

/** 画布视口尺寸（DOM 像素，Phaser Game 的 width/height） */
const VIEWPORT_W = 800
const VIEWPORT_H = 600
/** NPC 节点半径（世界坐标），与子组件 SandboxMap 一致 */
const NODE_R = 26
/** 顶层状态 */
const scenes = ref<Scene[]>([])
const activeSceneId = ref<number | null>(null)
const detail = ref<SceneDetail | null>(null)
const loading = ref(false)
const dirty = ref(false)
const saving = ref(false)

/** 状态气泡（M3.2）：轮询 simulation_meta.latest_say / latest_action */
const bubbleEnabled = ref(false)
const bubbleIntervalMs = ref(5000)
let bubbleTimer: ReturnType<typeof setInterval> | null = null

/** 网格吸附：默认关（用户拖拽时可按住 Shift 临时吸附）；开启后始终吸附 */
const snapEnabled = ref(false)
const snapStep = ref(20)

/**
 * M4.1 引擎控制：▶ 开始 / ⏭ 单步 / ⏸ 停止
 * - 默认 dry_run=true，不调用 LLM，仅跑确定性伪输出（由后端 graph/build.ts 提供）
 * - 引擎运行时每 3s 轮询一次 /engine/status；停止后清理定时器
 */
const engineStatus = ref<EngineStatus | null>(null)
const engineDryRun = ref(true)
const engineInterval = ref(5000)
const engineLoading = ref(false)
let engineStatusTimer: ReturnType<typeof setInterval> | null = null
const engineRunning = computed(() => engineStatus.value?.running === true)

/**
 * [M4.2.1.b] WebSocket 观察者
 * - 优先使用 /ws/engine 实时推送；断线指数退避重连
 * - 连续重连失败 → degraded → 自动回落 3s 轮询
 * - 场景切换 / 组件销毁 / 引擎停止 时统一关闭
 */
let wsClose: (() => void) | null = null
const wsState = ref<WsConnectionState>('closed')

/**
 * [M4.2.1.c] tick 时间线：ring buffer 最多 20 条
 * - WS tick.start → push 新 row；tick.npc.updated → 追加到当前 row.npcs；tick.end → 覆盖 duration
 * - 切场景 / 组件卸载时清空；会话累计独立于 ring buffer（用于顶栏 Σ 标签）
 */
const TIMELINE_MAX = 20
const timelineEntries = ref<TimelineTickRow[]>([])
/** 本次场景会话 tokens / cost 累计；cost_usd 为 null 表示至少有一次价格未知（仍累计 tokens） */
const sessionTokens = ref(0)
const sessionCostUsd = ref<number | null>(0)
/** drawer 模式（小屏）下的开关；panel 模式下不使用此字段 */
const timelineDrawerVisible = ref(false)
/** 视口宽度 ≥1280 走 panel；否则走 drawer（用户可点顶栏标签唤起） */
const VIEWPORT_WIDE_BREAKPOINT = 1280
const viewportWide = ref(
  typeof window !== 'undefined' ? window.innerWidth >= VIEWPORT_WIDE_BREAKPOINT : true,
)
function onWindowResize() {
  viewportWide.value = window.innerWidth >= VIEWPORT_WIDE_BREAKPOINT
}

/** panel 模式下时间线面板是否折叠（由顶栏累计标签切换） */
const timelinePanelCollapsed = ref(false)

/**
 * [M4.2.3.c] 反思 ring buffer：最多 20 条，来源于 WS `reflection.created`
 * - key 使用 reflection_ids[0]（同一次反思 3 条共享），防止重复 push（WS 重连再推同事件时）
 * - 切场景 / 组件卸载清空
 */
const REFLECTION_MAX = 20
const reflectionEntries = ref<ReflectionRingEntry[]>([])
const reflectionDrawerVisible = ref(false)
/** 手动反思按钮 loading；key = npc_id 以允许多 NPC 并发（虽然后端是同步，但前端不做互斥更好） */
const reflectingNpcs = ref<Set<number>>(new Set())

/**
 * [M4.2.4.c] 场景事件 ring buffer：最多 20 条
 * - 数据源：首屏 GET /api/scene/:id/events（补发历史）+ WS `scene.event.created`（实时）+ POST 响应（单客户端即时回显）
 * - key=event_id；WS / REST / POST 重复时后写覆盖保证幂等
 * - 切场景 / 组件卸载清空
 */
const EVENT_RING_MAX = 20
const eventEntries = ref<EventRingEntry[]>([])
const eventDrawerVisible = ref(false)
const eventDialogVisible = ref(false)
/** 预设按钮 loading：防快连点重复提交（同 id 互斥） */
const eventSubmitting = ref<Set<string>>(new Set())

function resetTimeline() {
  timelineEntries.value = []
  sessionTokens.value = 0
  sessionCostUsd.value = 0
  timelineDrawerVisible.value = false
  reflectionEntries.value = []
  reflectionDrawerVisible.value = false
  reflectingNpcs.value = new Set()
  eventEntries.value = []
  eventDrawerVisible.value = false
  eventDialogVisible.value = false
  eventSubmitting.value = new Set()
}

/**
 * [M4.2.3.c] WS reflection.created → 压入 ring buffer（去重：同 key 覆盖最新一条）
 * - 兼容 WS 重连期间可能的重推；UI 感受：徽章不会连续 +1
 */
function applyWsReflection(msg: WsReflectionCreatedMsg) {
  const key = msg.reflection_ids?.[0]
  if (!key) return
  const entry: ReflectionRingEntry = {
    key,
    scene_id: msg.scene_id,
    npc_id: msg.npc_id,
    npc_name: msg.npc_name || `NPC#${msg.npc_id}`,
    tick: msg.tick,
    items: msg.items,
    reflection_ids: msg.reflection_ids,
    source_memory_ids: msg.source_memory_ids,
    received_at: msg.ts || msg.at,
  }
  const list = reflectionEntries.value.slice().filter((e) => e.key !== key)
  list.push(entry)
  if (list.length > REFLECTION_MAX) list.splice(0, list.length - REFLECTION_MAX)
  reflectionEntries.value = list
}

/** [M4.2.3.c] 手动触发某 NPC 的反思（右键菜单入口） */
async function triggerManualReflect(npc: { npc_id: number; npc_name?: string }) {
  if (!activeSceneId.value) return
  if (reflectingNpcs.value.has(npc.npc_id)) return
  const next = new Set(reflectingNpcs.value)
  next.add(npc.npc_id)
  reflectingNpcs.value = next
  const npcName = npc.npc_name || `NPC#${npc.npc_id}`
  const notify = toast.loading(`${npcName} 反思中，预计 25~40 秒…`, { autoClose: false })
  try {
    const resp = await reflectOnce({ scene_id: activeSceneId.value, npc_id: npc.npc_id })
    const data = resp.data?.data
    toast.update(notify, {
      render:
        data?.status === 'generated'
          ? `${npcName} 已生成 ${data.items.length} 条反思`
          : data?.status === 'skipped'
            ? `${npcName} 反思跳过：最近记忆不足`
            : `${npcName} 反思生成失败（见后端日志）`,
      type: data?.status === 'generated' ? 'success' : data?.status === 'skipped' ? 'info' : 'error',
      isLoading: false,
      autoClose: 3500,
    })
    if (data?.status === 'generated') {
      reflectionDrawerVisible.value = true
    }
  } catch (e) {
    toast.update(notify, {
      render: `反思触发失败：${(e as Error).message || '未知错误'}`,
      type: 'error',
      isLoading: false,
      autoClose: 4000,
    })
  } finally {
    const back = new Set(reflectingNpcs.value)
    back.delete(npc.npc_id)
    reflectingNpcs.value = back
  }
}

/** [M4.2.3.c] 顶栏反思徽章点击：开关抽屉；长按/右键可清空（此处用抽屉内的「清空」按钮） */
function onReflectionPillClick() {
  reflectionDrawerVisible.value = !reflectionDrawerVisible.value
}
function clearReflections() {
  reflectionEntries.value = []
}

/**
 * [M4.2.4.c] 把 SceneEventRow / WsSceneEventCreatedMsg 压扁为 ring buffer entry，
 * 以 id 为 key 做后写覆盖（幂等）；保持按 received_at 升序（渲染时倒序）
 */
function upsertEventRing(entry: EventRingEntry) {
  const list = eventEntries.value.slice().filter((e) => e.key !== entry.key)
  list.push(entry)
  list.sort((a, b) => a.received_at.localeCompare(b.received_at))
  if (list.length > EVENT_RING_MAX) list.splice(0, list.length - EVENT_RING_MAX)
  eventEntries.value = list
}

function rowToEntry(row: SceneEventRow): EventRingEntry {
  return {
    key: row.id,
    scene_id: row.scene_id,
    type: row.type,
    actor: row.actor,
    content: row.content,
    payload: row.payload,
    visible_npcs: row.visible_npcs,
    received_at: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
    consumed_tick: row.consumed_tick,
    /** [M4.3.1.c] 透传对话链与 trace_id 供抽屉/气泡展示 */
    trace_id: row.trace_id ?? null,
    parent_event_id: row.parent_event_id ?? null,
    conv_turn: row.conv_turn ?? null,
  }
}

/** [M4.2.4.c] WS scene.event.created → 压入 ring buffer */
function applyWsSceneEvent(msg: WsSceneEventCreatedMsg) {
  upsertEventRing({
    key: msg.event_id,
    scene_id: msg.scene_id,
    type: msg.event_type,
    actor: msg.actor,
    content: msg.content,
    payload: msg.payload,
    visible_npcs: msg.visible_npcs,
    received_at: msg.ts || msg.at,
    consumed_tick: null,
    /** [M4.3.1.c] 透传 trace / 对话链字段 */
    trace_id: msg.trace_id ?? null,
    parent_event_id: msg.parent_event_id ?? null,
    conv_turn: msg.conv_turn ?? null,
  })
}

/**
 * [M4.2.4.c] 首屏 / 场景切换 / WS 首次 open 时补发最近事件
 * - 仅保留最近 EVENT_RING_MAX 条；按 id 升序入 buffer，最新自然在下（渲染时倒序显示）
 */
async function loadSceneEvents(sceneId: number) {
  try {
    const resp = await listSceneEvents(sceneId, { limit: EVENT_RING_MAX })
    const data = resp.data?.data
    if (!data?.list) return
    /** 后端返回 DESC；入 ring buffer 时转成按时间升序 */
    const entries = data.list.map(rowToEntry).reverse()
    for (const e of entries) upsertEventRing(e)
  } catch (e) {
    console.warn('[Sandbox] loadSceneEvents 失败（忽略，WS 会继续补推）:', e)
  }
}

/** [M4.2.4.c] 预设事件：顶栏快捷按钮调用（不开表单直接 POST） */
async function onEventPreset(presetId: string) {
  const preset = EVENT_PRESETS.find((p) => p.id === presetId)
  if (!preset || !activeSceneId.value) return
  if (eventSubmitting.value.has(presetId)) return
  const next = new Set(eventSubmitting.value)
  next.add(presetId)
  eventSubmitting.value = next
  try {
    const resp = await createSceneEvent(activeSceneId.value, preset.body)
    const row = resp.data?.data
    if (resp.data?.code === 0 && row) {
      upsertEventRing(rowToEntry(row))
      toast.success(`${preset.emoji} ${preset.label} 事件已注入 #${row.id}`)
    } else {
      toast.error(resp.data?.message || '事件注入失败')
    }
  } catch (e) {
    toast.error(`事件注入失败：${(e as Error).message || '未知错误'}`)
  } finally {
    const back = new Set(eventSubmitting.value)
    back.delete(presetId)
    eventSubmitting.value = back
  }
}

/** [M4.2.4.c] 打开「自定义事件」对话框 */
function onEventCustomClick() {
  if (!activeSceneId.value) {
    toast.warning('请先选择场景')
    return
  }
  eventDialogVisible.value = true
}

/** [M4.2.4.c] 对话框提交 → POST，成功后本地回显 + 关窗 */
async function submitCustomEvent(body: CreateSceneEventBody) {
  if (!activeSceneId.value) return
  try {
    const resp = await createSceneEvent(activeSceneId.value, body)
    const row = resp.data?.data
    if (resp.data?.code === 0 && row) {
      upsertEventRing(rowToEntry(row))
      toast.success(`✅ 事件已注入 #${row.id}`)
      eventDialogVisible.value = false
    } else {
      toast.error(resp.data?.message || '事件注入失败')
    }
  } catch (e) {
    toast.error(`事件注入失败：${(e as Error).message || '未知错误'}`)
  }
}

function onEventPillClick() {
  eventDrawerVisible.value = !eventDrawerVisible.value
}
function clearEvents() {
  eventEntries.value = []
}

/**
 * [M4.2.1.c] 点击顶栏 Σ 标签：
 * - 宽屏（panel 模式）：切换右侧面板折叠
 * - 小屏（drawer 模式）：切换抽屉可见
 */
function onTimelinePillClick() {
  if (viewportWide.value) {
    timelinePanelCollapsed.value = !timelinePanelCollapsed.value
  } else {
    timelineDrawerVisible.value = !timelineDrawerVisible.value
  }
}

/**
 * [M4.2.1.c] tick.start：新建一行 tick 记录放入 ring buffer
 * - 超过 TIMELINE_MAX 时移除最旧一条（尾插头删）
 */
function applyWsTickStart(msg: WsTickStartMsg) {
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
 * [M4.2.1.c] tick.npc.updated：追加 NPC 结果到对应 tick 行
 * - 若该 tick 行尚未建立（丢 start 或先来 npc 帧），即时补建一行
 * - 同步累计到 tick 行和 session 累计（仅 success 计费；skipped/error 也展示但不算）
 */
function applyWsNpcUpdated(msg: WsTickNpcUpdatedMsg) {
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
    /** [M4.5.1.c] plan_path / goal_title 统一由纯函数 extractPlanFromMeta 归一化（老后端降级返回 null） */
    ...extractPlanFromMeta(metaSummary),
  }
  if (status === 'skipped') entry.note = '超预算，跳过'
  else if (status === 'error') entry.note = '执行出错'
  row.npcs.push(entry)

  /** 只累计 success 的 tokens / cost（skipped 没发起 LLM 调用；error 视为已计但多半也没产生成本） */
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
 * [M4.2.0] 最近一次 simulation_meta 越界告警
 * - 从 EngineStatus.meta_warns 取最后一条
 * - 仅在 `at` 变化时弹一次 toast，避免反复骚扰
 */
const latestMetaWarn = computed(() => {
  const list = engineStatus.value?.meta_warns
  if (!list || list.length === 0) return null
  return list[list.length - 1] ?? null
})
let lastShownMetaWarnAt: string | null = null
function handleEngineStatusUpdate(next: EngineStatus | null) {
  engineStatus.value = next
  const w = next?.meta_warns?.[next.meta_warns.length - 1]
  if (w && w.at !== lastShownMetaWarnAt) {
    lastShownMetaWarnAt = w.at
    const name = w.npc_name || `NPC#${w.npc_id}`
    const kb = (w.bytes / 1024).toFixed(1)
    toast.warning(`${name} tick#${w.tick} simulation_meta 达到 ${kb}KB，已超软阈值`)
  }
}

/** 节点右键菜单状态（相对画布容器左上角） */
const ctxMenu = ref<{ visible: boolean; x: number; y: number; npc: SceneNpcLink | null }>({
  visible: false,
  x: 0,
  y: 0,
  npc: null,
})

/**
 * [M4.6.0·批次B-2] Phaser 画布由 SandboxMap 托管；父组件仅保留缩放数字 / dirty / 右键菜单。
 *
 * defineExpose 的命令式 API（与 SandboxMap.vue 同步）
 */
type SandboxMapExpose = {
  getPositions: () => Array<{ npc_id: number; pos_x: number; pos_y: number }>
  setZoom: (z: number) => void
  zoomIn: () => void
  zoomOut: () => void
  zoomFit: () => void
  refreshBubbles: () => void
  resetLayout: () => void
}
const mapRef = ref<SandboxMapExpose | null>(null)

/** 与 SandboxMap 相机同步（按钮展示缩放百分比） */
const zoomLevel = ref(1)

function onMapPositionChanged() {
  dirty.value = true
}

function onMapNpcRightClick(payload: { npc: SceneNpcLink; x: number; y: number }) {
  ctxMenu.value = {
    visible: true,
    x: payload.x,
    y: payload.y,
    npc: payload.npc,
  }
}

function onMapZoomChange(z: number) {
  zoomLevel.value = z
}

function zoomIn() {
  mapRef.value?.zoomIn()
}
function zoomOut() {
  mapRef.value?.zoomOut()
}
function zoomFit() {
  mapRef.value?.zoomFit()
}

/** 备注编辑对话框 */
const roleDialog = ref<{ visible: boolean; npc: SceneNpcLink | null; text: string; saving: boolean }>({
  visible: false,
  npc: null,
  text: '',
  saving: false,
})

/** simulation_meta 编辑对话框 */
const metaDialog = ref<{
  visible: boolean
  npc: SceneNpcLink | null
  text: string
  error: string
  saving: boolean
}>({
  visible: false,
  npc: null,
  text: '',
  error: '',
  saving: false,
})

const activeScene = computed<Scene | null>(
  () => scenes.value.find((s) => s.id === activeSceneId.value) ?? null,
)

/** 读取场景列表（只要启用态） */
async function loadScenes() {
  try {
    const { data } = await getSceneList({ status: 1, pageSize: 100 })
    if (data.code === 0 && data.data) {
      scenes.value = data.data.list
      const first = scenes.value[0]
      if (!activeSceneId.value && first) {
        activeSceneId.value = first.id
      }
    }
  } catch (e) {
    console.error(e)
    toast.error('加载场景列表失败')
  }
}

/** 从场景详情读取尺寸；缺省 800x600 */
function worldSize(d: SceneDetail | null): { w: number; h: number } {
  const w = typeof d?.width === 'number' && d.width >= 200 ? d.width : 800
  const h = typeof d?.height === 'number' && d.height >= 200 ? d.height : 600
  return { w, h }
}

/**
 * [M4.3.1.c] 根据 ring buffer 查某 NPC 最新 dialogue event 的回复对象
 *   - 约束：只查 actor === npcName 的最新一条 dialogue；取其 parent_event_id 指向的 entry.actor
 *   - 找不到 / 不是回复 / parent 已出 ring 窗口 → 返回 null（气泡回退到纯 latest_say）
 */
function findReplyToActor(npcName: string | null | undefined): string | null {
  if (!npcName) return null
  const list = eventEntries.value
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i]
    if (!e || e.type !== 'dialogue' || e.actor !== npcName) continue
    if (e.parent_event_id == null) return null
    const parent = list.find((x) => x.key === e.parent_event_id)
    return parent?.actor ?? null
  }
  return null
}

/** 刷新所有节点气泡：委派给 SandboxMap（读取 props.detail 内最新 simulation_meta） */
function refreshBubbles() {
  mapRef.value?.refreshBubbles()
}

/** 轮询：重新拉取场景详情，只更新 simulation_meta 并刷新气泡（不动节点位置） */
async function pollStatus() {
  if (!activeSceneId.value || !detail.value) return
  try {
    const { data } = await getSceneById(activeSceneId.value)
    if (data.code === 0 && data.data) {
      const fresh = data.data
      /** 就地合并 simulation_meta，保留用户未保存的拖拽坐标 */
      const metaMap = new Map<number, Record<string, unknown> | null | undefined>()
      for (const n of fresh.npcs) metaMap.set(n.npc_id, n.simulation_meta)
      detail.value = {
        ...detail.value,
        npcs: detail.value.npcs.map((n) => ({
          ...n,
          simulation_meta: metaMap.get(n.npc_id) ?? n.simulation_meta ?? null,
        })),
      }
      refreshBubbles()
    }
  } catch (e) {
    console.warn('[Sandbox] pollStatus failed:', e)
  }
}

function startBubbleTimer() {
  stopBubbleTimer()
  if (!bubbleEnabled.value) return
  /** 立即拉一次，后续按间隔轮询 */
  pollStatus()
  bubbleTimer = setInterval(pollStatus, Math.max(1000, bubbleIntervalMs.value))
}

function stopBubbleTimer() {
  if (bubbleTimer) {
    clearInterval(bubbleTimer)
    bubbleTimer = null
  }
}

watch(bubbleEnabled, (on) => {
  if (on) {
    startBubbleTimer()
  } else {
    stopBubbleTimer()
    refreshBubbles()
  }
})

watch(bubbleIntervalMs, () => {
  if (bubbleEnabled.value) startBubbleTimer()
})

/** 启动引擎 tick 循环（dry_run 默认开） */
async function onEngineStart() {
  if (!activeSceneId.value) return
  engineLoading.value = true
  try {
    const { data } = await startEngine({
      scene_id: activeSceneId.value,
      interval_ms: engineInterval.value,
      dry_run: engineDryRun.value,
      concurrency: 2,
    })
    if (data.code === 0 && data.data) {
      handleEngineStatusUpdate(data.data)
      startEngineObserver()
      /** 启动后自动打开气泡（用户可随时关） */
      if (!bubbleEnabled.value) bubbleEnabled.value = true
      toast.success(engineDryRun.value ? '引擎已启动（dry_run）' : '引擎已启动')
    } else {
      toast.error(data.message || '启动失败')
    }
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string; error?: string } } }
    const msg = err.response?.data?.message || '启动失败'
    toast.error(msg)
  } finally {
    engineLoading.value = false
  }
}

async function onEngineStop(force = false) {
  if (!activeSceneId.value) return
  engineLoading.value = true
  try {
    const { data } = await stopEngine(activeSceneId.value, force)
    if (data.code === 0) {
      handleEngineStatusUpdate(data.data || null)
      stopEngineObserver()
      toast.info(force ? '引擎已强制停止' : '引擎已停止')
    } else {
      toast.error(data.message || '停止失败')
    }
  } catch (e) {
    console.error(e)
    toast.error('停止失败')
  } finally {
    engineLoading.value = false
  }
}

async function onEngineStep() {
  if (!activeSceneId.value) return
  engineLoading.value = true
  try {
    const { data } = await stepEngine(activeSceneId.value, engineDryRun.value)
    if (data.code === 0) {
      handleEngineStatusUpdate(data.data || null)
      /** 手动单步后立即刷一次气泡 */
      if (bubbleEnabled.value) void pollStatus()
      toast.success(`已执行 tick #${engineStatus.value?.tick ?? '?'}`)
    } else {
      toast.error(data.message || '单步失败')
    }
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } }
    toast.error(err.response?.data?.message || '单步失败')
  } finally {
    engineLoading.value = false
  }
}

async function pollEngineStatus() {
  if (!activeSceneId.value) return
  try {
    const { data } = await getEngineStatus(activeSceneId.value)
    if (data.code === 0) {
      handleEngineStatusUpdate(data.data || null)
      /** 后端自停（max_ticks）后，前端同步关观察者 */
      if (!engineStatus.value?.running) {
        stopEngineObserver()
      }
    }
  } catch {
    /* 静默；下次轮询再试 */
  }
}

function startEngineStatusTimer() {
  stopEngineStatusTimer()
  engineStatusTimer = setInterval(pollEngineStatus, 3000)
}

function stopEngineStatusTimer() {
  if (engineStatusTimer) {
    clearInterval(engineStatusTimer)
    engineStatusTimer = null
  }
}

/**
 * [M4.2.1.b] 根据 status.ws_endpoint 决定走 WS 还是 HTTP 轮询
 * - 有 ws_endpoint → 尝试 openEngineWs；onConnectionChange('open') 停轮询
 * - 无 ws_endpoint / degraded → 3s 轮询
 * - 组件内保证同一时刻只有一种数据源在跑
 */
function startEngineObserver() {
  const endpoint = engineStatus.value?.ws_endpoint
  const sceneId = activeSceneId.value
  if (!sceneId) return
  if (!endpoint) {
    startEngineStatusTimer()
    return
  }
  stopEngineObserver()
  wsClose = openEngineWs(endpoint, sceneId, {
    onConnectionChange: (s) => {
      wsState.value = s
      if (s === 'open') {
        stopEngineStatusTimer()
      } else if (s === 'degraded') {
        startEngineStatusTimer()
      } else if (s === 'closed') {
        /** 仅短暂 closed → 重连中，不立即启轮询，等 degraded */
      }
    },
    onTickStart: (msg) => applyWsTickStart(msg),
    onNpcUpdated: (msg) => applyWsNpcUpdated(msg),
    onTickEnd: (msg) => applyWsTickEnd(msg),
    onMetaWarn: (msg) => applyWsMetaWarn(msg),
    onReflection: (msg) => applyWsReflection(msg),
    onSceneEvent: (msg) => applyWsSceneEvent(msg),
    onError: (msg) => {
      if (engineStatus.value) {
        engineStatus.value = {
          ...engineStatus.value,
          errors_recent: (engineStatus.value.errors_recent || 0) + 1,
        }
      }
      toast.error(msg.message || '引擎错误')
    },
  })
}

function stopEngineObserver() {
  if (wsClose) { try { wsClose() } catch { /* noop */ } ; wsClose = null }
  wsState.value = 'closed'
  stopEngineStatusTimer()
}

/** [M4.2.1.b] 用 WS 的 tick.end 帧覆盖关键字段，减少轮询滞后；[M4.2.1.c] 同步收尾 timeline 行 */
function applyWsTickEnd(msg: WsTickEndMsg) {
  if (engineStatus.value) {
    engineStatus.value = {
      ...engineStatus.value,
      tick: msg.tick,
      last_tick_at: msg.ts,
      last_duration_ms: msg.duration_ms,
      cost_usd_total: msg.cost_usd_total ?? engineStatus.value.cost_usd_total,
    }
  }
  /** timeline：把 duration_ms 与 ended_at 写回对应行（若行已移出 ring buffer 则无动作） */
  const list = timelineEntries.value.slice()
  const row = list.find((r) => r.tick === msg.tick)
  if (row) {
    row.duration_ms = msg.duration_ms
    row.ended_at = msg.ts
    timelineEntries.value = list
  }
}

/** [M4.2.1.b] WS 推来的 meta.warn 同步推进本地 meta_warns 数组 + 复用现有 toast 去重 */
function applyWsMetaWarn(msg: WsMetaWarnMsg) {
  if (!engineStatus.value) return
  const next: MetaWarn = {
    scene_id: msg.scene_id,
    npc_id: msg.npc_id,
    npc_name: msg.npc_name,
    tick: msg.tick,
    bytes: msg.bytes,
    soft_limit: msg.soft_limit,
    at: msg.at,
  }
  const list = (engineStatus.value.meta_warns || []).slice()
  list.push(next)
  if (list.length > 20) list.splice(0, list.length - 20)
  handleEngineStatusUpdate({ ...engineStatus.value, meta_warns: list })
}

/** 画布容器的 CSS 尺寸（视口固定；内部通过相机显示 world） */
const canvasWrapStyle = computed(() => ({
  width: VIEWPORT_W + 'px',
  height: VIEWPORT_H + 'px',
}))

/** 页脚展示的当前世界尺寸（与 detail 一致；拖拽未保存时的画布偏移不计入此展示） */
const worldDims = computed(() => worldSize(detail.value))

/** 关闭右键菜单 */
function closeCtxMenu() {
  if (ctxMenu.value.visible) {
    ctxMenu.value = { visible: false, x: 0, y: 0, npc: null }
  }
}

/** 菜单项：解除该 NPC 与当前场景的关联 */
async function unlinkCurrentNpc() {
  if (!detail.value || !activeSceneId.value || !ctxMenu.value.npc) return
  const target = ctxMenu.value.npc
  closeCtxMenu()
  try {
    await ElMessageBox.confirm(
      `确定要将「${target.npc_name || target.npc_id}」从本场景移除？该 NPC 本身不会被删除。`,
      '解除关联',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  /** 以当前 detail 构造覆盖负载（剔除目标 NPC），服务端会自动保留其余 NPC 的 pos_x/pos_y */
  const kept = detail.value.npcs.filter((n) => n.npc_id !== target.npc_id)
  const payload = kept.map((n) => ({
    npc_id: n.npc_id,
    role_note: n.role_note ?? null,
  }))
  try {
    const { data } = await replaceSceneNpcs(activeSceneId.value, payload)
    if (data.code !== 0) {
      toast.error(data.message || '移除失败')
      return
    }
    toast.success('已从本场景移除')
    await loadSceneDetail(activeSceneId.value)
  } catch (e) {
    console.error(e)
    toast.error('移除失败，请稍后重试')
  }
}

/** 菜单项：打开备注编辑对话框 */
function openRoleDialog() {
  const npc = ctxMenu.value.npc
  if (!npc) return
  roleDialog.value = {
    visible: true,
    npc,
    text: npc.role_note ?? '',
    saving: false,
  }
  closeCtxMenu()
}

/** 提交备注编辑（以当前 detail.npcs 构造完整覆盖负载，只改目标 role_note） */
async function saveRoleNote() {
  const st = roleDialog.value
  if (!detail.value || !activeSceneId.value || !st.npc) return
  st.saving = true
  try {
    const next = st.text.trim().slice(0, 256)
    const payload = detail.value.npcs.map((n) => ({
      npc_id: n.npc_id,
      role_note: n.npc_id === st.npc!.npc_id ? (next || null) : (n.role_note ?? null),
    }))
    const { data } = await replaceSceneNpcs(activeSceneId.value, payload)
    if (data.code !== 0) {
      toast.error(data.message || '保存失败')
      return
    }
    toast.success('备注已更新')
    st.visible = false
    await loadSceneDetail(activeSceneId.value)
  } catch (e) {
    console.error(e)
    toast.error('保存失败，请稍后重试')
  } finally {
    st.saving = false
  }
}

/** 菜单项：打开 simulation_meta 编辑对话框（自由 JSON） */
function openMetaDialog() {
  const npc = ctxMenu.value.npc
  if (!npc) return
  let initial = ''
  if (npc.simulation_meta && typeof npc.simulation_meta === 'object') {
    try {
      initial = JSON.stringify(npc.simulation_meta, null, 2)
    } catch {
      initial = ''
    }
  }
  metaDialog.value = {
    visible: true,
    npc,
    text: initial,
    error: '',
    saving: false,
  }
  closeCtxMenu()
}

/** 提交 simulation_meta：走 PUT /api/npc/:id，允许 null 清空 */
async function saveMeta() {
  const st = metaDialog.value
  if (!st.npc) return
  const raw = st.text.trim()
  let payload: Record<string, unknown> | null = null
  if (raw !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
        st.error = 'simulation_meta 必须是 JSON 对象（不允许数组/基础类型）'
        return
      }
      payload = parsed as Record<string, unknown> | null
    } catch (e) {
      st.error = 'JSON 解析失败：' + (e as Error).message
      return
    }
  }
  st.error = ''
  st.saving = true
  try {
    const { data } = await updateNpc(st.npc.npc_id, { simulation_meta: payload })
    if (data.code !== 0) {
      toast.error(data.message || '保存失败')
      return
    }
    toast.success('simulation_meta 已更新')
    st.visible = false
    /** 就地合并，避免整表重取打断当前未保存的布局；气泡若开启会下一轮轮询刷新 */
    if (activeSceneId.value && detail.value) {
      detail.value = {
        ...detail.value,
        npcs: detail.value.npcs.map((n) =>
          n.npc_id === st.npc!.npc_id ? { ...n, simulation_meta: payload } : n,
        ),
      }
      if (bubbleEnabled.value) refreshBubbles()
    }
  } catch (e) {
    console.error(e)
    toast.error('保存失败，请稍后重试')
  } finally {
    st.saving = false
  }
}

/** 重置为后端保存的坐标（撤销未保存的拖动） */
function resetLayout() {
  if (!detail.value) return
  mapRef.value?.resetLayout()
  dirty.value = false
}

/** 将所有节点按网格重新排布（批量初始化辅助） */
function autoArrange() {
  if (!detail.value) return
  const npcs = detail.value.npcs ?? []
  const ws = worldSize(detail.value)
  const cloned: SceneDetail = {
    ...detail.value,
    npcs: npcs.map((n, idx) => {
      const fb = fallbackPosition(idx, npcs.length, ws.w, ws.h)
      return { ...n, pos_x: fb.x, pos_y: fb.y }
    }),
  }
  detail.value = cloned
  dirty.value = true
  /** SandboxMap：layoutRebuildKey 变更触发重建 */
}

/** 保存布局 */
async function saveLayout() {
  if (!detail.value || !activeSceneId.value) return
  const positions = mapRef.value?.getPositions() ?? []
  if (positions.length === 0) {
    toast.info('当前场景没有关联角色，请先在「场景」Tab 关联')
    return
  }
  saving.value = true
  try {
    const { data } = await updateSceneLayout(activeSceneId.value, positions)
    if (data.code === 0) {
      toast.success('布局已保存')
      dirty.value = false
      /** 更新 detail 中的坐标，避免下次切换回来仍是旧值 */
      if (detail.value) {
        detail.value = {
          ...detail.value,
          npcs: detail.value.npcs.map((n) => {
            const p = positions.find((x) => x.npc_id === n.npc_id)
            return p ? { ...n, pos_x: p.pos_x, pos_y: p.pos_y } : n
          }),
        }
      }
    } else {
      toast.error(data.message || '保存失败')
    }
  } catch (e) {
    console.error(e)
    toast.error('保存失败，请稍后重试')
  } finally {
    saving.value = false
  }
}

/** 加载指定场景详情并创建画布 */
async function loadSceneDetail(id: number) {
  loading.value = true
  dirty.value = false
  try {
    const { data } = await getSceneById(id)
    if (data.code === 0 && data.data) {
      detail.value = data.data
    } else {
      toast.error(data.message || '加载失败')
    }
  } catch (e) {
    console.error(e)
    toast.error('加载场景详情失败')
  } finally {
    loading.value = false
  }
}

watch(activeSceneId, (id) => {
  if (id) {
    loadSceneDetail(id)
    /** 切场景时重置引擎面板状态 + 时间线，并拉一次最新状态 */
    stopEngineObserver()
    engineStatus.value = null
    lastShownMetaWarnAt = null
    resetTimeline()
    /** [M4.2.4.c] 场景事件首屏补发（与引擎状态轮询并行） */
    void loadSceneEvents(id)
    void pollEngineStatus().then(() => {
      if (engineStatus.value?.running) startEngineObserver()
    })
  } else {
    detail.value = null
    stopEngineObserver()
    engineStatus.value = null
    lastShownMetaWarnAt = null
    resetTimeline()
  }
})

onMounted(async () => {
  window.addEventListener('resize', onWindowResize)
  await loadScenes()
  if (activeSceneId.value) {
    await loadSceneDetail(activeSceneId.value)
    /** 恢复引擎状态：若后端已在跑，自动挂起观察者（WS 优先，降级轮询） */
    await pollEngineStatus()
    if (engineStatus.value?.running) startEngineObserver()
    /** [M4.2.4.c] 首次进入页面也补发最近事件（与引擎是否运行无关） */
    void loadSceneEvents(activeSceneId.value)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  stopBubbleTimer()
  stopEngineObserver()
})
</script>

<template>
  <div>
    <SandboxToolbar
      v-model:active-scene-id="activeSceneId"
      v-model:bubble-enabled="bubbleEnabled"
      v-model:bubble-interval-ms="bubbleIntervalMs"
      v-model:snap-enabled="snapEnabled"
      v-model:snap-step="snapStep"
      v-model:engine-dry-run="engineDryRun"
      v-model:engine-interval="engineInterval"
      :scenes="scenes"
      :loading="loading"
      :engine-running="engineRunning"
      :engine-status="engineStatus"
      :engine-loading="engineLoading"
      :latest-meta-warn="latestMetaWarn"
      :ws-state="wsState"
      :session-tokens="sessionTokens"
      :session-cost-usd="sessionCostUsd"
      :reflection-count="reflectionEntries.length"
      :event-count="eventEntries.length"
      :event-submitting="eventSubmitting"
      :detail="detail"
      :dirty="dirty"
      :saving="saving"
      :zoom-level="zoomLevel"
      @load-scenes="loadScenes"
      @engine-start="onEngineStart"
      @engine-step="onEngineStep"
      @engine-stop="onEngineStop($event)"
      @timeline-pill-click="onTimelinePillClick"
      @reflection-pill-click="onReflectionPillClick"
      @event-pill-click="onEventPillClick"
      @event-preset="onEventPreset($event)"
      @event-custom-click="onEventCustomClick"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @zoom-fit="zoomFit"
      @auto-arrange="autoArrange"
      @reset-layout="resetLayout"
      @save-layout="saveLayout"
    />

    <el-empty v-if="!loading && scenes.length === 0" description="尚无启用状态的场景，请先在「场景」Tab 创建" />

    <!--
      [M4.2.1.c] 布局策略：
      - viewportWide（≥1280px）：外层横向 row，左列 sandbox-layout-left（固定 800 宽，canvas 与 aside 竖向堆叠），
        右列为 SandboxTimeline（360 宽 sticky panel）。
      - 否则（<1280px，drawer 模式）：沿用原 `flex-col lg:flex-row`，canvas + aside 并排或堆叠，
        timeline 改由顶栏 Σ 标签唤起 el-drawer（渲染在 v-else 分支外层的独立节点）。
      - 使用 `display: contents` 让 canvas + aside 的 DOM 结构在两种模式下复用同一段 template。
    -->
    <div v-else :class="viewportWide ? 'sandbox-layout-wide' : 'flex flex-col lg:flex-row gap-4'">
      <div :class="viewportWide ? 'sandbox-layout-left' : 'contents'">
      <div class="sandbox-canvas-wrap" :style="canvasWrapStyle" @click.capture="closeCtxMenu">
        <SandboxMap
          ref="mapRef"
          class="sandbox-canvas"
          :detail="detail"
          :bubble-enabled="bubbleEnabled"
          :snap-enabled="snapEnabled"
          :snap-step="snapStep"
          :find-reply-to-actor="findReplyToActor"
          :viewport-width="VIEWPORT_W"
          :viewport-height="VIEWPORT_H"
          :node-radius="NODE_R"
          @position-changed="onMapPositionChanged"
          @npc-right-click="onMapNpcRightClick"
          @zoom-change="onMapZoomChange"
        />
        <el-skeleton v-if="loading" :rows="8" animated class="sandbox-skeleton" />

        <!-- 节点右键菜单（位置相对画布容器，由 Phaser pointer 坐标给出） -->
        <div v-if="ctxMenu.visible && ctxMenu.npc" class="sandbox-ctx-menu"
          :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }" @click.stop @contextmenu.prevent>
          <div class="sandbox-ctx-menu__title">
            {{ ctxMenu.npc.npc_name || '未命名' }}
          </div>
          <button class="sandbox-ctx-menu__item" @click="openRoleDialog">
            编辑场景备注（role_note）
          </button>
          <button class="sandbox-ctx-menu__item" @click="openMetaDialog">
            编辑 simulation_meta（JSON）
          </button>
          <div class="sandbox-ctx-menu__divider" />
          <!-- [M4.2.3.c] 手动触发该 NPC 一次反思（忽略周期） -->
          <button
            class="sandbox-ctx-menu__item"
            :disabled="!ctxMenu.npc || reflectingNpcs.has(ctxMenu.npc.npc_id)"
            @click="ctxMenu.npc && (triggerManualReflect({
              npc_id: ctxMenu.npc.npc_id,
              npc_name: ctxMenu.npc.npc_name,
            }), closeCtxMenu())"
          >
            {{ ctxMenu.npc && reflectingNpcs.has(ctxMenu.npc.npc_id) ? '反思中…' : '手动触发反思' }}
          </button>
          <div class="sandbox-ctx-menu__divider" />
          <button class="sandbox-ctx-menu__item sandbox-ctx-menu__item--danger" @click="unlinkCurrentNpc">
            从本场景移除关联
          </button>
        </div>
      </div>

      <SandboxAsidePanel :active-scene="activeScene" :detail="detail" />
      </div>

      <!-- [M4.2.1.c] 右侧独立列：tick 时间线浮窗（仅宽屏 ≥1280px） -->
      <SandboxTimeline
        v-if="viewportWide"
        mode="panel"
        :entries="timelineEntries"
        :total-tokens="sessionTokens"
        :total-cost="sessionCostUsd"
        v-model:collapsed="timelinePanelCollapsed"
      />
    </div>

    <!-- [M4.2.1.c] 小屏（<1280px）用抽屉：由顶栏 Σ 标签唤起 -->
    <SandboxTimeline
      v-if="!viewportWide"
      mode="drawer"
      :entries="timelineEntries"
      :total-tokens="sessionTokens"
      :total-cost="sessionCostUsd"
      v-model:visible="timelineDrawerVisible"
    />

    <!-- [M4.2.3.c] 反思抽屉：宽屏/小屏共用，徽章或右键成功回调打开 -->
    <SandboxReflections
      :entries="reflectionEntries"
      v-model:visible="reflectionDrawerVisible"
      @clear="clearReflections"
    />

    <!-- [M4.2.4.c] 场景事件抽屉：WS / REST / POST 三路数据同进 ring buffer -->
    <SandboxEvents
      :entries="eventEntries"
      v-model:visible="eventDrawerVisible"
      @clear="clearEvents"
    />

    <!-- [M4.2.4.c] 自定义事件注入对话框 -->
    <SandboxEventInjectorDialog
      v-model:visible="eventDialogVisible"
      :scene-id="activeSceneId"
      :npc-options="detail?.npcs ?? []"
      @submit="submitCustomEvent"
    />

    <p class="text-xs text-[var(--ainpc-muted)] mt-4">
      交互：<strong>左键</strong>拖拽节点（按 <kbd>Shift</kbd> 临时吸附）/ <strong>右键</strong>节点弹出菜单 /
      <strong>滚轮</strong>缩放 / <strong>右键拖拽空白处</strong>平移；点击「保存布局」将坐标写入
      <code>scene_npc.pos_x / pos_y</code>。视口 {{ VIEWPORT_W }}×{{ VIEWPORT_H }}；当前世界 {{ worldDims.w }}×{{ worldDims.h }}。
    </p>
    <p v-if="engineStatus" class="text-xs text-[var(--ainpc-muted)] mt-1">
      引擎：{{ engineRunning ? '运行中' : '空闲' }}
      <span v-if="engineStatus.last_tick_at"> · 最近 tick {{ new Date(engineStatus.last_tick_at).toLocaleTimeString() }}</span>
      <span v-if="engineStatus.last_duration_ms != null"> · 耗时 {{ engineStatus.last_duration_ms }}ms</span>
      <span v-if="engineStatus.errors_recent"> · 错误 {{ engineStatus.errors_recent }}</span>
      <span v-if="engineStatus.config?.dry_run"> · <code>dry_run</code></span>
    </p>

    <!-- role_note 编辑对话框 -->
    <el-dialog v-model="roleDialog.visible" title="编辑场景备注" width="460px" append-to-body>
      <div class="text-xs text-[var(--ainpc-muted)] mb-2">
        仅影响本场景中该角色的标注（如「店主」「派对主办」），最多 256 字符。
      </div>
      <el-input v-model="roleDialog.text" maxlength="256" show-word-limit
        :placeholder="roleDialog.npc?.npc_name || ''" />
      <template #footer>
        <el-button @click="roleDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="roleDialog.saving" @click="saveRoleNote">保存</el-button>
      </template>
    </el-dialog>

    <!-- simulation_meta 编辑对话框 -->
    <el-dialog v-model="metaDialog.visible" title="编辑 simulation_meta (JSON)" width="620px" append-to-body>
      <div class="text-xs text-[var(--ainpc-muted)] mb-2">
        外部仿真回写字段，<strong>自由 JSON 对象</strong>。沙盒气泡优先读取
        <code>latest_say</code>、其次 <code>latest_action</code>。留空表示清除。
      </div>
      <el-input v-model="metaDialog.text" type="textarea" :rows="12" class="font-mono-nums"
        placeholder='示例: {"latest_say": "欢迎光临", "memory": ["昨天见过主人公"]}' />
      <div v-if="metaDialog.error" class="text-[var(--el-color-danger)] text-xs mt-2">
        {{ metaDialog.error }}
      </div>
      <template #footer>
        <el-button @click="metaDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="metaDialog.saving" @click="saveMeta">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.sandbox-canvas-wrap {
  position: relative;
  border: 1px solid var(--ainpc-border);
  border-radius: 8px;
  overflow: hidden;
  background: #0d1117;
  flex-shrink: 0;
}

/*
 * [M4.2.1.c] panel 模式下的两列布局
 * - 左列固定 800px（== VIEWPORT_W）与 canvas 同宽；canvas 与 aside 竖向堆叠
 * - 右列为 SandboxTimeline sticky panel（360px）
 * - 只在 viewportWide=true 时生效；drawer 模式下沿用原 flex-col/lg:flex-row
 */
.sandbox-layout-wide {
  display: flex;
  flex-direction: row;
  gap: 1rem;
  align-items: flex-start;
}
.sandbox-layout-left {
  /* 用 block 而非 flex-col：避免 aside 的 `flex-1` 在纵向主轴下被拉伸到异常高度；
     canvas 是固定尺寸浮于上，aside 走块级文档流自然铺满 800px 宽 */
  display: block;
  width: 800px;
  flex-shrink: 0;
  min-width: 0;
}
.sandbox-layout-left > .sandbox-canvas-wrap {
  margin-bottom: 1rem;
}

.sandbox-canvas {
  width: 100%;
  height: 100%;
}

.sandbox-skeleton {
  position: absolute;
  inset: 0;
  padding: 1rem;
}

.sandbox-ctx-menu {
  position: absolute;
  z-index: 30;
  min-width: 200px;
  padding: 4px;
  background: var(--ainpc-surface, #161b22);
  border: 1px solid var(--ainpc-border, #30363d);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  user-select: none;
}

.sandbox-ctx-menu__title {
  padding: 6px 10px 4px;
  font-size: 12px;
  color: var(--ainpc-muted, #8b949e);
  border-bottom: 1px dashed var(--ainpc-border, #30363d);
  margin-bottom: 4px;
}

.sandbox-ctx-menu__item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  background: transparent;
  border: none;
  color: var(--ainpc-text, #f0f6fc);
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
}

.sandbox-ctx-menu__item:hover {
  background: rgba(88, 166, 255, 0.12);
}

.sandbox-ctx-menu__item--danger {
  color: var(--el-color-danger, #e5534b);
}

.sandbox-ctx-menu__item--danger:hover {
  background: rgba(229, 83, 75, 0.12);
}

.sandbox-ctx-menu__divider {
  height: 1px;
  margin: 4px 0;
  background: var(--ainpc-border, #30363d);
}
</style>
