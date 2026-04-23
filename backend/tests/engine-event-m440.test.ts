/**
 * [M4.4.0] 对话链窗口治理单测
 *
 * 覆盖模块
 *   - engine/event/config.ts：EVENT_LOOKBACK_COUNT 解析（新增）
 *   - engine/event/fetchRecentEvents.ts：混合窗口 SQL（纯 / count=0 走单分支 / count>0 走 UNION）
 *   - engine/dialogue/echo.ts：isEchoBlocked 按 tick 差精确判窗口（L-4 修复）
 *   - engine/event/intake.ts：currentTick/echoWindowTick 下传
 *   - engine/dialogue/emit.ts：current_tick → scene_event.created_tick + WS 字段
 *
 * 断言侧重点
 *   - lookbackCount=0 退化为 M4.3 单分支 SQL；>0 走 UNION + hardLimit 参数正确
 *   - 候选 created_tick 超窗口 → 放行，链再怎么交替也不拦（L-4 修复）
 *   - 候选在窗口内 + 链交替 → 继续按 M4.3.1.b 路径拦截（回归不失）
 *   - emit 把 current_tick 写到 SQL 参数与 WS 广播 payload
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const poolQueryMock = vi.fn();
  const poolExecuteMock = vi.fn();
  const busEmitMock = vi.fn();
  return { poolQueryMock, poolExecuteMock, busEmitMock };
});

vi.mock('../src/db/connection.js', () => ({
  pool: {
    query: mocks.poolQueryMock,
    execute: mocks.poolExecuteMock,
  },
}));

vi.mock('../src/engine/bus.js', () => ({
  bus: { emitEvent: mocks.busEmitMock, emit: mocks.busEmitMock },
}));

const ORIG_ENV = { ...process.env };
beforeEach(() => {
  mocks.poolQueryMock.mockReset();
  mocks.poolExecuteMock.mockReset();
  mocks.busEmitMock.mockReset();
});
afterEach(() => {
  process.env = { ...ORIG_ENV };
});

/* ---------------------- config.ts EVENT_LOOKBACK_COUNT ---------------------- */

describe('[M4.4.0] EVENT_LOOKBACK_COUNT env 解析', () => {
  it('未设置 → 默认值 50（允许 0 但 env 不给则取默认）', async () => {
    delete process.env.EVENT_LOOKBACK_COUNT;
    const { getEventConfig, resetEventConfig } = await import('../src/engine/event/config.js');
    resetEventConfig();
    expect(getEventConfig().lookbackCount).toBe(50);
  });

  it('EVENT_LOOKBACK_COUNT=0 合法（表示关闭条数窗，回 M4.3 纯时间窗）', async () => {
    process.env.EVENT_LOOKBACK_COUNT = '0';
    const { getEventConfig, resetEventConfig } = await import('../src/engine/event/config.js');
    resetEventConfig();
    expect(getEventConfig().lookbackCount).toBe(0);
  });

  it('EVENT_LOOKBACK_COUNT=-1 抛错（非负）', async () => {
    process.env.EVENT_LOOKBACK_COUNT = '-1';
    const { getEventConfig, resetEventConfig } = await import('../src/engine/event/config.js');
    resetEventConfig();
    expect(() => getEventConfig()).toThrow(/EVENT_LOOKBACK_COUNT.*非负/);
  });
});

/* ---------------------- fetchRecentEvents 混合窗口 SQL ---------------------- */

describe('[M4.4.0] fetchRecentSceneEvents 混合窗口', () => {
  it('lookbackCount=0 → 走单分支 SELECT（无 UNION），参数=[scene_id, seconds, hardLimit]', async () => {
    mocks.poolQueryMock.mockResolvedValueOnce([[], []]);
    const { fetchRecentSceneEvents } = await import('../src/engine/event/fetchRecentEvents.js');
    await fetchRecentSceneEvents({
      scene_id: 7,
      lookbackSeconds: 60,
      lookbackCount: 0,
      hardLimit: 200,
    });
    expect(mocks.poolQueryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/UNION/);
    expect(sql).toMatch(/FROM scene_event/);
    expect(params).toEqual([7, 60, 200]);
  });

  it('lookbackCount>0 → 走 UNION DISTINCT，两侧 scene_id + 外层 hardLimit', async () => {
    mocks.poolQueryMock.mockResolvedValueOnce([[], []]);
    const { fetchRecentSceneEvents } = await import('../src/engine/event/fetchRecentEvents.js');
    await fetchRecentSceneEvents({
      scene_id: 9,
      lookbackSeconds: 120,
      lookbackCount: 50,
      hardLimit: 500,
    });
    expect(mocks.poolQueryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UNION DISTINCT/);
    /** 两侧子查询都查 scene_event 且各带 ORDER BY id DESC LIMIT */
    expect(sql).toMatch(/ORDER BY id DESC/);
    /** 参数顺序：scene_id, seconds, hardLimit, scene_id, lookbackCount, hardLimit */
    expect(params).toEqual([9, 120, 500, 9, 50, 500]);
  });

  it('SELECT 字段包含 created_tick（M4.4.0 新扩列）', async () => {
    mocks.poolQueryMock.mockResolvedValueOnce([[], []]);
    const { fetchRecentSceneEvents } = await import('../src/engine/event/fetchRecentEvents.js');
    await fetchRecentSceneEvents({
      scene_id: 1,
      lookbackSeconds: 60,
      lookbackCount: 10,
    });
    const [sql] = mocks.poolQueryMock.mock.calls[0] as [string];
    expect(sql).toMatch(/created_tick/);
  });
});

/* ---------------------- echo.ts tick 窗口精判（L-4 修复） ---------------------- */

describe('[M4.4.0] isEchoBlocked 按 tick 差窗口', () => {
  it('candidate.created_tick 超出 currentTick-windowTick → 放行（即便 3 层交替）', async () => {
    const { isEchoBlocked } = await import('../src/engine/dialogue/echo.js');
    /** 构造严格 A,B,A,B 4 层交替（理应拦），但 candidate 产生于 tick=80，currentTick=100，windowTick=10 → 差=20 超窗口 */
    const byId = new Map<number, import('../src/engine/dialogue/echo.js').EchoChainNode>([
      [1, { id: 1, type: 'dialogue', actor: 'A', parent_event_id: null, conv_turn: 1, created_tick: 78 }],
      [2, { id: 2, type: 'dialogue', actor: 'B', parent_event_id: 1, conv_turn: 2, created_tick: 79 }],
      [3, { id: 3, type: 'dialogue', actor: 'A', parent_event_id: 2, conv_turn: 3, created_tick: 79 }],
      [4, { id: 4, type: 'dialogue', actor: 'B', parent_event_id: 3, conv_turn: 4, created_tick: 80 }],
    ]);
    const candidate = byId.get(4)!;
    expect(
      isEchoBlocked({
        candidate,
        byId,
        echoMaxTurn: 3,
        currentTick: 100,
        windowTick: 10,
      }),
    ).toBe(false);
  });

  it('candidate.created_tick 在窗口内 + 链严格交替 → 照常拦（回归 M4.3.1.b）', async () => {
    const { isEchoBlocked } = await import('../src/engine/dialogue/echo.js');
    const byId = new Map<number, import('../src/engine/dialogue/echo.js').EchoChainNode>([
      [1, { id: 1, type: 'dialogue', actor: 'A', parent_event_id: null, conv_turn: 1, created_tick: 95 }],
      [2, { id: 2, type: 'dialogue', actor: 'B', parent_event_id: 1, conv_turn: 2, created_tick: 96 }],
      [3, { id: 3, type: 'dialogue', actor: 'A', parent_event_id: 2, conv_turn: 3, created_tick: 97 }],
      [4, { id: 4, type: 'dialogue', actor: 'B', parent_event_id: 3, conv_turn: 4, created_tick: 98 }],
    ]);
    const candidate = byId.get(4)!;
    expect(
      isEchoBlocked({
        candidate,
        byId,
        echoMaxTurn: 3,
        currentTick: 100,
        windowTick: 10,
      }),
    ).toBe(true);
  });

  it('currentTick 或 windowTick 缺失 → 退回 M4.3 语义（不依赖 tick 差，仅靠 conv_turn + 链交替）', async () => {
    const { isEchoBlocked } = await import('../src/engine/dialogue/echo.js');
    /** 同窗内样本但不传 currentTick：应仍按 M4.3.1.b 拦 */
    const byId = new Map<number, import('../src/engine/dialogue/echo.js').EchoChainNode>([
      [1, { id: 1, type: 'dialogue', actor: 'A', parent_event_id: null, conv_turn: 1 }],
      [2, { id: 2, type: 'dialogue', actor: 'B', parent_event_id: 1, conv_turn: 2 }],
      [3, { id: 3, type: 'dialogue', actor: 'A', parent_event_id: 2, conv_turn: 3 }],
      [4, { id: 4, type: 'dialogue', actor: 'B', parent_event_id: 3, conv_turn: 4 }],
    ]);
    expect(
      isEchoBlocked({ candidate: byId.get(4)!, byId, echoMaxTurn: 3 }),
    ).toBe(true);
  });
});

/* ------------------------- intake.ts 下传 tick 参数 ------------------------- */

describe('[M4.4.0] pickEventsForNpc 下传 currentTick / echoWindowTick', () => {
  it('candidate 超 echoWindowTick 窗口 → 不拦，进入 items', async () => {
    const { pickEventsForNpc } = await import('../src/engine/event/intake.js');
    /** 构造 4 层 A,B,A,B 链，candidate=4 created_tick=80，currentTick=100，windowTick=10 → 超窗口放行 */
    const allEvents = [
      { id: 4, scene_id: 1, type: 'dialogue' as const, actor: 'B', content: 't4', payload: null, visible_npcs: null, created_at: new Date(), consumed_tick: null, trace_id: null, parent_event_id: 3, conv_turn: 4, created_tick: 80 },
      { id: 3, scene_id: 1, type: 'dialogue' as const, actor: 'A', content: 't3', payload: null, visible_npcs: null, created_at: new Date(), consumed_tick: null, trace_id: null, parent_event_id: 2, conv_turn: 3, created_tick: 79 },
      { id: 2, scene_id: 1, type: 'dialogue' as const, actor: 'B', content: 't2', payload: null, visible_npcs: null, created_at: new Date(), consumed_tick: null, trace_id: null, parent_event_id: 1, conv_turn: 2, created_tick: 78 },
      { id: 1, scene_id: 1, type: 'dialogue' as const, actor: 'A', content: 't1', payload: null, visible_npcs: null, created_at: new Date(), consumed_tick: null, trace_id: null, parent_event_id: null, conv_turn: 1, created_tick: 77 },
    ];
    const r = pickEventsForNpc({
      allEvents,
      npc_id: 10,
      /** self_actor_name 故意设为 'C'，不过滤任何自播 */
      self_actor_name: 'C',
      consumedSet: new Set(),
      maxPerTick: 10,
      echoMaxTurn: 3,
      currentTick: 100,
      echoWindowTick: 10,
    });
    expect(r.status).toBe('injected');
    /** id=4 应仍在 items 里（未因 echo 被拦；tick 差=20 超窗口） */
    expect(r.items.map((i) => i.id)).toContain(4);
    /** items 需透传 created_tick */
    const item4 = r.items.find((i) => i.id === 4);
    expect(item4?.created_tick).toBe(80);
  });
});

/* ---------------------- emit.ts current_tick 写入 ---------------------- */

describe('[M4.4.0] emitDialogueFromSay 写 created_tick + WS', () => {
  it('current_tick=5 → SQL 参数末位为 5；bus 广播 payload.created_tick=5', async () => {
    /** insertId → 回读 created_at */
    mocks.poolExecuteMock.mockResolvedValueOnce([{ insertId: 777 }, []]);
    mocks.poolQueryMock.mockResolvedValueOnce([[{ created_at: '2026-04-21T00:00:00.000Z' }], []]);
    const { emitDialogueFromSay } = await import('../src/engine/dialogue/emit.js');
    const r = await emitDialogueFromSay({
      scene_id: 3,
      actor: 'A',
      content: '回应一下',
      eventItems: null,
      trace_id: null,
      current_tick: 5,
    });
    expect(r?.event_id).toBe(777);
    expect(mocks.poolExecuteMock).toHaveBeenCalledTimes(1);
    const [, params] = mocks.poolExecuteMock.mock.calls[0] as [string, unknown[]];
    /** 10 参数：末位 = current_tick = 5 */
    expect(params).toHaveLength(10);
    expect(params[9]).toBe(5);

    /** WS 广播 payload 含 created_tick */
    expect(mocks.busEmitMock).toHaveBeenCalledTimes(1);
    const [ev] = mocks.busEmitMock.mock.calls[0] as [Record<string, unknown>];
    expect(ev.type).toBe('scene.event.created');
    expect(ev.created_tick).toBe(5);
  });
});
