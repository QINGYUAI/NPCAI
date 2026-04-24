/**
 * [M4.6.0 U-C] useSandboxSimulation 单测
 * 覆盖面：
 *   1. 初始 state：engineStatus=null / wsState=closed / engineRunning=false / latestMetaWarn=null
 *   2. setEngineStatus 整包替换；engineRunning / latestMetaWarn 派生正确
 *   3. applyTickEnd：仅更新 4 个字段；cost_usd_total 未传时保留旧值
 *   4. applyTickEnd：engineStatus=null 时静默跳过（不抛错）
 *   5. applyMetaWarn：追加到 meta_warns 尾部；latestMetaWarn 派生指向最新
 *   6. applyMetaWarn：超过 20 条时 ring buffer 头删
 *   7. reset：engineStatus=null + wsState=closed
 */
import { describe, it, expect } from 'vitest'
import { useSandboxSimulation } from './useSandboxSimulation'
import type {
  EngineStatus,
  WsMetaWarnMsg,
  WsTickEndMsg,
} from '../types/engine'

function mkStatus(partial: Partial<EngineStatus> = {}): EngineStatus {
  return {
    scene_id: 1,
    running: true,
    tick: 0,
    started_at: '2026-04-25T00:00:00Z',
    last_tick_at: null,
    last_duration_ms: null,
    npc_count: 2,
    errors_recent: 0,
    cost_usd_total: 0,
    config: null,
    meta_warns: [],
    ...partial,
  }
}

function mkMetaWarn(i: number): WsMetaWarnMsg {
  return {
    ts: `2026-04-25T00:${String(i).padStart(2, '0')}:00Z`,
    type: 'meta.warn',
    scene_id: 1,
    tick: i,
    npc_id: 1,
    npc_name: `npc#${i}`,
    bytes: 10240,
    soft_limit: 8192,
    at: `2026-04-25T00:${String(i).padStart(2, '0')}:00Z`,
  }
}

describe('useSandboxSimulation · 初始 state & 基础派生', () => {
  it('初始：engineStatus=null / wsState=closed / engineRunning=false / latestMetaWarn=null', () => {
    const s = useSandboxSimulation()
    expect(s.engineStatus.value).toBeNull()
    expect(s.wsState.value).toBe('closed')
    expect(s.engineRunning.value).toBe(false)
    expect(s.latestMetaWarn.value).toBeNull()
  })

  it('setEngineStatus 整包替换；engineRunning / latestMetaWarn 派生正确', () => {
    const s = useSandboxSimulation()
    s.setEngineStatus(mkStatus({ running: true }))
    expect(s.engineStatus.value?.running).toBe(true)
    expect(s.engineRunning.value).toBe(true)
    s.setEngineStatus(mkStatus({ running: false }))
    expect(s.engineRunning.value).toBe(false)
  })
})

describe('useSandboxSimulation · applyTickEnd', () => {
  it('仅更新 tick/last_tick_at/last_duration_ms/cost_usd_total 四个字段；其余不变', () => {
    const s = useSandboxSimulation()
    s.setEngineStatus(mkStatus({ tick: 5, errors_recent: 3, cost_usd_total: 0.1 }))
    const msg: WsTickEndMsg = {
      ts: '2026-04-25T00:10:00Z',
      type: 'tick.end',
      scene_id: 1,
      tick: 6,
      duration_ms: 1234,
      cost_usd_total: 0.25,
    }
    s.applyTickEnd(msg)
    expect(s.engineStatus.value?.tick).toBe(6)
    expect(s.engineStatus.value?.last_tick_at).toBe(msg.ts)
    expect(s.engineStatus.value?.last_duration_ms).toBe(1234)
    expect(s.engineStatus.value?.cost_usd_total).toBe(0.25)
    expect(s.engineStatus.value?.errors_recent).toBe(3)
  })

  it('tick.end 未带 cost_usd_total 时保留旧值', () => {
    const s = useSandboxSimulation()
    s.setEngineStatus(mkStatus({ cost_usd_total: 0.88 }))
    s.applyTickEnd({
      ts: '2026-04-25T00:10:00Z',
      type: 'tick.end',
      scene_id: 1,
      tick: 7,
      duration_ms: 500,
    })
    expect(s.engineStatus.value?.cost_usd_total).toBe(0.88)
  })

  it('engineStatus=null 时 applyTickEnd 静默跳过（不抛错）', () => {
    const s = useSandboxSimulation()
    expect(() =>
      s.applyTickEnd({
        ts: '2026-04-25T00:10:00Z',
        type: 'tick.end',
        scene_id: 1,
        tick: 1,
        duration_ms: 500,
      }),
    ).not.toThrow()
    expect(s.engineStatus.value).toBeNull()
  })
})

describe('useSandboxSimulation · applyMetaWarn', () => {
  it('追加到 meta_warns 尾部；latestMetaWarn 派生指向最新', () => {
    const s = useSandboxSimulation()
    s.setEngineStatus(mkStatus({ meta_warns: [] }))
    s.applyMetaWarn(mkMetaWarn(1))
    s.applyMetaWarn(mkMetaWarn(2))
    const list = s.engineStatus.value?.meta_warns ?? []
    expect(list.length).toBe(2)
    expect(list[0]!.tick).toBe(1)
    expect(list[1]!.tick).toBe(2)
    expect(s.latestMetaWarn.value?.tick).toBe(2)
  })

  it('超过 20 条时 ring buffer 头删（保持 20 条，最早的丢弃）', () => {
    const s = useSandboxSimulation()
    s.setEngineStatus(mkStatus({ meta_warns: [] }))
    for (let i = 1; i <= 25; i += 1) s.applyMetaWarn(mkMetaWarn(i))
    const list = s.engineStatus.value?.meta_warns ?? []
    expect(list.length).toBe(20)
    expect(list[0]!.tick).toBe(6)
    expect(list[19]!.tick).toBe(25)
  })
})

describe('useSandboxSimulation · reset', () => {
  it('reset 清空 engineStatus + wsState', () => {
    const s = useSandboxSimulation()
    s.setEngineStatus(mkStatus({ tick: 9 }))
    s.setWsState('open')
    s.reset()
    expect(s.engineStatus.value).toBeNull()
    expect(s.wsState.value).toBe('closed')
  })
})
