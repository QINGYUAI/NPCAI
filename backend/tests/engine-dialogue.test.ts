/**
 * [M4.3.1.a] dialogue 自动化单测（10 条）
 *
 * 覆盖矩阵
 *   truncate 与 pickDialogueParent（纯函数，4 条）
 *     1. truncate：<=max 原样返回
 *     2. pickDialogueParent：空 items → { null, 1 }
 *     3. pickDialogueParent：只有 self dialogue → { null, 1 }（V2=b 自播也要被忽略为 parent）
 *     4. pickDialogueParent：多条 other 候选时取 conv_turn 最大（并列取 id 最大）
 *
 *   emitDialogueFromSay（mock pool + bus + config，4 条）
 *     5. DIALOGUE_AUTO_EVENT_ENABLED=false → 直接返回 null，不 INSERT
 *     6. enabled=true 成功写 scene_event：SQL 9 参数且末三位是 trace_id/parent/conv_turn
 *     7. enabled=true 成功后 bus.emitEvent('scene.event.created') 带 trace_id
 *     8. content 超 contentMaxLen 被截断并加 …
 *
 *   intake.pickEventsForNpc 自播过滤（2 条）
 *     9. self_actor_name 命中：同名 dialogue 被丢，dropped_count 增
 *    10. self_actor_name 仅对 dialogue 生效：同名 system/plot 正常放行
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBlockItem, SceneEventRow } from '../src/engine/event/types.js';

/** 全文件共享 pool / bus mock；dialogue.config 用 resetDialogueConfig 控制 */
const { executeMock, queryMock, busEmitMock } = vi.hoisted(() => ({
  executeMock: vi.fn(async () => [{ insertId: 501, affectedRows: 1 }, null]),
  queryMock: vi.fn(async () => [[{ created_at: new Date('2026-04-23T03:00:00Z') }], null]),
  busEmitMock: vi.fn(),
}));

vi.mock('../src/db/connection.js', () => ({
  pool: { execute: executeMock, query: queryMock },
}));
vi.mock('../src/engine/bus.js', () => ({ bus: { emitEvent: busEmitMock } }));

/* ------------------------------- 纯函数 -------------------------------- */

describe('[M4.3.1.a] pickDialogueParent 纯函数', () => {
  it('用例2：空/undefined items → parent=null, conv_turn=1（会话起点）', async () => {
    const { pickDialogueParent } = await import('../src/engine/dialogue/emit.js');
    expect(pickDialogueParent(null, '小明')).toEqual({ parent_event_id: null, conv_turn: 1 });
    expect(pickDialogueParent([], '小明')).toEqual({ parent_event_id: null, conv_turn: 1 });
    expect(pickDialogueParent(undefined, '小明')).toEqual({ parent_event_id: null, conv_turn: 1 });
  });

  it('用例3：只有 self dialogue（V2=b 自播）不应作为 parent → { null, 1 }', async () => {
    const { pickDialogueParent } = await import('../src/engine/dialogue/emit.js');
    const items: EventBlockItem[] = [
      {
        id: 10,
        type: 'dialogue',
        content: '我自己的话',
        actor: '小明',
        created_at: new Date(),
        conv_turn: 2,
        parent_event_id: null,
      },
    ];
    expect(pickDialogueParent(items, '小明')).toEqual({ parent_event_id: null, conv_turn: 1 });
  });

  it('用例4：多条 other 候选时取 conv_turn 最大；并列时 id 最大', async () => {
    const { pickDialogueParent } = await import('../src/engine/dialogue/emit.js');
    const items: EventBlockItem[] = [
      { id: 30, type: 'dialogue', content: 'a', actor: '小美', created_at: new Date(), conv_turn: 2, parent_event_id: null },
      { id: 31, type: 'dialogue', content: 'b', actor: '小美', created_at: new Date(), conv_turn: 3, parent_event_id: 30 },
      { id: 32, type: 'dialogue', content: 'c', actor: '小美', created_at: new Date(), conv_turn: 3, parent_event_id: 30 },
      { id: 25, type: 'dialogue', content: '自己的', actor: '小明', created_at: new Date(), conv_turn: 5, parent_event_id: null },
      { id: 20, type: 'system', content: 'sys', actor: 'system', created_at: new Date(), conv_turn: null, parent_event_id: null },
    ];
    /** 应该挑 id=32（conv_turn=3 并列但 id 更大），conv_turn=3+1=4 */
    expect(pickDialogueParent(items, '小明')).toEqual({ parent_event_id: 32, conv_turn: 4 });
  });
});

describe('[M4.3.1.a] truncate 逻辑通过 emit 验证', () => {
  beforeEach(async () => {
    executeMock.mockClear();
    queryMock.mockClear();
    busEmitMock.mockClear();
    const { resetDialogueConfig } = await import('../src/engine/dialogue/config.js');
    resetDialogueConfig();
    process.env.DIALOGUE_AUTO_EVENT_ENABLED = 'true';
    process.env.DIALOGUE_CONTENT_MAX_LEN = '5';
  });

  it('用例1：content 长度 == contentMaxLen=5 时原样入库，不加 …', async () => {
    const { emitDialogueFromSay } = await import('../src/engine/dialogue/emit.js');
    const r = await emitDialogueFromSay({
      scene_id: 1,
      actor: '小明',
      content: 'hello',
      eventItems: null,
      trace_id: null,
    });
    expect(r).not.toBeNull();
    expect(r!.content).toBe('hello');
    const [, params] = executeMock.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe('hello');
  });

  it('用例8：content 超 contentMaxLen=5 → 截断加 …，入 SQL 长度严格等于 max', async () => {
    const { emitDialogueFromSay } = await import('../src/engine/dialogue/emit.js');
    const r = await emitDialogueFromSay({
      scene_id: 1,
      actor: '小明',
      content: 'hello world 很长一段话',
      eventItems: null,
      trace_id: null,
    });
    expect(r).not.toBeNull();
    expect(r!.content).toBe('hell…');
    expect(r!.content.length).toBe(5);
    /** INSERT 参数 index=3 是 content */
    const [, params] = executeMock.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe('hell…');
  });
});

/* ------------------------------ emitDialogueFromSay -------------------------------- */

describe('[M4.3.1.a] emitDialogueFromSay 写库 + 广播', () => {
  beforeEach(async () => {
    executeMock.mockClear();
    queryMock.mockClear();
    busEmitMock.mockClear();
    const { resetDialogueConfig } = await import('../src/engine/dialogue/config.js');
    resetDialogueConfig();
    process.env.DIALOGUE_AUTO_EVENT_ENABLED = 'true';
    process.env.DIALOGUE_CONTENT_MAX_LEN = '200';
  });

  it('用例5：DIALOGUE_AUTO_EVENT_ENABLED=false → 返回 null，不 INSERT', async () => {
    process.env.DIALOGUE_AUTO_EVENT_ENABLED = 'false';
    const { resetDialogueConfig } = await import('../src/engine/dialogue/config.js');
    resetDialogueConfig();
    const { emitDialogueFromSay } = await import('../src/engine/dialogue/emit.js');
    const r = await emitDialogueFromSay({
      scene_id: 1,
      actor: '小明',
      content: '吃了吗？',
      eventItems: null,
      trace_id: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
    });
    expect(r).toBeNull();
    expect(executeMock).not.toHaveBeenCalled();
    expect(busEmitMock).not.toHaveBeenCalled();
  });

  it('用例6：SQL 9 参数，末三位依次是 trace_id / parent_event_id / conv_turn', async () => {
    const { emitDialogueFromSay } = await import('../src/engine/dialogue/emit.js');
    const items: EventBlockItem[] = [
      {
        id: 77,
        type: 'dialogue',
        content: '在吗？',
        actor: '小美',
        created_at: new Date(),
        conv_turn: 1,
        parent_event_id: null,
      },
    ];
    const r = await emitDialogueFromSay({
      scene_id: 9,
      actor: '小明',
      content: '在的。',
      eventItems: items,
      trace_id: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
    });
    expect(r).toEqual({
      event_id: 501,
      parent_event_id: 77,
      conv_turn: 2,
      content: '在的。',
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [sql, params] = executeMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO scene_event/);
    expect(sql).toMatch(/\(scene_id, type, actor, content, payload, visible_npcs, trace_id, parent_event_id, conv_turn\)/);
    expect(params).toHaveLength(9);
    expect(params[0]).toBe(9);
    expect(params[1]).toBe('dialogue');
    expect(params[2]).toBe('小明');
    expect(params[3]).toBe('在的。');
    expect(params[4]).toBeNull();
    /** visible_npcs 按 V2=a 始终为 null */
    expect(params[5]).toBeNull();
    expect(params[6]).toBe('aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee');
    expect(params[7]).toBe(77);
    expect(params[8]).toBe(2);
  });

  it('用例7：成功后 bus.emitEvent("scene.event.created") 带 trace_id 与 event_type=dialogue', async () => {
    const { emitDialogueFromSay } = await import('../src/engine/dialogue/emit.js');
    await emitDialogueFromSay({
      scene_id: 9,
      actor: '小明',
      content: 'hi',
      eventItems: null,
      trace_id: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
    });
    expect(busEmitMock).toHaveBeenCalledTimes(1);
    const [ev] = busEmitMock.mock.calls[0] as [Record<string, unknown>];
    expect(ev.type).toBe('scene.event.created');
    expect(ev.event_type).toBe('dialogue');
    expect(ev.scene_id).toBe(9);
    expect(ev.trace_id).toBe('aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee');
    expect(ev.visible_npcs).toBeNull();
  });
});

/* ---------------------------- intake self-actor 过滤 ---------------------------- */

describe('[M4.3.1.a] pickEventsForNpc 自播 dialogue 过滤（V2=b）', () => {
  it('用例9：self_actor_name 命中 → 同名 dialogue 被丢弃，dropped_count 增加', async () => {
    const { pickEventsForNpc } = await import('../src/engine/event/intake.js');
    const rows: SceneEventRow[] = [
      {
        id: 1,
        scene_id: 1,
        type: 'dialogue',
        actor: '小明',
        content: '自己说的',
        payload: null,
        visible_npcs: null,
        created_at: new Date(),
        consumed_tick: null,
      },
      {
        id: 2,
        scene_id: 1,
        type: 'dialogue',
        actor: '小美',
        content: '别人说的',
        payload: null,
        visible_npcs: null,
        created_at: new Date(),
        consumed_tick: null,
      },
    ];
    const r = pickEventsForNpc({
      allEvents: rows,
      npc_id: 10,
      consumedSet: new Set(),
      maxPerTick: 10,
      self_actor_name: '小明',
    });
    expect(r.status).toBe('injected');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.id).toBe(2);
    expect(r.items[0]!.actor).toBe('小美');
    expect(r.dropped_count).toBe(1);
  });

  it('用例10：自播过滤仅对 dialogue 生效；同名 system/plot 正常放行', async () => {
    const { pickEventsForNpc } = await import('../src/engine/event/intake.js');
    const rows: SceneEventRow[] = [
      {
        id: 3,
        scene_id: 1,
        type: 'system',
        actor: '小明',
        content: '系统广播以小明身份？',
        payload: null,
        visible_npcs: null,
        created_at: new Date(),
        consumed_tick: null,
      },
      {
        id: 4,
        scene_id: 1,
        type: 'dialogue',
        actor: '小明',
        content: '自播 dialogue',
        payload: null,
        visible_npcs: null,
        created_at: new Date(),
        consumed_tick: null,
      },
    ];
    const r = pickEventsForNpc({
      allEvents: rows,
      npc_id: 10,
      consumedSet: new Set(),
      maxPerTick: 10,
      self_actor_name: '小明',
    });
    expect(r.status).toBe('injected');
    expect(r.items.map((i) => i.id)).toEqual([3]);
    expect(r.dropped_count).toBe(1);
  });
});
