/**
 * 地图物品控制器（放置、移除、列表）
 */
import { Request, Response } from 'express';
import { pool } from '../../db/connection.js';
import {
  deriveTileDataFromItems,
  findOrCreateItem,
  getTileTypesForMap,
} from '../../services/itemMap.js';
import { asyncHandler, apiError } from '../map.middleware.js';

/** 获取地图上的物品列表 */
export const getMapItems = asyncHandler(async (req: Request, res: Response) => {
  const { mapId } = req.params;
  const [rows] = await pool.execute(
    `SELECT b.id, b.item_id, b.map_id, b.pos_x, b.pos_y, b.rotation, i.name, i.category, i.description, i.footprint, i.tile_value
     FROM item_map_binding b
     JOIN item i ON b.item_id = i.id
     WHERE b.map_id = ?
     ORDER BY b.id`,
    [mapId]
  );
  const list = rows as Record<string, unknown>[];
  for (const r of list) {
    if (typeof r.footprint === 'string') r.footprint = JSON.parse(r.footprint as string);
  }
  res.json({ code: 0, data: list });
});

/** 在地图上放置物品 */
export const addMapItem = asyncHandler(async (req: Request, res: Response) => {
  const { mapId } = req.params;
  const body = req.body as {
    item_id?: number;
    name?: string;
    category?: string;
    description?: string;
    footprint?: number[][];
    tile_value?: number;
    pos_x: number;
    pos_y: number;
    rotation?: number;
  };
  const mapIdNum = Number(mapId);
  if (!mapIdNum) return apiError(res, -1, '地图 ID 无效', 400);

  let itemId: number;
  if (body.item_id) {
    itemId = Number(body.item_id);
    if (!itemId) return apiError(res, -1, 'item_id 无效', 400);
  } else if (body.name && body.footprint) {
    itemId = await findOrCreateItem({
      name: body.name,
      category: body.category,
      description: body.description,
      footprint: body.footprint,
      tile_value: body.tile_value,
      metadata: body.tile_value ? { color: '#444444' } : undefined,
    });
  } else {
    return apiError(res, -1, '需提供 item_id 或完整物品定义 (name, footprint)', 400);
  }

  await pool.execute(
    'INSERT INTO item_map_binding (item_id, map_id, pos_x, pos_y, rotation) VALUES (?, ?, ?, ?, ?)',
    [itemId, mapIdNum, Number(body.pos_x) || 0, Number(body.pos_y) || 0, body.rotation ?? 0]
  );

  const [mapRow] = await pool.execute('SELECT width, height FROM game_map WHERE id = ?', [mapIdNum]);
  const m = (mapRow as { width: number; height: number }[])[0];
  if (m) {
    const grid = await deriveTileDataFromItems(mapIdNum, m.width, m.height);
    const tileTypes = await getTileTypesForMap(mapIdNum);
    await pool.execute('UPDATE game_map SET tile_data = ?, metadata = ? WHERE id = ?', [
      JSON.stringify(grid),
      JSON.stringify({ tile_types: tileTypes }),
      mapIdNum,
    ]);
  }
  res.json({ code: 0, message: '放置成功' });
});

/** 移除地图上的物品 */
export const removeMapItem = asyncHandler(async (req: Request, res: Response) => {
  const { mapId, bindingId } = req.params;
  const mapIdNum = Number(mapId);
  const bindingIdNum = Number(bindingId);
  if (!mapIdNum || !bindingIdNum) return apiError(res, -1, '参数无效', 400);

  await pool.execute('DELETE FROM item_map_binding WHERE id = ? AND map_id = ?', [bindingIdNum, mapIdNum]);

  const [mapRow] = await pool.execute('SELECT width, height FROM game_map WHERE id = ?', [mapIdNum]);
  const m = (mapRow as { width: number; height: number }[])[0];
  if (m) {
    const grid = await deriveTileDataFromItems(mapIdNum, m.width, m.height);
    const tileTypes = await getTileTypesForMap(mapIdNum);
    await pool.execute('UPDATE game_map SET tile_data = ?, metadata = ? WHERE id = ?', [
      JSON.stringify(grid),
      JSON.stringify({ tile_types: tileTypes }),
      mapIdNum,
    ]);
  }
  res.json({ code: 0, message: '移除成功' });
});
