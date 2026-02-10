/**
 * 角色 NPC 控制器
 */
import { Request, Response } from 'express';
import { pool } from '../db/connection.js';
import { chatCompletion } from '../utils/llmClient.js';

/** 获取 NPC 列表，支持筛选 */
export async function getNpcList(req: Request, res: Response) {
  try {
    const { category, status } = req.query;
    let sql = `SELECT n.id, n.name, n.description, n.background, n.personality,
      n.gender, n.age, n.occupation, n.voice_tone, n.avatar,
      n.ai_config_id, n.system_prompt, n.category, n.prompt_type, n.status, n.sort,
      n.created_at, n.updated_at, c.name as ai_config_name, c.provider
      FROM npc n LEFT JOIN ai_config c ON n.ai_config_id = c.id WHERE 1=1`;
    const params: (string | number)[] = [];

    if (category) {
      sql += ' AND n.category = ?';
      params.push(category as string);
    }
    if (status !== undefined && status !== '') {
      sql += ' AND n.status = ?';
      params.push(Number(status));
    }
    sql += ' ORDER BY n.sort ASC, n.id DESC';

    const [rows] = await pool.execute(sql, params);
    res.json({ code: 0, data: rows });
  } catch (err) {
    console.error('getNpcList:', err);
    res.status(500).json({ code: -1, message: '获取列表失败' });
  }
}

/** 根据 ID 获取单个 NPC */
export async function getNpcById(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT n.*, c.name as ai_config_name FROM npc n
       LEFT JOIN ai_config c ON n.ai_config_id = c.id
       WHERE n.id = ?`,
      [id]
    );
    const list = rows as unknown[];
    if (list.length === 0) {
      return res.status(404).json({ code: -1, message: 'NPC 不存在' });
    }
    res.json({ code: 0, data: list[0] });
  } catch (err) {
    console.error('getNpcById:', err);
    res.status(500).json({ code: -1, message: '获取失败' });
  }
}

/** 新增 NPC */
export async function createNpc(req: Request, res: Response) {
  try {
    const body = req.body as Record<string, unknown>;
    const { name, description, background, personality, gender, age, occupation, voice_tone, avatar, ai_config_id, system_prompt, category, prompt_type, status, sort } = body;

    if (!name || !ai_config_id) {
      return res.status(400).json({ code: -1, message: '角色名称和 AI 配置为必填' });
    }

    const [result] = await pool.execute(
      `INSERT INTO npc (name, description, background, personality, gender, age, occupation, voice_tone, avatar, ai_config_id, system_prompt, category, prompt_type, status, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        description || null,
        background || null,
        personality || null,
        gender || null,
        age || null,
        occupation || null,
        voice_tone || null,
        avatar || null,
        ai_config_id,
        system_prompt || null,
        category || 'custom',
        prompt_type || 'high',
        status ?? 1,
        sort ?? 0,
      ]
    );

    const insertId = (result as { insertId: number }).insertId;
    res.status(201).json({ code: 0, data: { id: insertId }, message: '创建成功' });
  } catch (err) {
    console.error('createNpc:', err);
    res.status(500).json({ code: -1, message: '创建失败' });
  }
}

/** 更新 NPC */
export async function updateNpc(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const body = req.body as Record<string, unknown>;
    const updates: string[] = [];
    const params: unknown[] = [];

    const fields = ['name', 'description', 'background', 'personality', 'gender', 'age', 'occupation', 'voice_tone', 'avatar', 'ai_config_id', 'system_prompt', 'category', 'prompt_type', 'status', 'sort'];
    for (const f of fields) {
      if (body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(body[f]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ code: -1, message: '无有效更新字段' });
    }

    params.push(id);
    await pool.execute(`UPDATE npc SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ code: 0, message: '更新成功' });
  } catch (err) {
    console.error('updateNpc:', err);
    res.status(500).json({ code: -1, message: '更新失败' });
  }
}

/** AI 自动生成角色内容（简介、背景、性格、系统提示词） */
export async function generateNpcContent(req: Request, res: Response) {
  try {
    const body = req.body as { ai_config_id: number; name?: string; hint?: string };
    const { ai_config_id, name, hint } = body;

    if (!ai_config_id) {
      return res.status(400).json({ code: -1, message: '请选择 AI 配置' });
    }
    const inputText = [name?.trim(), hint?.trim()].filter(Boolean).join('。') || '';
    if (!inputText) {
      return res.status(400).json({ code: -1, message: '请至少填写角色名称或补充描述' });
    }

    const [rows] = await pool.execute(
      'SELECT id, provider, api_key, base_url, model, max_tokens FROM ai_config WHERE id = ? AND status = 1',
      [ai_config_id]
    );
    const list = rows as unknown[];
    if (list.length === 0) {
      return res.status(404).json({ code: -1, message: 'AI 配置不存在或已禁用' });
    }
    const cfg = list[0] as { api_key: string | null; base_url: string | null; provider: string; model: string; max_tokens: number };

    const prompt = `你是一个游戏/小说角色设定助手。请根据用户描述，生成一个完整的 AI NPC 角色设定。

用户输入：${inputText}

请严格按以下 JSON 格式返回，不要添加任何其他文字或说明：
{
  "description": "角色简介，1-2句话，用于列表展示",
  "background": "详细背景故事，含出身、经历、关系等，100-300字",
  "personality": "性格特质与待人方式，如：开朗/冷淡、谨慎/冲动",
  "gender": "性别：male/female/other/unknown 之一",
  "age": "年龄：具体数字或描述如青年、中年",
  "occupation": "职业",
  "voice_tone": "说话风格/语气，如：温和、爽朗、沉稳",
  "system_prompt": "完整的系统提示词，含人设、口吻、行为约束，可直接用作 AI 对话的角色设定"
}`;

    const content = await chatCompletion(
      {
        api_key: cfg.api_key!,
        base_url: cfg.base_url,
        provider: cfg.provider,
        model: cfg.model,
        max_tokens: cfg.max_tokens,
      },
      [{ role: 'user', content: prompt }],
      { timeout: 45000, max_tokens: 1500 }
    );

    const parsed = parseNpcGenerateJson(content);
    res.json({ code: 0, data: parsed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '生成失败';
    console.error('generateNpcContent:', err);
    res.status(500).json({ code: -1, message: msg });
  }
}

/** 从 LLM 返回文本中提取并解析 JSON */
function parseNpcGenerateJson(text: string): {
  description: string;
  background: string;
  personality: string;
  gender: string;
  age: string;
  occupation: string;
  voice_tone: string;
  system_prompt: string;
} {
  let raw = text.trim();
  const jsonBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlock) {
    raw = jsonBlock[1]!.trim();
  }
  const fallback = { description: '', background: '', personality: '', gender: '', age: '', occupation: '', voice_tone: '', system_prompt: '' };
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      description: String(obj.description ?? ''),
      background: String(obj.background ?? ''),
      personality: String(obj.personality ?? ''),
      gender: String(obj.gender ?? ''),
      age: String(obj.age ?? ''),
      occupation: String(obj.occupation ?? ''),
      voice_tone: String(obj.voice_tone ?? ''),
      system_prompt: String(obj.system_prompt ?? ''),
    };
  } catch {
    return fallback;
  }
}

/** 删除 NPC */
export async function deleteNpc(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const [result] = await pool.execute('DELETE FROM npc WHERE id = ?', [id]);
    const affected = (result as { affectedRows: number }).affectedRows;
    if (affected === 0) {
      return res.status(404).json({ code: -1, message: 'NPC 不存在' });
    }
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    console.error('deleteNpc:', err);
    res.status(500).json({ code: -1, message: '删除失败' });
  }
}
