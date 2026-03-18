/**
 * AI 配置 CRUD 路由
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  getConfigList,
  getConfigById,
  createConfig,
  updateConfig,
  deleteConfig,
  setDefaultConfig,
  testConnection,
} from '../controllers/config.js';

export const configRouter = Router();

configRouter.get('/', asyncHandler(getConfigList));
configRouter.get('/:id', asyncHandler(getConfigById));
configRouter.post('/', asyncHandler(createConfig));
configRouter.put('/:id', asyncHandler(updateConfig));
configRouter.delete('/:id', asyncHandler(deleteConfig));
configRouter.post('/:id/test', asyncHandler(testConnection));
configRouter.patch('/:id/default', asyncHandler(setDefaultConfig));
