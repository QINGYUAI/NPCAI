/**
 * 地图模块请求校验（Zod）
 */
import { z } from 'zod';

/** 创建地图 body */
export const createMapSchema = z.object({
  name: z.string().min(1, 'name 为必填'),
  width: z.coerce.number().min(1).max(200),
  height: z.coerce.number().min(1).max(200),
  items: z
    .array(
      z.object({
        item_id: z.number().optional(),
        name: z.string().optional(),
        category: z.string().optional(),
        description: z.string().optional(),
        footprint: z.array(z.array(z.number())).optional(),
        tile_value: z.number().optional(),
        pos_x: z.number(),
        pos_y: z.number(),
        rotation: z.number().optional(),
      })
    )
    .optional(),
  tile_data: z.array(z.array(z.number())).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** AI 生成地图 body */
export const generateMapSchema = z.object({
  ai_config_id: z.number({ required_error: '请选择 AI 配置' }),
  hint: z.string().optional(),
  current_map: z
    .object({
      name: z.string(),
      width: z.number(),
      height: z.number(),
      items: z.array(z.unknown()).optional(),
      tile_types: z.record(z.string(), z.object({ name: z.string(), color: z.string() })).optional(),
    })
    .optional(),
});

/** 添加 NPC 绑定 body */
export const addBindingSchema = z.object({
  npc_id: z.number({ required_error: 'npc_id 为必填' }),
  init_x: z.number().optional().default(0),
  init_y: z.number().optional().default(0),
});

/** 添加物品 body */
export const addItemSchema = z.object({
  item_id: z.number().optional(),
  name: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  footprint: z.array(z.array(z.number())).optional(),
  tile_value: z.number().optional(),
  pos_x: z.number(),
  pos_y: z.number(),
  rotation: z.number().optional(),
}).refine((data) => data.item_id || (data.name && data.footprint), {
  message: '需提供 item_id 或完整物品定义 (name, footprint)',
});
