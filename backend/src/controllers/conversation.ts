/**
 * 用户-NPC 对话控制器
 * 实现用户与 NPC 一对一对话，存储对话历史，组装 System Prompt 调用 LLM
 * 含记忆系统：对话前注入相关记忆，对话后总结入库
 */
import { Request, Response } from 'express';
import { pool } from '../db/connection.js';
import { chatCompletion, chatCompletionStream, embedText } from '../utils/llmClient.js';
import { randomUUID } from 'crypto';
import { HttpError } from '../utils/httpError.js';
import { prepareChatContext } from '../services/conversationContext.js';
import { reflectOnMemories } from '../services/memoryReflect.js';

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
  // 记忆数量达到阈值时，异步触发反思（使用统一 memoryReflect 服务）
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

/** 对话 API：接收用户输入，返回 NPC 回复并存储消息 */
export async function chat(req: Request, res: Response) {
  try {
    const body = req.body as { npc_id: number; session_id?: string; user_input: string };
    const { npc_id, session_id: inputSessionId, user_input } = body;

    let ctx;
    try {
      ctx = await prepareChatContext(npc_id, user_input, inputSessionId);
    } catch (e) {
      if (e instanceof HttpError) {
        return res.status(e.status).json({ code: -1, message: e.message });
      }
      throw e;
    }
    const { npc, sessionId, conversationId, messages } = ctx;

    // 调用 LLM（prepareChatContext 已校验 api_key 非空）
    const npcReply = await chatCompletion(
      {
        api_key: npc.api_key!,
        base_url: npc.base_url,
        provider: npc.provider,
        model: npc.model,
        max_tokens: npc.max_tokens,
      },
      messages,
      { timeout: 45000, max_tokens: 800 }
    );

    // 写入两条消息：用户输入、NPC 回复
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

    let ctx;
    try {
      ctx = await prepareChatContext(npc_id, user_input, inputSessionId);
    } catch (e) {
      if (e instanceof HttpError) {
        return res.status(e.status).json({ code: -1, message: e.message });
      }
      throw e;
    }
    const { npc, sessionId, conversationId, messages } = ctx;

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
