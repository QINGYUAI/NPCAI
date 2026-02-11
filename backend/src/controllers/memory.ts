/**
 * NPC 记忆管理 - 查看、编辑、删除、反思
 */
import { Request, Response } from 'express';
import { pool } from '../db/connection.js';
import { chatCompletion } from '../utils/llmClient.js';

/** 获取某 NPC 的最近思考记录（wander/对话思考，按时间倒序，供轮询实时展示） */
export async function getRecentThoughts(req: Request, res: Response) {
  try {
    const npc_id = Number(req.query.npc_id);
    if (!npc_id || isNaN(npc_id)) {
      return res.status(400).json({ code: -1, message: 'npc_id 必填' });
    }
    const [rows] = await pool.execute(
      `SELECT id, npc_id, type, description, created_at
       FROM npc_memory
       WHERE npc_id = ? AND type IN ('wander', 'conversation')
       ORDER BY created_at DESC
       LIMIT 50`,
      [npc_id]
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    console.error('getRecentThoughts:', err);
    res.status(500).json({ code: -1, message: '获取思考记录失败' });
  }
}

/** 获取某 NPC 的记忆列表 */
export async function getMemories(req: Request, res: Response) {
  try {
    const npc_id = Number(req.query.npc_id);
    if (!npc_id || isNaN(npc_id)) {
      return res.status(400).json({ code: -1, message: 'npc_id 必填' });
    }
    const [rows] = await pool.execute(
      `SELECT id, npc_id, conversation_id, type, description, importance, created_at
       FROM npc_memory
       WHERE npc_id = ?
       ORDER BY importance DESC, id DESC
       LIMIT 100`,
      [npc_id]
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    console.error('getMemories:', err);
    res.status(500).json({ code: -1, message: '获取记忆失败' });
  }
}

/** 删除记忆 */
export async function deleteMemory(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ code: -1, message: 'id 必填' });
    }
    const [result] = await pool.execute('DELETE FROM npc_memory WHERE id = ?', [id]);
    const affected = (result as { affectedRows: number }).affectedRows;
    if (affected === 0) {
      return res.status(404).json({ code: -1, message: '记忆不存在' });
    }
    res.json({ code: 0, message: '已删除' });
  } catch (err) {
    console.error('deleteMemory:', err);
    res.status(500).json({ code: -1, message: '删除失败' });
  }
}

/** 更新记忆（description、importance） */
export async function updateMemory(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    const body = req.body as { description?: string; importance?: number };
    if (!id || isNaN(id)) {
      return res.status(400).json({ code: -1, message: 'id 必填' });
    }
    const updates: string[] = [];
    const vals: (string | number)[] = [];
    if (typeof body.description === 'string') {
      updates.push('description = ?');
      vals.push(body.description);
    }
    if (typeof body.importance === 'number') {
      updates.push('importance = ?');
      vals.push(Math.max(0, Math.min(1, body.importance)));
    }
    if (updates.length === 0) {
      return res.status(400).json({ code: -1, message: '无有效更新字段' });
    }
    vals.push(id);
    await pool.execute(`UPDATE npc_memory SET ${updates.join(', ')} WHERE id = ?`, vals);
    res.json({ code: 0, message: '已更新' });
  } catch (err) {
    console.error('updateMemory:', err);
    res.status(500).json({ code: -1, message: '更新失败' });
  }
}

/** 手动触发反思：从近期记忆提炼洞察 */
export async function reflectMemories(req: Request, res: Response) {
  try {
    const npc_id = Number(req.query.npc_id);
    if (!npc_id || isNaN(npc_id)) {
      return res.status(400).json({ code: -1, message: 'npc_id 必填' });
    }
    const [npcRows] = await pool.execute(
      `SELECT n.id, n.name, c.api_key, c.base_url, c.provider, c.model, c.max_tokens
       FROM npc n
       LEFT JOIN ai_config c ON n.ai_config_id = c.id
       WHERE n.id = ? AND n.status = 1`,
      [npc_id]
    );
    const npcList = npcRows as { id: number; name: string; api_key: string | null; base_url: string | null; provider: string; model: string; max_tokens: number }[];
    if (npcList.length === 0 || !npcList[0].api_key?.trim()) {
      return res.status(400).json({ code: -1, message: 'NPC 不存在或未配置 AI' });
    }
    const npc = npcList[0];

    const [rows] = await pool.execute(
      'SELECT description FROM npc_memory WHERE npc_id = ? ORDER BY id DESC LIMIT 30',
      [npc_id]
    );
    const memories = (rows as { description: string }[]).map((r) => r.description);
    if (memories.length < 3) {
      return res.status(400).json({ code: -1, message: '记忆不足 3 条，无法反思' });
    }

    const prompt = `你是${npc.name}。以下是近期记忆列表：\n${memories.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\n请从这些记忆中提炼 3 条高层级洞察或认知，每条 1 句话。直接输出，每行一条。`;
    const resp = await chatCompletion(
      {
        api_key: npc.api_key!,
        base_url: npc.base_url,
        provider: npc.provider,
        model: npc.model,
        max_tokens: npc.max_tokens,
      },
      [{ role: 'user' as const, content: prompt }],
      { timeout: 20000, max_tokens: 300 }
    );
    const lines = resp
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    let added = 0;
    for (const line of lines.slice(0, 3)) {
      await pool.execute(
        'INSERT INTO npc_memory (npc_id, type, description, importance) VALUES (?, ?, ?, ?)',
        [npc_id, 'reflection', line, 0.7]
      );
      added++;
    }
    res.json({ code: 0, message: `已生成 ${added} 条反思`, data: { added } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '反思失败';
    console.error('reflectMemories:', err);
    res.status(500).json({ code: -1, message: msg });
  }
}
