/**
 * [M4.2.3.c] 反思相关前端类型
 *
 * 与后端 src/engine/reflection/types.ts + engine/types.ts 的 `reflection.created` TickEvent 对齐。
 * 独立于 engine.ts 避免循环 + 便于未来扩展手动 API 返回类型。
 */

/** 反思固定 3 种主题；顺序约定用于 UI 排序 */
export const REFLECTION_THEMES = ['goal', 'emotion', 'relation'] as const
export type ReflectionTheme = (typeof REFLECTION_THEMES)[number]

/** 单条反思条目（与后端 ReflectionItem 一致） */
export interface ReflectionItem {
  theme: ReflectionTheme
  content: string
}

/** WS 事件：服务端在 `status==='generated'` 时推送（本 session ring buffer 唯一数据源） */
export interface WsReflectionCreatedMsg {
  ts: string
  type: 'reflection.created'
  scene_id: number
  tick: number
  npc_id: number
  npc_name?: string
  items: ReflectionItem[]
  reflection_ids: number[]
  source_memory_ids: number[]
  at: string
}

/** POST /api/engine/reflect 响应体（data 字段） */
export interface ReflectApiResp {
  scene_id: number
  npc_id: number
  npc_name: string
  tick: number
  status: 'generated' | 'skipped' | 'failed'
  items: ReflectionItem[]
  reflection_ids: number[]
  source_memory_ids: number[]
}

/** Sandbox ring buffer 内部表达：压扁 WS 消息 + 服务端/客户端时间，便于去重 */
export interface ReflectionRingEntry {
  /** 取 reflection_ids[0] 作为事件 key（同一次反思 3 条共享） */
  key: number
  scene_id: number
  npc_id: number
  npc_name: string
  tick: number
  items: ReflectionItem[]
  reflection_ids: number[]
  source_memory_ids: number[]
  /** WS 推送时刻（ts 优先，fallback at） */
  received_at: string
}

/** theme → 中文标签 + emoji；组件层统一用这份映射 */
export const THEME_LABELS: Record<ReflectionTheme, { label: string; emoji: string; color: string }> = {
  goal: { label: '目标', emoji: '🎯', color: '#f59e0b' },
  emotion: { label: '情绪', emoji: '💭', color: '#ec4899' },
  relation: { label: '关系', emoji: '🤝', color: '#3b82f6' },
}
