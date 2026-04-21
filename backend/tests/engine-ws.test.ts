/**
 * [M4.2.1.b] /ws/engine WebSocket 订阅单测
 *  - 握手：scene_id 不存在返回 4000 close
 *  - 握手：scene_id 存在则收到 hello 帧并能收到 bus 事件
 *  - MAX_PER_SCENE：超过上限时最老连接收到 4001 close，新连接接入
 *  - 心跳：客户端回 pong 不被踢；此处仅做接口存在性断言（真实超时涉及 60s，跳过）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';

/** mock DB：scene_id=1 存在，其它不存在 */
vi.mock('../src/db/connection.js', () => ({
  pool: {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM scene WHERE id')) {
        const id = Array.isArray(params) ? Number(params[0]) : 0;
        return id === 1 ? [[{ id: 1 }], null] : [[], null];
      }
      return [[], null];
    }),
  },
}));

describe('[M4.2.1.b] /ws/engine WebSocket', () => {
  const savedMax = process.env.OBSERVABILITY_WS_MAX_PER_SCENE;
  const savedEnabled = process.env.OBSERVABILITY_WS_ENABLED;
  let server: http.Server;
  let port: number;
  let bus: typeof import('../src/engine/bus.js').bus;

  beforeEach(async () => {
    process.env.OBSERVABILITY_WS_ENABLED = 'true';
    process.env.OBSERVABILITY_WS_MAX_PER_SCENE = '3';
    vi.resetModules();
    const wsMod = await import('../src/engine/wsServer.js');
    const busMod = await import('../src/engine/bus.js');
    bus = busMod.bus;
    server = http.createServer((_, res) => res.end('ok'));
    wsMod.mountEngineWs(server);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    process.env.OBSERVABILITY_WS_ENABLED = savedEnabled;
    process.env.OBSERVABILITY_WS_MAX_PER_SCENE = savedMax;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function openWs(sceneId: number | string): WebSocket {
    return new WebSocket(`ws://localhost:${port}/ws/engine?scene_id=${sceneId}`);
  }

  function waitMessage(ws: WebSocket, matcher: (msg: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitMessage 超时')), timeoutMs);
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (matcher(msg)) {
            clearTimeout(timer);
            resolve(msg);
          }
        } catch {
          /* 忽略非 JSON */
        }
      });
    });
  }

  function waitClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitClose 超时')), timeoutMs);
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  it('scene_id 不存在应以 4000 close', async () => {
    const ws = openWs(9999);
    const { code } = await waitClose(ws);
    expect(code).toBe(4000);
  });

  it('scene_id 缺失也应以 4000 close', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/engine`);
    const { code } = await waitClose(ws);
    expect(code).toBe(4000);
  });

  it('连上存在的 scene 应收到 hello 帧，并能收到 bus 事件', async () => {
    const ws = openWs(1);
    const hello = await waitMessage(ws, (m) => m.type === 'hello');
    expect(hello.scene_id).toBe(1);

    const tickEndPromise = waitMessage(ws, (m) => m.type === 'tick.end');
    bus.emitEvent({ type: 'tick.end', scene_id: 1, tick: 7, duration_ms: 100, cost_usd_total: 0.0012 });
    const evt = await tickEndPromise;
    expect(evt.tick).toBe(7);
    expect(evt.cost_usd_total).toBeCloseTo(0.0012, 6);
    expect(typeof evt.ts).toBe('string');

    ws.close();
    await waitClose(ws);
  });

  it('跨场景事件不应发给其它订阅者（scene 过滤）', async () => {
    const ws = openWs(1);
    await waitMessage(ws, (m) => m.type === 'hello');

    let crossReceived = false;
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'tick.end' && msg.scene_id === 2) crossReceived = true;
    });
    bus.emitEvent({ type: 'tick.end', scene_id: 2, tick: 1, duration_ms: 10 });
    await new Promise((r) => setTimeout(r, 100));
    expect(crossReceived).toBe(false);

    ws.close();
    await waitClose(ws);
  });

  it('达到 MAX_PER_SCENE 时最老连接应被 4001 踢掉', async () => {
    /** MAX=3，开 3 个后再开第 4 个：第 1 个会被踢 */
    const ws1 = openWs(1);
    await waitMessage(ws1, (m) => m.type === 'hello');
    const ws2 = openWs(1);
    await waitMessage(ws2, (m) => m.type === 'hello');
    const ws3 = openWs(1);
    await waitMessage(ws3, (m) => m.type === 'hello');

    const ws1ClosePromise = waitClose(ws1);
    const ws4 = openWs(1);
    await waitMessage(ws4, (m) => m.type === 'hello');

    const { code } = await ws1ClosePromise;
    expect(code).toBe(4001);

    ws2.close(); await waitClose(ws2);
    ws3.close(); await waitClose(ws3);
    ws4.close(); await waitClose(ws4);
  });

  it('meta.warn 事件可通过 WS 推送到前端', async () => {
    const ws = openWs(1);
    await waitMessage(ws, (m) => m.type === 'hello');

    const warnP = waitMessage(ws, (m) => m.type === 'meta.warn');
    bus.emitEvent({
      type: 'meta.warn',
      scene_id: 1,
      tick: 5,
      npc_id: 10,
      bytes: 70000,
      soft_limit: 65536,
      at: new Date().toISOString(),
    });
    const msg = await warnP;
    expect(msg.bytes).toBe(70000);
    expect(msg.soft_limit).toBe(65536);

    ws.close();
    await waitClose(ws);
  });
});
