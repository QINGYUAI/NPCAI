/**
 * 地图与场景路由
 */
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  getMapList,
  getMapById,
  createMap,
  updateMap,
  deleteMap,
  generateMapContent,
  convertLayoutImageToMap,
  getMapItems,
  addMapItem,
  removeMapItem,
  getMapBindings,
  addMapBinding,
  removeMapBinding,
  initScene,
  getSceneState,
  startMap,
  pauseMapController,
  resumeMapController,
} from '../controllers/map.js';

const layoutUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(process.cwd(), 'uploads', 'layouts');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '') || '.png';
      cb(null, `layout-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

export const mapRouter = Router();

// 地图 CRUD
mapRouter.get('/', getMapList);
mapRouter.post('/', createMap);
// AI 生成地图配置
mapRouter.post('/generate', generateMapContent);
// 室内布局图上传转地图（需 Vision 模型）
mapRouter.post('/convert-layout', layoutUpload.single('file'), convertLayoutImageToMap);
// 带子路径的路由放前面，避免被 /:id 抢匹配
mapRouter.get('/:mapId/bindings', getMapBindings);
mapRouter.post('/:mapId/bindings', addMapBinding);
mapRouter.get('/:mapId/items', getMapItems);
mapRouter.post('/:mapId/items', addMapItem);
mapRouter.delete('/:mapId/items/:bindingId', removeMapItem);
mapRouter.delete('/:mapId/bindings/:npcId', removeMapBinding);
mapRouter.post('/:mapId/init', initScene);
mapRouter.post('/:mapId/start', startMap);
mapRouter.post('/:mapId/pause', pauseMapController);
mapRouter.post('/:mapId/resume', resumeMapController);
mapRouter.get('/:mapId/state', getSceneState);
mapRouter.get('/:id', getMapById);
mapRouter.put('/:id', updateMap);
mapRouter.delete('/:id', deleteMap);
