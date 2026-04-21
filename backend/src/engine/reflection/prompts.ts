/**
 * [M4.2.3.a] 反思节点的 prompt 模板 + zod 输出校验
 *
 * 设计原则（对齐 graph/prompts.ts）
 * - 中文框架 + JSON 返回（不允许 Markdown 代码块，由 SYSTEM_PREFIX 约束）
 * - 严格校验：3 条固定主题 goal/emotion/relation；每条 content 截断至 200 字
 * - 失败走 chatCompletion 的 retry1 策略 + zod 第二次失败即 'failed' 降级，不阻塞主流程
 *
 * 非职责
 * - 不负责调 LLM / 不负责落库；纯字符串构造 + schema 导出
 */
import { z } from 'zod';
import type { MemoryEntry } from '../memory/types.js';
import type { NpcRow, SceneRow } from '../types.js';
import { SYSTEM_PREFIX } from '../graph/prompts.js';
import { REFLECTION_THEMES } from './types.js';

/**
 * zod schema：校验 LLM 的 JSON 输出
 * - items 必须恰好 3 条（多了裁剪、少了判失败）
 * - theme 必须是 goal/emotion/relation 三者之一
 * - content 必须非空字符串，超长自动截断（prompt 侧也有 200 字提示）
 */
export const reflectionResponseSchema = z.object({
  items: z
    .array(
      z.object({
        theme: z.enum(REFLECTION_THEMES),
        content: z
          .string()
          .trim()
          .min(1, 'content 不可为空')
          .transform((s) => s.slice(0, 200)),
      }),
    )
    .length(3, 'items 必须恰好 3 条（goal/emotion/relation 各 1）'),
});

export type ReflectionResponse = z.infer<typeof reflectionResponseSchema>;

/**
 * 验证 3 条 items 的 theme 正好覆盖 goal/emotion/relation（无重复无遗漏）
 *
 * 为什么不放 zod 里：zod `.length(3)` 校验的是条数，枚举完备性需要集合论，
 * 放在业务侧校验错误信息更清晰，且 reflect.ts 可针对性降级（例如自动补缺）
 */
export function assertThemesComplete(resp: ReflectionResponse): void {
  const got = new Set(resp.items.map((i) => i.theme));
  const missing = REFLECTION_THEMES.filter((t) => !got.has(t));
  if (missing.length > 0) {
    throw new Error(
      `反思主题不完整：缺失 ${missing.join(',')}；实际 ${Array.from(got).join(',')}`,
    );
  }
}

/**
 * 把最近 K 条记忆格式化为 prompt 可用的 bullet list
 * - 每条前缀标注 #id 和 ★tag 让 LLM 能在输出里引用（虽然本 schema 未强制回引，保留扩展）
 * - 单条裁到 120 字；避免 prompt 爆炸
 */
export function buildReflectionMemoriesBlock(entries: MemoryEntry[]): string {
  if (!entries || entries.length === 0) return '（最近无可用记忆）';
  return entries
    .map((e, i) => {
      const content = (e.content ?? '').replace(/\s+/g, ' ').slice(0, 120);
      const tag = e.importance >= 8 ? '★★★' : e.importance >= 5 ? '★★' : '★';
      return `${i + 1}. [#${e.id} ${tag} ${e.type}] ${content}`;
    })
    .join('\n');
}

/**
 * 构建反思 prompt
 * @param params - scene/npc/memories + tick，其中 memories 建议传最近 20 条
 */
export function buildReflectionPrompt(params: {
  scene: SceneRow;
  npc: NpcRow;
  prevSummary: string;
  memories: MemoryEntry[];
  tick: number;
}): { system: string; user: string } {
  const { scene, npc, prevSummary, memories, tick } = params;
  const system = `${SYSTEM_PREFIX}
【角色设定】
${npc.system_prompt || `你的名字是「${npc.name}」。`}

【性格】${npc.personality || '未特别指定'}

【当前任务】基于最近记忆对自己做一次"反思"：抽象出当前的目标 / 情绪 / 关系三条独立洞察。`;

  const user = `【场景】${scene.name}${scene.description ? `（${scene.description}）` : ''}
【当前 tick】${tick}
【旧摘要】${prevSummary || '（空）'}

【最近记忆】（越靠前越新，#id 可在反思内容里引用）
${buildReflectionMemoriesBlock(memories)}

请综合上述信息，以第一人称输出 **恰好 3 条** 反思，每条不超过 200 字：
- goal：我当前最核心的目标/计划是什么？为什么？
- emotion：我现在的情绪与潜在原因？
- relation：我与同场景其他角色（或关键人物）的关系当前状态？

请严格按以下 JSON 返回（不要 Markdown、不要额外字段）：
{
  "items": [
    { "theme": "goal",     "content": "..." },
    { "theme": "emotion",  "content": "..." },
    { "theme": "relation", "content": "..." }
  ]
}`;
  return { system, user };
}
