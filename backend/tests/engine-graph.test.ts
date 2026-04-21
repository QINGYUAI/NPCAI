/**
 * 推理子图 live 模式单测
 *   - 成功：plan + speak + memory 三阶段正常
 *   - 重试：第一次 JSON 损坏，第二次恢复
 *   - 降级：两次 speak 均失败 → throw（调度器按 error 记 tick_log）
 *   - memory 失败：不影响整体，保留旧 summary
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** vi.hoisted：把 mock 工厂与外部变量都提升至 import 之前 */
const { chatMock } = vi.hoisted(() => ({
  chatMock: vi.fn<(...args: unknown[]) => Promise<string>>(),
}))

vi.mock('../src/utils/llmClient.js', () => ({
  chatCompletion: chatMock,
  /** [M4.2.2.b] retrieve/store 会依赖 embedText；这里返回固定空向量避免噪音，测试关注 chat 节点行为 */
  embedText: vi.fn(async () => ({ vector: new Array(1536).fill(0), model: 'text-embedding-3-small', cached: true })),
}))

/** mock pool.query/execute：ai_config 单行查询 + store/retrieve 的 MySQL 调用 */
vi.mock('../src/db/connection.js', () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM ai_config')) {
        return [[{ id: 1, provider: 'openai', api_key: 'sk-fake', base_url: null, model: 'gpt-4o-mini', max_tokens: 800 }], null]
      }
      /** retrieve 降级查询返回空 */
      return [[], null]
    }),
    /** store 节点 INSERT npc_memory + UPDATE embed_status 全部走 execute */
    execute: vi.fn(async () => [{ affectedRows: 1, insertId: 1 }, null]),
  },
}))

/** [M4.2.2.b] memory-retrieve 在真实测试中由 memory-retrieve.test.ts 覆盖；这里用空实现避免与本测关心的节点耦合 */
vi.mock('../src/engine/memory/retrieve.js', () => ({
  retrieveMemories: vi.fn(async () => ({ entries: [], degraded: false })),
}))

/** [M4.2.2.b] memory-store 同理：写入由 memory-store.test.ts 专门覆盖 */
vi.mock('../src/engine/memory/store.js', () => ({
  storeMemory: vi.fn(async () => ({ id: null, embedded: false, status: null })),
}))

import { runGraph } from '../src/engine/graph/build.js'
import type { NpcRow, SceneRow } from '../src/engine/types.js'

const scene: SceneRow = { id: 1, name: '集市', description: '嘈杂的小镇集市', width: 800, height: 600 }
const npc: NpcRow = {
  id: 10,
  name: 'Alice',
  personality: '开朗、爱聊天',
  system_prompt: '你是集市上的花店老板 Alice，语气温暖。',
  simulation_meta: null,
  ai_config_id: 1,
}

beforeEach(() => {
  chatMock.mockReset()
})

describe('runGraph(live)', () => {
  it('三节点均成功，产出完整 meta', async () => {
    chatMock
      .mockResolvedValueOnce('{"plan":["整理花束","招呼过路人","清点零钱"]}')
      .mockResolvedValueOnce('{"latest_say":"今天的玫瑰开得真好","latest_action":"arranging_flowers","emotion":"happy"}')
      .mockResolvedValueOnce('{"memory_summary":"今天集市很热闹，我在整理玫瑰花束。"}')

    const res = await runGraph({ scene, npc, neighbors: [], tick: 1, dryRun: false })
    expect(res.nextMeta.version).toBe('1.0')
    expect(res.nextMeta.latest_say).toBe('今天的玫瑰开得真好')
    expect(res.nextMeta.latest_action).toBe('arranging_flowers')
    expect(res.nextMeta.emotion).toBe('happy')
    expect(res.nextMeta.plan).toEqual(['整理花束', '招呼过路人', '清点零钱'])
    expect(res.nextMeta.memory_summary).toBe('今天集市很热闹，我在整理玫瑰花束。')
    expect(chatMock).toHaveBeenCalledTimes(3)
  })

  it('speak 第一次 JSON 损坏第二次恢复：重试成功', async () => {
    chatMock
      .mockResolvedValueOnce('{"plan":["看看书"]}')
      .mockResolvedValueOnce('这不是 JSON')
      .mockResolvedValueOnce('{"latest_say":"好","latest_action":"reading","emotion":"curious"}')
      .mockResolvedValueOnce('{"memory_summary":"读了点书"}')

    const res = await runGraph({ scene, npc, neighbors: [], tick: 2, dryRun: false })
    expect(res.nextMeta.latest_say).toBe('好')
    expect(res.nextMeta.emotion).toBe('curious')
  })

  it('speak 两次都失败 → 抛错由调度器记 error', async () => {
    chatMock
      .mockResolvedValueOnce('{"plan":["闲逛"]}')
      .mockResolvedValueOnce('坏 JSON 1')
      .mockResolvedValueOnce('坏 JSON 2')

    await expect(runGraph({ scene, npc, neighbors: [], tick: 3, dryRun: false })).rejects.toThrow(/speak/)
  })

  it('memory 失败不影响整体；保留上一轮 summary', async () => {
    const npcWithMem: NpcRow = {
      ...npc,
      simulation_meta: { version: '1.0', last_tick_at: '2026-01-01T00:00:00Z', memory_summary: '旧记忆' },
    }
    chatMock
      .mockResolvedValueOnce('{"plan":["散步"]}')
      .mockResolvedValueOnce('{"latest_say":"走走","latest_action":"walking","emotion":"neutral"}')
      .mockResolvedValueOnce('糟糕 JSON')
      .mockResolvedValueOnce('也坏')

    const res = await runGraph({ scene, npc: npcWithMem, neighbors: [], tick: 4, dryRun: false })
    expect(res.nextMeta.memory_summary).toBe('旧记忆')
    expect(res.nextMeta.latest_say).toBe('走走')
  })

  it('plan 失败但 speak 成功：使用兜底 plan 继续', async () => {
    chatMock
      .mockResolvedValueOnce('plan 坏')
      .mockResolvedValueOnce('plan 也坏')
      .mockResolvedValueOnce('{"latest_say":"嗨","latest_action":"idle","emotion":"neutral"}')
      .mockResolvedValueOnce('{"memory_summary":"默认记忆"}')

    const res = await runGraph({ scene, npc, neighbors: [], tick: 5, dryRun: false })
    expect(res.nextMeta.plan && res.nextMeta.plan.length).toBeGreaterThan(0)
    expect(res.nextMeta.latest_say).toBe('嗨')
  })
})

describe('runGraph(dry_run)', () => {
  it('不调用 LLM，产出确定性 meta', async () => {
    const res = await runGraph({ scene, npc, neighbors: [], tick: 1, dryRun: true })
    expect(chatMock).not.toHaveBeenCalled()
    expect(res.nextMeta.version).toBe('1.0')
    expect(res.nextMeta.debug?.dry_run).toBe(true)
  })
})
