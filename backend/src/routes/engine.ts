/**
 * 引擎路由 /api/engine/*
 */
import { Router } from 'express';
import {
  startEngine,
  stopEngine,
  getEngineStatus,
  getEngineTicks,
  stepEngine,
} from '../controllers/engine.js';
import { reflectOnce } from '../controllers/reflection.js';

export const engineRouter = Router();

engineRouter.post('/start', startEngine);
engineRouter.post('/stop', stopEngine);
engineRouter.post('/step', stepEngine);
engineRouter.get('/status', getEngineStatus);
engineRouter.get('/ticks', getEngineTicks);
/** [M4.2.3.c] 手动触发某 NPC 的一次反思（忽略 tick 周期判定） */
engineRouter.post('/reflect', reflectOnce);
