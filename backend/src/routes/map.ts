/**
 * 地图与场景路由
 */
import { Router } from 'express';
import {
  getMapList,
  getMapById,
  createMap,
  updateMap,
  deleteMap,
  generateMapContent,
  getMapBindings,
  addMapBinding,
  removeMapBinding,
  initScene,
  getSceneState,
  startMap,
  pauseMapController,
  resumeMapController,
} from '../controllers/map.js';

export const mapRouter = Router();

// 地图 CRUD
mapRouter.get('/', getMapList);
mapRouter.post('/', createMap);
// AI 生成地图配置（需在 /:mapId 之前注册，避免 "generate" 被当作 mapId）
mapRouter.post('/generate', generateMapContent);
// 带子路径的路由放前面，避免被 /:id 抢匹配
mapRouter.get('/:mapId/bindings', getMapBindings);
mapRouter.post('/:mapId/bindings', addMapBinding);
mapRouter.delete('/:mapId/bindings/:npcId', removeMapBinding);
mapRouter.post('/:mapId/init', initScene);
mapRouter.post('/:mapId/start', startMap);
mapRouter.post('/:mapId/pause', pauseMapController);
mapRouter.post('/:mapId/resume', resumeMapController);
mapRouter.get('/:mapId/state', getSceneState);
mapRouter.get('/:id', getMapById);
mapRouter.put('/:id', updateMap);
mapRouter.delete('/:id', deleteMap);
