/**
 * 记忆反思服务
 * 从近期记忆提炼高层级洞察，写入 type=reflection
 * 供 conversation 对话后触发、memory controller 手动触发共用
 */
import { pool } from '../db/connection.js';
import { chatCompletion } from '../utils/llmClient.js';

/** LLM 配置 */
export type LlmConfig = {
  api_key: string;
  base_url?: string | null;
  provider: string;
  model?: string;
  max_tokens?: number;
};

/** 反思结果 */
export interface ReflectResult {
  added: number;
}

/** 最少记忆条数，低于此数不执行反思 */
const MIN_MEMORIES = 3;

/** 读取的最近记忆条数 */
const FETCH_LIMIT = 30;

/** 最多生成的洞察条数 */
const MAX_INSIGHTS = 3;

/**
 * 从近期记忆中提炼 3 条高层级洞察，写入 npc_memory type=reflection
 */
export async function reflectOnMemories(
  npcId: number,
  npcName: string,
  llmConfig: LlmConfig
): Promise<ReflectResult> {
  const [rows] = await pool.execute(
    'SELECT description FROM npc_memory WHERE npc_id = ? ORDER BY id DESC LIMIT ?',
    [npcId, FETCH_LIMIT]
  );
  const memories = (rows as { description: string }[]).map((r) => r.description);
  if (memories.length < MIN_MEMORIES) {
    return { added: 0 };
  }

  const prompt = `你是${npcName}。以下是近期记忆列表：\n${memories.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\n请从这些记忆中提炼 3 条高层级洞察或认知（关于角色对用户、对交流的整体感受），每条 1 句话。直接输出，每行一条，不要编号。`;

  const resp = await chatCompletion(
    { ...llmConfig, api_key: llmConfig.api_key },
    [{ role: 'user' as const, content: prompt }],
    { timeout: 20000, max_tokens: 300 }
  );

  const lines = resp
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let added = 0;
  for (const line of lines.slice(0, MAX_INSIGHTS)) {
    await pool.execute(
      'INSERT INTO npc_memory (npc_id, type, description, importance) VALUES (?, ?, ?, ?)',
      [npcId, 'reflection', line, 0.7]
    );
    added++;
  }
  return { added };
}
