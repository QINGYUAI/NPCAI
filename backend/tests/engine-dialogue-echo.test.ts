/**
 * [M4.3.1.b] 对话回声保护单测（12 条）
 *
 * 覆盖矩阵
 *   buildParentMap（纯函数，2 条）
 *     1. 基础：数组构 id→row，保留 parent_event_id / conv_turn
 *     2. 降级：非法 id（undefined）与 null 行不进入 map
 *
 *   walkChain（纯函数，3 条）
 *     3. 单节点无 parent → 返回 1 层
 *     4. 链出快照（parent 找不到）→ 回溯停止，返回已取到的段
 *     5. 环保护：parent 指回自己 → 不无限循环
 *
 *   isEchoBlocked（纯函数，5 条）
 *     6. echoMaxTurn=0 → 放行（E4=a，禁用通道）
 *     7. 非 dialogue type → 放行（E1 只保护 dialogue）
 *     8. conv_turn=N (=3) 未过门 → 放行（3 轮不拦）
 *     9. conv_turn=N+1 且严格 A↔B 交替 N+1 层 → 拦（硬上限）
 *    10. conv_turn 到门但链上 ≥3 actor（多方对话）→ 放行（不误伤）
 *
 *   pickEventsForNpc 集成（2 条）
 *    11. echoMaxTurn=3，AB 构成 4 轮交替 → candidate 被拦 dropped_count++
 *    12. echoMaxTurn=0（禁用）→ 同样输入不拦；items 含全部通过可见性/consumed 的事件
 */
import { describe, expect, it, vi } from 'vitest';
import type { SceneEventRow } from '../src/engine/event/types.js';
import {
  buildParentMap,
  isEchoBlocked,
  walkChain,
  type EchoChainNode,
} from '../src/engine/dialogue/echo.js';
import { pickEventsForNpc } from '../src/engine/event/intake.js';

/** 构造最小 SceneEventRow fixture */
function mkEv(
  id: number,
  actor: string | null,
  type: SceneEventRow['type'] = 'dialogue',
  parent: number | null = null,
  turn: number | null = null,
): SceneEventRow {
  return {
    id,
    scene_id: 1,
    type,
    actor,
    content: `${actor ?? 'sys'}: msg${id}`,
    payload: null,
    visible_npcs: null,
    created_at: new Date(`2026-04-23T03:00:${String(id).padStart(2, '0')}Z`),
    consumed_tick: null,
    trace_id: null,
    parent_event_id: parent,
    conv_turn: turn,
  };
}

/* -------------------------- buildParentMap ---------------------------- */

describe('[M4.3.1.b] buildParentMap 纯函数', () => {
  it('用例1：基础构建保留 parent_event_id / conv_turn', () => {
    const map = buildParentMap([
      mkEv(10, 'A', 'dialogue', null, 1),
      mkEv(11, 'B', 'dialogue', 10, 2),
    ]);
    expect(map.size).toBe(2);
    expect(map.get(11)?.parent_event_id).toBe(10);
    expect(map.get(11)?.conv_turn).toBe(2);
    expect(map.get(10)?.parent_event_id).toBeNull();
  });

  it('用例2：非法条目（null 行 / 无数字 id）被静默忽略', () => {
    const bad = [
      null,
      undefined,
      { id: 'x', type: 'dialogue', actor: 'A' },
      mkEv(20, 'A'),
    ] as unknown as Array<EchoChainNode>;
    const map = buildParentMap(bad);
    expect(map.size).toBe(1);
    expect(map.has(20)).toBe(true);
  });
});

/* ------------------------------ walkChain ------------------------------ */

describe('[M4.3.1.b] walkChain 纯函数', () => {
  it('用例3：首句 parent=null → 只回 1 层 actor', () => {
    const row = mkEv(30, 'A', 'dialogue', null, 1);
    const map = buildParentMap([row]);
    const chain = walkChain(row, map, 4);
    expect(chain).toEqual(['A']);
  });

  it('用例4：链出快照（parent id 不在 map 内）→ 回溯停止', () => {
    /** id=41 指向 id=33，但 map 只有 41（33 在窗口外） */
    const row = mkEv(41, 'B', 'dialogue', 33, 2);
    const map = buildParentMap([row]);
    const chain = walkChain(row, map, 4);
    expect(chain).toEqual(['B']);
  });

  it('用例5：parent 指回自身（脏数据环）→ 不无限循环', () => {
    const row = mkEv(50, 'A', 'dialogue', 50, 5);
    const map = buildParentMap([row]);
    const chain = walkChain(row, map, 10);
    expect(chain.length).toBe(1);
    expect(chain).toEqual(['A']);
  });
});

/* ----------------------------- isEchoBlocked --------------------------- */

describe('[M4.3.1.b] isEchoBlocked 纯函数', () => {
  /** 构 4 层 A↔B 交替链：e1 A(turn=1) ← e2 B(2) ← e3 A(3) ← e4 B(4) */
  const buildAlternateChain = () => {
    const e1 = mkEv(101, 'A', 'dialogue', null, 1);
    const e2 = mkEv(102, 'B', 'dialogue', 101, 2);
    const e3 = mkEv(103, 'A', 'dialogue', 102, 3);
    const e4 = mkEv(104, 'B', 'dialogue', 103, 4);
    return { map: buildParentMap([e1, e2, e3, e4]), e1, e2, e3, e4 };
  };

  it('用例6：echoMaxTurn=0 → 任何输入放行（E4=a 禁用通道）', () => {
    const { map, e4 } = buildAlternateChain();
    expect(isEchoBlocked({ candidate: e4, byId: map, echoMaxTurn: 0 })).toBe(false);
  });

  it('用例7：非 dialogue type → 放行（weather/plot 不受保护影响）', () => {
    const map = buildParentMap([mkEv(1, 'A', 'weather', null, 999)]);
    const sysEv = mkEv(1, 'A', 'weather', null, 999);
    expect(isEchoBlocked({ candidate: sysEv, byId: map, echoMaxTurn: 3 })).toBe(false);
  });

  it('用例8：conv_turn=N（=3）未达门槛 → 放行（3 轮不拦）', () => {
    const { map, e3 } = buildAlternateChain();
    expect(isEchoBlocked({ candidate: e3, byId: map, echoMaxTurn: 3 })).toBe(false);
  });

  it('用例9：conv_turn=N+1 且严格 A↔B 交替 N+1 层 → 拦（硬上限）', () => {
    const { map, e4 } = buildAlternateChain();
    expect(isEchoBlocked({ candidate: e4, byId: map, echoMaxTurn: 3 })).toBe(true);
  });

  it('用例10：conv_turn 到门但链上含第 3 个 actor → 放行（不误伤多方对话）', () => {
    /** 链：A(1) ← B(2) ← C(3) ← B(4)；最后一层非 A/B 交替 */
    const e1 = mkEv(201, 'A', 'dialogue', null, 1);
    const e2 = mkEv(202, 'B', 'dialogue', 201, 2);
    const e3 = mkEv(203, 'C', 'dialogue', 202, 3);
    const e4 = mkEv(204, 'B', 'dialogue', 203, 4);
    const map = buildParentMap([e1, e2, e3, e4]);
    expect(isEchoBlocked({ candidate: e4, byId: map, echoMaxTurn: 3 })).toBe(false);
  });
});

/* ----------------------- pickEventsForNpc 集成 ------------------------- */

describe('[M4.3.1.b] pickEventsForNpc 回声拦截集成', () => {
  it('用例11：AB 4 轮交替 + echoMaxTurn=3，最新 B 发言被拦（dropped+1）', () => {
    const e1 = mkEv(301, 'A', 'dialogue', null, 1);
    const e2 = mkEv(302, 'B', 'dialogue', 301, 2);
    const e3 = mkEv(303, 'A', 'dialogue', 302, 3);
    const e4 = mkEv(304, 'B', 'dialogue', 303, 4);
    /** intake 需要 allEvents 按 created_at DESC：最新 e4 在前 */
    const allEvents = [e4, e3, e2, e1];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    /** 从 NPC "A"（self）的视角：e1/e3 自播被先过滤；e2/e4 过自播；e4 conv_turn=4 走回声拦截 */
    const res = pickEventsForNpc({
      allEvents,
      npc_id: 1,
      consumedSet: new Set(),
      maxPerTick: 10,
      self_actor_name: 'A',
      echoMaxTurn: 3,
    });

    /** e1/e3 自播 → 2 drop；e4 回声 → 1 drop；仅 e2 入选 */
    expect(res.status).toBe('injected');
    expect(res.items.map((i) => i.id)).toEqual([302]);
    expect(res.dropped_count).toBe(3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[intake.echo] 回声拦截'));
    warnSpy.mockRestore();
  });

  it('用例12：同输入但 echoMaxTurn=0（禁用）→ e4 放行、dropped 只剩自播', () => {
    const e1 = mkEv(401, 'A', 'dialogue', null, 1);
    const e2 = mkEv(402, 'B', 'dialogue', 401, 2);
    const e3 = mkEv(403, 'A', 'dialogue', 402, 3);
    const e4 = mkEv(404, 'B', 'dialogue', 403, 4);
    const res = pickEventsForNpc({
      allEvents: [e4, e3, e2, e1],
      npc_id: 1,
      consumedSet: new Set(),
      maxPerTick: 10,
      self_actor_name: 'A',
      echoMaxTurn: 0,
    });
    expect(res.items.map((i) => i.id)).toEqual([404, 402]);
    expect(res.dropped_count).toBe(2);
  });
});
