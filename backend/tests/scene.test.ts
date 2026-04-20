/**
 * 场景路由契约测试：
 *   PUT /api/scene/:id/layout
 *   PUT /api/scene/:id/npcs
 *
 * 策略：mock `../src/db/connection.js` 的 pool，断言 HTTP 层的校验与状态码。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

/** 最小可控 pool mock：提供 query / execute / getConnection */
type Row = Record<string, unknown>
let mockSceneExists = true
let mockLinkedNpcIds: number[] = [10, 11]
let mockSceneExistsForNpcs = true
let mockNpcIdsInDb: number[] = [10, 11, 12]

const execCalls: unknown[][] = []

const connection = {
  query: vi.fn(async (sql: string, params: unknown[]): Promise<[Row[], unknown]> => {
    if (sql.includes('SELECT id FROM scene')) {
      return [mockSceneExists ? [{ id: Number(params[0]) }] : [], null]
    }
    if (sql.includes('SELECT npc_id FROM scene_npc')) {
      return [mockLinkedNpcIds.map((id) => ({ npc_id: id })), null]
    }
    if (sql.includes('SELECT id FROM npc')) {
      const nid = Number(params[0])
      return [mockNpcIdsInDb.includes(nid) ? [{ id: nid }] : [], null]
    }
    if (sql.includes('SELECT npc_id, pos_x, pos_y FROM scene_npc')) {
      return [mockLinkedNpcIds.map((id) => ({ npc_id: id, pos_x: null, pos_y: null })), null]
    }
    return [[], null]
  }),
  execute: vi.fn(async (...args: unknown[]) => {
    execCalls.push(args)
    return [{}, null]
  }),
  beginTransaction: vi.fn(async () => {}),
  commit: vi.fn(async () => {}),
  rollback: vi.fn(async () => {}),
  release: vi.fn(() => {}),
}

/** Hoisted mock：控制 scene controller 拿到的 pool */
vi.mock('../src/db/connection.js', () => ({
  pool: {
    getConnection: vi.fn(async () => connection),
    query: vi.fn(async (sql: string, params: unknown[]): Promise<[Row[], unknown]> => {
      if (sql.includes('SELECT id FROM scene')) {
        return [mockSceneExistsForNpcs ? [{ id: Number(params[0]) }] : [], null]
      }
      return [[], null]
    }),
    execute: vi.fn(async () => [{ affectedRows: 1, insertId: 1 }, null]),
  },
}))

let app: express.Express

beforeAll(async () => {
  const { sceneRouter } = await import('../src/routes/scene.js')
  app = express()
  app.use(express.json())
  app.use('/api/scene', sceneRouter)
})

describe('PUT /api/scene/:id/layout', () => {
  it('场景不存在返回 404', async () => {
    mockSceneExists = false
    const res = await request(app).put('/api/scene/999/layout').send({ positions: [] })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(-1)
  })

  it('缺少 positions 数组返回 400', async () => {
    mockSceneExists = true
    const res = await request(app).put('/api/scene/1/layout').send({})
    expect(res.status).toBe(400)
  })

  it('非法 npc_id 返回 400', async () => {
    const res = await request(app)
      .put('/api/scene/1/layout')
      .send({ positions: [{ npc_id: 0, pos_x: 1, pos_y: 2 }] })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/npc_id/)
  })

  it('重复 npc_id 返回 400', async () => {
    const res = await request(app)
      .put('/api/scene/1/layout')
      .send({
        positions: [
          { npc_id: 10, pos_x: 1, pos_y: 2 },
          { npc_id: 10, pos_x: 3, pos_y: 4 },
        ],
      })
    expect(res.status).toBe(400)
  })

  it('未关联该场景的 npc_id 返回 400', async () => {
    mockLinkedNpcIds = [10]
    const res = await request(app)
      .put('/api/scene/1/layout')
      .send({ positions: [{ npc_id: 11, pos_x: 1, pos_y: 2 }] })
    expect(res.status).toBe(400)
  })

  it('合法请求成功保存', async () => {
    mockLinkedNpcIds = [10, 11]
    const res = await request(app)
      .put('/api/scene/1/layout')
      .send({
        positions: [
          { npc_id: 10, pos_x: 100, pos_y: 200 },
          { npc_id: 11, pos_x: 300, pos_y: 400 },
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
  })
})

describe('PUT /api/scene/:id/npcs', () => {
  it('场景不存在返回 404', async () => {
    mockSceneExists = false
    const res = await request(app).put('/api/scene/999/npcs').send({ npcs: [] })
    expect(res.status).toBe(404)
  })

  it('缺少 npcs 数组返回 400', async () => {
    mockSceneExists = true
    const res = await request(app).put('/api/scene/1/npcs').send({})
    expect(res.status).toBe(400)
  })

  it('重复 npc_id 返回 400', async () => {
    const res = await request(app)
      .put('/api/scene/1/npcs')
      .send({ npcs: [{ npc_id: 10 }, { npc_id: 10 }] })
    expect(res.status).toBe(400)
  })

  it('不存在的 npc_id 返回 400', async () => {
    mockNpcIdsInDb = [10]
    const res = await request(app)
      .put('/api/scene/1/npcs')
      .send({ npcs: [{ npc_id: 9999 }] })
    expect(res.status).toBe(400)
  })

  it('合法请求成功更新', async () => {
    mockNpcIdsInDb = [10, 11]
    const res = await request(app)
      .put('/api/scene/1/npcs')
      .send({
        npcs: [
          { npc_id: 10, role_note: '店主' },
          { npc_id: 11 },
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
  })
})
