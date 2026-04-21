/**
 * [M4.2.2.b] memory-retrieve 节点单测
 *
 * 覆盖：
 *   1) 正常路径：embed→qdrant.search→MySQL 反查→返回 topK entries，degraded=false
 *   2) Qdrant 抛 QdrantUnavailableError → 降级 MySQL importance 排序，degraded=true
 *   3) embedText 抛错 → 直接走 MySQL 降级（vector 为 null 分支），degraded=true
 *   4) cfg.enabled=false → 空数组 + degraded=false（全局禁用路径）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** 构造 1536 维零向量，符合 MEMORY_EMBED_DIM 硬校验 */
const ZERO_VEC = new Array(1536).fill(0)

const { embedMock, searchMock, queryMock, memoryConfigMock } = vi.hoisted(() => {
  const makeConfig = (enabled: boolean) => ({
    enabled,
    embedModel: 'text-embedding-3-small',
    embedDim: 1536,
    topK: 3,
    retentionDays: 30,
    storeMode: 'sync',
    retrieveQueryMode: 'prev_summary_plus_neighbors',
    qdrant: { url: 'http://localhost:6333', apiKey: undefined, collection: 'npc_memory', vectorSize: 1536 },
    embedCache: { enabled: true, ttlDays: 30, dir: '.cache/embed' },
  })
  return {
    embedMock: vi.fn(),
    searchMock: vi.fn(),
    queryMock: vi.fn(),
    memoryConfigMock: { current: makeConfig(true), makeConfig },
  }
})

vi.mock('../src/utils/llmClient.js', () => ({
  embedText: embedMock,
}))

/** 动态返回可由每个用例覆写 */
vi.mock('../src/engine/memory/config.js', () => ({
  getMemoryConfig: () => memoryConfigMock.current,
  resetMemoryConfig: () => {},
}))

const qdrantStore = {
  search: searchMock,
  upsert: vi.fn(),
  deleteByIds: vi.fn(),
  ensureCollection: vi.fn(),
  health: vi.fn().mockResolvedValue(true),
}
vi.mock('../src/engine/memory/qdrantClient.js', () => ({
  getQdrantMemoryStore: () => qdrantStore,
  /** 必须在 mock 内部定义 error class，否则 retrieve.ts 的 instanceof 判断会失效 */
  QdrantUnavailableError: class QdrantUnavailableError extends Error {
    constructor(msg: string) { super(msg); this.name = 'QdrantUnavailableError' }
  },
}))

/** pool.query 按 SQL 关键字分支返回（queryMock 已在 hoisted 中声明） */
vi.mock('../src/db/connection.js', () => ({
  pool: {
    query: queryMock,
  },
}))

import { retrieveMemories } from '../src/engine/memory/retrieve.js'
import { QdrantUnavailableError } from '../src/engine/memory/qdrantClient.js'
import type { NpcRow, SceneRow } from '../src/engine/types.js'

const scene: SceneRow = { id: 1, name: 'Park', description: null, width: 800, height: 600 }
const npc: NpcRow = {
  id: 10, name: 'Alice', personality: null, system_prompt: null, simulation_meta: null, ai_config_id: 1,
}
const aiCfg = { id: 1, api_key: 'sk-fake', base_url: null, provider: 'openai' }

beforeEach(() => {
  embedMock.mockReset()
  searchMock.mockReset()
  queryMock.mockReset()
  memoryConfigMock.current = memoryConfigMock.makeConfig(true)
})

describe('retrieveMemories', () => {
  it('正常：embed + qdrant.search 成功，MySQL 反查 topK 条，degraded=false', async () => {
    embedMock.mockResolvedValueOnce({ vector: ZERO_VEC, model: 'text-embedding-3-small', cached: false })
    searchMock.mockResolvedValueOnce([
      { id: 101, score: 0.95 }, { id: 102, score: 0.88 }, { id: 103, score: 0.71 },
    ])
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('WHERE id IN')) {
        /** 故意乱序返回，验证 retrieve 会按 Qdrant 顺序重排 */
        return [[
          { id: 103, npc_id: 10, scene_id: 1, tick: 3, type: 'dialogue', content: 'c3', importance: 3, created_at: new Date() },
          { id: 101, npc_id: 10, scene_id: 1, tick: 1, type: 'observation', content: 'c1', importance: 7, created_at: new Date() },
          { id: 102, npc_id: 10, scene_id: 1, tick: 2, type: 'dialogue', content: 'c2', importance: 5, created_at: new Date() },
        ], null]
      }
      return [[], null]
    })

    const res = await retrieveMemories({
      scene, npc, neighbors: [{ id: 11, name: 'Bob' }], prevSummary: 'yesterday we met', tick: 4, aiCfg,
    })

    expect(res.degraded).toBe(false)
    expect(res.entries.map((e) => e.id)).toEqual([101, 102, 103])
    expect(searchMock).toHaveBeenCalledWith(10, ZERO_VEC, 3)
  })

  it('Qdrant 不可达 → 降级 MySQL importance 排序，degraded=true', async () => {
    embedMock.mockResolvedValueOnce({ vector: ZERO_VEC, model: 'm', cached: false })
    searchMock.mockRejectedValueOnce(new QdrantUnavailableError('conn refused'))
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('ORDER BY importance')) {
        return [[
          { id: 201, npc_id: 10, scene_id: 1, tick: null, type: 'event', content: 'hi', importance: 9, created_at: new Date() },
        ], null]
      }
      return [[], null]
    })

    const res = await retrieveMemories({
      scene, npc, neighbors: [], prevSummary: '', tick: 1, aiCfg,
    })
    expect(res.degraded).toBe(true)
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0]?.id).toBe(201)
  })

  it('embedText 失败 → 直接走 MySQL 降级（vector=null 分支），degraded=true', async () => {
    embedMock.mockRejectedValueOnce(new Error('quota exhausted'))
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('ORDER BY importance')) {
        return [[], null]
      }
      return [[], null]
    })

    const res = await retrieveMemories({
      scene, npc, neighbors: [], prevSummary: '', tick: 1, aiCfg,
    })
    expect(res.degraded).toBe(true)
    expect(res.entries).toHaveLength(0)
    /** search 从未被调用（vector=null 直接跳降级） */
    expect(searchMock).not.toHaveBeenCalled()
  })

  it('cfg.enabled=false → 空返回 + degraded=false（不算降级）', async () => {
    memoryConfigMock.current = memoryConfigMock.makeConfig(false)
    const res = await retrieveMemories({
      scene, npc, neighbors: [], prevSummary: '', tick: 1, aiCfg,
    })
    expect(res).toEqual({ entries: [], degraded: false })
    expect(embedMock).not.toHaveBeenCalled()
  })
})
