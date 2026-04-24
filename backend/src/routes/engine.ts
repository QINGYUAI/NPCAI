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
import { getTraceDetail } from '../controllers/trace.js';
import {
  postGoal,
  patchGoal,
  getGoalList,
  getGoalDetail,
  deleteGoalById,
} from '../controllers/goals.js';

export const engineRouter = Router();

engineRouter.post('/start', startEngine);
engineRouter.post('/stop', stopEngine);
engineRouter.post('/step', stepEngine);
engineRouter.get('/status', getEngineStatus);
engineRouter.get('/ticks', getEngineTicks);
/** [M4.2.3.c] 手动触发某 NPC 的一次反思（忽略 tick 周期判定） */
engineRouter.post('/reflect', reflectOnce);
/** [M4.3.0] 运维探针：按 trace_id 聚合 5 张表的本 tick 写入 */
engineRouter.get('/trace/:trace_id', getTraceDetail);
/** [M4.5.1.a] 动态目标 REST：写操作受 GOAL_ENABLED 约束；读操作不受限 */
engineRouter.post('/goals', postGoal);
engineRouter.patch('/goals/:id', patchGoal);
engineRouter.get('/goals', getGoalList);
engineRouter.get('/goals/:id', getGoalDetail);
engineRouter.delete('/goals/:id', deleteGoalById);
