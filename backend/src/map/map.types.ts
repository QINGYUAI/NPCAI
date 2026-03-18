/**
 * 地图模块共享类型定义
 * 供 controller、service、前端类型对齐使用
 */

/** 图块类型定义（name + color） */
export interface TileTypeDef {
  name: string;
  color: string;
}

/** AI 生成的物品项 */
export interface GenerateMapItem {
  name: string;
  category?: string;
  description?: string;
  footprint: number[][];
  tile_value: number;
  pos_x: number;
  pos_y: number;
  rotation?: number;
}

/** AI 生成地图结果 */
export interface GenerateMapResult {
  name: string;
  width: number;
  height: number;
  items: GenerateMapItem[];
  tile_types: Record<number, TileTypeDef>;
  tile_data: number[][];
}

/** 创建地图请求（物品驱动） */
export interface CreateMapItemInput {
  item_id?: number;
  name?: string;
  category?: string;
  description?: string;
  footprint?: number[][];
  tile_value?: number;
  pos_x: number;
  pos_y: number;
  rotation?: number;
}
