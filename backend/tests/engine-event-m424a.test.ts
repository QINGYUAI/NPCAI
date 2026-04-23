/**
 * [M4.2.4.a] 事件总线数据层 / Prompt 基建 单测
 *
 * 覆盖模块
 *   - engine/event/config.ts：getEventConfig env 解析 + 校验 + 缓存重置
 *   - engine/event/types.ts：EVENT_TYPES 常量
 *   - engine/event/prompts.ts：createSceneEventSchema zod 边界 + hasEvents + buildEventBlock 格式化
 *   - engine/graph/prompts.ts：buildPlanPrompt 新增的 eventBlock 注入位置 + 向后兼容
 *
 * 断言侧重点
 *   - 默认/边界/非法 env 路径都能走通或 throw；error 文案包含关键字以便排查
 *   - zod schema 拒错给出「人类能读」的 message（含字段名 + 限额）
 *   - buildEventBlock 在 content 多空白 / 超长 / actor 空 / actor 有值 四种下一致输出
 *   - buildPlanPrompt 在不注入事件时保持与 M4.2.3 之前完全相同的 user 字符串（向后兼容）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEventConfig, resetEventConfig } from '../src/engine/event/config.js';
import { EVENT_TYPES } from '../src/engine/event/types.js';
import {
  buildEventBlock,
  createSceneEventSchema,
  hasEvents,
} from '../src/engine/event/prompts.js';
import { buildPlanPrompt } from '../src/engine/graph/prompts.js';
import type { EventBlockItem, EventType } from '../src/engine/event/types.js';
import type { NpcRow, SceneRow } from '../src/engine/types.js';

/** 隔离 env：每个 case 前重置 + 保存原值 */
const ORIG_ENV = { ...process.env };
beforeEach(() => {
  resetEventConfig();
});
afterEach(() => {
  process.env = { ...ORIG_ENV };
  resetEventConfig();
});

/* -------------------------------- config.ts -------------------------------- */

describe('[M4.2.4.a] getEventConfig env 解析', () => {
  it('默认值：[M4.4.0] enabled=true / lookback=120s / count=50 / max=10', () => {
    delete process.env.EVENT_BUS_ENABLED;
    delete process.env.EVENT_LOOKBACK_SECONDS;
    delete process.env.EVENT_LOOKBACK_COUNT;
    delete process.env.EVENT_MAX_PER_TICK;
    const cfg = getEventConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.lookbackSeconds).toBe(120);
    expect(cfg.lookbackCount).toBe(50);
    expect(cfg.maxPerTick).toBe(10);
  });

  it('EVENT_BUS_ENABLED=false 真实关闭', () => {
    process.env.EVENT_BUS_ENABLED = 'false';
    expect(getEventConfig().enabled).toBe(false);
  });

  it('自定义正整数生效', () => {
    process.env.EVENT_LOOKBACK_SECONDS = '120';
    process.env.EVENT_MAX_PER_TICK = '3';
    const cfg = getEventConfig();
    expect(cfg.lookbackSeconds).toBe(120);
    expect(cfg.maxPerTick).toBe(3);
  });

  it('EVENT_LOOKBACK_SECONDS=0 抛错（正整数）', () => {
    process.env.EVENT_LOOKBACK_SECONDS = '0';
    expect(() => getEventConfig()).toThrow(/EVENT_LOOKBACK_SECONDS.*正整数/);
  });

  it('EVENT_MAX_PER_TICK=-1 抛错', () => {
    process.env.EVENT_MAX_PER_TICK = '-1';
    expect(() => getEventConfig()).toThrow(/EVENT_MAX_PER_TICK.*正整数/);
  });

  it('EVENT_LOOKBACK_SECONDS=NaN 抛错', () => {
    process.env.EVENT_LOOKBACK_SECONDS = 'abc';
    expect(() => getEventConfig()).toThrow(/EVENT_LOOKBACK_SECONDS.*正整数/);
  });

  it('二次调用命中缓存；resetEventConfig 后生效新 env', () => {
    process.env.EVENT_MAX_PER_TICK = '5';
    expect(getEventConfig().maxPerTick).toBe(5);
    process.env.EVENT_MAX_PER_TICK = '7';
    expect(getEventConfig().maxPerTick).toBe(5);
    resetEventConfig();
    expect(getEventConfig().maxPerTick).toBe(7);
  });
});

/* -------------------------------- types.ts --------------------------------- */

describe('[M4.2.4.a] EVENT_TYPES 常量稳定性', () => {
  it('固定 4 枚举，顺序对齐 MySQL ENUM', () => {
    expect(EVENT_TYPES).toEqual(['weather', 'dialogue', 'system', 'plot']);
  });
});

/* ------------------------------ prompts.ts zod ------------------------------ */

describe('[M4.2.4.a] createSceneEventSchema 入库校验', () => {
  const baseValid = { type: 'weather' as EventType, content: '天色阴沉' };

  it('最简合法 body 解析成功', () => {
    const out = createSceneEventSchema.parse(baseValid);
    expect(out.content).toBe('天色阴沉');
    expect(out.actor ?? null).toBe(null);
  });

  it('全量合法 body（含 payload / visible_npcs / actor）解析成功', () => {
    const body = {
      type: 'plot' as EventType,
      content: '  街角传来喧闹声  ',
      actor: '  旁白  ',
      payload: { intensity: 3, source: 'dice' },
      visible_npcs: [1, 2, 3],
    };
    const out = createSceneEventSchema.parse(body);
    expect(out.content).toBe('街角传来喧闹声');
    expect(out.actor).toBe('旁白');
    expect(out.payload).toEqual({ intensity: 3, source: 'dice' });
    expect(out.visible_npcs).toEqual([1, 2, 3]);
  });

  it('actor 空字符串被 transform 为 null（与不传语义一致）', () => {
    const out = createSceneEventSchema.parse({ ...baseValid, actor: '   ' });
    expect(out.actor).toBe(null);
  });

  it('type 不在 4 枚举内 → 失败', () => {
    const r = createSceneEventSchema.safeParse({ ...baseValid, type: 'fire' });
    expect(r.success).toBe(false);
  });

  it('content 全空白 → 失败（含 content 关键字）', () => {
    const r = createSceneEventSchema.safeParse({ ...baseValid, content: '   ' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join('.')).join(',')).toContain('content');
    }
  });

  it('content 超过 500 字 → 失败', () => {
    const r = createSceneEventSchema.safeParse({ ...baseValid, content: 'x'.repeat(501) });
    expect(r.success).toBe(false);
  });

  it('actor 超过 64 字 → 失败', () => {
    const r = createSceneEventSchema.safeParse({ ...baseValid, actor: 'a'.repeat(65) });
    expect(r.success).toBe(false);
  });

  it('payload 序列化超 2KB → 失败', () => {
    const bigStr = 'x'.repeat(2100);
    const r = createSceneEventSchema.safeParse({ ...baseValid, payload: { blob: bigStr } });
    expect(r.success).toBe(false);
  });

  it('visible_npcs 含 0/负数 → 失败', () => {
    const r = createSceneEventSchema.safeParse({ ...baseValid, visible_npcs: [1, 0, 3] });
    expect(r.success).toBe(false);
  });

  it('visible_npcs 长度超 100 → 失败', () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const r = createSceneEventSchema.safeParse({ ...baseValid, visible_npcs: ids });
    expect(r.success).toBe(false);
  });

  it('空数组 visible_npcs 合法（审计记录但无人可见）', () => {
    const out = createSceneEventSchema.parse({ ...baseValid, visible_npcs: [] });
    expect(out.visible_npcs).toEqual([]);
  });
});

/* ------------------------------ prompts.ts view ----------------------------- */

describe('[M4.2.4.a] hasEvents / buildEventBlock 格式化', () => {
  const sampleItems: EventBlockItem[] = [
    { id: 1, type: 'weather', content: '天色转阴有雨', actor: null, created_at: '2026-04-21' },
    { id: 2, type: 'dialogue', content: '你好  我在找茶馆', actor: '小明', created_at: '2026-04-21' },
    { id: 3, type: 'plot', content: 'x'.repeat(200), actor: '旁白', created_at: '2026-04-21' },
  ];

  it('hasEvents：null/undefined/[] → false；[...] → true', () => {
    expect(hasEvents(null)).toBe(false);
    expect(hasEvents(undefined)).toBe(false);
    expect(hasEvents([])).toBe(false);
    expect(hasEvents(sampleItems)).toBe(true);
  });

  it('空列表 → 空字符串（调用方拼接不产生多余换行）', () => {
    expect(buildEventBlock([])).toBe('');
    expect(buildEventBlock(null)).toBe('');
    expect(buildEventBlock(undefined)).toBe('');
  });

  it('头部含标题；每条含 [type] 前缀；尾部带换行', () => {
    const block = buildEventBlock(sampleItems);
    expect(block.startsWith('【最近发生的事件】')).toBe(true);
    expect(block).toContain('[weather]');
    expect(block).toContain('[dialogue 来自 小明]');
    expect(block).toContain('[plot 来自 旁白]');
    expect(block.endsWith('\n')).toBe(true);
  });

  it('actor 非空 → 追加「来自 {actor}」；actor=null → 无 actor 段', () => {
    const block = buildEventBlock(sampleItems);
    const weatherLine = block.split('\n').find((l) => l.includes('[weather'))!;
    expect(weatherLine).toMatch(/\[weather\] 天色转阴有雨/);
    expect(weatherLine).not.toContain('来自');
    const diaLine = block.split('\n').find((l) => l.includes('[dialogue'))!;
    expect(diaLine).toMatch(/\[dialogue 来自 小明\] 你好 我在找茶馆/);
  });

  it('content 超长截断到 160 字 + 省略号', () => {
    const block = buildEventBlock(sampleItems);
    const longLine = block.split('\n').find((l) => l.includes('[plot'))!;
    /** [plot 来自 旁白] + 空格 + 160 char + 省略号 */
    const after = longLine.split('] ')[1]!;
    expect(after.length).toBe(161);
    expect(after.endsWith('…')).toBe(true);
  });
});

/* ---------------------- graph/prompts.ts.buildPlanPrompt -------------------- */

describe('[M4.2.4.a] buildPlanPrompt eventBlock 注入', () => {
  const scene: SceneRow = { id: 1, name: '集市', description: null, width: 32, height: 32 };
  const npc: NpcRow = {
    id: 10,
    name: '小明',
    personality: '稳重',
    system_prompt: null,
    simulation_meta: null,
    ai_config_id: 4,
  };
  const baseParams = {
    scene,
    npc,
    neighbors: [],
    prevSummary: '',
    tick: 1,
  };

  it('不传 eventBlock → user 不含「最近发生的事件」（向后兼容 M4.2.3）', () => {
    const { user } = buildPlanPrompt(baseParams);
    expect(user).not.toContain('最近发生的事件');
    expect(user.startsWith('【场景】')).toBe(true);
  });

  it('eventBlock=空字符串 → 与不传效果一致', () => {
    const { user: a } = buildPlanPrompt({ ...baseParams, eventBlock: '' });
    const { user: b } = buildPlanPrompt(baseParams);
    expect(a).toBe(b);
  });

  it('eventBlock 非空 → 注入到 user 消息最开头（先事件后场景）', () => {
    const block = buildEventBlock([
      { id: 1, type: 'weather', content: '下雨了', actor: null, created_at: '' },
    ]);
    const { user } = buildPlanPrompt({ ...baseParams, eventBlock: block });
    expect(user.startsWith('【最近发生的事件】')).toBe(true);
    const evIdx = user.indexOf('【最近发生的事件】');
    const sceneIdx = user.indexOf('【场景】');
    expect(evIdx).toBeGreaterThanOrEqual(0);
    expect(sceneIdx).toBeGreaterThan(evIdx);
  });
});
