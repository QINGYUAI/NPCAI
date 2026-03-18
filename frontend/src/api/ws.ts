/**
 * WebSocket 场景状态推送
 * 地图运行时连接 WS，接收 sceneState 更新，减少轮询
 */
import type { SceneState } from '../types/map.js'

const WS_TOKEN = import.meta.env.VITE_WS_TOKEN || 'ainpc-dev-token'
const getWsBase = () => {
  const api = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api'
  return api.replace(/\/api\/?$/, '')
}

/** 连接地图场景 WebSocket，收到 sceneState 时回调；返回断开函数 */
export function connectMapScene(
  mapId: number,
  onState: (state: SceneState) => void
): () => void {
  const base = getWsBase()
  const wsUrl = `${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(WS_TOKEN)}&mapId=${mapId}`
  let ws: WebSocket | null = new WebSocket(wsUrl)

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data as string)
      if (data.type === 'sceneState' && data.npcs) {
        onState({ npcs: data.npcs, running: data.running })
      }
    } catch {
      /* 忽略解析失败 */
    }
  }

  const disconnect = () => {
    if (ws) {
      ws.close()
      ws = null
    }
  }

  ws.onclose = ws.onerror = () => {
    ws = null
  }

  return disconnect
}
