/**
 * [M4.2.4.c] 场景事件前端类型
 *
 * 对齐关系
 * - 后端 `backend/src/engine/event/types.ts` SceneEventRow / EventType
 * - 后端 `backend/src/engine/types.ts` TickEvent 中的 `scene.event.created` 分支（WS 广播）
 * - 后端 `backend/src/controllers/sceneEvents.ts` REST 响应（POST/GET/DELETE）
 *
 * 独立于 engine.ts 以避免循环引用；EVENT_TYPE_LABELS 统一 UI 展示（emoji/color/中文）
 */

/** 后端 ENUM 严格 4 枚举（与 scene_event.type 一致） */
export const EVENT_TYPES = ['weather', 'dialogue', 'system', 'plot'] as const
export type EventType = (typeof EVENT_TYPES)[number]

/** SceneEventRow：POST/GET 响应里的完整行（含 created_at、consumed_tick） */
export interface SceneEventRow {
  id: number
  scene_id: number
  type: EventType
  /** 自由字符串；发起者名称，null=system 缺省 */
  actor: string | null
  /** 自然语言主体，1~500 字 */
  content: string
  /** 可选结构化附加；<=2KB 序列化，后端保证是 object 或 null */
  payload: Record<string, unknown> | null
  /** null=全场景可见；number[]=仅指定 NPC 可见；空数组=审计留痕但不投递 */
  visible_npcs: number[] | null
  /** ISO 或 Date；服务端写入时间 */
  created_at: string
  /** 首次被某 NPC 消费的 tick；尚未消费时为 null */
  consumed_tick: number | null
}

/** POST /api/scene/:id/events 的 body 契约（zod schema 在后端） */
export interface CreateSceneEventBody {
  type: EventType
  content: string
  /** 可选；最长 64 字；空串会被后端 trim 成 null */
  actor?: string | null
  /** 可选；<=2KB 序列化（UI 传前会本地 JSON.parse 校验） */
  payload?: Record<string, unknown> | null
  /** undefined/null = 全场景可见；数组 = 定向投递 */
  visible_npcs?: number[] | null
}

/** GET /api/scene/:id/events 响应体（data 字段） */
export interface ListSceneEventsResp {
  list: SceneEventRow[]
  limit: number
  since: number | null
}

/**
 * WS 广播 `scene.event.created`：后端 bus.emitEvent 同步触发
 * - ts: WS 包装器加的时间戳（wsServer.serializeEvent）
 * - event_id / event_type / actor / content / payload / visible_npcs 对齐 SceneEventRow
 */
export interface WsSceneEventCreatedMsg {
  ts: string
  type: 'scene.event.created'
  scene_id: number
  event_id: number
  event_type: EventType
  actor: string | null
  content: string
  payload: Record<string, unknown> | null
  visible_npcs: number[] | null
  at: string
}

/**
 * ring buffer 条目：压扁 SceneEventRow / WsSceneEventCreatedMsg 到同一个结构
 * - key=event_id，保证同一事件 WS + REST 双路到达只保留一条（去重覆盖）
 * - received_at 取 WS ts 或 row.created_at，用于排序与时间展示
 */
export interface EventRingEntry {
  key: number
  scene_id: number
  type: EventType
  actor: string | null
  content: string
  payload: Record<string, unknown> | null
  visible_npcs: number[] | null
  /** ISO 字符串；WS 优先 ts，REST 优先 created_at */
  received_at: string
  /** 兼容真实事件的 consumed_tick；仅首次查询会有；WS 新增时为 null */
  consumed_tick: number | null
}

/** type → 中文 / emoji / 高亮色；组件层统一用这份映射 */
export const EVENT_TYPE_LABELS: Record<EventType, { label: string; emoji: string; color: string }> = {
  weather:  { label: '天气',   emoji: '🌦️', color: '#38bdf8' },
  dialogue: { label: '对话',   emoji: '💬', color: '#a5d6ff' },
  system:   { label: '系统',   emoji: '⚙️', color: '#a371f7' },
  plot:     { label: '剧情',   emoji: '🎬', color: '#f59e0b' },
}

/** 2 个预设事件（顶栏快速注入按钮用） */
export const EVENT_PRESETS: Array<{
  id: string
  label: string
  emoji: string
  body: CreateSceneEventBody
}> = [
  {
    id: 'rain',
    label: '下雨',
    emoji: '🌧️',
    body: {
      type: 'weather',
      actor: 'system',
      content: '天空突然阴沉，开始下起淅淅沥沥的小雨。',
      payload: { weather: 'rain', intensity: 'light' },
      visible_npcs: null,
    },
  },
  {
    id: 'earthquake',
    label: '地震',
    emoji: '🌋',
    body: {
      type: 'plot',
      actor: 'system',
      content: '脚下传来一阵剧烈的震动，桌上的杯子碰撞作响，地震持续了十几秒。',
      payload: { plot: 'earthquake', magnitude: 5.2 },
      visible_npcs: null,
    },
  },
]
