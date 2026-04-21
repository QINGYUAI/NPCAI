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
 * [M4.2.1.b] 把 http(s)://host:port/api 反推成 ws(s)://host:port，拼接 ws_endpoint
 * - VITE_API_BASE 形如 "http://localhost:3000/api"
 * - 支持自定义覆盖 VITE_WS_BASE（如反向代理场景）
 */
function resolveWsUrl(endpoint: string, sceneId: number): string {
  const override = (import.meta.env.VITE_WS_BASE as string | undefined)?.trim()
  if (override) {
    return `${override.replace(/\/$/, '')}${endpoint}?scene_id=${sceneId}`
  }
  const base = (import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:3000/api'
  try {
    const u = new URL(base)
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${u.host}${endpoint}?scene_id=${sceneId}`
  } catch {
    const loc = typeof window !== 'undefined' ? window.location : { protocol: 'http:', host: 'localhost:3000' }
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${loc.host}${endpoint}?scene_id=${sceneId}`
  }
}

export interface EngineWsHandlers {
  onTickStart?: (e: WsTickStartMsg) => void
  onNpcUpdated?: (e: WsTickNpcUpdatedMsg) => void
  onTickEnd?: (e: WsTickEndMsg) => void
  onError?: (e: WsErrorMsg) => void
  onMetaWarn?: (e: WsMetaWarnMsg) => void
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
