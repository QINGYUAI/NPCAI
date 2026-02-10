/**
 * 对话相关路由
 */
import { Router } from 'express';
import { chat, chatStream, getMessages, getConversations, createConversation, deleteConversation } from '../controllers/conversation.js';

export const conversationRouter = Router();

/** 用户与 NPC 对话（普通，一次返回完整回复） */
conversationRouter.post('/chat', chat);

/** 用户与 NPC 对话（流式，逐字返回） */
conversationRouter.post('/chat/stream', chatStream);

/** 获取某 NPC 的会话列表 */
conversationRouter.get('/conversations', getConversations);

/** 创建新会话 */
conversationRouter.post('/conversations', createConversation);

/** 删除会话 */
conversationRouter.delete('/conversations/:id', deleteConversation);

/** 获取会话历史消息 */
conversationRouter.get('/messages', getMessages);
