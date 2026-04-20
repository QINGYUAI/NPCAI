/**
 * 角色 NPC 路由
 */
import { Router } from 'express';
import {
  getNpcList,
  getNpcById,
  getNpcScenes,
  createNpc,
  updateNpc,
  deleteNpc,
  generateNpcContent,
} from '../controllers/npc.js';

export const npcRouter = Router();

npcRouter.post('/generate', generateNpcContent);
npcRouter.get('/', getNpcList);
/** 须在 /:id 之前，避免 id 被解析为 "scenes" */
npcRouter.get('/:id/scenes', getNpcScenes);
npcRouter.get('/:id', getNpcById);
npcRouter.post('/', createNpc);
npcRouter.put('/:id', updateNpc);
npcRouter.delete('/:id', deleteNpc);
