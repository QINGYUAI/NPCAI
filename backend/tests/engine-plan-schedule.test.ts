/**
 * [M4.4.1.b] plan 节点日程驱动分支单测（+6）
 *   Part A (3) · buildPlanPrompt 纯函数：无日程 / 日程+location / 日程无location
 *   Part B (3) · runGraph 分支（mock chat）：有事件忽略日程 / 无事件吸收日程 / nextMeta.scheduled_activity 总写
 *
 * 设计
 *   - Part A 纯函数直测，不需要 mock 任何模块
 *   - Part B 参考 tests/engine-graph.test.ts mock 同一套：llmClient / connection / memory / reflection
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────── Part A: buildPlanPrompt 纯函数 ───────────────────────
import { buildPlanPrompt } from '../src/engine/graph/prompts.js';
import type { NpcRow, SceneRow } from '../src/engine/types.js';

const scene: SceneRow = { id: 1, name: '小镇广场', description: '安静的广场', width: 800, height: 600 };
const npc: NpcRow = {
  id: 10,
  name: '小明',
  personality: '安静',
  system_prompt: '你是小明',
  simulation_meta: null,
  ai_config_id: 1,
};

describe('[M4.4.1.b] buildPlanPrompt', () => {
  it('无 scheduledActivity：system 不出现「当前时段计划」行', () => {
    const { system } = buildPlanPrompt({ scene, npc, neighbors: [], prevSummary: '', tick: 1 });
    expect(system).not.toContain('当前时段计划');
  });

  it('有 scheduledActivity + location：system 含「<activity> at <location>」', () => {
    const { system } = buildPlanPrompt({
      scene,
      npc,
      neighbors: [],
      prevSummary: '',
      tick: 1,
      scheduledActivity: { activity: '工作', location: '书房', priority: 7 },
    });
    expect(system).toContain('【当前时段计划】工作 at 书房');
  });

  it('有 scheduledActivity 但 location=null：只显示 activity，不拼 "at "', () => {
    const { system } = buildPlanPrompt({
      scene,
      npc,
      neighbors: [],
      prevSummary: '',
      tick: 1,
      scheduledActivity: { activity: '散步', location: null, priority: 5 },
    });
    expect(system).toContain('【当前时段计划】散步');
    expect(system).not.toContain(' at ');
  });
});

// ─────────────────────── Part B: runGraph 分支 (mock chat) ───────────────────────

const { chatMock } = vi.hoisted(() => ({
  chatMock: vi.fn<(...args: unknown[]) => Promise<string>>(),
}));

vi.mock('../src/utils/llmClient.js', () => ({
  chatCompletion: chatMock,
  embedText: vi.fn(async () => ({
    vector: new Array(1536).fill(0),
    model: 'text-embedding-3-small',
    cached: true,
  })),
}));

vi.mock('../src/db/connection.js', () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM ai_config')) {
        return [
          [
            {
              id: 1,
              provider: 'openai',
              api_key: 'sk-fake',
              base_url: null,
              model: 'gpt-4o-mini',
              max_tokens: 800,
            },
          ],
          null,
        ];
      }
      return [[], null];
    }),
    execute: vi.fn(async () => [{ affectedRows: 1, insertId: 1 }, null]),
  },
}));

vi.mock('../src/engine/memory/retrieve.js', () => ({
  retrieveMemories: vi.fn(async () => ({ entries: [], degraded: false })),
}));
vi.mock('../src/engine/memory/store.js', () => ({
  storeMemory: vi.fn(async () => ({ id: null, embedded: false, status: null })),
}));
vi.mock('../src/engine/reflection/reflect.js', () => ({
  reflectIfTriggered: vi.fn(async () => ({
    status: 'skipped' as const,
    reflection_ids: [],
    source_memory_ids: [],
  })),
}));

import { runGraph } from '../src/engine/graph/build.js';
import type { EventBlockItem } from '../src/engine/event/types.js';

function getPlanSystem(): string {
  const firstCall = chatMock.mock.calls[0];
  if (!firstCall) return '';
  const messages = firstCall[1] as Array<{ role: string; content: unknown }>;
  const sys = messages.find((m) => m.role === 'system');
  return typeof sys?.content === 'string' ? sys.content : '';
}

describe('[M4.4.1.b] runGraph 日程驱动分支', () => {
  beforeEach(() => {
    chatMock.mockReset();
  });

  it('有事件 + 有日程 → plan prompt 不含日程行（事件分支优先，避免 hint 干扰）', async () => {
    chatMock
      .mockResolvedValueOnce('{"plan":["看看"]}')
      .mockResolvedValueOnce('{"latest_say":"嗯","latest_action":"idle","emotion":"neutral"}')
      .mockResolvedValueOnce('{"memory_summary":"ok"}');

    const evt: EventBlockItem = {
      id: 1,
      type: 'dialogue',
      actor: '小美',
      content: '你好',
      at: new Date().toISOString(),
    } as unknown as EventBlockItem;

    await runGraph({
      scene,
      npc,
      neighbors: [],
      tick: 1,
      dryRun: false,
      eventBlock: '【最近事件】\n1. 小美: 你好',
      eventItems: [evt],
      scheduledActivity: { activity: '工作', location: '书房', priority: 7 },
    });

    const planSys = getPlanSystem();
    expect(planSys).not.toContain('当前时段计划');
  });

  it('无事件 + 有日程 → plan prompt system 含「当前时段计划」', async () => {
    chatMock
      .mockResolvedValueOnce('{"plan":["工作"]}')
      .mockResolvedValueOnce('{"latest_say":"专心","latest_action":"working","emotion":"neutral"}')
      .mockResolvedValueOnce('{"memory_summary":"ok"}');

    await runGraph({
      scene,
      npc,
      neighbors: [],
      tick: 2,
      dryRun: false,
      eventBlock: '',
      eventItems: [],
      scheduledActivity: { activity: '工作', location: '书房', priority: 7 },
    });

    const planSys = getPlanSystem();
    expect(planSys).toContain('【当前时段计划】工作 at 书房');
  });

  it('nextMeta.scheduled_activity 始终等于 input.scheduledActivity（无论事件分支）', async () => {
    chatMock
      .mockResolvedValueOnce('{"plan":["看书"]}')
      .mockResolvedValueOnce('{"latest_say":"嗨","latest_action":"read","emotion":"neutral"}')
      .mockResolvedValueOnce('{"memory_summary":"ok"}');

    const sched = { activity: '午餐', location: '餐厅', priority: 6 };
    const res = await runGraph({
      scene,
      npc,
      neighbors: [],
      tick: 3,
      dryRun: false,
      eventBlock: '【最近事件】\n1. 邻居: 今天天气不错',
      eventItems: [
        {
          id: 9,
          type: 'dialogue',
          actor: '小美',
          content: '你好',
          at: new Date().toISOString(),
        } as unknown as EventBlockItem,
      ],
      scheduledActivity: sched,
    });

    expect(res.nextMeta.scheduled_activity).toEqual(sched);
  });
});
