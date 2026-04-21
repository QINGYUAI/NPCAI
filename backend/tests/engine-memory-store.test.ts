/**
 * [M4.2.2.b] memory-store 节点单测
 *
 * 覆盖：
 *   1) 正常双写：MySQL INSERT → embedText → Qdrant upsert → UPDATE status='embedded'
 *   2) embedText 失败：INSERT OK，UPDATE status='failed'，返回 { embedded: false, status: 'failed' }
 *   3) Qdrant upsert 失败：INSERT OK，UPDATE status='pending'
 *   4) content 过短（<5 字符）：跳过，MySQL 不写入
 *   5) ruleBasedImportance 规则打分：边界值校验
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ZERO_VEC = new Array(1536).fill(0)

const { embedMock, upsertMock, executeMock, insertCalls, updateCalls } = vi.hoisted(() => {
  const inserts: Array<{ sql: string; params: unknown[] }> = []
  const updates: Array<{ sql: string; params: unknown[] }> = []
  return {
    embedMock: vi.fn(),
    upsertMock: vi.fn(),
    insertCalls: inserts,
    updateCalls: updates,
    executeMock: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO npc_memory')) {
        inserts.push({ sql, params })
        return [{ insertId: 777, affectedRows: 1 }, null]
      }
      if (sql.includes('UPDATE npc_memory')) {
        updates.push({ sql, params })
        return [{ insertId: 0, affectedRows: 1 }, null]
      }
      return [{ insertId: 0, affectedRows: 0 }, null]
    }),
  }
})

vi.mock('../src/utils/llmClient.js', () => ({
  embedText: embedMock,
}))

vi.mock('../src/engine/memory/config.js', () => ({
  getMemoryConfig: () => ({
    enabled: true,
    embedModel: 'text-embedding-3-small',
    embedDim: 1536,
    topK: 3,
    retentionDays: 30,
    storeMode: 'sync',
    retrieveQueryMode: 'prev_summary_plus_neighbors',
    qdrant: { url: 'http://localhost:6333', apiKey: undefined, collection: 'npc_memory', vectorSize: 1536 },
    embedCache: { enabled: true, ttlDays: 30, dir: '.cache/embed' },
  }),
  resetMemoryConfig: () => {},
}))

const qdrantStore = {
  upsert: upsertMock,
  search: vi.fn(),
  deleteByIds: vi.fn(),
  ensureCollection: vi.fn(),
  health: vi.fn().mockResolvedValue(true),
}
vi.mock('../src/engine/memory/qdrantClient.js', () => ({
  getQdrantMemoryStore: () => qdrantStore,
  QdrantUnavailableError: class QdrantUnavailableError extends Error {
    constructor(msg: string) { super(msg); this.name = 'QdrantUnavailableError' }
  },
}))

vi.mock('../src/db/connection.js', () => ({
  pool: {
    execute: executeMock,
    query: vi.fn(async () => [[], null]),
  },
}))

import { storeMemory, ruleBasedImportance } from '../src/engine/memory/store.js'
import { QdrantUnavailableError } from '../src/engine/memory/qdrantClient.js'
import type { NpcRow, SceneRow } from '../src/engine/types.js'

const scene: SceneRow = { id: 1, name: 'Park', description: null, width: 800, height: 600 }
const npc: NpcRow = {
  id: 10, name: 'Alice', personality: null, system_prompt: null, simulation_meta: null, ai_config_id: 1,
}
const aiCfg = { id: 1, api_key: 'sk-fake', base_url: null, provider: 'openai' }

beforeEach(() => {
  insertCalls.length = 0
  updateCalls.length = 0
  executeMock.mockClear()
  embedMock.mockReset()
  upsertMock.mockReset()
})

describe('storeMemory', () => {
  it('正常双写：INSERT → embed → upsert → UPDATE embedded', async () => {
    embedMock.mockResolvedValueOnce({ vector: ZERO_VEC, model: 'text-embedding-3-small', cached: false })
    upsertMock.mockResolvedValueOnce(undefined)

    const res = await storeMemory({
      scene, npc, tick: 3, type: 'dialogue', content: '今天的晚霞真好看，我很想和你分享',
      aiCfg,
    })

    expect(res).toEqual({ id: 777, embedded: true, status: 'embedded' })
    expect(insertCalls).toHaveLength(1)
    expect(updateCalls).toHaveLength(1)
    expect(String(updateCalls[0]!.params[0])).toBe('embedded')
    expect(upsertMock).toHaveBeenCalledWith(777, ZERO_VEC, expect.objectContaining({
      npc_id: 10, scene_id: 1, type: 'dialogue', tick: 3,
    }))
  })

  it('embedText 失败：MySQL 落库但 embed_status=failed', async () => {
    embedMock.mockRejectedValueOnce(new Error('quota'))

    const res = await storeMemory({
      scene, npc, tick: 3, type: 'dialogue', content: '今天的晚霞真好看',
      aiCfg,
    })

    expect(res).toEqual({ id: 777, embedded: false, status: 'failed' })
    expect(insertCalls).toHaveLength(1)
    expect(updateCalls).toHaveLength(1)
    expect(String(updateCalls[0]!.params[0])).toBe('failed')
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('Qdrant upsert 失败：保留向量 + status=pending（将来 cron 重试，避免重复计费）', async () => {
    embedMock.mockResolvedValueOnce({ vector: ZERO_VEC, model: 'text-embedding-3-small', cached: false })
    upsertMock.mockRejectedValueOnce(new QdrantUnavailableError('conn refused'))

    const res = await storeMemory({
      scene, npc, tick: 3, type: 'observation', content: 'walking_to_dock',
      aiCfg,
    })

    expect(res).toEqual({ id: 777, embedded: false, status: 'pending' })
    expect(updateCalls).toHaveLength(1)
    expect(String(updateCalls[0]!.params[0])).toBe('pending')
  })

  it('content 过短（<5 字符）：完全跳过，无 DB 调用', async () => {
    const res = await storeMemory({
      scene, npc, tick: 3, type: 'dialogue', content: 'ok',
      aiCfg,
    })
    expect(res).toEqual({ id: null, embedded: false, status: null })
    expect(insertCalls).toHaveLength(0)
    expect(embedMock).not.toHaveBeenCalled()
  })
})

describe('ruleBasedImportance 规则打分', () => {
  it('type 基线：observation 3 / dialogue 5 / event 7', () => {
    expect(ruleBasedImportance('短语', 'observation')).toBe(3)
    expect(ruleBasedImportance('短语', 'dialogue')).toBe(5)
    expect(ruleBasedImportance('短语', 'event')).toBe(7)
  })

  it('长度加分：>40 字 +1；>100 字 +2', () => {
    const short = 'a'.repeat(39)
    const mid = 'a'.repeat(50)
    const long = 'a'.repeat(150)
    expect(ruleBasedImportance(short, 'dialogue')).toBe(5)
    expect(ruleBasedImportance(mid, 'dialogue')).toBe(6)
    expect(ruleBasedImportance(long, 'dialogue')).toBe(7)
  })

  it('标点加分：含 ? / ！ / ？ 各 +1；clamp 到 [1, 10]', () => {
    expect(ruleBasedImportance('你好吗?', 'dialogue')).toBe(6)
    /** event(7) + 长度(2) + 标点(1) = 10 */
    expect(ruleBasedImportance('a'.repeat(150) + '！', 'event')).toBe(10)
  })
})
