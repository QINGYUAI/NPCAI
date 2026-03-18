/**
 * 物品路由
 */
import { Router } from 'express';
import { getItemList, getItemById, createItem, updateItem, deleteItem } from '../controllers/item.js';

export const itemRouter = Router();

itemRouter.get('/', getItemList);
itemRouter.post('/', createItem);
itemRouter.get('/:id', getItemById);
itemRouter.put('/:id', updateItem);
itemRouter.delete('/:id', deleteItem);
