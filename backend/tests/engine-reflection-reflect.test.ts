/**
 * [M4.2.3.b] reflect 节点单测
 *
 * 覆盖用例
 *   1) 触发条件：tick % everyNTick === 0 且 everyNTick > 0 且 !dryRun → 正常流程
 *   2) 未命中周期：tick % everyNTick !== 0 → status='skipped'，无 LLM/DB
 *   3) dryRun=true → status='skipped'
 *   4) everyNTick=0（关闭自动反思）→ status='skipped'
 *   5) 最近记忆为空 → status='skipped'（避免空上下文瞎编）
 *   6) LLM 两次均返回非法 JSON → status='failed'
 *   7) zod 校验失败（items 不足 3 条）→ status='failed'
 *   8) 主题不完备（两条 goal）→ status='failed'
 *   9) INSERT npc_reflection 失败 → status='failed'
 *  10) 正常路径 + storeMemory 反哺：status='generated'，reflection_ids 3 个，memory_id 回填调用触发
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { chatMock, storeMemoryMock, executeMock, queryMock, pushInsertId } = vi.hoisted(() => {
  const insertIdQueue: number[] = [];
  return {
    chatMock: vi.fn(),
    storeMemoryMock: vi.fn(),
    queryMock: vi.fn(async () => [[], null]),
    executeMock: vi.fn(async (sql: string, _params: unknown[]) => {
      if (sql.includes('INSERT INTO npc_reflection')) {
        const id = insertIdQueue.shift() ?? 1000;
        return [{ insertId: id, affectedRows: 3 }, null];
      }
      if (sql.includes('UPDATE npc_reflection')) {
        return [{ insertId: 0, affectedRows: 1 }, null];
      }
      return [{ insertId: 0, affectedRows: 0 }, null];
    }),
    pushInsertId: (id: number) => {
      insertIdQueue.push(id);
    },
  };
});

vi.mock('../src/utils/llmClient.js', () => ({
  chatCompletion: chatMock,
}));

vi.mock('../src/engine/memory/store.js', () => ({
  storeMemory: storeMemoryMock,
}));

/** 默认 reflection 配置：每 5 tick 反思一次，拉 20 条记忆；单用例可 mockReturnValueOnce 覆写 */
const baseConfig = {
  enabled: true,
  embedModel: 'text-embedding-3-small',
  embedDim: 1536,
  topK: 3,
  retentionDays: 30,
  storeMode: 'sync' as const,
  retrieveQueryMode: 'prev_summary_plus_neighbors' as const,
  embedAiConfigId: 0,
  qdrant: { url: 'http://localhost:6333', apiKey: undefined, collection: 'npc_memory', vectorSize: 1536 },
  embedCache: { enabled: true, ttlDays: 30, dir: '.cache/embed' },
  reflection: { everyNTick: 5, recentMemoryK: 20 },
};
const { configMock } = vi.hoisted(() => ({ configMock: vi.fn() }));
vi.mock('../src/engine/memory/config.js', () => ({
  getMemoryConfig: configMock,
  resetMemoryConfig: () => {},
}));

vi.mock('../src/db/connection.js', () => ({
  pool: {
    execute: executeMock,
    query: queryMock,
  },
}));

import { reflectIfTriggered } from '../src/engine/reflection/reflect.js';
import type { NpcRow, SceneRow } from '../src/engine/types.js';

const scene: SceneRow = {
  id: 10,
  name: '集市',
  description: '熙熙攘攘',
  width: 32,
  height: 32,
};
const npc: NpcRow = {
  id: 20,
  name: '老李',
  personality: '稳重',
  system_prompt: '你是一个货郎',
  simulation_meta: null,
  ai_config_id: 4,
};
const aiCfg = {
  id: 4,
  provider: 'openai',
  api_key: 'sk-xxx',
  base_url: 'https://api.example.com',
  model: 'qwen-max',
  max_tokens: 800,
};

function fakeMemories(n = 3) {
  return Array.from({ length: n }, (_, i) => [
    {
      id: 100 + i,
      npc_id: npc.id,
      scene_id: scene.id,
      tick: 1 + i,
      type: 'observation',
      content: `记忆 ${i}`,
      importance: 5,
      created_at: new Date(),
    },
  ]).flat();
}

const validItems = [
  { theme: 'goal', content: '我要在天黑前卖完最后三匹布' },
  { theme: 'emotion', content: '有些焦虑但仍算平静' },
  { theme: 'relation', content: '与隔壁王大娘关系融洽，可合作拉客' },
];

beforeEach(() => {
  chatMock.mockReset();
  storeMemoryMock.mockReset();
  executeMock.mockClear();
  queryMock.mockReset();
  queryMock.mockResolvedValue([fakeMemories(3), null]);
  configMock.mockReset();
  configMock.mockReturnValue(baseConfig);
  storeMemoryMock.mockResolvedValue({ id: 555, embedded: true, status: 'embedded' });
});

describe('reflectIfTriggered - 触发/跳过条件', () => {
  it('dryRun=true 直接 skipped，不调 LLM 不查 DB', async () => {
    const r = await reflectIfTriggered({
      scene, npc, tick: 5, prevSummary: '', aiCfg, dryRun: true,
    });
    expect(r.status).toBe('skipped');
    expect(chatMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('tick 未命中周期（tick=3, everyN=5）→ skipped', async () => {
    const r = await reflectIfTriggered({
      scene, npc, tick: 3, prevSummary: '', aiCfg, dryRun: false,
    });
    expect(r.status).toBe('skipped');
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('everyNTick=0 全局关闭 → skipped', async () => {
    configMock.mockReturnValue({
      ...baseConfig,
      reflection: { ...baseConfig.reflection, everyNTick: 0 },
    });
    const r = await reflectIfTriggered({
      scene, npc, tick: 10, prevSummary: '', aiCfg, dryRun: false,
    });
    expect(r.status).toBe('skipped');
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('最近记忆为空 → skipped', async () => {
    queryMock.mockResolvedValueOnce([[], null]);
    const r = await reflectIfTriggered({
      scene, npc, tick: 5, prevSummary: '', aiCfg, dryRun: false,
    });
    expect(r.status).toBe('skipped');
    expect(chatMock).not.toHaveBeenCalled();
  });
});

describe('reflectIfTriggered - LLM 路径降级', () => {
  it('LLM 两次都返回非 JSON → failed', async () => {
    chatMock.mockResolvedValue('这不是 json');
    const r = await reflectIfTriggered({
      scene, npc, tick: 5, prevSummary: '', aiCfg, dryRun: false,
    });
    expect(r.status).toBe('failed');
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('zod 校验失败（items 少于 3）→ failed', async () => {
    chatMock.mockResolvedValue(
      JSON.stringify({ items: [{ theme: 'goal', content: '只有一条' }] }),
    );
    const r = await reflectIfTriggered({
      scene, npc, tick: 5, prevSummary: '', aiCfg, dryRun: false,
    });
    expect(r.status).toBe('failed');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('主题不完备（goal 出现两次）→ failed', async () => {
    const bad = {
      items: [
        { theme: 'goal', content: 'A' },
        { theme: 'goal', content: 'B' },
        { theme: 'emotion', content: 'C' },
      ],
    };
    chatMock.mockResolvedValue(JSON.stringify(bad));
    const r = await reflectIfTriggered({
      scene, npc, tick: 5, prevSummary: '', aiCfg, dryRun: false,
    });
    expect(r.status).toBe('failed');
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('reflectIfTriggered - 正常路径', () => {
  it('生成 3 条反思 + 双写 npc_memory → generated，reflection_ids 连续', async () => {
    chatMock.mockResolvedValue(JSON.stringify({ items: validItems }));
    pushInsertId(2001);
    const r = await reflectIfTriggered({
      scene, npc, tick: 10, prevSummary: '旧摘要', aiCfg, dryRun: false,
    });
    expect(r.status).toBe('generated');
    expect(r.items).toHaveLength(3);
    expect(r.reflection_ids).toEqual([2001, 2002, 2003]);
    expect(r.source_memory_ids).toEqual([100, 101, 102]);

    /** INSERT 1 次 + UPDATE 3 次（回填 memory_id） */
    const insertCalls = executeMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO npc_reflection'),
    );
    const updateCalls = executeMock.mock.calls.filter((c) =>
      String(c[0]).includes('UPDATE npc_reflection'),
    );
    expect(insertCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(3);

    /** 每条反思都反哺 storeMemory */
    expect(storeMemoryMock).toHaveBeenCalledTimes(3);
    const themes = storeMemoryMock.mock.calls.map((c) => (c[0] as { content: string }).content);
    expect(themes[0]).toMatch(/^\[goal\]/);
    expect(themes[1]).toMatch(/^\[emotion\]/);
    expect(themes[2]).toMatch(/^\[relation\]/);
  });

  it('INSERT 失败 → failed，不触发 storeMemory', async () => {
    chatMock.mockResolvedValue(JSON.stringify({ items: validItems }));
    executeMock.mockImplementationOnce(async (sql: string) => {
      if (sql.includes('INSERT INTO npc_reflection')) {
        throw new Error('duplicate constraint');
      }
      return [{ insertId: 0, affectedRows: 0 }, null];
    });
    const r = await reflectIfTriggered({
      scene, npc, tick: 5, prevSummary: '', aiCfg, dryRun: false,
    });
    expect(r.status).toBe('failed');
    expect(storeMemoryMock).not.toHaveBeenCalled();
  });

  it('storeMemory 反哺失败不影响 generated', async () => {
    chatMock.mockResolvedValue(JSON.stringify({ items: validItems }));
    pushInsertId(3001);
    storeMemoryMock.mockRejectedValue(new Error('embed down'));
    const r = await reflectIfTriggered({
      scene, npc, tick: 5, prevSummary: '', aiCfg, dryRun: false,
    });
    expect(r.status).toBe('generated');
    expect(r.reflection_ids).toEqual([3001, 3002, 3003]);
  });
});
