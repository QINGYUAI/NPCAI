/**
 * AI 配置控制器 - 处理配置的增删改查逻辑
 */
import { Request, Response } from 'express';
import { pool } from '../db/connection.js';
import type { CreateConfigDto } from '../types/index.js';

/** 获取配置列表，支持按提供商、状态筛选 */
export async function getConfigList(req: Request, res: Response) {
  try {
    const { provider, status } = req.query;
    let sql = 'SELECT id, name, provider, base_url, model, temperature, max_tokens, is_default, status, remark, created_at, updated_at FROM ai_config WHERE 1=1';
    const params: (string | number)[] = [];

    if (provider) {
      sql += ' AND provider = ?';
      params.push(provider as string);
    }
    if (status !== undefined && status !== '') {
      sql += ' AND status = ?';
      params.push(Number(status));
    }
    sql += ' ORDER BY is_default DESC, id DESC';

    const [rows] = await pool.execute(sql, params);
    res.json({ code: 0, data: rows });
  } catch (err) {
    console.error('getConfigList:', err);
    res.status(500).json({ code: -1, message: '获取配置列表失败' });
  }
}

/** 根据 ID 获取单个配置（不返回 api_key） */
export async function getConfigById(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      'SELECT id, name, provider, base_url, model, temperature, max_tokens, is_default, status, remark, created_at, updated_at FROM ai_config WHERE id = ?',
      [id]
    );
    const list = rows as unknown[];
    if (list.length === 0) {
      return res.status(404).json({ code: -1, message: '配置不存在' });
    }
    res.json({ code: 0, data: list[0] });
  } catch (err) {
    console.error('getConfigById:', err);
    res.status(500).json({ code: -1, message: '获取配置失败' });
  }
}

/** 新增配置 */
export async function createConfig(req: Request, res: Response) {
  try {
    const body: CreateConfigDto = req.body;
    const { name, provider, api_key, base_url, model, temperature, max_tokens, is_default, status, remark } = body;

    if (!name || !provider) {
      return res.status(400).json({ code: -1, message: '配置名称和提供商为必填' });
    }

    if (is_default === 1) {
      await pool.execute('UPDATE ai_config SET is_default = 0');
    }

    const [result] = await pool.execute(
      `INSERT INTO ai_config (name, provider, api_key, base_url, model, temperature, max_tokens, is_default, status, remark)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        provider,
        api_key || null,
        base_url || null,
        model || 'gpt-3.5-turbo',
        temperature ?? 0.7,
        max_tokens ?? 2000,
        is_default ?? 0,
        status ?? 1,
        remark || null,
      ]
    );

    const insertId = (result as { insertId: number }).insertId;
    res.status(201).json({ code: 0, data: { id: insertId }, message: '创建成功' });
  } catch (err) {
    console.error('createConfig:', err);
    res.status(500).json({ code: -1, message: '创建配置失败' });
  }
}

/** 更新配置 */
export async function updateConfig(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const body = req.body as Record<string, unknown>;
    const { name, provider, api_key, base_url, model, temperature, max_tokens, is_default, status, remark } = body;

    const updates: string[] = [];
    const params: unknown[] = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (provider !== undefined) { updates.push('provider = ?'); params.push(provider); }
    if (api_key !== undefined) { updates.push('api_key = ?'); params.push(api_key); }
    if (base_url !== undefined) { updates.push('base_url = ?'); params.push(base_url); }
    if (model !== undefined) { updates.push('model = ?'); params.push(model); }
    if (temperature !== undefined) { updates.push('temperature = ?'); params.push(temperature); }
    if (max_tokens !== undefined) { updates.push('max_tokens = ?'); params.push(max_tokens); }
    if (is_default !== undefined) {
      updates.push('is_default = ?');
      params.push(is_default);
      if (is_default === 1) {
        await pool.execute('UPDATE ai_config SET is_default = 0 WHERE id != ?', [id]);
      }
    }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }
    if (remark !== undefined) { updates.push('remark = ?'); params.push(remark); }

    if (updates.length === 0) {
      return res.status(400).json({ code: -1, message: '无有效更新字段' });
    }

    params.push(id);
    await pool.execute(`UPDATE ai_config SET ${updates.join(', ')} WHERE id = ?`, params);

    res.json({ code: 0, message: '更新成功' });
  } catch (err) {
    console.error('updateConfig:', err);
    res.status(500).json({ code: -1, message: '更新配置失败' });
  }
}

/** 删除配置 */
export async function deleteConfig(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const [result] = await pool.execute('DELETE FROM ai_config WHERE id = ?', [id]);
    const affected = (result as { affectedRows: number }).affectedRows;
    if (affected === 0) {
      return res.status(404).json({ code: -1, message: '配置不存在' });
    }
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    console.error('deleteConfig:', err);
    res.status(500).json({ code: -1, message: '删除配置失败' });
  }
}

/** 连接测试 - 验证 API Key 与配置是否可用 */
export async function testConnection(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      'SELECT id, name, provider, api_key, base_url, model FROM ai_config WHERE id = ?',
      [id]
    );
    const list = rows as unknown[];
    if (list.length === 0) {
      return res.status(404).json({ code: -1, message: '配置不存在' });
    }
    const config = list[0] as { api_key: string | null; base_url: string | null; provider: string; model: string };
    const { api_key, base_url, provider, model } = config;

    if (!api_key || !api_key.trim()) {
      return res.status(400).json({ code: -1, message: '该配置未设置 API Key' });
    }

    const { PROVIDER_BASE_URLS } = await import('../utils/providerDefaults.js');
    const base = (base_url && base_url.trim()) || PROVIDER_BASE_URLS[provider] || 'https://api.openai.com/v1';
    const url = base.replace(/\/$/, '') + '/chat/completions';

    const body = {
      model: model || 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${api_key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (resp.ok) {
      res.json({ code: 0, message: '连接成功' });
    } else {
      const errText = await resp.text();
      let errMsg = `HTTP ${resp.status}`;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.error?.message || errJson.message || errText.slice(0, 200) || errMsg;
      } catch {
        errMsg = errText.slice(0, 200) || errMsg;
      }
      res.json({ code: -1, message: `连接失败: ${errMsg}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '连接测试失败';
    const isAbort = msg.includes('abort') || msg.includes('timeout');
    res.json({
      code: -1,
      message: isAbort ? '连接超时，请检查网络或 Base URL' : `连接失败: ${msg}`,
    });
  }
}

/** 设为默认配置 */
export async function setDefaultConfig(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('UPDATE ai_config SET is_default = 0');
      const [result] = await conn.execute('UPDATE ai_config SET is_default = 1 WHERE id = ?', [id]);
      const affected = (result as { affectedRows: number }).affectedRows;
      await conn.commit();
      if (affected === 0) {
        return res.status(404).json({ code: -1, message: '配置不存在' });
      }
      res.json({ code: 0, message: '已设为默认' });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('setDefaultConfig:', err);
    res.status(500).json({ code: -1, message: '操作失败' });
  }
}
