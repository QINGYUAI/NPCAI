/**
 * [M4.2.3.c] POST /api/engine/reflect 控制器测试（mock pool + reflectIfTriggered + bus）
 *
 * 覆盖用例
 *   1) 参数校验：scene_id/npc_id 缺失或非正整数 → 400
 *   2) scene_npc 关系缺失 → 404 NPC_NOT_IN_SCENE
 *   3) NPC 未绑定 ai_config_id → 422 NPC_AI_CONFIG_MISSING
 *   4) ai_config 存在但 status!=1 → 422 AI_CONFIG_INVALID
 *   5) 引擎停机：tick = MAX(tick_log.tick) + 1（从 7 升 8）
 *   6) 引擎停机 + 该 NPC 从无 tick：tick = 1
 *   7) 引擎运行中：tick = scheduler.status().tick
 *   8) status='generated' → emit bus + 返回 200 + items/reflection_ids
 *   9) status='failed'    → 不 emit bus，但仍 200 返回给前端感知
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQueryMock, reflectMock, schedulerRef, busEmitMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  reflectMock: vi.fn(),
  schedulerRef: { current: null as null | { isRunning: boolean; status: () => { tick: number } } },
  busEmitMock: vi.fn(),
}));

vi.mock('../src/db/connection.js', () => ({
  pool: {
    query: poolQueryMock,
    execute: vi.fn(),
  },
}));

vi.mock('../src/engine/reflection/reflect.js', () => ({
  reflectIfTriggered: reflectMock,
}));

vi.mock('../src/engine/registry.js', () => ({
  getScheduler: () => schedulerRef.current,
}));

vi.mock('../src/engine/bus.js', () => ({
  bus: { emitEvent: busEmitMock },
}));

vi.mock('../src/engine/index.js', () => ({
  isEngineEnabled: () => true,
}));

import { engineRouter } from '../src/routes/engine.js';

const app = express();
app.use(express.json());
app.use('/api/engine', engineRouter);

const SCENE_ROW = { id: 1, name: '集市', description: null, width: 32, height: 32 };
const NPC_ROW = {
  id: 10,
  name: '老李',
  personality: '稳重',
  system_prompt: 'sys',
  simulation_meta: { memory_summary: '旧摘要', version: '1.0', last_tick_at: '' },
  ai_config_id: 4,
};
const AI_ROW = {
  id: 4,
  provider: 'openai',
  api_key: 'sk-xxx',
  base_url: 'https://api.example.com',
  model: 'qwen-max',
  max_tokens: 800,
};

function mountPool(opts: {
  linked?: boolean;
  scene?: unknown;
  npc?: Partial<typeof NPC_ROW> | null;
  aiCfg?: Partial<typeof AI_ROW> | null;
  lastTick?: number | null;
}) {
  poolQueryMock.mockImplementation(async (sql: string, _params: unknown[]) => {
    if (sql.includes('FROM scene_npc')) {
      return [opts.linked === false ? [] : [{ scene_id: 1 }], null];
    }
    if (sql.includes('FROM scene WHERE id')) {
      return [opts.scene === null ? [] : [opts.scene ?? SCENE_ROW], null];
    }
    if (sql.includes('FROM npc WHERE id')) {
      return [opts.npc === null ? [] : [{ ...NPC_ROW, ...(opts.npc || {}) }], null];
    }
    if (sql.includes('FROM ai_config WHERE id')) {
      return [opts.aiCfg === null ? [] : [{ ...AI_ROW, ...(opts.aiCfg || {}) }], null];
    }
    if (sql.includes('MAX(tick)')) {
      return [[{ last_tick: opts.lastTick ?? null }], null];
    }
    return [[], null];
  });
}

beforeEach(() => {
  poolQueryMock.mockReset();
  reflectMock.mockReset();
  busEmitMock.mockReset();
  schedulerRef.current = null;
});

describe('POST /api/engine/reflect - 参数校验', () => {
  it('scene_id 缺失 → 400', async () => {
    const r = await request(app).post('/api/engine/reflect').send({ npc_id: 10 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_PARAM');
  });
  it('npc_id 非正整数 → 400', async () => {
    const r = await request(app)
      .post('/api/engine/reflect')
      .send({ scene_id: 1, npc_id: -5 });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/engine/reflect - 绑定/配置错误', () => {
  it('scene_npc 无关联 → 404', async () => {
    mountPool({ linked: false });
    const r = await request(app)
      .post('/api/engine/reflect')
      .send({ scene_id: 1, npc_id: 10 });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('NPC_NOT_IN_SCENE');
    expect(reflectMock).not.toHaveBeenCalled();
  });
  it('NPC.ai_config_id=null → 422 NPC_AI_CONFIG_MISSING', async () => {
    mountPool({ npc: { ai_config_id: null as unknown as number } });
    const r = await request(app)
      .post('/api/engine/reflect')
      .send({ scene_id: 1, npc_id: 10 });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('NPC_AI_CONFIG_MISSING');
  });
  it('ai_config 查不到（status!=1 或不存在）→ 422 AI_CONFIG_INVALID', async () => {
    mountPool({ aiCfg: null });
    const r = await request(app)
      .post('/api/engine/reflect')
      .send({ scene_id: 1, npc_id: 10 });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('AI_CONFIG_INVALID');
  });
});

describe('POST /api/engine/reflect - tick 取值', () => {
  it('引擎停机 + 历史 tick=7 → 使用 tick=8', async () => {
    mountPool({ lastTick: 7 });
    reflectMock.mockResolvedValue({
      status: 'generated',
      items: [
        { theme: 'goal', content: 'A' },
        { theme: 'emotion', content: 'B' },
        { theme: 'relation', content: 'C' },
      ],
      reflection_ids: [1001, 1002, 1003],
      source_memory_ids: [50, 51],
    });
    const r = await request(app)
      .post('/api/engine/reflect')
      .send({ scene_id: 1, npc_id: 10 });
    expect(r.status).toBe(200);
    expect(r.body.data.tick).toBe(8);
    /** reflect 节点被 force=true 调用一次 */
    expect(reflectMock).toHaveBeenCalledTimes(1);
    const arg = reflectMock.mock.calls[0]?.[0];
    expect(arg.force).toBe(true);
    expect(arg.tick).toBe(8);
    expect(arg.prevSummary).toBe('旧摘要');
  });

  it('引擎停机 + 该 NPC 无历史 → tick=1', async () => {
    mountPool({ lastTick: null });
    reflectMock.mockResolvedValue({
      status: 'skipped',
      items: [],
      reflection_ids: [],
      source_memory_ids: [],
    });
    const r = await request(app)
      .post('/api/engine/reflect')
      .send({ scene_id: 1, npc_id: 10 });
    expect(r.status).toBe(200);
    expect(r.body.data.tick).toBe(1);
    expect(r.body.data.status).toBe('skipped');
  });

  it('引擎运行中 → 使用 scheduler.tick', async () => {
    mountPool({ lastTick: 7 });
    schedulerRef.current = {
      isRunning: true,
      status: () => ({ tick: 42 }),
    };
    reflectMock.mockResolvedValue({
      status: 'generated',
      items: [
        { theme: 'goal', content: 'A' },
        { theme: 'emotion', content: 'B' },
        { theme: 'relation', content: 'C' },
      ],
      reflection_ids: [2001, 2002, 2003],
      source_memory_ids: [],
    });
    const r = await request(app)
      .post('/api/engine/reflect')
      .send({ scene_id: 1, npc_id: 10 });
    expect(r.status).toBe(200);
    expect(r.body.data.tick).toBe(42);
  });
});

describe('POST /api/engine/reflect - 返回 + WS 广播', () => {
  it('status=generated → emit reflection.created + 返回 items/reflection_ids', async () => {
    mountPool({ lastTick: 3 });
    reflectMock.mockResolvedValue({
      status: 'generated',
      items: [
        { theme: 'goal', content: '目标 X' },
        { theme: 'emotion', content: '情绪 Y' },
        { theme: 'relation', content: '关系 Z' },
      ],
      reflection_ids: [501, 502, 503],
      source_memory_ids: [11, 12, 13],
    });
    const r = await request(app)
      .post('/api/engine/reflect')
      .send({ scene_id: 1, npc_id: 10 });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('generated');
    expect(r.body.data.reflection_ids).toEqual([501, 502, 503]);
    expect(r.body.data.items).toHaveLength(3);

    expect(busEmitMock).toHaveBeenCalledTimes(1);
    const ev = busEmitMock.mock.calls[0]?.[0];
    expect(ev.type).toBe('reflection.created');
    expect(ev.tick).toBe(4);
    expect(ev.npc_id).toBe(10);
    expect(ev.items).toHaveLength(3);
  });

  it('status=failed → 不 emit bus，但仍 HTTP 200 供前端感知', async () => {
    mountPool({ lastTick: 3 });
    reflectMock.mockResolvedValue({
      status: 'failed',
      items: [],
      reflection_ids: [],
      source_memory_ids: [],
    });
    const r = await request(app)
      .post('/api/engine/reflect')
      .send({ scene_id: 1, npc_id: 10 });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('failed');
    expect(busEmitMock).not.toHaveBeenCalled();
  });
});
