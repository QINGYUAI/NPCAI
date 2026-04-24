/**
 * [M4.5.0 U-B] memory-store slot_hour 分支单测
 *
 * 覆盖（纯 slot_hour 开关 / 边界，与现有 store.test.ts 解耦）：
 *   1) slotHourEnabled=true + 合法 slotHour → INSERT 末位参数为该数字
 *   2) slotHourEnabled=true + 越界 slotHour=24 → INSERT 末位参数为 null（保守降级）
 *   3) slotHourEnabled=false + 任意 slotHour → INSERT 末位参数为 null（总开关生效）
 *
 * 约束：不引入数据库、Qdrant、embed 真实实现；mock memory/config 的 slotHourEnabled 随用例切换
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ZERO_VEC = new Array(1536).fill(0);

const { embedMock, upsertMock, executeMock, insertCalls, cfgRef } = vi.hoisted(() => {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const ref: { slotHourEnabled: boolean } = { slotHourEnabled: true };
  return {
    embedMock: vi.fn(),
    upsertMock: vi.fn(),
    insertCalls: inserts,
    cfgRef: ref,
    executeMock: vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO npc_memory')) {
        return [{ insertId: 999, affectedRows: 1 }, null];
      }
      if (sql.includes('UPDATE npc_memory')) {
        return [{ insertId: 0, affectedRows: 1 }, null];
      }
      return [{ insertId: 0, affectedRows: 0 }, null];
    }),
  };
});

vi.mock('../src/utils/llmClient.js', () => ({
  embedText: embedMock,
}));

vi.mock('../src/engine/memory/config.js', () => ({
  getMemoryConfig: () => ({
    enabled: true,
    embedModel: 'text-embedding-3-small',
    embedDim: 1536,
    topK: 3,
    retentionDays: 30,
    storeMode: 'sync',
    retrieveQueryMode: 'prev_summary_plus_neighbors',
    reflection: { everyNTick: 5, recentMemoryK: 20 },
    slotHourEnabled: cfgRef.slotHourEnabled,
    embedAiConfigId: 0,
    qdrant: {
      url: 'http://localhost:6333',
      apiKey: undefined,
      collection: 'npc_memory',
      vectorSize: 1536,
    },
    embedCache: { enabled: true, ttlDays: 30, dir: '.cache/embed' },
  }),
  resetMemoryConfig: () => {},
}));

const qdrantStore = {
  upsert: upsertMock,
  search: vi.fn(),
  deleteByIds: vi.fn(),
  ensureCollection: vi.fn(),
  health: vi.fn().mockResolvedValue(true),
};
vi.mock('../src/engine/memory/qdrantClient.js', () => ({
  getQdrantMemoryStore: () => qdrantStore,
  QdrantUnavailableError: class QdrantUnavailableError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'QdrantUnavailableError';
    }
  },
}));

vi.mock('../src/db/connection.js', () => ({
  pool: {
    execute: (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO npc_memory')) {
        insertCalls.push({ sql, params });
      }
      return executeMock(sql, params);
    },
    query: vi.fn(async () => [[], null]),
  },
}));

import { storeMemory } from '../src/engine/memory/store.js';
import type { NpcRow, SceneRow } from '../src/engine/types.js';

const scene: SceneRow = { id: 1, name: 'Park', description: null, width: 800, height: 600 };
const npc: NpcRow = {
  id: 10,
  name: 'Alice',
  personality: null,
  system_prompt: null,
  simulation_meta: null,
  ai_config_id: 1,
};
const aiCfg = { id: 1, api_key: 'sk-fake', base_url: null, provider: 'openai' };

describe('[M4.5.0 U-B] memory.store slot_hour 写入分支', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    executeMock.mockClear();
    embedMock.mockReset();
    upsertMock.mockReset();
    embedMock.mockResolvedValue({
      vector: ZERO_VEC,
      model: 'text-embedding-3-small',
      cached: false,
    });
    upsertMock.mockResolvedValue(undefined);
    cfgRef.slotHourEnabled = true;
  });

  it('slotHourEnabled=true + slotHour=10 → INSERT 末位参数 = 10', async () => {
    await storeMemory({
      scene,
      npc,
      tick: 3,
      type: 'dialogue',
      content: '今天下午三点的阳光很舒服',
      aiCfg,
      slotHour: 10,
    });
    expect(insertCalls).toHaveLength(1);
    const params = insertCalls[0]!.params as unknown[];
    /** params 顺序：npc_id, scene_id, tick, type, content, importance, trace_id, slot_hour */
    expect(params[params.length - 1]).toBe(10);
  });

  it('slotHourEnabled=true + slotHour=24（越界）→ 末位参数 = null', async () => {
    await storeMemory({
      scene,
      npc,
      tick: 3,
      type: 'dialogue',
      content: '今天下午三点的阳光很舒服',
      aiCfg,
      slotHour: 24,
    });
    const params = insertCalls[0]!.params as unknown[];
    expect(params[params.length - 1]).toBeNull();
  });

  it('slotHourEnabled=false + slotHour=10 → 末位参数 = null（总开关拦截）', async () => {
    cfgRef.slotHourEnabled = false;
    await storeMemory({
      scene,
      npc,
      tick: 3,
      type: 'dialogue',
      content: '今天下午三点的阳光很舒服',
      aiCfg,
      slotHour: 10,
    });
    const params = insertCalls[0]!.params as unknown[];
    expect(params[params.length - 1]).toBeNull();
  });
});
