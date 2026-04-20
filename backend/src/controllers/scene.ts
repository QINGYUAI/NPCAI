/**
 * 场景 CRUD 与场景↔NPC 关联（覆盖式）
 */
import { Request, Response } from 'express';
import { pool } from '../db/connection.js';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

/** 列表：分页、关键词、状态、分类、标签（tags JSON 数组包含该字符串） */
export async function getSceneList(req: Request, res: Response) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '20'), 10) || 20));
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const status = req.query.status;
    const category = typeof req.query.category === 'string' ? req.query.category : '';
    const tag = typeof req.query.tag === 'string' ? req.query.tag.trim() : '';

    let where = ' WHERE 1=1';
    const params: unknown[] = [];

    if (keyword) {
      where += ' AND (s.name LIKE ? OR s.description LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw);
    }
    if (status !== undefined && status !== '') {
      where += ' AND s.status = ?';
      params.push(Number(status));
    }
    if (category) {
      where += ' AND s.category = ?';
      params.push(category);
    }
    if (tag) {
      where += ' AND s.tags IS NOT NULL AND JSON_CONTAINS(s.tags, JSON_QUOTE(?), "$")';
      params.push(tag);
    }

    const [countRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM scene s${where}`,
      params,
    );
    const total = Number((countRows as { total: number }[])[0]?.total ?? 0);

    const offset = (page - 1) * pageSize;
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT s.id, s.name, s.description, s.category, s.tags, s.status, s.sort, s.created_at, s.updated_at,
        (SELECT COUNT(*) FROM scene_npc sn WHERE sn.scene_id = s.id) AS npc_count
       FROM scene s${where}
       ORDER BY s.sort ASC, s.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );

    res.json({
      code: 0,
      data: {
        list: rows,
        total,
        page,
        pageSize,
      },
    });
  } catch (err) {
    console.error('getSceneList:', err);
    res.status(500).json({ code: -1, message: '获取场景列表失败' });
  }
}

/** 详情含关联 NPC */
export async function getSceneById(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const [scenes] = await pool.query<RowDataPacket[]>('SELECT * FROM scene WHERE id = ?', [id]);
    if (scenes.length === 0) {
      return res.status(404).json({ code: -1, message: '场景不存在' });
    }
    const scene = scenes[0] as Record<string, unknown>;
    const [links] = await pool.query<RowDataPacket[]>(
      `SELECT sn.npc_id, sn.role_note, sn.pos_x, sn.pos_y,
              n.name AS npc_name, n.avatar AS npc_avatar, n.category AS npc_category,
              n.simulation_meta AS simulation_meta
       FROM scene_npc sn
       INNER JOIN npc n ON n.id = sn.npc_id
       WHERE sn.scene_id = ?
       ORDER BY sn.npc_id ASC`,
      [id],
    );
    res.json({
      code: 0,
      data: { ...scene, npcs: links },
    });
  } catch (err) {
    console.error('getSceneById:', err);
    res.status(500).json({ code: -1, message: '获取场景失败' });
  }
}

/** 沙盒逻辑尺寸范围：至少 200，至多 8000 */
function clampDim(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(200, Math.min(8000, Math.round(n)));
}

function normalizeTags(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (Array.isArray(input)) {
    const arr = input.map((x) => String(x));
    if (arr.length === 0) return null;
    return JSON.stringify(arr);
  }
  if (typeof input === 'string') {
    try {
      const p = JSON.parse(input);
      if (Array.isArray(p)) return JSON.stringify(p.map((x) => String(x)));
    } catch {
      /* 单字符串当作单元素数组 */
      return JSON.stringify([input.trim()].filter(Boolean));
    }
  }
  return null;
}

/** 新建场景 */
export async function createScene(req: Request, res: Response) {
  try {
    const body = req.body as Record<string, unknown>;
    const name = String(body.name ?? '').trim();
    if (!name) {
      return res.status(400).json({ code: -1, message: '场景名称为必填' });
    }
    const description = body.description != null ? String(body.description) : null;
    const category = (body.category as string) || 'custom';
    const tagsJson = normalizeTags(body.tags);
    const status = body.status !== undefined ? Number(body.status) : 1;
    const sort = body.sort !== undefined ? Number(body.sort) : 0;
    const backgroundImage =
      body.background_image === undefined || body.background_image === null || body.background_image === ''
        ? null
        : String(body.background_image).slice(0, 512);
    const width = clampDim(body.width, 800);
    const height = clampDim(body.height, 600);

    const [result] = await pool.execute(
      `INSERT INTO scene (name, description, category, tags, background_image, width, height, status, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, description, category, tagsJson, backgroundImage, width, height, status, sort],
    );
    const insertId = (result as ResultSetHeader).insertId;
    res.status(201).json({ code: 0, data: { id: insertId }, message: '创建成功' });
  } catch (err) {
    console.error('createScene:', err);
    res.status(500).json({ code: -1, message: '创建场景失败' });
  }
}

/** 更新场景元数据（不含 NPC 关联） */
export async function updateScene(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const body = req.body as Record<string, unknown>;

    const [exist] = await pool.query<RowDataPacket[]>('SELECT id FROM scene WHERE id = ?', [id]);
    if (exist.length === 0) {
      return res.status(404).json({ code: -1, message: '场景不存在' });
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (body.name !== undefined) {
      const n = String(body.name).trim();
      if (!n) return res.status(400).json({ code: -1, message: '场景名称不能为空' });
      updates.push('name = ?');
      params.push(n);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description === null || body.description === '' ? null : String(body.description));
    }
    if (body.category !== undefined) {
      updates.push('category = ?');
      params.push(String(body.category || 'custom'));
    }
    if (body.tags !== undefined) {
      const tj = normalizeTags(body.tags);
      updates.push('tags = ?');
      params.push(tj);
    }
    if (body.background_image !== undefined) {
      updates.push('background_image = ?');
      params.push(
        body.background_image === null || body.background_image === ''
          ? null
          : String(body.background_image).slice(0, 512),
      );
    }
    if (body.width !== undefined) {
      updates.push('width = ?');
      params.push(clampDim(body.width, 800));
    }
    if (body.height !== undefined) {
      updates.push('height = ?');
      params.push(clampDim(body.height, 600));
    }
    if (body.status !== undefined) {
      updates.push('status = ?');
      params.push(Number(body.status));
    }
    if (body.sort !== undefined) {
      updates.push('sort = ?');
      params.push(Number(body.sort));
    }

    if (updates.length === 0) {
      return res.status(400).json({ code: -1, message: '无有效更新字段' });
    }

    params.push(id);
    await pool.execute(`UPDATE scene SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ code: 0, message: '更新成功' });
  } catch (err) {
    console.error('updateScene:', err);
    res.status(500).json({ code: -1, message: '更新场景失败' });
  }
}

/** 删除场景（级联删除 scene_npc） */
export async function deleteScene(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const [exist] = await pool.query<RowDataPacket[]>('SELECT id FROM scene WHERE id = ?', [id]);
    if (exist.length === 0) {
      return res.status(404).json({ code: -1, message: '场景不存在' });
    }
    const [result] = await pool.execute('DELETE FROM scene WHERE id = ?', [id]);
    const affected = (result as ResultSetHeader).affectedRows;
    if (affected === 0) {
      return res.status(404).json({ code: -1, message: '场景不存在' });
    }
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    console.error('deleteScene:', err);
    res.status(500).json({ code: -1, message: '删除场景失败' });
  }
}

interface NpcLinkInput {
  npc_id: number;
  role_note?: string | null;
  pos_x?: number | null;
  pos_y?: number | null;
}

interface LayoutPositionInput {
  npc_id: number;
  pos_x: number | null;
  pos_y: number | null;
}

/** 沙盒坐标范围上限（与前端画布一致，防异常值写入） */
const POS_MAX = 100000;

function normalizePosition(val: unknown): number | null {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  if (n < -POS_MAX || n > POS_MAX) return null;
  return n;
}

/** 覆盖该场景下全部 NPC 关联 */
export async function replaceSceneNpcs(req: Request, res: Response) {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const [exist] = await conn.query<RowDataPacket[]>('SELECT id FROM scene WHERE id = ?', [id]);
    if (exist.length === 0) {
      res.status(404).json({ code: -1, message: '场景不存在' });
      return;
    }

    const raw = req.body as { npcs?: unknown };
    if (!raw || !Array.isArray(raw.npcs)) {
      res.status(400).json({ code: -1, message: '请求体须包含 npcs 数组' });
      return;
    }

    const links = raw.npcs as NpcLinkInput[];
    const seen = new Set<number>();
    for (const row of links) {
      const nid = Number(row.npc_id);
      if (!Number.isFinite(nid) || nid <= 0) {
        res.status(400).json({ code: -1, message: 'npc_id 无效' });
        return;
      }
      if (seen.has(nid)) {
        res.status(400).json({ code: -1, message: 'npcs 中存在重复的 npc_id' });
        return;
      }
      seen.add(nid);
    }

    for (const nid of seen) {
      const [nr] = await conn.query<RowDataPacket[]>('SELECT id FROM npc WHERE id = ?', [nid]);
      if (nr.length === 0) {
        res.status(400).json({ code: -1, message: `NPC id=${nid} 不存在` });
        return;
      }
    }

    /** 旧坐标：保存元数据时避免覆盖沙盒已有布局 */
    const [oldRows] = await conn.query<RowDataPacket[]>(
      'SELECT npc_id, pos_x, pos_y FROM scene_npc WHERE scene_id = ?',
      [id],
    );
    const oldPos = new Map<number, { pos_x: number | null; pos_y: number | null }>();
    for (const r of oldRows as RowDataPacket[]) {
      oldPos.set(Number(r.npc_id), {
        pos_x: r.pos_x === null || r.pos_x === undefined ? null : Number(r.pos_x),
        pos_y: r.pos_y === null || r.pos_y === undefined ? null : Number(r.pos_y),
      });
    }

    await conn.beginTransaction();
    await conn.execute('DELETE FROM scene_npc WHERE scene_id = ?', [id]);
    for (const row of links) {
      const nid = Number(row.npc_id);
      const note =
        row.role_note === undefined || row.role_note === null || row.role_note === ''
          ? null
          : String(row.role_note).slice(0, 256);
      const prev = oldPos.get(nid) || { pos_x: null, pos_y: null };
      const px = row.pos_x !== undefined ? normalizePosition(row.pos_x) : prev.pos_x;
      const py = row.pos_y !== undefined ? normalizePosition(row.pos_y) : prev.pos_y;
      await conn.execute(
        'INSERT INTO scene_npc (scene_id, npc_id, role_note, pos_x, pos_y) VALUES (?, ?, ?, ?, ?)',
        [id, nid, note, px, py],
      );
    }
    await conn.commit();
    res.json({ code: 0, message: '关联已更新' });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* ignore */
    }
    console.error('replaceSceneNpcs:', err);
    res.status(500).json({ code: -1, message: '更新关联失败' });
  } finally {
    conn.release();
  }
}

/**
 * 沙盒专用：只更新已关联 NPC 的坐标
 * 不新增/删除关联，不改动 role_note
 * body: { positions: [{npc_id, pos_x, pos_y}] }
 */
export async function updateSceneLayout(req: Request, res: Response) {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const [exist] = await conn.query<RowDataPacket[]>('SELECT id FROM scene WHERE id = ?', [id]);
    if (exist.length === 0) {
      res.status(404).json({ code: -1, message: '场景不存在' });
      return;
    }

    const raw = req.body as { positions?: unknown };
    if (!raw || !Array.isArray(raw.positions)) {
      res.status(400).json({ code: -1, message: '请求体须包含 positions 数组' });
      return;
    }

    const [linkedRows] = await conn.query<RowDataPacket[]>(
      'SELECT npc_id FROM scene_npc WHERE scene_id = ?',
      [id],
    );
    const linked = new Set<number>(
      (linkedRows as RowDataPacket[]).map((r) => Number(r.npc_id)),
    );

    const positions = raw.positions as LayoutPositionInput[];
    const seen = new Set<number>();
    for (const p of positions) {
      const nid = Number(p.npc_id);
      if (!Number.isFinite(nid) || nid <= 0) {
        res.status(400).json({ code: -1, message: 'npc_id 无效' });
        return;
      }
      if (seen.has(nid)) {
        res.status(400).json({ code: -1, message: 'positions 中存在重复的 npc_id' });
        return;
      }
      seen.add(nid);
      if (!linked.has(nid)) {
        res.status(400).json({ code: -1, message: `NPC id=${nid} 未与该场景关联，不可设置坐标` });
        return;
      }
    }

    await conn.beginTransaction();
    for (const p of positions) {
      const nid = Number(p.npc_id);
      const px = normalizePosition(p.pos_x);
      const py = normalizePosition(p.pos_y);
      await conn.execute(
        'UPDATE scene_npc SET pos_x = ?, pos_y = ? WHERE scene_id = ? AND npc_id = ?',
        [px, py, id, nid],
      );
    }
    await conn.commit();
    res.json({ code: 0, message: '布局已保存' });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* ignore */
    }
    console.error('updateSceneLayout:', err);
    res.status(500).json({ code: -1, message: '保存布局失败' });
  } finally {
    conn.release();
  }
}

function escapeCsvCell(val: string | number | null | undefined): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** 导出某场景下关联的 NPC 列表（JSON 或 CSV） */
export async function exportSceneNpcs(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const format = String(req.query.format || 'json').toLowerCase() === 'csv' ? 'csv' : 'json';

    const [scenes] = await pool.query<RowDataPacket[]>('SELECT id, name, category, description FROM scene WHERE id = ?', [
      id,
    ]);
    if (scenes.length === 0) {
      return res.status(404).json({ code: -1, message: '场景不存在' });
    }
    const scene = scenes[0] as Record<string, unknown>;
    const [links] = await pool.query<RowDataPacket[]>(
      `SELECT sn.npc_id, sn.role_note, n.name AS npc_name, n.category AS npc_category
       FROM scene_npc sn
       INNER JOIN npc n ON n.id = sn.npc_id
       WHERE sn.scene_id = ?
       ORDER BY sn.npc_id ASC`,
      [id],
    );

    const filenameBase = `scene-${id}-npcs`;

    if (format === 'json') {
      const body = {
        scene_id: scene.id,
        scene_name: scene.name,
        scene_category: scene.category,
        scene_description: scene.description,
        exported_at: new Date().toISOString(),
        npcs: links,
      };
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.json"`);
      return res.send(JSON.stringify(body, null, 2));
    }

    const header = ['npc_id', 'npc_name', 'npc_category', 'role_note'];
    const lines = [header.join(',')];
    for (const row of links as Record<string, unknown>[]) {
      lines.push(
        [
          escapeCsvCell(row.npc_id as number),
          escapeCsvCell(row.npc_name as string),
          escapeCsvCell(row.npc_category as string),
          escapeCsvCell(row.role_note as string | null),
        ].join(','),
      );
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('exportSceneNpcs:', err);
    res.status(500).json({ code: -1, message: '导出失败' });
  }
}
