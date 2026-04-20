/**
 * AI配置模块 - 后端入口
 * 提供 AI 配置、角色 NPC 等服务
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { configRouter } from './routes/config.js';
import { npcRouter } from './routes/npc.js';
import { uploadRouter } from './routes/upload.js';
import { aiLogRouter } from './routes/aiLog.js';
import { sceneRouter } from './routes/scene.js';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());

// 静态资源：上传的头像等
const uploadsDir = path.join(process.cwd(), 'uploads');
app.use('/uploads', express.static(uploadsDir));

// 路由挂载
app.use('/api/config', configRouter);
app.use('/api/npc', npcRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/ai-logs', aiLogRouter);
app.use('/api/scene', sceneRouter);

// 健康检查
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', message: 'AI配置服务运行中' });
});

app.listen(PORT, () => {
  console.log(`🚀 服务已启动: http://localhost:${PORT}`);
});
