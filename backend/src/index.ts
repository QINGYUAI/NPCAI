/**
 * AI配置模块 - 后端入口
 * 提供 AI 配置、角色 NPC 等服务
 */
import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { configRouter } from './routes/config.js';
import { npcRouter } from './routes/npc.js';
import { uploadRouter } from './routes/upload.js';
import { aiLogRouter } from './routes/aiLog.js';
import { sceneRouter } from './routes/scene.js';
import { engineRouter } from './routes/engine.js';
import { initEngine } from './engine/index.js';
import { mountEngineWs } from './engine/wsServer.js';
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
app.use('/api/engine', engineRouter);

initEngine();

// 健康检查
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', message: 'AI配置服务运行中' });
});

/**
 * [M4.2.1.b] 改用 http.createServer 以便 ws 同端口挂载（/ws/engine）
 * 若 OBSERVABILITY_WS_ENABLED=false，mountEngineWs 会跳过挂载，前端自动回落轮询
 */
const httpServer = http.createServer(app);
mountEngineWs(httpServer);

httpServer.listen(PORT, () => {
  console.log(`🚀 服务已启动: http://localhost:${PORT}`);
});
