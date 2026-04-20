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

export const sceneRouter = Router();

sceneRouter.get('/', getSceneList);
sceneRouter.post('/', createScene);
/** 子路由须写在 /:id 之前，避免被错误匹配 */
sceneRouter.put('/:id/npcs', replaceSceneNpcs);
sceneRouter.put('/:id/layout', updateSceneLayout);
sceneRouter.get('/:id/export', exportSceneNpcs);
sceneRouter.get('/:id', getSceneById);
sceneRouter.put('/:id', updateScene);
sceneRouter.delete('/:id', deleteScene);
