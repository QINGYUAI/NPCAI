/**
 * AI 配置 CRUD 路由
 */
import { Router } from 'express';
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

// 获取配置列表
configRouter.get('/', getConfigList);

// 获取单个配置（按 ID）
configRouter.get('/:id', getConfigById);

// 新增配置
configRouter.post('/', createConfig);

// 更新配置
configRouter.put('/:id', updateConfig);

// 删除配置
configRouter.delete('/:id', deleteConfig);

// 连接测试
configRouter.post('/:id/test', testConnection);

// 设为默认配置
configRouter.patch('/:id/default', setDefaultConfig);
