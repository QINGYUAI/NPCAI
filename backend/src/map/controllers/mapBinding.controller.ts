/**
 * 地图 NPC 绑定控制器
 */
import { Request, Response } from 'express';
import { pool } from '../../db/connection.js';
import { redis } from '../../db/redis.js';
import { asyncHandler, apiError } from '../map.middleware.js';

/** 获取地图绑定的 NPC 列表 */
export const getMapBindings = asyncHandler(async (req: Request, res: Response) => {
  const { mapId } = req.params;
  const [rows] = await pool.execute(
    `SELECT b.id, b.npc_id, b.map_id, b.init_x, b.init_y, n.name as npc_name, n.avatar
     FROM npc_map_binding b
     JOIN npc n ON b.npc_id = n.id
     WHERE b.map_id = ? ORDER BY b.id`,
    [mapId]
  );
  res.json({ code: 0, data: rows });
});

/** 添加 NPC 到地图 */
export const addMapBinding = asyncHandler(async (req: Request, res: Response) => {
  const { mapId } = req.params;
  const { npc_id, init_x = 0, init_y = 0 } = req.body;
  if (!npc_id) return apiError(res, -1, 'npc_id 为必填', 400);

  await pool.execute(
    `INSERT INTO npc_map_binding (npc_id, map_id, init_x, init_y)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE init_x = ?, init_y = ?`,
    [npc_id, mapId, init_x, init_y, init_x, init_y]
  );
  res.json({ code: 0, message: '添加成功' });
});

/** 移除地图上的 NPC */
export const removeMapBinding = asyncHandler(async (req: Request, res: Response) => {
  const { mapId, npcId } = req.params;
  await pool.execute('DELETE FROM npc_map_binding WHERE map_id = ? AND npc_id = ?', [mapId, npcId]);
  await redis.del(`map:${mapId}:npc:${npcId}`);
  await redis.srem(`map:${mapId}:npcs`, npcId);
  res.json({ code: 0, message: '移除成功' });
});
