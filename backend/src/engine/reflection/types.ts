/**
 * [M4.2.3.a] 反思子系统共享类型
 *
 * 职责
 * - 定义 reflect 节点的输入 / 输出 / 单条反思记录结构
 * - 供 prompts.ts（zod schema）、reflect.ts（运行时）、controllers（API 响应）复用
 *
 * 非职责
 * - 不直接暴露给前端；前端有独立 types/reflection.ts（M4.2.3.c 再建）
 *
 * 3 条固定 theme 的约束来自拉票 Q1a：goal / emotion / relation 各 1 条
 */

/** 反思主题枚举；与 npc_reflection.theme 列 + prompts zod schema 严格一致 */
export const REFLECTION_THEMES = ['goal', 'emotion', 'relation'] as const;
export type ReflectionTheme = (typeof REFLECTION_THEMES)[number];

/** 单条反思条目（LLM 输出 + 落库后的共享结构） */
export interface ReflectionItem {
  theme: ReflectionTheme;
  /** 第一人称短段，<=200 字；prompts 中已限制 */
  content: string;
}

/** reflect 节点产出的本 tick 结果 */
export interface ReflectionResult {
  /** 固定 3 条：goal/emotion/relation 各 1；LLM 漏产会被 zod 截获降级 */
  items: ReflectionItem[];
  /** 参考了哪些 npc_memory.id，用于写入 source_memory_ids */
  source_memory_ids: number[];
  /**
   * 状态：
   * - 'generated'：LLM 成功 + zod 通过 + 已落库 npc_reflection（可能尚未 memory 入库）
   * - 'skipped'：不满足触发条件（tick 未到、记忆过少等），本 tick 无反思
   * - 'failed'：LLM 或 zod 均失败；节点吞掉异常，引擎主流程继续
   */
  status: 'generated' | 'skipped' | 'failed';
  /** 本次反思在 npc_reflection 表里的 id 列表（3 条；skipped/failed 为 []） */
  reflection_ids: number[];
}
