/**
 * 对话上下文准备服务
 * 抽取 chat/chatStream 的公共逻辑：查 NPC、会话、消息、记忆、组装 prompt
 */
import { pool } from '../db/connection.js';
import { embedText, cosineSimilarity } from '../utils/llmClient.js';
import { HttpError } from '../utils/httpError.js';
import { randomUUID } from 'crypto';

const MEMORY_TOP_N = 5;

type MemoryRow = { id: number; description: string; type: string; importance: number; embedding?: string | null };

export interface NpcChatContext {
  id: number;
  name: string;
  description: string | null;
  background: string | null;
  personality: string | null;
  gender?: string | null;
  age?: string | null;
  occupation?: string | null;
  voice_tone?: string | null;
  system_prompt: string | null;
  api_key: string | null;
  base_url: string | null;
  provider: string;
  model: string;
  max_tokens: number;
}

export interface PrepareChatResult {
  npc: NpcChatContext;
  sessionId: string;
  conversationId: number;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
}

async function getTopMemories(
  npcId: number,
  limit: number,
  queryText: string | undefined,
  llmConfig: { api_key: string; base_url?: string | null; provider: string } | undefined
): Promise<{ id: number; description: string; type: string; importance: number }[]> {
  const [rows] = await pool.execute(
    'SELECT id, description, type, importance, embedding FROM npc_memory WHERE npc_id = ? ORDER BY id DESC LIMIT 50',
    [npcId]
  );
  const mems = rows as MemoryRow[];
  if (mems.length === 0) return [];

  const withEmbedding = mems.filter((m) => m.embedding);
  if (queryText && llmConfig && withEmbedding.length >= 2) {
    try {
      const queryEmb = await embedText(llmConfig, queryText);
      const scored = mems
        .map((m) => {
          let sim = 0;
          if (m.embedding) {
            const emb = JSON.parse(m.embedding) as number[];
            sim = cosineSimilarity(queryEmb, emb);
          }
          const imp = Number(m.importance) || 0.5;
          const score = m.embedding ? 0.7 * sim + 0.3 * imp : imp;
          return { ...m, score };
        })
        .sort((a, b) => (b as { score: number }).score - (a as { score: number }).score)
        .slice(0, limit);
      return scored.map(({ id, description, type, importance }) => ({ id, description, type, importance }));
    } catch {
      /* embedding 失败时回退到 importance */
    }
  }
  return mems
    .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))
    .slice(0, limit)
    .map(({ id, description, type, importance }) => ({ id, description, type, importance }));
}

/**
 * 准备对话上下文：查 NPC、会话、历史消息、记忆，组装 LLM 消息列表
 * 抛出 HttpError(400/404) 时由调用方返回对应响应
 */
export async function prepareChatContext(
  npcId: number,
  userInput: string,
  inputSessionId?: string
): Promise<PrepareChatResult> {
  if (!npcId || !userInput?.trim()) {
    throw new HttpError(400, 'npc_id 和 user_input 为必填');
  }

  const [npcRows] = await pool.execute(
    `SELECT n.id, n.name, n.description, n.background, n.personality, n.gender, n.age, n.occupation, n.voice_tone,
      n.system_prompt, n.ai_config_id, c.api_key, c.base_url, c.provider, c.model, c.max_tokens
     FROM npc n
     LEFT JOIN ai_config c ON n.ai_config_id = c.id
     WHERE n.id = ? AND n.status = 1`,
    [npcId]
  );
  const npcList = npcRows as unknown[];
  if (npcList.length === 0) {
    throw new HttpError(404, 'NPC 不存在或已禁用');
  }

  const npc = npcList[0] as NpcChatContext;
  if (!npc.api_key?.trim()) {
    throw new HttpError(400, '该 NPC 绑定的 AI 配置未设置 API Key');
  }

  const sessionId = inputSessionId || randomUUID();
  let conversationId: number;

  const [convRows] = await pool.execute(
    'SELECT id FROM npc_conversation WHERE session_id = ? AND npc_id = ? LIMIT 1',
    [sessionId, npcId]
  );
  const convList = convRows as { id: number }[];
  if (convList.length > 0) {
    conversationId = convList[0]!.id;
  } else {
    const [insertResult] = await pool.execute(
      'INSERT INTO npc_conversation (npc_id, session_id) VALUES (?, ?)',
      [npcId, sessionId]
    );
    conversationId = (insertResult as { insertId: number }).insertId;
  }

  const [msgRows] = await pool.execute(
    'SELECT id, role, content FROM npc_message WHERE conversation_id = ? ORDER BY id DESC LIMIT 10',
    [conversationId]
  );
  const recentMessages = ((msgRows as unknown[]) as { role: string; content: string }[]).reverse();

  const memories = await getTopMemories(
    npc.id,
    MEMORY_TOP_N,
    userInput.trim(),
    { api_key: npc.api_key, base_url: npc.base_url, provider: npc.provider }
  );
  const memoryBlock =
    memories.length > 0
      ? `\n【相关记忆】\n${memories.map((m) => `- ${m.description}`).join('\n')}\n`
      : '';

  const extra = [
    npc.gender ? `性别：${npc.gender === 'male' ? '男' : npc.gender === 'female' ? '女' : npc.gender}` : '',
    npc.age ? `年龄：${npc.age}` : '',
    npc.occupation ? `职业：${npc.occupation}` : '',
    npc.voice_tone ? `说话风格：${npc.voice_tone}` : '',
  ]
    .filter(Boolean)
    .join('。');
  const baseSystem =
    npc.system_prompt?.trim() ||
    `你是${npc.name}，${npc.description || ''}。${extra ? extra + '。' : ''}背景：${npc.background || ''}。性格：${npc.personality || ''}。请以该角色身份与用户对话，回复简洁自然。`;
  const roleConstraint = `\n【重要】你必须完全代入${npc.name}这一角色。禁止提及你是人工智能、没有感受、无法像人类一样等；用户问候时以角色身份自然回应。`;
  const systemMsg = (baseSystem + roleConstraint + memoryBlock).trim();

  const history = recentMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));
  const messages = [
    { role: 'system' as const, content: systemMsg },
    ...history,
    { role: 'user' as const, content: userInput.trim() },
  ];

  return { npc, sessionId, conversationId, messages };
}
