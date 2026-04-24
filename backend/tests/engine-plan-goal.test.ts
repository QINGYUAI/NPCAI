/**
 * [M4.5.1.b] plan 节点三路分支单测（+11）
 *
 *   Part A (6) · computePlanPath 纯函数：event > goal > schedule > idle 所有路径 + 平手/低优 2 用例
 *   Part B (3) · buildPlanPrompt 纯函数：activeGoal 注入、goal 与 schedule 互斥、goal 空 title 降级
 *   Part C (2) · runGraph 分支（mock chat）：goal 命中 → prompt 含【当前目标】；meta.plan_path/active_goal 正确落档
 *
 * 设计
 *   - Part A/B 脱离 DB / LLM，最快；Part C 参考 engine-plan-schedule.test.ts 同一套 mock
 *   - 覆盖"goal priority < schedule priority 回退 schedule"这一最容易被漏掉的分支
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ────────────────────────── Part A: computePlanPath ──────────────────────────
import { computePlanPath } from '../src/engine/graph/planPath.js';

describe('[M4.5.1.b] computePlanPath', () => {
  it('hasEvents=true 恒返回 event（即便有 goal 与高优先级日程）', () => {
    expect(
      computePlanPath({
        hasEvents: true,
        activeGoal: { id: 1, title: '找小美', priority: 10 },
        scheduledActivity: { activity: '工作', location: '书房', priority: 9 },
      }),
    ).toBe('event');
  });

  it('无事件 + goal.priority ≥ schedule.priority → goal（平手 goal 先赢）', () => {
    expect(
      computePlanPath({
        hasEvents: false,
        activeGoal: { id: 1, title: '找小美', priority: 7 },
        scheduledActivity: { activity: '工作', location: '书房', priority: 7 },
      }),
    ).toBe('goal');
  });

  it('无事件 + goal.priority < schedule.priority → schedule（日程高优盖过弱目标）', () => {
    expect(
      computePlanPath({
        hasEvents: false,
        activeGoal: { id: 1, title: '闲逛', priority: 3 },
        scheduledActivity: { activity: '演讲', location: '礼堂', priority: 9 },
      }),
    ).toBe('schedule');
  });

  it('无事件 + 无 goal + 有 schedule → schedule', () => {
    expect(
      computePlanPath({
        hasEvents: false,
        activeGoal: null,
        scheduledActivity: { activity: '午餐', location: null, priority: 5 },
      }),
    ).toBe('schedule');
  });

  it('无事件 + 有 goal + 无 schedule → goal（日程 0 视作未覆盖，goal 任意 priority 都赢）', () => {
    expect(
      computePlanPath({
        hasEvents: false,
        activeGoal: { id: 1, title: '练琴', priority: 1 },
        scheduledActivity: null,
      }),
    ).toBe('goal');
  });

  it('三者皆无 → idle', () => {
    expect(
      computePlanPath({ hasEvents: false, activeGoal: null, scheduledActivity: null }),
    ).toBe('idle');
  });
});

// ────────────────────────── Part B: buildPlanPrompt activeGoal ──────────────────────────
import { buildPlanPrompt } from '../src/engine/graph/prompts.js';
import type { NpcRow, SceneRow } from '../src/engine/types.js';

const scene: SceneRow = { id: 1, name: '小镇广场', description: '安静', width: 800, height: 600 };
const npc: NpcRow = {
  id: 10,
  name: '小明',
  personality: '安静',
  system_prompt: '你是小明',
  simulation_meta: null,
  ai_config_id: 1,
};

describe('[M4.5.1.b] buildPlanPrompt activeGoal 注入', () => {
  it('activeGoal 非空 → system 含「【当前目标】<title>」', () => {
    const { system } = buildPlanPrompt({
      scene,
      npc,
      neighbors: [],
      prevSummary: '',
      tick: 1,
      activeGoal: { id: 99, title: '去找小美和好', priority: 8 },
    });
    expect(system).toContain('【当前目标】去找小美和好');
    expect(system).not.toContain('当前时段计划');
  });

  it('activeGoal + scheduledActivity 同时给 → goal 胜出，不注入日程行（调用方应强制二选一）', () => {
    const { system } = buildPlanPrompt({
      scene,
      npc,
      neighbors: [],
      prevSummary: '',
      tick: 1,
      activeGoal: { id: 99, title: '去找小美', priority: 8 },
      scheduledActivity: { activity: '工作', location: '书房', priority: 6 },
    });
    expect(system).toContain('【当前目标】去找小美');
    expect(system).not.toContain('【当前时段计划】');
  });

  it('activeGoal.title 空白 → 降级为日程行（若有 schedule）', () => {
    const { system } = buildPlanPrompt({
      scene,
      npc,
      neighbors: [],
      prevSummary: '',
      tick: 1,
      activeGoal: { id: 99, title: '   ', priority: 8 },
      scheduledActivity: { activity: '午餐', location: '餐厅', priority: 6 },
    });
    expect(system).not.toContain('【当前目标】');
    expect(system).toContain('【当前时段计划】午餐 at 餐厅');
  });
});

// ────────────────────────── Part C: runGraph 三路分支（mock chat）──────────────────────────

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

function getPlanSystem(): string {
  const firstCall = chatMock.mock.calls[0];
  if (!firstCall) return '';
  const messages = firstCall[1] as Array<{ role: string; content: unknown }>;
  const sys = messages.find((m) => m.role === 'system');
  return typeof sys?.content === 'string' ? sys.content : '';
}

describe('[M4.5.1.b] runGraph 三路分支', () => {
  beforeEach(() => {
    chatMock.mockReset();
  });

  it('goal 命中：plan prompt 含【当前目标】; meta.plan_path="goal"; meta.active_goal 完整', async () => {
    chatMock
      .mockResolvedValueOnce('{"plan":["去找小美"]}')
      .mockResolvedValueOnce('{"latest_say":"要去找她","latest_action":"walking","emotion":"curious"}')
      .mockResolvedValueOnce('{"memory_summary":"ok"}');

    const res = await runGraph({
      scene,
      npc,
      neighbors: [],
      tick: 5,
      dryRun: false,
      eventBlock: '',
      eventItems: [],
      scheduledActivity: { activity: '工作', location: '书房', priority: 5 },
      activeGoal: { id: 42, title: '去找小美和好', priority: 8 },
    });

    const planSys = getPlanSystem();
    expect(planSys).toContain('【当前目标】去找小美和好');
    expect(planSys).not.toContain('【当前时段计划】');
    expect(res.nextMeta.plan_path).toBe('goal');
    expect(res.nextMeta.active_goal).toEqual({ id: 42, title: '去找小美和好', priority: 8 });
    /** scheduled_activity 仍原样写档便于 UI 兜底 */
    expect(res.nextMeta.scheduled_activity).toEqual({ activity: '工作', location: '书房', priority: 5 });
  });

  it('goal.priority < schedule.priority：回退 schedule 分支；meta.active_goal=null', async () => {
    chatMock
      .mockResolvedValueOnce('{"plan":["工作"]}')
      .mockResolvedValueOnce('{"latest_say":"专心","latest_action":"working","emotion":"neutral"}')
      .mockResolvedValueOnce('{"memory_summary":"ok"}');

    const res = await runGraph({
      scene,
      npc,
      neighbors: [],
      tick: 6,
      dryRun: false,
      eventBlock: '',
      eventItems: [],
      scheduledActivity: { activity: '演讲', location: '礼堂', priority: 9 },
      activeGoal: { id: 43, title: '闲逛', priority: 3 },
    });

    const planSys = getPlanSystem();
    expect(planSys).toContain('【当前时段计划】演讲 at 礼堂');
    expect(planSys).not.toContain('【当前目标】');
    expect(res.nextMeta.plan_path).toBe('schedule');
    expect(res.nextMeta.active_goal).toBeNull();
  });
});
