/**
 * 物品 CRUD 控制器
 */
import { Request, Response } from 'express';
import { pool } from '../db/connection.js';

/** 物品列表 */
export async function getItemList(req: Request, res: Response) {
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, category, description, footprint, tile_value, is_blocking, metadata, status, sort, created_at
       FROM item ORDER BY sort ASC, id DESC`
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    console.error('getItemList:', err);
    res.status(500).json({ code: -1, message: '获取物品列表失败' });
  }
}

/** 物品详情 */
export async function getItemById(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT * FROM item WHERE id = ?', [id]);
    const list = rows as Record<string, unknown>[];
    if (list.length === 0) {
      return res.status(404).json({ code: -1, message: '物品不存在' });
    }
    res.json({ code: 0, data: list[0] });
  } catch (err) {
    console.error('getItemById:', err);
    res.status(500).json({ code: -1, message: '获取物品失败' });
  }
}

/** 创建物品 */
export async function createItem(req: Request, res: Response) {
  try {
    const { name, category, description, footprint, tile_value, is_blocking, metadata, status, sort } = req.body;
    if (!name || !footprint) {
      return res.status(400).json({ code: -1, message: 'name、footprint 为必填' });
    }
    const footprintStr = typeof footprint === 'string' ? footprint : JSON.stringify(footprint);
    const metaStr = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;

    const [result] = await pool.execute(
      `INSERT INTO item (name, category, description, footprint, tile_value, is_blocking, metadata, status, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        category || 'object',
        description || null,
        footprintStr,
        tile_value ?? 1,
        is_blocking ?? 1,
        metaStr,
        status ?? 1,
        sort ?? 0,
      ]
    );
    const r = result as { insertId: number };
    res.json({ code: 0, data: { id: r.insertId }, message: '创建成功' });
  } catch (err) {
    console.error('createItem:', err);
    res.status(500).json({ code: -1, message: '创建物品失败' });
  }
}

/** 更新物品 */
export async function updateItem(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { name, category, description, footprint, tile_value, is_blocking, metadata, status, sort } = req.body;
    const updates: string[] = [];
    const params: unknown[] = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (category !== undefined) { updates.push('category = ?'); params.push(category); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (footprint !== undefined) {
      updates.push('footprint = ?');
      params.push(typeof footprint === 'string' ? footprint : JSON.stringify(footprint));
    }
    if (tile_value !== undefined) { updates.push('tile_value = ?'); params.push(tile_value); }
    if (is_blocking !== undefined) { updates.push('is_blocking = ?'); params.push(is_blocking); }
    if (metadata !== undefined) {
      updates.push('metadata = ?');
      params.push(metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null);
    }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }
    if (sort !== undefined) { updates.push('sort = ?'); params.push(sort); }

    if (updates.length === 0) {
      return res.status(400).json({ code: -1, message: '无有效更新字段' });
    }
    params.push(id);
    await pool.execute(`UPDATE item SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ code: 0, message: '更新成功' });
  } catch (err) {
    console.error('updateItem:', err);
    res.status(500).json({ code: -1, message: '更新物品失败' });
  }
}

/** 删除物品 */
export async function deleteItem(req: Request, res: Response) {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM item WHERE id = ?', [id]);
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    console.error('deleteItem:', err);
    res.status(500).json({ code: -1, message: '删除物品失败' });
  }
}
