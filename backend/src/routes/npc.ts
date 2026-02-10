/**
 * 角色 NPC 路由
 */
import { Router } from 'express';
import { getNpcList, getNpcById, createNpc, updateNpc, deleteNpc, generateNpcContent } from '../controllers/npc.js';

export const npcRouter = Router();

npcRouter.post('/generate', generateNpcContent);
npcRouter.get('/', getNpcList);
npcRouter.get('/:id', getNpcById);
npcRouter.post('/', createNpc);
npcRouter.put('/:id', updateNpc);
npcRouter.delete('/:id', deleteNpc);
