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

export const engineRouter = Router();

engineRouter.post('/start', startEngine);
engineRouter.post('/stop', stopEngine);
engineRouter.post('/step', stepEngine);
engineRouter.get('/status', getEngineStatus);
engineRouter.get('/ticks', getEngineTicks);
