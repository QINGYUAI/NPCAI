/**
 * 地图相关共享类型
 */
export interface GameMap {
  id: number
  name: string
  width: number
  height: number
  tile_data: number[][]
  metadata?: Record<string, unknown>
  status: number
}

export interface MapBinding {
  id: number
  npc_id: number
  map_id: number
  init_x: number
  init_y: number
  npc_name: string
  avatar?: string
}

export interface NpcState {
  npc_id: number
  x: number
  y: number
  state: string
  groupId: string
  avatar?: string
  thinking?: string
}

export interface SceneState {
  npcs: NpcState[]
  running?: boolean
}

export interface MapItem {
  id: number
  item_id: number
  map_id: number
  pos_x: number
  pos_y: number
  rotation?: number
  name: string
  category?: string
  footprint: number[][]
  tile_value: number
}
