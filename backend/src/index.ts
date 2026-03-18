/**
 * AI配置模块 - 后端入口
 * 提供 AI 配置、角色 NPC、地图、对话、WebSocket 等服务
 */
import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { configRouter } from './routes/config.js';
import { npcRouter } from './routes/npc.js';
import { conversationRouter } from './routes/conversation.js';
import { memoryRouter } from './routes/memory.js';
import { uploadRouter } from './routes/upload.js';
import { mapRouter } from './routes/map.js';
import { itemRouter } from './routes/item.js';
import { aiLogRouter } from './routes/aiLog.js';
import { initWsServer } from './ws/server.js';
import { startWanderLoop } from './services/wander.js';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// 中间件
app.use(cors());
app.use(express.json());

// 静态资源：上传的头像等
const uploadsDir = path.join(process.cwd(), 'uploads');
app.use('/uploads', express.static(uploadsDir));

// 路由挂载
app.use('/api/config', configRouter);
app.use('/api/npc', npcRouter);
app.use('/api/conversation', conversationRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/map', mapRouter);
app.use('/api/item', itemRouter);
app.use('/api/ai-logs', aiLogRouter);

// 健康检查
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', message: 'AI配置服务运行中' });
});

initWsServer(server);
startWanderLoop();

server.listen(PORT, () => {
  console.log(`🚀 服务已启动: http://localhost:${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}/ws?token=xxx&mapId=1`);
});
