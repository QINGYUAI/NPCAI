/**
 * 引擎 API：/api/engine/* + /ws/engine
 */
import { api } from './client.js'
import type { ApiResponse } from './client.js'
import type {
  EngineStatus,
  StartEngineParams,
  TickLogRow,
  WsConnectionState,
  WsEngineMsg,
  WsMetaWarnMsg,
  WsTickEndMsg,
  WsTickNpcUpdatedMsg,
  WsTickStartMsg,
  WsErrorMsg,
} from '../types/engine.js'
import type { ReflectApiResp, WsReflectionCreatedMsg } from '../types/reflection.js'
import type {
  CreateSceneEventBody,
  ListSceneEventsResp,
  SceneEventRow,
  WsSceneEventCreatedMsg,
} from '../types/event.js'

export function startEngine(params: StartEngineParams) {
  return api.post<ApiResponse<EngineStatus>>('/engine/start', params)
}

export function stopEngine(scene_id: number, force = false) {
  return api.post<ApiResponse<EngineStatus>>('/engine/stop', { scene_id, force })
}

export function stepEngine(scene_id: number, dry_run = true) {
  return api.post<ApiResponse<EngineStatus>>('/engine/step', { scene_id, dry_run })
}

export function getEngineStatus(scene_id: number) {
  return api.get<ApiResponse<EngineStatus>>('/engine/status', { params: { scene_id } })
}

export function getEngineTicks(params: {
  scene_id: number
  after?: number
  limit?: number
  order?: 'asc' | 'desc'
}) {
  return api.get<ApiResponse<TickLogRow[]>>('/engine/ticks', { params })
}

/**
 * [M4.2.3.c] POST /api/engine/reflect
 * 手动触发某 NPC 的一次反思（同步返回；会阻塞 25~40s 等 LLM）
 * - 成功（status=generated）会额外通过 WS 推 reflection.created 给 Sandbox 徽章 +1
 * - status=failed / skipped 时 HTTP 仍为 200，看 data.status 区分
 */
export function reflectOnce(params: { scene_id: number; npc_id: number }) {
  return api.post<ApiResponse<ReflectApiResp>>('/engine/reflect', params)
}

/**
 * [M4.2.4.c] POST /api/scene/:id/events —— 注入一条场景事件
 * - 后端同步写库 + WS 广播 scene.event.created；返回完整 SceneEventRow
 * - 单客户端 caller：响应 body 可直接入 ring buffer（无需等 WS 回环）
 */
export function createSceneEvent(scene_id: number, body: CreateSceneEventBody) {
  return api.post<ApiResponse<SceneEventRow>>(`/scene/${scene_id}/events`, body)
}

/**
 * [M4.2.4.c] GET /api/scene/:id/events —— 查询最近事件（首屏/重连补发）
 * - limit 默认 50，上限 200；since 用于增量同步（id > since）
 */
export function listSceneEvents(
  scene_id: number,
  params?: { limit?: number; since?: number },
) {
  return api.get<ApiResponse<ListSceneEventsResp>>(`/scene/${scene_id}/events`, { params })
}

/**
 * [M4.2.4.c] DELETE /api/scene/:id/events/:eid —— 手动删除一条事件
 * - 当前版本 UI 不暴露该入口，保留 API 供后续右键菜单或工具面板使用
 */
export function deleteSceneEvent(scene_id: number, event_id: number) {
  return api.delete<ApiResponse<{ id: number }>>(`/scene/${scene_id}/events/${event_id}`)
}

/**
 * [M4.2.1.b] 生成 ws_endpoint 绝对 URL（方案 D：同源优先）
 *
 * 决策顺序：
 *   1) VITE_WS_BASE 显式覆盖（反向代理 / 不同 host） → 直接拼
 *   2) VITE_API_BASE 是完整 URL（http/https）→ 反推 host 作为 ws host
 *   3) 其余情况（空 / '/api' 等相对路径）→ 走 window.location.host（同源，经 Vite proxy `ws: true`）
 *     · 这让手机 / 局域网 / Tailscale 用 http://<ip>:5173 打开也能建立 WS，无需额外配置
 */
function resolveWsUrl(endpoint: string, sceneId: number): string {
  const override = (import.meta.env.VITE_WS_BASE as string | undefined)?.trim()
  if (override) {
    return `${override.replace(/\/$/, '')}${endpoint}?scene_id=${sceneId}`
  }
  const base = ((import.meta.env.VITE_API_BASE as string | undefined) || '').trim()
  if (/^https?:\/\//i.test(base)) {
    try {
      const u = new URL(base)
      const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${proto}//${u.host}${endpoint}?scene_id=${sceneId}`
    } catch {
      /** fallthrough 到同源策略 */
    }
  }
  const loc =
    typeof window !== 'undefined'
      ? window.location
      : { protocol: 'http:', host: 'localhost:5173' }
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${loc.host}${endpoint}?scene_id=${sceneId}`
}

export interface EngineWsHandlers {
  onTickStart?: (e: WsTickStartMsg) => void
  onNpcUpdated?: (e: WsTickNpcUpdatedMsg) => void
  onTickEnd?: (e: WsTickEndMsg) => void
  onError?: (e: WsErrorMsg) => void
  onMetaWarn?: (e: WsMetaWarnMsg) => void
  /** [M4.2.3.c] 反思生成事件；仅 status='generated' 时后端会推 */
  onReflection?: (e: WsReflectionCreatedMsg) => void
  /** [M4.2.4.c] 场景事件创建广播；POST /api/scene/:id/events 成功后同步触发 */
  onSceneEvent?: (e: WsSceneEventCreatedMsg) => void
  onConnectionChange?: (state: WsConnectionState) => void
}

const WS_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000]
const WS_MAX_RETRY = WS_BACKOFF_MS.length
/** 若 WS_IDLE_TIMEOUT_MS 内没收到任何帧，主动 close 触发重连（服务端 30s 推一次 ping） */
const WS_IDLE_TIMEOUT_MS = 45_000

/**
 * [M4.2.1.b] 打开 /ws/engine 订阅
 * - 自动重连（指数退避），连续失败 WS_MAX_RETRY 次后回调 'degraded'，调用方切回 HTTP 轮询
 * - 心跳：收到服务端 ping 回 pong；WS_IDLE_TIMEOUT_MS 内无帧则主动重连
 * - 返回 close() 关闭并停止重连
 */
export function openEngineWs(
  endpoint: string,
  sceneId: number,
  handlers: EngineWsHandlers,
): () => void {
  let ws: WebSocket | null = null
  let retryIndex = 0
  let closedByUser = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const emitState = (s: WsConnectionState) => {
    try { handlers.onConnectionChange?.(s) } catch { /* noop */ }
  }

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      /** 超时主动 close → 进入 onclose 流程 → 重连 */
      try { ws?.close() } catch { /* noop */ }
    }, WS_IDLE_TIMEOUT_MS)
  }

  const scheduleReconnect = () => {
    if (closedByUser) return
    if (retryIndex >= WS_MAX_RETRY) {
      emitState('degraded')
      return
    }
    const delay = WS_BACKOFF_MS[retryIndex] ?? WS_BACKOFF_MS[WS_BACKOFF_MS.length - 1]!
    retryIndex += 1
    reconnectTimer = setTimeout(() => connect(), delay)
  }

  const connect = () => {
    if (closedByUser) return
    emitState('connecting')
    try {
      ws = new WebSocket(resolveWsUrl(endpoint, sceneId))
    } catch (e) {
      console.warn('[engineWs] 创建 WebSocket 失败:', e)
      scheduleReconnect()
      return
    }

    ws.addEventListener('open', () => {
      retryIndex = 0
      emitState('open')
      resetIdleTimer()
    })

    ws.addEventListener('message', (ev) => {
      resetIdleTimer()
      let msg: WsEngineMsg
      try {
        msg = JSON.parse(ev.data) as WsEngineMsg
      } catch {
        return
      }
      switch (msg.type) {
        case 'ping':
          try { ws?.send(JSON.stringify({ type: 'pong' })) } catch { /* noop */ }
          return
        case 'hello':
        case 'pong':
          return
        case 'tick.start': handlers.onTickStart?.(msg); return
        case 'tick.npc.updated': handlers.onNpcUpdated?.(msg); return
        case 'tick.end': handlers.onTickEnd?.(msg); return
        case 'error': handlers.onError?.(msg); return
        case 'meta.warn': handlers.onMetaWarn?.(msg); return
        case 'reflection.created': handlers.onReflection?.(msg); return
        case 'scene.event.created': handlers.onSceneEvent?.(msg); return
        default: return
      }
    })

    ws.addEventListener('close', () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
      if (closedByUser) { emitState('closed'); return }
      emitState('closed')
      scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      /** 错误总是紧跟 close 事件；留给 close 处理重连 */
    })
  }

  connect()

  return () => {
    closedByUser = true
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    try { ws?.close() } catch { /* noop */ }
  }
}
