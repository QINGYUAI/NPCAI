/**
 * [M4.2.3.a] reflection/prompts.ts 单测
 *
 * 覆盖
 *   1) zod schema 正常解析 3 条 goal/emotion/relation
 *   2) items 数量错误（2 / 4）应被拒
 *   3) theme 不在枚举（例如 "mood"）应被拒
 *   4) content 超长（>200）应被截断但不拒绝
 *   5) assertThemesComplete 对重复/缺失主题应 throw
 *   6) buildReflectionPrompt 对空记忆/有记忆两种输入分别渲染
 */
import { describe, it, expect } from 'vitest';
import {
  reflectionResponseSchema,
  assertThemesComplete,
  buildReflectionPrompt,
  buildReflectionMemoriesBlock,
} from '../src/engine/reflection/prompts.js';
import type { MemoryEntry } from '../src/engine/memory/types.js';
import type { NpcRow, SceneRow } from '../src/engine/types.js';

const npc = {
  id: 1,
  name: '小明',
  system_prompt: '你是程序员小明',
  personality: '沉稳',
} as unknown as NpcRow;

const scene = {
  id: 1,
  name: '中央广场',
  description: '阳光充足',
} as unknown as SceneRow;

const goodResp = {
  items: [
    { theme: 'goal', content: '继续优化照明系统的节点同步协议' },
    { theme: 'emotion', content: '平静，略带专注' },
    { theme: 'relation', content: '与小美有轻度对话' },
  ],
};

describe('reflectionResponseSchema', () => {
  it('正常 3 条 goal/emotion/relation 通过解析', () => {
    const r = reflectionResponseSchema.parse(goodResp);
    expect(r.items).toHaveLength(3);
    expect(r.items.map((i) => i.theme).sort()).toEqual(['emotion', 'goal', 'relation']);
  });

  it('items 只有 2 条应拒绝', () => {
    const bad = { items: goodResp.items.slice(0, 2) };
    expect(() => reflectionResponseSchema.parse(bad)).toThrow(/items/);
  });

  it('items 有 4 条应拒绝', () => {
    const bad = {
      items: [...goodResp.items, { theme: 'goal', content: '额外一条' }],
    };
    expect(() => reflectionResponseSchema.parse(bad)).toThrow(/items/);
  });

  it('theme 不在枚举应拒绝', () => {
    const bad = {
      items: [
        { theme: 'mood', content: 'x' },
        { theme: 'emotion', content: 'y' },
        { theme: 'relation', content: 'z' },
      ],
    };
    expect(() => reflectionResponseSchema.parse(bad)).toThrow();
  });

  it('content 超长会被截断到 200 字', () => {
    const long = 'a'.repeat(500);
    const r = reflectionResponseSchema.parse({
      items: [
        { theme: 'goal', content: long },
        { theme: 'emotion', content: 'b' },
        { theme: 'relation', content: 'c' },
      ],
    });
    expect(r.items[0].content).toHaveLength(200);
  });

  it('content 空字符串应拒绝', () => {
    const bad = {
      items: [
        { theme: 'goal', content: '   ' },
        { theme: 'emotion', content: 'b' },
        { theme: 'relation', content: 'c' },
      ],
    };
    expect(() => reflectionResponseSchema.parse(bad)).toThrow();
  });
});

describe('assertThemesComplete', () => {
  it('3 条主题齐全：通过', () => {
    const r = reflectionResponseSchema.parse(goodResp);
    expect(() => assertThemesComplete(r)).not.toThrow();
  });

  it('2 条 goal + 1 条 relation（缺 emotion）：应 throw 指出缺失', () => {
    const dup = reflectionResponseSchema.parse({
      items: [
        { theme: 'goal', content: 'a' },
        { theme: 'goal', content: 'b' },
        { theme: 'relation', content: 'c' },
      ],
    });
    expect(() => assertThemesComplete(dup)).toThrowError(/emotion/);
  });
});

describe('buildReflectionMemoriesBlock', () => {
  it('空数组返回占位', () => {
    expect(buildReflectionMemoriesBlock([])).toContain('（最近无可用记忆）');
  });

  it('包含 #id / ★tag / type 三要素', () => {
    const mem: MemoryEntry[] = [
      { id: 42, npc_id: 1, scene_id: 1, tick: 3, type: 'dialogue', content: '你好', importance: 8, created_at: new Date() },
    ];
    const block = buildReflectionMemoriesBlock(mem);
    expect(block).toContain('#42');
    expect(block).toContain('★★★');
    expect(block).toContain('dialogue');
  });
});

describe('buildReflectionPrompt', () => {
  it('没有记忆时仍然可构造出完整 JSON 框架', () => {
    const { system, user } = buildReflectionPrompt({
      scene,
      npc,
      prevSummary: '',
      memories: [],
      tick: 5,
    });
    expect(system).toContain('反思');
    expect(user).toContain('goal');
    expect(user).toContain('emotion');
    expect(user).toContain('relation');
    expect(user).toContain('【当前 tick】5');
    expect(user).toContain('（最近无可用记忆）');
  });

  it('prevSummary 与 memories 齐全时：两段都要出现', () => {
    const mem: MemoryEntry[] = [
      { id: 7, npc_id: 1, scene_id: 1, tick: 2, type: 'observation', content: '看到咖啡店', importance: 3, created_at: new Date() },
    ];
    const { user } = buildReflectionPrompt({
      scene,
      npc,
      prevSummary: '上一段摘要',
      memories: mem,
      tick: 10,
    });
    expect(user).toContain('上一段摘要');
    expect(user).toContain('#7');
  });
});
