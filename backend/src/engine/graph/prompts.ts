/**
 * M4.1 推理图提示词模板
 *
 * 设计原则：
 * - 模板框架用中文；但不强制 LLM 输出中文（由 NPC.system_prompt/personality 决定角色语言）
 * - JSON 返回严格格式；失败由 zod 校验 + 调度器重试一次
 */

import type { NpcRow, SceneRow } from '../types.js';

export const SYSTEM_PREFIX = `你正在扮演一个 2D 多智能体小镇中的角色。请严格遵守：
1. 回应只输出 **一个 JSON 对象**，不要有任何额外说明、不使用 Markdown 代码块；
2. 遵循角色设定（system_prompt / personality）；
3. 不要输出与角色无关的内容；
4. 字段值应与角色背景、场景氛围吻合；
5. 如果信息不足，也要合理构造符合角色的内容，不要返回空。`;

/** plan 节点：基于最近记忆与场景，为本 tick 规划 1-3 步 */
export function buildPlanPrompt(params: {
  scene: SceneRow;
  npc: NpcRow;
  neighbors: Array<{ id: number; name: string }>;
  prevSummary: string;
  tick: number;
}): { system: string; user: string } {
  const { scene, npc, neighbors, prevSummary, tick } = params;
  const system = `${SYSTEM_PREFIX}
【角色设定】
${npc.system_prompt || `你的名字是「${npc.name}」。`}

【性格】${npc.personality || '未特别指定'}

【当前任务】为下一小段时间（1-3 步）做一个轻量计划。`;

  const user = `【场景】${scene.name}${scene.description ? `（${scene.description}）` : ''}
【同场景角色】${neighbors.map((n) => n.name).join('、') || '无'}
【记忆摘要】${prevSummary || '（无）'}
【当前 tick】${tick}

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
}): { system: string; user: string } {
  const { scene, npc, plan, tick } = params;
  const system = `${SYSTEM_PREFIX}
【角色设定】
${npc.system_prompt || `你的名字是「${npc.name}」。`}

【性格】${npc.personality || '未特别指定'}`;

  const user = `【场景】${scene.name}
【本轮计划】${plan.slice(0, 3).join(' / ') || '(无计划)'}
【当前 tick】${tick}

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
