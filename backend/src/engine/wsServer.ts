/**
 * [M4.2.1.b] WebSocket 订阅：/ws/engine?scene_id=<id>
 *
 * 设计要点
 * - 复用 express 的 http.Server（同端口），不另开端口，部署最简
 * - 每个 scene_id 维护独立订阅集合；超过 MAX_PER_SCENE 时踢掉最老一个（4001）
 * - 心跳：服务端每 30s 发 ping；60s 内没收到任何帧则 close(4002)
 * - bus 事件按 scene_id 过滤后转发；非业务 error 帧吃掉，不让前端断连
 * - 环境变量：
 *   - OBSERVABILITY_WS_ENABLED (default true) = false 时完全不挂载，GET /api/engine/status 也不返回 ws_endpoint
 *   - OBSERVABILITY_WS_MAX_PER_SCENE (default 10)
 *
 * 错误码：
 *   4000 = scene_id 参数错误 / 场景不存在
 *   4001 = 被 MAX_PER_SCENE 挤掉
 *   4002 = 心跳超时
 */
import { URL } from 'node:url';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { pool } from '../db/connection.js';
import type { RowDataPacket } from 'mysql2';
import { bus } from './bus.js';
import type { TickEvent } from './types.js';

/** 关闭码（自定义 4000-4999 段） */
export const WS_CODE_BAD_SCENE = 4000;
export const WS_CODE_KICKED = 4001;
export const WS_CODE_HEARTBEAT_TIMEOUT = 4002;

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;

/** [M4.2.1.b] WS 开关 */
export function isWsEnabled(): boolean {
  const v = (process.env.OBSERVABILITY_WS_ENABLED ?? 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no' && v !== 'off';
}

function getMaxPerScene(): number {
  const n = Number(process.env.OBSERVABILITY_WS_MAX_PER_SCENE ?? 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
}

/** 每个 socket 的运行时状态 */
interface WsState {
  scene_id: number;
  /** 最近一次收到任意帧（含 pong）的时间 */
  lastSeenAt: number;
}

/** scene_id → 订阅 socket 集合（Set 保持插入顺序，便于踢最老） */
type SceneSet = Set<WebSocket>;

const state = new WeakMap<WebSocket, WsState>();
const sceneSubscribers = new Map<number, SceneSet>();

/** 测试/运维：当前订阅者数量 */
export function getSubscriberCount(scene_id: number): number {
  return sceneSubscribers.get(scene_id)?.size ?? 0;
}

/**
 * [M4.2.1.b] 把 bus 事件序列化为 WS 下行消息，附服务端时间戳
 * - meta 字段做 summary：只保留 latest_say / latest_action / emotion 以控在 <4KB
 *
 * [M4.3.0] 所有事件都把 trace_id（可能为 null）带到前端
 *   - tick.npc.updated 分支：meta 被 summary 后丢了 trace 场景，故显式挑一下字段再带
 *   - 其他分支走默认 `{ ts, ...ev }`，因 TickEvent 已把 trace_id 放进事件本身
 */
function serializeEvent(ev: TickEvent): string {
  const ts = new Date().toISOString();
  if (ev.type === 'tick.npc.updated') {
    const m = ev.meta;
    return JSON.stringify({
      ts,
      type: ev.type,
      scene_id: ev.scene_id,
      tick: ev.tick,
      npc_id: ev.npc_id,
      npc_name: ev.npc_name,
      status: ev.status ?? 'success',
      duration_ms: ev.duration_ms,
      tokens: ev.tokens,
      cost_usd: ev.cost_usd,
      trace_id: ev.trace_id ?? null,
      meta_summary: {
        latest_say: m?.latest_say ?? null,
        latest_action: m?.latest_action ?? null,
        emotion: m?.emotion ?? null,
      },
    });
  }
  return JSON.stringify({ ts, ...ev });
}

function addSubscriber(scene_id: number, ws: WebSocket): void {
  let set = sceneSubscribers.get(scene_id);
  if (!set) {
    set = new Set<WebSocket>();
    sceneSubscribers.set(scene_id, set);
  }
  /** 达到上限：踢掉最老一个（Set 保持插入顺序，第一个迭代项即最老） */
  const max = getMaxPerScene();
  while (set.size >= max) {
    const first = set.values().next().value;
    if (!first) break;
    try {
      first.close(WS_CODE_KICKED, 'too many subscribers on scene');
    } catch {
      /* noop */
    }
    set.delete(first);
  }
  set.add(ws);
}

function removeSubscriber(ws: WebSocket): void {
  const s = state.get(ws);
  if (!s) return;
  const set = sceneSubscribers.get(s.scene_id);
  if (set) {
    set.delete(ws);
    if (set.size === 0) sceneSubscribers.delete(s.scene_id);
  }
  state.delete(ws);
}

/** [M4.2.1.b] 从 ?scene_id= 解析；>0 整数有效 */
function parseSceneId(req: IncomingMessage): number {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const raw = url.searchParams.get('scene_id');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : NaN;
  } catch {
    return NaN;
  }
}

async function sceneExists(scene_id: number): Promise<boolean> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM scene WHERE id = ? LIMIT 1', [
      scene_id,
    ]);
    return (rows as unknown[]).length > 0;
  } catch (e) {
    console.warn('[wsServer] sceneExists 查询异常:', (e as Error).message);
    return false;
  }
}

/**
 * [M4.2.1.b] 挂载 /ws/engine 到已存在的 http.Server
 * - 未启用时返回 null，不挂载
 * - 启用时绑定 bus 单一监听器，进程级只会被 mount 一次
 */
let mounted = false;
export function mountEngineWs(server: HttpServer): WebSocketServer | null {
  if (!isWsEnabled()) {
    console.log('[wsServer] OBSERVABILITY_WS_ENABLED=false，跳过挂载');
    return null;
  }
  if (mounted) {
    console.warn('[wsServer] mountEngineWs 已挂载过，忽略重复调用');
    return null;
  }
  mounted = true;

  const wss = new WebSocketServer({ server, path: '/ws/engine' });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const scene_id = parseSceneId(req);
    if (!Number.isFinite(scene_id)) {
      ws.close(WS_CODE_BAD_SCENE, 'scene_id required');
      return;
    }
    if (!(await sceneExists(scene_id))) {
      ws.close(WS_CODE_BAD_SCENE, `scene ${scene_id} not found`);
      return;
    }

    addSubscriber(scene_id, ws);
    state.set(ws, { scene_id, lastSeenAt: Date.now() });

    /** 连接确认帧 */
    try {
      ws.send(JSON.stringify({ ts: new Date().toISOString(), type: 'hello', scene_id }));
    } catch {
      /* noop */
    }

    ws.on('message', (raw) => {
      const s = state.get(ws);
      if (s) s.lastSeenAt = Date.now();
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'pong') return;
        if (msg?.type === 'ping') {
          try {
            ws.send(JSON.stringify({ ts: new Date().toISOString(), type: 'pong' }));
          } catch {
            /* noop */
          }
        }
      } catch {
        /* 非 JSON 帧忽略 */
      }
    });

    ws.on('pong', () => {
      const s = state.get(ws);
      if (s) s.lastSeenAt = Date.now();
    });

    ws.on('close', () => removeSubscriber(ws));
    ws.on('error', () => removeSubscriber(ws));
  });

  /** 心跳：每 HEARTBEAT_INTERVAL_MS 发 ping；超时 close(4002) */
  const hbTimer = setInterval(() => {
    const now = Date.now();
    for (const set of sceneSubscribers.values()) {
      for (const ws of set) {
        const s = state.get(ws);
        if (!s) continue;
        if (now - s.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
          try {
            ws.close(WS_CODE_HEARTBEAT_TIMEOUT, 'heartbeat timeout');
          } catch {
            /* noop */
          }
          continue;
        }
        if (ws.readyState === ws.OPEN) {
          try {
            ws.ping();
            ws.send(JSON.stringify({ ts: new Date().toISOString(), type: 'ping' }));
          } catch {
            /* noop */
          }
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  hbTimer.unref?.();

  /** 订阅 bus：按 scene_id 过滤后广播 */
  const onTick = (ev: TickEvent) => {
    const set = sceneSubscribers.get(ev.scene_id);
    if (!set || set.size === 0) return;
    const payload = serializeEvent(ev);
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(payload);
        } catch {
          /* 单连接发送失败不影响其他 */
        }
      }
    }
  };
  bus.on('tick', onTick);

  console.log('[wsServer] /ws/engine 已挂载，MAX_PER_SCENE =', getMaxPerScene());
  return wss;
}
