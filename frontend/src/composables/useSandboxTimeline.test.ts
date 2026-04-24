/**
 * [M4.6.0 U-C] useSandboxTimeline 单测
 * 覆盖面：
 *   1. 初始 state：timelineEntries=[] / sessionTokens=0 / sessionCostUsd=0
 *   2. applyTickStart：新建行
 *   3. applyTickStart：超过 TIMELINE_MAX 时头删
 *   4. applyNpcUpdated：追加到对应 tick 行；成功时累计 tokens/cost
 *   5. applyNpcUpdated：行不存在时补建；skipped 不计费 + 打 note
 *   6. applyNpcUpdated：success 但 cost_usd=null → session/row cost 吸收为 null
 *   7. applyNpcUpdated：plan_path='goal' + active_goal → entry 提取出 plan_path/goal_title
 *   8. completeTickRow：覆盖 duration_ms/ended_at；行已不在 ring buffer 时静默跳过
 *   9. reset：三个 ref 全清零
 */
import { describe, it, expect } from 'vitest'
import {
  useSandboxTimeline,
  TIMELINE_MAX,
} from './useSandboxTimeline'
import type {
  WsTickStartMsg,
  WsTickNpcUpdatedMsg,
} from '../types/engine'

function mkTickStart(tick: number): WsTickStartMsg {
  return {
    ts: `2026-04-25T00:${String(tick).padStart(2, '0')}:00Z`,
    type: 'tick.start',
    scene_id: 1,
    tick,
    at: `2026-04-25T00:${String(tick).padStart(2, '0')}:00Z`,
  }
}

function mkNpcUpdated(
  tick: number,
  npc_id: number,
  status: 'success' | 'skipped' | 'error',
  opts: {
    total?: number
    cost?: number | null
    plan_path?: 'event' | 'goal' | 'schedule' | 'idle' | null
    active_goal?: { id: number; title: string; priority: number } | null
  } = {},
): WsTickNpcUpdatedMsg {
  return {
    ts: `2026-04-25T00:${String(tick).padStart(2, '0')}:05Z`,
    type: 'tick.npc.updated',
    scene_id: 1,
    tick,
    npc_id,
    npc_name: `npc#${npc_id}`,
    status,
    duration_ms: 400,
    tokens: opts.total ? { prompt: 100, completion: 50, total: opts.total } : undefined,
    cost_usd: opts.cost !== undefined ? opts.cost : 0.001,
    meta_summary: {
      latest_say: '你好',
      latest_action: null,
      emotion: 'neutral',
      plan_path: opts.plan_path ?? null,
      active_goal: opts.active_goal ?? null,
    },
  }
}

describe('useSandboxTimeline · 初始 state', () => {
  it('初始：timelineEntries=[] / sessionTokens=0 / sessionCostUsd=0', () => {
    const t = useSandboxTimeline()
    expect(t.timelineEntries.value).toEqual([])
    expect(t.sessionTokens.value).toBe(0)
    expect(t.sessionCostUsd.value).toBe(0)
  })
})

describe('useSandboxTimeline · applyTickStart', () => {
  it('新建行：tick / started_at / tokens_total=0 / cost_usd=0 / npcs=[]', () => {
    const t = useSandboxTimeline()
    t.applyTickStart(mkTickStart(1))
    expect(t.timelineEntries.value).toHaveLength(1)
    const row = t.timelineEntries.value[0]!
    expect(row.tick).toBe(1)
    expect(row.started_at).toBe('2026-04-25T00:01:00Z')
    expect(row.tokens_total).toBe(0)
    expect(row.cost_usd).toBe(0)
    expect(row.npcs).toEqual([])
  })

  it('超过 TIMELINE_MAX 时头删：始终保留最近 TIMELINE_MAX 条', () => {
    const t = useSandboxTimeline()
    for (let i = 1; i <= TIMELINE_MAX + 5; i += 1) t.applyTickStart(mkTickStart(i))
    expect(t.timelineEntries.value).toHaveLength(TIMELINE_MAX)
    expect(t.timelineEntries.value[0]!.tick).toBe(6)
    expect(t.timelineEntries.value[TIMELINE_MAX - 1]!.tick).toBe(TIMELINE_MAX + 5)
  })
})

describe('useSandboxTimeline · applyNpcUpdated', () => {
  it('追加到对应 tick 行；success 累计 tokens/cost 到 row + session', () => {
    const t = useSandboxTimeline()
    t.applyTickStart(mkTickStart(1))
    t.applyNpcUpdated(mkNpcUpdated(1, 10, 'success', { total: 200, cost: 0.005 }))
    t.applyNpcUpdated(mkNpcUpdated(1, 11, 'success', { total: 300, cost: 0.008 }))
    const row = t.timelineEntries.value[0]!
    expect(row.npcs).toHaveLength(2)
    expect(row.tokens_total).toBe(500)
    expect(row.cost_usd).toBeCloseTo(0.013, 6)
    expect(t.sessionTokens.value).toBe(500)
    expect(t.sessionCostUsd.value).toBeCloseTo(0.013, 6)
  })

  it('行不存在时补建；skipped 不计费但打 note', () => {
    const t = useSandboxTimeline()
    t.applyNpcUpdated(mkNpcUpdated(7, 20, 'skipped', { total: 100, cost: 0.002 }))
    expect(t.timelineEntries.value).toHaveLength(1)
    const row = t.timelineEntries.value[0]!
    expect(row.tick).toBe(7)
    expect(row.npcs[0]!.status).toBe('skipped')
    expect(row.npcs[0]!.note).toBe('超预算，跳过')
    expect(row.tokens_total).toBe(0)
    expect(t.sessionTokens.value).toBe(0)
    expect(t.sessionCostUsd.value).toBe(0)
  })

  it('success 但 cost_usd=null → session/row cost 吸收为 null', () => {
    const t = useSandboxTimeline()
    t.applyTickStart(mkTickStart(2))
    t.applyNpcUpdated(mkNpcUpdated(2, 30, 'success', { total: 200, cost: null }))
    const row = t.timelineEntries.value[0]!
    expect(row.cost_usd).toBeNull()
    expect(t.sessionCostUsd.value).toBeNull()
    /** tokens 仍然要累计：null 只吸收 cost */
    expect(row.tokens_total).toBe(200)
    expect(t.sessionTokens.value).toBe(200)
  })

  it('plan_path=goal + active_goal → entry 携带 plan_path/goal_title', () => {
    const t = useSandboxTimeline()
    t.applyTickStart(mkTickStart(3))
    t.applyNpcUpdated(
      mkNpcUpdated(3, 40, 'success', {
        total: 100,
        cost: 0.001,
        plan_path: 'goal',
        active_goal: { id: 99, title: '打扫厨房', priority: 8 },
      }),
    )
    const entry = t.timelineEntries.value[0]!.npcs[0]!
    expect(entry.plan_path).toBe('goal')
    expect(entry.goal_title).toBe('打扫厨房')
  })
})

describe('useSandboxTimeline · completeTickRow', () => {
  it('覆盖对应行的 duration_ms / ended_at', () => {
    const t = useSandboxTimeline()
    t.applyTickStart(mkTickStart(5))
    t.completeTickRow(5, 2200, '2026-04-25T00:05:05Z')
    const row = t.timelineEntries.value[0]!
    expect(row.duration_ms).toBe(2200)
    expect(row.ended_at).toBe('2026-04-25T00:05:05Z')
  })

  it('行已不在 ring buffer 时静默跳过（不抛错）', () => {
    const t = useSandboxTimeline()
    expect(() => t.completeTickRow(999, 1000, '2026-04-25T00:00:00Z')).not.toThrow()
    expect(t.timelineEntries.value).toHaveLength(0)
  })
})

describe('useSandboxTimeline · reset', () => {
  it('reset 清空三个 ref', () => {
    const t = useSandboxTimeline()
    t.applyTickStart(mkTickStart(1))
    t.applyNpcUpdated(mkNpcUpdated(1, 10, 'success', { total: 500, cost: 0.01 }))
    t.reset()
    expect(t.timelineEntries.value).toEqual([])
    expect(t.sessionTokens.value).toBe(0)
    expect(t.sessionCostUsd.value).toBe(0)
  })
})
