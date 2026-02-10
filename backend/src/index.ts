/**
 * AI配置模块 - 后端入口
 * 提供 AI 配置的增删改查 API
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { configRouter } from './routes/config.js';
import { npcRouter } from './routes/npc.js';

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());

// 路由挂载
app.use('/api/config', configRouter);
app.use('/api/npc', npcRouter);

// 健康检查
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', message: 'AI配置服务运行中' });
});

app.listen(PORT, () => {
  console.log(`🚀 服务已启动: http://localhost:${PORT}`);
});
