/**
 * 场景路由
 */
import { Router } from 'express';
import {
  getSceneList,
  getSceneById,
  createScene,
  updateScene,
  deleteScene,
  replaceSceneNpcs,
  updateSceneLayout,
  exportSceneNpcs,
} from '../controllers/scene.js';
import {
  createSceneEvent,
  listSceneEvents,
  deleteSceneEvent,
} from '../controllers/sceneEvents.js';

export const sceneRouter = Router();

sceneRouter.get('/', getSceneList);
sceneRouter.post('/', createScene);
/** 子路由须写在 /:id 之前，避免被错误匹配 */
sceneRouter.put('/:id/npcs', replaceSceneNpcs);
sceneRouter.put('/:id/layout', updateSceneLayout);
sceneRouter.get('/:id/export', exportSceneNpcs);
/** [M4.2.4.b] 场景事件子路由（在 /:id 捕获之前注册） */
sceneRouter.post('/:id/events', createSceneEvent);
sceneRouter.get('/:id/events', listSceneEvents);
sceneRouter.delete('/:id/events/:eid', deleteSceneEvent);
sceneRouter.get('/:id', getSceneById);
sceneRouter.put('/:id', updateScene);
sceneRouter.delete('/:id', deleteScene);
