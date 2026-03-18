/**
 * 记忆管理路由
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  getMemories,
  getRecentThoughts,
  deleteMemory,
  updateMemory,
  reflectMemories,
} from '../controllers/memory.js';

export const memoryRouter = Router();

/** 获取某 NPC 的最近思考记录（按时间，供轮询） */
memoryRouter.get('/thoughts', asyncHandler(getRecentThoughts));

/** 获取某 NPC 的记忆列表 */
memoryRouter.get('/', asyncHandler(getMemories));

/** 手动触发反思 */
memoryRouter.post('/reflect', asyncHandler(reflectMemories));

/** 删除记忆 */
memoryRouter.delete('/:id', asyncHandler(deleteMemory));

/** 更新记忆 */
memoryRouter.patch('/:id', asyncHandler(updateMemory));
