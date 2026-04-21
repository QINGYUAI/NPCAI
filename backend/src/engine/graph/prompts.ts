/**
 * M4.1 推理图提示词模板
 *
 * 设计原则：
 * - 模板框架用中文；但不强制 LLM 输出中文（由 NPC.system_prompt/personality 决定角色语言）
 * - JSON 返回严格格式；失败由 zod 校验 + 调度器重试一次
 *
 * [M4.2.2.b] 新增
 * - buildMemoryBlock：把 memory-retrieve 返回的 entries 格式化成 prompt 段，
 *   plan / speak 两个节点都可选注入「相关记忆」上下文
 */

import type { MemoryEntry } from '../memory/types.js';
import type { NpcRow, SceneRow } from '../types.js';

export const SYSTEM_PREFIX = `你正在扮演一个 2D 多智能体小镇中的角色。请严格遵守：
1. 回应只输出 **一个 JSON 对象**，不要有任何额外说明、不使用 Markdown 代码块；
2. 遵循角色设定（system_prompt / personality）；
3. 不要输出与角色无关的内容；
4. 字段值应与角色背景、场景氛围吻合；
5. 如果信息不足，也要合理构造符合角色的内容，不要返回空。`;

/**
 * [M4.2.2.b] 相关记忆提示段
 * - 返回非空字符串时包含尾部换行，调用方可直接拼接到 user prompt
 * - 条数裁剪：最多 5 条；单条截断到 120 字符，避免 prompt 爆炸
 * - 空列表返回空字符串（调用方用 `memoryBlock || ''` 即可）
 */
export function buildMemoryBlock(entries: MemoryEntry[]): string {
  if (!entries || entries.length === 0) return '';
  const top = entries.slice(0, 5);
  const lines = top.map((e, i) => {
    const content = (e.content ?? '').replace(/\s+/g, ' ').slice(0, 120);
    const tag = importanceTag(e.importance);
    return `${i + 1}. ${tag}${content}`;
  });
  return `【相关记忆】（越靠前越相关）\n${lines.join('\n')}\n`;
}

/** 简单重要度可视化：高=★★★ 中=★★ 低=★ 便于 LLM 感知权重 */
function importanceTag(importance: number): string {
  if (importance >= 8) return '★★★ ';
  if (importance >= 5) return '★★ ';
  return '★ ';
}

/** plan 节点：基于最近记忆与场景，为本 tick 规划 1-3 步 */
export function buildPlanPrompt(params: {
  scene: SceneRow;
  npc: NpcRow;
  neighbors: Array<{ id: number; name: string }>;
  prevSummary: string;
  tick: number;
  /** [M4.2.2.b] 由 memory-retrieve 节点生成的相关记忆段，可选 */
  memoryBlock?: string;
  /**
   * [M4.2.4.a] 由 event-intake 节点生成的场景事件段（拉票 Q5a：user 消息头部注入）
   * - 放在【场景】之前，确保 LLM 在理解角色位置前先感知世界变动
   * - 空字符串 / undefined 均等效于不注入
   */
  eventBlock?: string;
}): { system: string; user: string } {
  const { scene, npc, neighbors, prevSummary, tick, memoryBlock, eventBlock } = params;
  const system = `${SYSTEM_PREFIX}
【角色设定】
${npc.system_prompt || `你的名字是「${npc.name}」。`}

【性格】${npc.personality || '未特别指定'}

【当前任务】为下一小段时间（1-3 步）做一个轻量计划。`;

  const user = `${eventBlock || ''}【场景】${scene.name}${scene.description ? `（${scene.description}）` : ''}
【同场景角色】${neighbors.map((n) => n.name).join('、') || '无'}
【记忆摘要】${prevSummary || '（无）'}
${memoryBlock || ''}【当前 tick】${tick}

请严格按下列 JSON 返回：
{
  "plan": ["步骤1", "步骤2", "步骤3"]   // 1 到 3 条短句，语言与角色一致
}`;
  return { system, user };
}

/** speak 节点：基于 plan 的第一步，生成一句台词 + 一个动作 + 情绪 */
export function buildSpeakPrompt(params: {
  scene: SceneRow;
  npc: NpcRow;
  plan: string[];
  tick: number;
  /** [M4.2.2.b] 相关记忆段，可选；与 plan 共用一套，避免上下文割裂 */
  memoryBlock?: string;
}): { system: string; user: string } {
  const { scene, npc, plan, tick, memoryBlock } = params;
  const system = `${SYSTEM_PREFIX}
【角色设定】
${npc.system_prompt || `你的名字是「${npc.name}」。`}

【性格】${npc.personality || '未特别指定'}`;

  const user = `【场景】${scene.name}
【本轮计划】${plan.slice(0, 3).join(' / ') || '(无计划)'}
${memoryBlock || ''}【当前 tick】${tick}

请按下列 JSON 返回：
{
  "latest_say": "一句不超过 40 字的台词（角色第一人称）",
  "latest_action": "一个短语形式的动作（如：walking_to_dock / looking_at_painting）",
  "emotion": "neutral | happy | sad | angry | curious | scared 之一"
}`;
  return { system, user };
}

/** 记忆摘要节点：把旧 summary + 本 tick 产出压缩成 <= 300 字 */
export function buildMemoryPrompt(params: {
  npc: NpcRow;
  prevSummary: string;
  latestSay: string | null;
  latestAction: string | null;
}): { system: string; user: string } {
  const { npc, prevSummary, latestSay, latestAction } = params;
  const system = `${SYSTEM_PREFIX}
【角色设定】
${npc.system_prompt || `你的名字是「${npc.name}」。`}`;

  const user = `请将下列信息合并为一段不超过 200 字的「个人记忆摘要」（第一人称、保留关键事件与人物）。

【旧摘要】
${prevSummary || '（空）'}

【本轮新增】
- 台词：${latestSay || '（无）'}
- 动作：${latestAction || '（无）'}

请按 JSON 返回：
{ "memory_summary": "合并后的摘要文本" }`;
  return { system, user };
}
