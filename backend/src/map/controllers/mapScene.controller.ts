/**
 * 地图场景控制器（初始化、启停、状态）
 */
import { Request, Response } from 'express';
import { redis } from '../../db/redis.js';
import { pauseMap, resumeMap } from '../../services/wander.js';
import { initSceneData } from '../map.service.js';
import { buildSceneState } from '../../services/mapScene.js';
import { asyncHandler, withRedisHint } from '../map.middleware.js';

/** 场景初始化：从 npc_map_binding 加载到 Redis */
export const initScene = asyncHandler(async (req: Request, res: Response) => {
  const { mapId } = req.params;
  const { npcCount } = await initSceneData(mapId);
  if (npcCount === 0) {
    res.json({ code: 0, data: { npcCount: 0 }, message: '空地图，未启动' });
    return;
  }
  res.json({ code: 0, data: { npcCount }, message: '场景已初始化' });
});

/** 开始：初始化并启动 NPC 移动 */
export const startMap = withRedisHint(async (req: Request, res: Response) => {
  const { mapId } = req.params;
  const npcIds = await redis.smembers(`map:${mapId}:npcs`);
  if (npcIds.length === 0) {
    const { npcCount } = await initSceneData(mapId);
    if (npcCount === 0) {
      res.json({ code: 0, data: { npcCount: 0 }, message: '空地图，无法启动' });
      return;
    }
    await resumeMap(mapId);
    res.json({ code: 0, data: { npcCount }, message: '已启动' });
    return;
  }
  await resumeMap(mapId);
  res.json({ code: 0, data: { npcCount: npcIds.length }, message: '已恢复' });
});

/** 暂停：停止该地图 NPC 移动 */
export const pauseMapController = asyncHandler(async (req: Request, res: Response) => {
  const { mapId } = req.params;
  await pauseMap(mapId);
  res.json({ code: 0, message: '已暂停' });
});

/** 恢复：恢复该地图 NPC 移动 */
export const resumeMapController = asyncHandler(async (req: Request, res: Response) => {
  const { mapId } = req.params;
  await resumeMap(mapId);
  res.json({ code: 0, message: '已恢复' });
});

/** 获取场景内 NPC 实时状态 */
export const getSceneState = asyncHandler(async (req: Request, res: Response) => {
  const { mapId } = req.params;
  const data = await buildSceneState(mapId);
  res.json({ code: 0, data });
});
