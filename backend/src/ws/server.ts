/**
 * WebSocket 服务
 * 鉴权：URL 携带 token；多用户隔离：按 mapId 分组
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';

/** 期望的 token（开发期可从 env 配置，正式环境应从 session/JWT 校验） */
const EXPECTED_TOKEN = process.env.WS_TOKEN || 'ainpc-dev-token';

/** 按 mapId 分组的客户端 Set */
const mapClients = new Map<string, Set<WebSocket>>();

function getOrCreateRoom(mapId: string): Set<WebSocket> {
  let set = mapClients.get(mapId);
  if (!set) {
    set = new Set();
    mapClients.set(mapId, set);
  }
  return set;
}

function leaveRoom(ws: WebSocket, mapId: string | null) {
  if (mapId) {
    const set = mapClients.get(mapId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) mapClients.delete(mapId);
    }
  }
}

/** 向某地图的所有订阅者推送 */
export function broadcastToMap(mapId: string, payload: Record<string, unknown>) {
  const set = mapClients.get(mapId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const client of set) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/** 启动 WebSocket 服务 */
export function initWsServer(httpServer: Server) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const mapId = url.searchParams.get('mapId');
    const userId = url.searchParams.get('userId') || 'anonymous';

    // 鉴权
    if (token !== EXPECTED_TOKEN) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    if (!mapId) {
      ws.close(4002, 'mapId required');
      return;
    }

    const room = getOrCreateRoom(mapId);
    room.add(ws);
    (ws as WebSocket & { mapId?: string; userId?: string }).mapId = mapId;
    (ws as WebSocket & { mapId?: string; userId?: string }).userId = userId;

    ws.send(JSON.stringify({ type: 'connected', mapId, userId }));

    ws.on('close', () => {
      const ext = ws as WebSocket & { mapId?: string };
      leaveRoom(ws, ext.mapId || null);
    });

    ws.on('error', () => {
      const ext = ws as WebSocket & { mapId?: string };
      leaveRoom(ws, ext.mapId || null);
    });
  });

  console.log('📡 WebSocket 已启动: /ws');
  return wss;
}
