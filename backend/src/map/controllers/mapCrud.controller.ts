/**
 * 地图 CRUD 控制器
 */
import { Request, Response } from 'express';
import { pool } from '../../db/connection.js';
import { redis } from '../../db/redis.js';
import { createMapData } from '../map.service.js';
import { asyncHandler, apiError } from '../map.middleware.js';

/** 获取地图列表 */
export const getMapList = asyncHandler(async (req: Request, res: Response) => {
  const [rows] = await pool.execute(
    `SELECT id, name, width, height, status, created_at
     FROM game_map ORDER BY id DESC`
  );
  res.json({ code: 0, data: rows });
});

/** 根据 ID 获取地图详情 */
export const getMapById = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const [rows] = await pool.execute('SELECT * FROM game_map WHERE id = ?', [id]);
  const list = rows as Record<string, unknown>[];
  if (list.length === 0) {
    return apiError(res, -1, '地图不存在', 404);
  }
  const row = list[0];
  if (typeof row!.tile_data === 'string') {
    row!.tile_data = JSON.parse(row!.tile_data as string);
  }
  res.json({ code: 0, data: row });
});

/** 创建地图（需配合 validateBody(createMapSchema) 中间件） */
export const createMap = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as {
    name: string;
    width: number;
    height: number;
    items?: Array<{ item_id?: number; name?: string; category?: string; description?: string; footprint?: number[][]; tile_value?: number; pos_x: number; pos_y: number; rotation?: number }>;
    tile_data?: number[][];
    metadata?: Record<string, unknown>;
  };
  const { id } = await createMapData({
    name: body.name,
    width: body.width,
    height: body.height,
    items: body.items,
    tile_data: body.tile_data,
    metadata: body.metadata,
  });
  res.json({ code: 0, data: { id }, message: '创建成功' });
});

/** 更新地图 */
export const updateMap = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, width, height, tile_data, metadata, status } = req.body;
  const updates: string[] = [];
  const params: unknown[] = [];

  if (name !== undefined) {
    updates.push('name = ?');
    params.push(name);
  }
  if (width !== undefined) {
    updates.push('width = ?');
    params.push(width);
  }
  if (height !== undefined) {
    updates.push('height = ?');
    params.push(height);
  }
  if (tile_data !== undefined) {
    updates.push('tile_data = ?');
    params.push(typeof tile_data === 'string' ? tile_data : JSON.stringify(tile_data));
  }
  if (metadata !== undefined) {
    updates.push('metadata = ?');
    params.push(metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null);
  }
  if (status !== undefined) {
    updates.push('status = ?');
    params.push(status);
  }

  if (updates.length === 0) {
    return apiError(res, -1, '无有效更新字段', 400);
  }
  params.push(id);
  await pool.execute(`UPDATE game_map SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ code: 0, message: '更新成功' });
});

/** 删除地图 */
export const deleteMap = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  await pool.execute('DELETE FROM game_map WHERE id = ?', [id]);
  const keys = await redis.keys(`map:${id}:*`);
  if (keys.length > 0) await redis.del(...keys);
  res.json({ code: 0, message: '删除成功' });
});
