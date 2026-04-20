/**
 * 引擎 REST 路由契约测试（mock pool；不打真 LLM）
 *   POST /api/engine/start
 *   POST /api/engine/stop
 *   POST /api/engine/step
 *   GET  /api/engine/status
 *   GET  /api/engine/ticks
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

type Row = Record<string, unknown>

let mockSceneId: number | null = 1
let mockLinkedNpcs: Array<{ id: number; name: string }> = [
  { id: 10, name: 'Alice' },
  { id: 11, name: 'Bob' },
]
const insertedTickRows: unknown[][] = []
const updatedNpcMetaRows: unknown[][] = []
let mockTickLogRows: Row[] = []

const connection = {
  query: vi.fn(async (sql: string, _params: unknown[]): Promise<[Row[], unknown]> => {
    void _params
    if (sql.includes('FROM npc_tick_log')) {
      return [mockTickLogRows, null]
    }
    return [[], null]
  }),
  execute: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('INSERT INTO npc_tick_log')) {
      insertedTickRows.push(params)
    } else if (sql.includes('UPDATE npc SET simulation_meta')) {
      updatedNpcMetaRows.push(params)
    }
    return [{ affectedRows: 1, insertId: 1 }, null]
  }),
  beginTransaction: vi.fn(async () => { }),
  commit: vi.fn(async () => { }),
  rollback: vi.fn(async () => { }),
  release: vi.fn(() => { }),
}

vi.mock('../src/db/connection.js', () => ({
  pool: {
    getConnection: vi.fn(async () => connection),
    query: vi.fn(async (sql: string, params: unknown[]): Promise<[Row[], unknown]> => {
      if (sql.includes('FROM scene WHERE id') || sql.includes('SELECT id FROM scene')) {
        return [mockSceneId && Number(params[0]) === mockSceneId
          ? [{ id: mockSceneId, name: 'S', description: null, width: 800, height: 600 }]
          : [], null]
      }
      if (sql.includes('FROM scene_npc') && sql.includes('COUNT(*)')) {
        return [[{ c: mockLinkedNpcs.length }], null]
      }
      if (sql.includes('FROM scene_npc') && sql.includes('INNER JOIN npc')) {
        return [mockLinkedNpcs.map((n) => ({
          id: n.id,
          name: n.name,
          personality: null,
          system_prompt: null,
          simulation_meta: null,
          ai_config_id: 1,
        })), null]
      }
      if (sql.includes('FROM npc_tick_log')) {
        return [mockTickLogRows, null]
      }
      return [[], null]
    }),
    execute: vi.fn(async () => [{ affectedRows: 1, insertId: 1 }, null]),
  },
}))

let app: express.Express

beforeAll(async () => {
  const { engineRouter } = await import('../src/routes/engine.js')
  app = express()
  app.use(express.json())
  app.use('/api/engine', engineRouter)
})

describe('POST /api/engine/start', () => {
  it('scene_id 非法返回 400', async () => {
    const res = await request(app).post('/api/engine/start').send({ scene_id: 0 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('INVALID_PARAM')
  })

  it('interval_ms 越界返回 400', async () => {
    const res = await request(app).post('/api/engine/start').send({ scene_id: 1, interval_ms: 100 })
    expect(res.status).toBe(400)
  })

  it('场景不存在返回 400', async () => {
    mockSceneId = null
    const res = await request(app).post('/api/engine/start').send({ scene_id: 9999, dry_run: true })
    expect(res.status).toBe(400)
  })

  it('场景无 NPC 返回 422', async () => {
    mockSceneId = 2
    mockLinkedNpcs = []
    const res = await request(app).post('/api/engine/start').send({ scene_id: 2, dry_run: true })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('NO_NPC_IN_SCENE')
  })

  it('dry_run 启动成功并立即 tick 一次', async () => {
    mockSceneId = 3
    mockLinkedNpcs = [
      { id: 100, name: 'Ada' },
      { id: 101, name: 'Ben' },
    ]
    insertedTickRows.length = 0
    updatedNpcMetaRows.length = 0
    const res = await request(app)
      .post('/api/engine/start')
      .send({ scene_id: 3, dry_run: true, interval_ms: 60_000, max_ticks: 1 })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.running).toBe(true)
    expect(res.body.data.config.dry_run).toBe(true)

    /** 异步 tick：等待写入落盘 */
    await new Promise((r) => setTimeout(r, 150))
    expect(insertedTickRows.length).toBeGreaterThanOrEqual(2)
    expect(updatedNpcMetaRows.length).toBeGreaterThanOrEqual(2)

    /** 停止以释放 timer */
    await request(app).post('/api/engine/stop').send({ scene_id: 3, force: true })
  })
})

describe('POST /api/engine/stop', () => {
  it('未启动的场景返回 running:false', async () => {
    const res = await request(app).post('/api/engine/stop').send({ scene_id: 42 })
    expect(res.status).toBe(200)
    expect(res.body.data.running).toBe(false)
  })
})

describe('GET /api/engine/status', () => {
  it('未启动时返回空壳', async () => {
    const res = await request(app).get('/api/engine/status?scene_id=999')
    expect(res.status).toBe(200)
    expect(res.body.data.running).toBe(false)
    expect(res.body.data.tick).toBe(0)
  })

  it('scene_id 缺失返回 400', async () => {
    const res = await request(app).get('/api/engine/status')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/engine/ticks', () => {
  it('返回 tick_log 列表', async () => {
    mockTickLogRows = [
      { id: 1, scene_id: 7, npc_id: 10, tick: 1, status: 'success' },
    ]
    const res = await request(app).get('/api/engine/ticks?scene_id=7')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.data[0].status).toBe('success')
  })
})
