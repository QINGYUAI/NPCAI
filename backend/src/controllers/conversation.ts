/**
 * 用户-NPC 对话控制器
 * 实现用户与 NPC 一对一对话，存储对话历史，组装 System Prompt 调用 LLM
 * 含记忆系统：对话前注入相关记忆，对话后总结入库
 */
import { Request, Response } from 'express';
import { pool } from '../db/connection.js';
import { chatCompletion, chatCompletionStream, embedText, cosineSimilarity } from '../utils/llmClient.js';
import { randomUUID } from 'crypto';

/** 按 importance 排序取 top N 条记忆，用于注入 prompt */
const MEMORY_TOP_N = 5;

/** 记忆项（含可选 embedding） */
type MemoryRow = { id: number; description: string; type: string; importance: number; embedding?: string | null };

/** 按 npc_id 查询记忆，支持语义检索（传入 queryText + llmConfig 时按相似度排序） */
async function getTopMemories(
  npcId: number,
  limit: number = MEMORY_TOP_N,
  queryText?: string,
  llmConfig?: { api_key: string; base_url?: string | null; provider: string }
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

/** 对话后：用 LLM 总结本轮对话，写入 npc_memory（异步，不阻塞响应） */
async function rememberConversation(params: {
  npcName: string;
  npcId: number;
  conversationId: number;
  userInput: string;
  npcReply: string;
  llmConfig: { api_key: string; base_url?: string | null; provider: string; model: string; max_tokens: number };
}) {
  const { npcName, npcId, conversationId, userInput, npcReply, llmConfig } = params;
  try {
    const summaryPrompt = `你是${npcName}。请用 1-2 句话总结刚才的这场对话，并说明你对这次交流的感受（喜欢/一般/不喜欢）。要求：以第三人称描述，例如「用户询问了xxx，${npcName}回复了xxx，${npcName}对这次交流感觉xxx。」`;
    const messages = [
      { role: 'user' as const, content: `对话内容：\n用户：${userInput}\n${npcName}：${npcReply}\n\n${summaryPrompt}` },
    ];
    const description = await chatCompletion(
      { ...llmConfig, api_key: llmConfig.api_key },
      messages,
      { timeout: 15000, max_tokens: 200 }
    );
    const importance = description.includes('喜欢') ? 0.8 : description.includes('一般') ? 0.5 : 0.4;
    const [insResult] = await pool.execute(
      'INSERT INTO npc_memory (npc_id, conversation_id, type, description, importance) VALUES (?, ?, ?, ?, ?)',
      [npcId, conversationId, 'conversation', description.trim(), importance]
    );
    const memId = (insResult as { insertId: number }).insertId;
    // 异步生成 embedding 并更新（用于语义检索）
    ;(async () => {
      try {
        const emb = await embedText(
          { api_key: llmConfig.api_key, base_url: llmConfig.base_url, provider: llmConfig.provider },
          description.trim()
        );
        await pool.execute('UPDATE npc_memory SET embedding = ? WHERE id = ?', [
          JSON.stringify(emb),
          memId,
        ]);
      } catch {
        /* 忽略，无 embedding 时回退到 importance 检索 */
      }
    })();
  } catch (err) {
    console.error('rememberConversation:', err);
  }
  // 记忆数量达到阈值时，异步触发反思
  try {
    const [countRows] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM npc_memory WHERE npc_id = ? AND type = ?',
      [npcId, 'conversation']
    );
    const cnt = (countRows as { cnt: number }[])[0]?.cnt ?? 0;
    if (cnt >= 12) {
      reflectOnMemories(npcId, npcName, llmConfig).catch(() => {});
    }
  } catch {
    /* 忽略 */
  }
}

/** 从近期记忆提炼高层级洞察，写入 type=reflection */
async function reflectOnMemories(
  npcId: number,
  npcName: string,
  llmConfig: { api_key: string; base_url?: string | null; provider: string; model: string; max_tokens: number }
) {
  try {
    const [rows] = await pool.execute(
      'SELECT description FROM npc_memory WHERE npc_id = ? ORDER BY id DESC LIMIT 30',
      [npcId]
    );
    const memories = (rows as { description: string }[]).map((r) => r.description);
    if (memories.length < 5) return;
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
    for (const line of lines.slice(0, 3)) {
      await pool.execute(
        'INSERT INTO npc_memory (npc_id, type, description, importance) VALUES (?, ?, ?, ?)',
        [npcId, 'reflection', line, 0.7]
      );
    }
  } catch (err) {
    console.error('reflectOnMemories:', err);
  }
}

/** 对话 API：接收用户输入，返回 NPC 回复并存储消息 */
export async function chat(req: Request, res: Response) {
  try {
    const body = req.body as { npc_id: number; session_id?: string; user_input: string };
    const { npc_id, session_id: inputSessionId, user_input } = body;

    if (!npc_id || !user_input?.trim()) {
      return res.status(400).json({ code: -1, message: 'npc_id 和 user_input 为必填' });
    }

    // 1. 查询 NPC 及关联的 AI 配置
    const [npcRows] = await pool.execute(
      `SELECT n.id, n.name, n.description, n.background, n.personality, n.gender, n.age, n.occupation, n.voice_tone,
        n.system_prompt, n.ai_config_id, c.api_key, c.base_url, c.provider, c.model, c.max_tokens
       FROM npc n
       LEFT JOIN ai_config c ON n.ai_config_id = c.id
       WHERE n.id = ? AND n.status = 1`,
      [npc_id]
    );

    const npcList = npcRows as unknown[];
    if (npcList.length === 0) {
      return res.status(404).json({ code: -1, message: 'NPC 不存在或已禁用' });
    }

    const npc = npcList[0] as {
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
    };

    if (!npc.api_key?.trim()) {
      return res.status(400).json({ code: -1, message: '该 NPC 绑定的 AI 配置未设置 API Key' });
    }

    // 2. 获取或创建会话
    const sessionId = inputSessionId || randomUUID();
    let conversationId: number;

    const [convRows] = await pool.execute(
      'SELECT id FROM npc_conversation WHERE session_id = ? AND npc_id = ? LIMIT 1',
      [sessionId, npc_id]
    );

    const convList = convRows as { id: number }[];
    if (convList.length > 0) {
      conversationId = convList[0]!.id;
    } else {
      const [insertResult] = await pool.execute(
        'INSERT INTO npc_conversation (npc_id, session_id) VALUES (?, ?)',
        [npc_id, sessionId]
      );
      conversationId = (insertResult as { insertId: number }).insertId;
    }

    // 3. 查询最近 10 条对话作为上下文
    const [msgRows] = await pool.execute(
      'SELECT id, role, content FROM npc_message WHERE conversation_id = ? ORDER BY id DESC LIMIT 10',
      [conversationId]
    );

    const recentMessages = ((msgRows as unknown[]) as { role: string; content: string }[]).reverse();

    // 3.1 查询 NPC 相关记忆（有 embedding 时按语义相似度 + 重要度；否则按 importance）
    const memories = await getTopMemories(
      npc.id,
      MEMORY_TOP_N,
      user_input.trim(),
      { api_key: npc.api_key!, base_url: npc.base_url, provider: npc.provider }
    );
    const memoryBlock =
      memories.length > 0
        ? `\n【相关记忆】\n${memories.map((m) => `- ${m.description}`).join('\n')}\n`
        : '';

    // 4. 组装 System Prompt（若无自定义则用基础信息拼接，含性别、年龄、职业、说话风格等；注入记忆）
    const extra = [
      npc.gender ? `性别：${npc.gender === 'male' ? '男' : npc.gender === 'female' ? '女' : npc.gender}` : '',
      npc.age ? `年龄：${npc.age}` : '',
      npc.occupation ? `职业：${npc.occupation}` : '',
      npc.voice_tone ? `说话风格：${npc.voice_tone}` : '',
    ].filter(Boolean).join('。');
    const baseSystem =
      npc.system_prompt?.trim() ||
      `你是${npc.name}，${npc.description || ''}。${extra ? extra + '。' : ''}背景：${npc.background || ''}。性格：${npc.personality || ''}。请以该角色身份与用户对话，回复简洁自然。`;
    // 角色扮演硬约束：禁止脱出角色，始终以 NPC 身份回应（包括问候、闲聊）
    const roleConstraint = `\n【重要】你必须完全代入${npc.name}这一角色。禁止提及你是人工智能、没有感受、无法像人类一样等；用户问候时以角色身份自然回应。`;
    const systemMsg = (baseSystem + roleConstraint + memoryBlock).trim();

    // 5. 组装消息列表
    const history = recentMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
    const messages = [
      { role: 'system' as const, content: systemMsg },
      ...history,
      { role: 'user' as const, content: user_input.trim() },
    ];

    // 6. 调用 LLM
    const npcReply = await chatCompletion(
      {
        api_key: npc.api_key,
        base_url: npc.base_url,
        provider: npc.provider,
        model: npc.model,
        max_tokens: npc.max_tokens,
      },
      messages,
      { timeout: 45000, max_tokens: 800 }
    );

    // 7. 写入两条消息：用户输入、NPC 回复
    await pool.execute(
      'INSERT INTO npc_message (conversation_id, role, content) VALUES (?, ?, ?)',
      [conversationId, 'user', user_input.trim()]
    );
    const [assistResult] = await pool.execute(
      'INSERT INTO npc_message (conversation_id, role, content) VALUES (?, ?, ?)',
      [conversationId, 'assistant', npcReply]
    );
    const messageId = (assistResult as { insertId: number }).insertId;

    // 8. 异步总结对话并写入记忆（不阻塞响应）
    rememberConversation({
      npcName: npc.name,
      npcId: npc.id,
      conversationId,
      userInput: user_input.trim(),
      npcReply,
      llmConfig: {
        api_key: npc.api_key!,
        base_url: npc.base_url,
        provider: npc.provider,
        model: npc.model,
        max_tokens: npc.max_tokens,
      },
    }).catch(() => {});

    res.json({
      code: 0,
      data: {
        content: npcReply,
        message_id: messageId,
        session_id: sessionId,
        conversation_id: conversationId,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '对话失败';
    console.error('chat:', err);
    res.status(500).json({ code: -1, message: msg });
  }
}

/** 流式对话 API：逐字返回 NPC 回复，前端可实时渲染 */
export async function chatStream(req: Request, res: Response) {
  try {
    const body = req.body as { npc_id: number; session_id?: string; user_input: string };
    const { npc_id, session_id: inputSessionId, user_input } = body;

    if (!npc_id || !user_input?.trim()) {
      return res.status(400).json({ code: -1, message: 'npc_id 和 user_input 为必填' });
    }

    // 1-5 与 chat 相同
    const [npcRows] = await pool.execute(
      `SELECT n.id, n.name, n.description, n.background, n.personality, n.gender, n.age, n.occupation, n.voice_tone,
        n.system_prompt, n.ai_config_id, c.api_key, c.base_url, c.provider, c.model, c.max_tokens
       FROM npc n
       LEFT JOIN ai_config c ON n.ai_config_id = c.id
       WHERE n.id = ? AND n.status = 1`,
      [npc_id]
    );
    const npcList = npcRows as unknown[];
    if (npcList.length === 0) {
      return res.status(404).json({ code: -1, message: 'NPC 不存在或已禁用' });
    }
    const npc = npcList[0] as {
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
    };
    if (!npc.api_key?.trim()) {
      return res.status(400).json({ code: -1, message: '该 NPC 绑定的 AI 配置未设置 API Key' });
    }

    const sessionId = inputSessionId || randomUUID();
    let conversationId: number;
    const [convRows] = await pool.execute(
      'SELECT id FROM npc_conversation WHERE session_id = ? AND npc_id = ? LIMIT 1',
      [sessionId, npc_id]
    );
    const convList = convRows as { id: number }[];
    if (convList.length > 0) {
      conversationId = convList[0]!.id;
    } else {
      const [insertResult] = await pool.execute(
        'INSERT INTO npc_conversation (npc_id, session_id) VALUES (?, ?)',
        [npc_id, sessionId]
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
      user_input.trim(),
      { api_key: npc.api_key!, base_url: npc.base_url, provider: npc.provider }
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
    ].filter(Boolean).join('。');
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
      { role: 'user' as const, content: user_input.trim() },
    ];

    // 写入用户消息
    await pool.execute(
      'INSERT INTO npc_message (conversation_id, role, content) VALUES (?, ?, ?)',
      [conversationId, 'user', user_input.trim()]
    );

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let npcReply = '';
    try {
      for await (const chunk of chatCompletionStream(
        {
          api_key: npc.api_key!,
          base_url: npc.base_url,
          provider: npc.provider,
          model: npc.model,
          max_tokens: npc.max_tokens,
        },
        messages,
        { timeout: 45000, max_tokens: 800 }
      )) {
        npcReply += chunk;
        res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
      }
    } catch (streamErr) {
      const errMsg = streamErr instanceof Error ? streamErr.message : '流式生成失败';
      res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.end();
      return;
    }

    const [assistResult] = await pool.execute(
      'INSERT INTO npc_message (conversation_id, role, content) VALUES (?, ?, ?)',
      [conversationId, 'assistant', npcReply]
    );
    const messageId = (assistResult as { insertId: number }).insertId;

    rememberConversation({
      npcName: npc.name,
      npcId: npc.id,
      conversationId,
      userInput: user_input.trim(),
      npcReply,
      llmConfig: {
        api_key: npc.api_key!,
        base_url: npc.base_url,
        provider: npc.provider,
        model: npc.model,
        max_tokens: npc.max_tokens,
      },
    }).catch(() => {});

    res.write(`data: ${JSON.stringify({ done: true, message_id: messageId, session_id: sessionId, conversation_id: conversationId })}\n\n`);
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '对话失败';
    console.error('chatStream:', err);
    res.status(500).json({ code: -1, message: msg });
  }
}

/** 获取某 NPC 的会话列表（按最新消息排序） */
export async function getConversations(req: Request, res: Response) {
  try {
    const npc_id = Number(req.query.npc_id);
    if (!npc_id || isNaN(npc_id)) {
      return res.status(400).json({ code: -1, message: 'npc_id 必填' });
    }
    const [rows] = await pool.execute(
      `SELECT c.id, c.session_id, c.created_at,
        (SELECT COUNT(*) FROM npc_message m WHERE m.conversation_id = c.id) AS msg_count,
        (SELECT content FROM npc_message m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_preview
       FROM npc_conversation c
       WHERE c.npc_id = ? AND c.status = 1
       ORDER BY c.id DESC
       LIMIT 50`,
      [npc_id]
    );
    const list = (rows as Record<string, unknown>[]).map((r) => ({
      id: r.id,
      session_id: r.session_id,
      created_at: r.created_at,
      msg_count: Number(r.msg_count) || 0,
      last_preview: typeof r.last_preview === 'string' ? (r.last_preview.slice(0, 40) + (r.last_preview.length > 40 ? '…' : '')) : null,
    }));
    res.json({ code: 0, data: list });
  } catch (err) {
    console.error('getConversations:', err);
    res.status(500).json({ code: -1, message: '获取会话列表失败' });
  }
}

/** 创建新会话 */
export async function createConversation(req: Request, res: Response) {
  try {
    const body = req.body as { npc_id: number };
    const { npc_id } = body;
    if (!npc_id) {
      return res.status(400).json({ code: -1, message: 'npc_id 必填' });
    }
    const sessionId = randomUUID();
    const [result] = await pool.execute(
      'INSERT INTO npc_conversation (npc_id, session_id) VALUES (?, ?)',
      [npc_id, sessionId]
    );
    const id = (result as { insertId: number }).insertId;
    res.json({ code: 0, data: { id, session_id: sessionId } });
  } catch (err) {
    console.error('createConversation:', err);
    res.status(500).json({ code: -1, message: '创建会话失败' });
  }
}

/** 删除会话 */
export async function deleteConversation(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ code: -1, message: 'id 必填' });
    }
    await pool.execute('DELETE FROM npc_conversation WHERE id = ?', [id]);
    res.json({ code: 0, message: '已删除' });
  } catch (err) {
    console.error('deleteConversation:', err);
    res.status(500).json({ code: -1, message: '删除会话失败' });
  }
}

/** 获取会话历史消息 */
export async function getMessages(req: Request, res: Response) {
  try {
    const { session_id } = req.query;

    if (!session_id || typeof session_id !== 'string') {
      return res.status(400).json({ code: -1, message: 'session_id 为必填' });
    }

    const [rows] = await pool.execute(
      `SELECT m.id, m.role, m.content, m.created_at
       FROM npc_message m
       JOIN npc_conversation c ON m.conversation_id = c.id
       WHERE c.session_id = ?
       ORDER BY m.id ASC`,
      [session_id]
    );

    res.json({ code: 0, data: rows });
  } catch (err) {
    console.error('getMessages:', err);
    res.status(500).json({ code: -1, message: '获取消息失败' });
  }
}
