/**
 * AI 调用日志路由
 */
import { Router } from 'express';
import { getAiLogs } from '../controllers/aiLog.js';

export const aiLogRouter = Router();

/** 获取 AI 调用日志列表（分页），支持 api_type、status 筛选 */
aiLogRouter.get('/', getAiLogs);
