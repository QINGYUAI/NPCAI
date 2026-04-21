/**
 * [M4.2.4.b] event-intake 纯函数 + DB 工具函数单测
 *
 * 覆盖
 *   - pickEventsForNpc：5 种分支（empty / 全可见 / visible_npcs 过滤 / consumed 去重 / maxPerTick 截断）
 *   - fetchRecentSceneEvents：SQL 参数化 + normalizeRow（非对象 payload / 非数组 visible_npcs → null）
 *   - fetchConsumedSet：空输入短路 + 正常返回 `${event_id}:${npc_id}` Set
 *   - writeConsumedBatch：空输入短路 + INSERT IGNORE + 首次 consumed_tick 更新 SQL 正确
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pickEventsForNpc } from '../src/engine/event/intake.js';
import type { SceneEventRow, EventType } from '../src/engine/event/types.js';

/* -------------------------- pickEventsForNpc 分支 --------------------------- */

function mkEvent(id: number, overrides: Partial<SceneEventRow> = {}): SceneEventRow {
  return {
    id,
    scene_id: 1,
    type: 'weather' as EventType,
    actor: null,
    content: `e${id}`,
    payload: null,
    visible_npcs: null,
    created_at: new Date(`2026-04-21T00:00:${String(60 - id).padStart(2, '0')}Z`),
    consumed_tick: null,
    ...overrides,
  };
}

describe('[M4.2.4.b] pickEventsForNpc 过滤/去重/截断', () => {
  it('空事件数组 → status=empty + dropped=0', () => {
    const r = pickEventsForNpc({
      allEvents: [],
      npc_id: 10,
      consumedSet: new Set(),
      maxPerTick: 5,
    });
    expect(r.status).toBe('empty');
    expect(r.items).toEqual([]);
    expect(r.consumed_ids).toEqual([]);
    expect(r.dropped_count).toBe(0);
  });

  it('全场景可见（visible_npcs=null）→ injected + 全通过', () => {
    const events = [mkEvent(1), mkEvent(2), mkEvent(3)];
    const r = pickEventsForNpc({
      allEvents: events,
      npc_id: 10,
      consumedSet: new Set(),
      maxPerTick: 5,
    });
    expect(r.status).toBe('injected');
    expect(r.items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(r.consumed_ids).toEqual([1, 2, 3]);
    expect(r.dropped_count).toBe(0);
  });

  it('visible_npcs 不含本 NPC → 丢弃 + dropped 累加；其他可见事件正常通过', () => {
    const events = [
      mkEvent(1, { visible_npcs: [99] }),
      mkEvent(2, { visible_npcs: null }),
      mkEvent(3, { visible_npcs: [10, 11] }),
      mkEvent(4, { visible_npcs: [] }),
    ];
    const r = pickEventsForNpc({
      allEvents: events,
      npc_id: 10,
      consumedSet: new Set(),
      maxPerTick: 5,
    });
    expect(r.status).toBe('injected');
    expect(r.items.map((i) => i.id)).toEqual([2, 3]);
    expect(r.dropped_count).toBe(2);
  });

  it('consumed 命中 → 去重 + dropped 累加', () => {
    const events = [mkEvent(1), mkEvent(2), mkEvent(3)];
    const r = pickEventsForNpc({
      allEvents: events,
      npc_id: 10,
      consumedSet: new Set(['2:10']),
      maxPerTick: 5,
    });
    expect(r.items.map((i) => i.id)).toEqual([1, 3]);
    expect(r.dropped_count).toBe(1);
  });

  it('超过 maxPerTick → 保留 DESC 前 N 条，余下计 dropped', () => {
    const events = [mkEvent(1), mkEvent(2), mkEvent(3), mkEvent(4), mkEvent(5)];
    const r = pickEventsForNpc({
      allEvents: events,
      npc_id: 10,
      consumedSet: new Set(),
      maxPerTick: 2,
    });
    expect(r.items.map((i) => i.id)).toEqual([1, 2]);
    expect(r.dropped_count).toBe(3);
  });

  it('全部被过滤 → status=empty（即使输入非空）', () => {
    const events = [
      mkEvent(1, { visible_npcs: [99] }),
      mkEvent(2, { visible_npcs: [99] }),
    ];
    const r = pickEventsForNpc({
      allEvents: events,
      npc_id: 10,
      consumedSet: new Set(),
      maxPerTick: 5,
    });
    expect(r.status).toBe('empty');
    expect(r.items).toEqual([]);
    expect(r.dropped_count).toBe(2);
  });

  it('actor 非空透传到 EventBlockItem（供 buildEventBlock 输出「来自 X」）', () => {
    const events = [mkEvent(1, { actor: '小明' })];
    const r = pickEventsForNpc({
      allEvents: events,
      npc_id: 10,
      consumedSet: new Set(),
      maxPerTick: 5,
    });
    expect(r.items[0]?.actor).toBe('小明');
  });
});

/* --------------------- fetchRecentEvents.ts DB 工具函数 --------------------- */

/** 统一 hoist mock pool，供动态 import 模块消费 */
const { poolQueryMock, poolExecuteMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  poolExecuteMock: vi.fn(),
}));

vi.mock('../src/db/connection.js', () => ({
  pool: { query: poolQueryMock, execute: poolExecuteMock },
}));

beforeEach(() => {
  poolQueryMock.mockReset();
  poolExecuteMock.mockReset();
});

describe('[M4.2.4.b] fetchRecentSceneEvents SQL', () => {
  it('按 scene_id + lookbackSeconds + hardLimit 参数化查询；normalize payload/visible_npcs', async () => {
    const { fetchRecentSceneEvents } = await import('../src/engine/event/fetchRecentEvents.js');
    poolQueryMock.mockResolvedValueOnce([
      [
        {
          id: 1,
          scene_id: 1,
          type: 'weather',
          actor: null,
          content: 'rain',
          /** 非法 payload（数组）→ 应被 normalize 成 null */
          payload: [1, 2, 3],
          /** 合法 visible_npcs */
          visible_npcs: [10, 20],
          created_at: '2026-04-21',
          consumed_tick: null,
        },
        {
          id: 2,
          scene_id: 1,
          type: 'plot',
          actor: '旁白',
          content: 'x',
          payload: { k: 1 },
          visible_npcs: 'notArray',
          created_at: '2026-04-21',
          consumed_tick: 5,
        },
      ],
      null,
    ]);

    const rows = await fetchRecentSceneEvents({ scene_id: 1, lookbackSeconds: 60, hardLimit: 500 });
    expect(rows.length).toBe(2);
    expect(rows[0]?.payload).toBe(null);
    expect(rows[0]?.visible_npcs).toEqual([10, 20]);
    expect(rows[1]?.payload).toEqual({ k: 1 });
    expect(rows[1]?.visible_npcs).toBe(null);

    const sqlCall = poolQueryMock.mock.calls[0]!;
    expect(String(sqlCall[0])).toContain('FROM scene_event');
    expect(String(sqlCall[0])).toContain('INTERVAL ? SECOND');
    expect(sqlCall[1]).toEqual([1, 60, 500]);
  });

  it('hardLimit 缺省或 <=0 → 500', async () => {
    const { fetchRecentSceneEvents } = await import('../src/engine/event/fetchRecentEvents.js');
    poolQueryMock.mockResolvedValueOnce([[], null]);
    await fetchRecentSceneEvents({ scene_id: 7, lookbackSeconds: 30 });
    expect(poolQueryMock.mock.calls[0]![1]).toEqual([7, 30, 500]);
  });
});

describe('[M4.2.4.b] fetchConsumedSet', () => {
  it('event_ids 或 npc_ids 为空 → 不查 DB，返回空 Set', async () => {
    const { fetchConsumedSet } = await import('../src/engine/event/fetchRecentEvents.js');
    const s1 = await fetchConsumedSet({ event_ids: [], npc_ids: [1, 2] });
    const s2 = await fetchConsumedSet({ event_ids: [1, 2], npc_ids: [] });
    expect(s1.size).toBe(0);
    expect(s2.size).toBe(0);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('返回 `${event_id}:${npc_id}` Set', async () => {
    const { fetchConsumedSet } = await import('../src/engine/event/fetchRecentEvents.js');
    poolQueryMock.mockResolvedValueOnce([
      [
        { event_id: 1, npc_id: 10 },
        { event_id: 2, npc_id: 20 },
      ],
      null,
    ]);
    const s = await fetchConsumedSet({ event_ids: [1, 2, 3], npc_ids: [10, 20] });
    expect(s.has('1:10')).toBe(true);
    expect(s.has('2:20')).toBe(true);
    expect(s.size).toBe(2);
    const sql = String(poolQueryMock.mock.calls[0]![0]);
    expect(sql).toContain('FROM scene_event_consumed');
    expect(sql).toContain('event_id IN (?,?,?)');
    expect(sql).toContain('npc_id IN (?,?)');
  });
});

describe('[M4.2.4.b] writeConsumedBatch', () => {
  it('空输入 → 不发 SQL', async () => {
    const { writeConsumedBatch } = await import('../src/engine/event/fetchRecentEvents.js');
    await writeConsumedBatch({ pairs: [], tick: 7 });
    expect(poolExecuteMock).not.toHaveBeenCalled();
  });

  it('2 对 pairs → INSERT IGNORE + UPDATE consumed_tick 两条 SQL（去重 event_id）', async () => {
    const { writeConsumedBatch } = await import('../src/engine/event/fetchRecentEvents.js');
    poolExecuteMock.mockResolvedValue([{ affectedRows: 2 }, null]);
    await writeConsumedBatch({
      pairs: [
        { event_id: 1, npc_id: 10 },
        { event_id: 1, npc_id: 11 },
        { event_id: 2, npc_id: 10 },
      ],
      tick: 7,
    });
    expect(poolExecuteMock).toHaveBeenCalledTimes(2);
    const [insSql, insArgs] = poolExecuteMock.mock.calls[0]!;
    expect(String(insSql)).toContain('INSERT IGNORE INTO scene_event_consumed');
    expect(insArgs).toEqual([1, 10, 7, 1, 11, 7, 2, 10, 7]);

    const [updSql, updArgs] = poolExecuteMock.mock.calls[1]!;
    expect(String(updSql)).toContain('UPDATE scene_event SET consumed_tick');
    expect(String(updSql)).toContain('consumed_tick IS NULL');
    /** 首值是 tick；余下是去重后的 event_id */
    expect(updArgs).toEqual([7, 1, 2]);
  });
});
