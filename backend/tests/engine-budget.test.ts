/**
 * [M4.2.0] Budget skip + meta_warns + X-Meta-Warn 响应头 单测
 *
 * 覆盖：
 *   1) budget_tokens_per_tick 生效：第一次 tick 产生 tokens > budget → 第二次 tick 该 NPC 写入 status='skipped'
 *   2) scheduler.status().meta_warns 在软阈值越界后有一条记录
 *   3) GET /api/engine/status 在 scheduler 近期有 warn 时响应头带 X-Meta-Warn: 1
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { RowDataPacket } from 'mysql2'

type Row = Record<string, unknown>

const insertedTickRows: Array<{ sql: string; params: unknown[] }> = []

const connection = {
  query: vi.fn(async (_sql: string, _params: unknown[]): Promise<[Row[], unknown]> => {
    void _sql; void _params
    return [[], null]
  }),
  execute: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('INSERT INTO npc_tick_log')) {
      insertedTickRows.push({ sql, params })
    }
    return [{ affectedRows: 1, insertId: 1 } as unknown as RowDataPacket, null]
  }),
  beginTransaction: vi.fn(async () => {}),
  commit: vi.fn(async () => {}),
  rollback: vi.fn(async () => {}),
  release: vi.fn(() => {}),
}

/** 场景 id=1, NPC id=10, ai_config_id=1, budget=100 */
vi.mock('../src/db/connection.js', () => ({
  pool: {
    getConnection: vi.fn(async () => connection),
    query: vi.fn(async (sql: string, params: unknown[]): Promise<[Row[], unknown]> => {
      if (sql.includes('FROM scene WHERE id') || sql.includes('SELECT id FROM scene')) {
        return [[{ id: Number(params[0]) || 1, name: 'S', description: null, width: 800, height: 600 }], null]
      }
      if (sql.includes('FROM scene_npc') && sql.includes('COUNT(*)')) {
        return [[{ c: 1 }], null]
      }
      if (sql.includes('FROM scene_npc') && sql.includes('INNER JOIN npc')) {
        return [[{
          id: 10, name: 'Alice', personality: null, system_prompt: null,
          simulation_meta: null, ai_config_id: 1,
        }], null]
      }
      if (sql.includes('FROM ai_config WHERE id IN')) {
        /** budget=100，用于触发 skip */
        return [[{ id: 1, budget_tokens_per_tick: 100 }], null]
      }
      if (sql.includes('FROM npc_tick_log')) return [[], null]
      if (sql.includes('COUNT(*) AS c FROM npc_tick_log')) return [[{ c: 0 }], null]
      return [[], null]
    }),
    execute: vi.fn(async () => [{ affectedRows: 1, insertId: 1 } as unknown as RowDataPacket, null]),
  },
}))

/** mock runGraph：第一次返回 tokens=500（远超 budget），触发第二次 skip */
const runGraphMock = vi.fn()
vi.mock('../src/engine/graph/build.js', () => ({
  runGraph: runGraphMock,
}))

describe('[M4.2.0] budget skip + meta_warns', () => {
  beforeEach(() => {
    insertedTickRows.length = 0
    runGraphMock.mockReset()
  })

  it('上一 tick 超 budget，下一 tick 该 NPC 记 skipped', async () => {
    const { SceneScheduler } = await import('../src/engine/scheduler.js')

    /** 第 1 次 tick：返回 500 tokens（> budget=100），触发下一 tick skip */
    runGraphMock.mockResolvedValueOnce({
      nextMeta: { version: '1.0', last_tick_at: new Date().toISOString() },
      inputSummary: 't=1 npc=Alice',
      cost_usd: 0,
      tokens: 500,
    })

    const s = new SceneScheduler(1, { interval_ms: 60_000, max_ticks: null, concurrency: 1, dry_run: false })
    await s.stepOnce()

    /** 第 2 次 tick：应走 skip 分支（runGraph 不再被调用） */
    await s.stepOnce()

    const statuses = insertedTickRows.map((r) => String(r.params[5]))
    expect(statuses).toContain('success')
    expect(statuses).toContain('skipped')
    /** runGraph 只被调用过一次 */
    expect(runGraphMock).toHaveBeenCalledTimes(1)

    /** skipped 条目携带错误信息 'budget exceeded' */
    const skipped = insertedTickRows.find((r) => String(r.params[5]) === 'skipped')
    expect(skipped).toBeDefined()
    expect(String(skipped!.params[9])).toContain('budget exceeded')
  })

  it('软阈值越界产生 meta_warns 条目', async () => {
    const { SceneScheduler } = await import('../src/engine/scheduler.js')

    /** 构造一个 > 64KB 的 meta 值（memory_summary 拉长） */
    const bigString = 'x'.repeat(70 * 1024)
    runGraphMock.mockResolvedValueOnce({
      nextMeta: {
        version: '1.0',
        last_tick_at: new Date().toISOString(),
        memory_summary: bigString,
      },
      inputSummary: 'big',
      cost_usd: 0,
      tokens: 0,
    })

    const s = new SceneScheduler(1, { interval_ms: 60_000, max_ticks: null, concurrency: 1, dry_run: false })
    await s.stepOnce()
    const status = s.status()
    expect(status.meta_warns.length).toBe(1)
    const w = status.meta_warns[0]!
    expect(w.bytes).toBeGreaterThan(64 * 1024)
    expect(w.scene_id).toBe(1)
    expect(w.npc_id).toBe(10)
    expect(w.npc_name).toBe('Alice')
    expect(s.hasFreshMetaWarn()).toBe(true)
  })
})

describe('[M4.2.0] GET /api/engine/status 携带 X-Meta-Warn 响应头', () => {
  let app: express.Express

  beforeAll(async () => {
    const { engineRouter } = await import('../src/routes/engine.js')
    app = express()
    app.use(express.json())
    app.use('/api/engine', engineRouter)
  })

  it('scheduler 不存在时无 X-Meta-Warn 头', async () => {
    const res = await request(app).get('/api/engine/status?scene_id=8888')
    expect(res.status).toBe(200)
    expect(res.headers['x-meta-warn']).toBeUndefined()
    expect(res.body.data.meta_warns).toEqual([])
  })

  it('scheduler 近期有 warn 时响应头为 1', async () => {
    const { SceneScheduler } = await import('../src/engine/scheduler.js')
    const { setScheduler } = await import('../src/engine/registry.js')

    const bigString = 'y'.repeat(70 * 1024)
    runGraphMock.mockReset()
    runGraphMock.mockResolvedValueOnce({
      nextMeta: { version: '1.0', last_tick_at: new Date().toISOString(), memory_summary: bigString },
      inputSummary: 'big',
      cost_usd: 0,
      tokens: 0,
    })
    const s = new SceneScheduler(777, { interval_ms: 60_000, max_ticks: null, concurrency: 1, dry_run: false })
    await s.stepOnce()
    /** 手动塞进 registry 让 controller 能查到 */
    setScheduler(777, s)

    const res = await request(app).get('/api/engine/status?scene_id=777')
    expect(res.status).toBe(200)
    expect(res.headers['x-meta-warn']).toBe('1')
  })
})
