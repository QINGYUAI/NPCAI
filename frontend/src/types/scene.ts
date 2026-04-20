/**
 * 场景类型（人物-场景编排）
 */
export interface Scene {
  id: number
  name: string
  description: string | null
  category: string
  /** 后端 JSON 列，前端常为 string[] */
  tags: string[] | null
  /** 2D 沙盒底图 URL（可空） */
  background_image?: string | null
  /** 2D 沙盒逻辑宽度（像素） */
  width?: number
  /** 2D 沙盒逻辑高度（像素） */
  height?: number
  status: number
  sort: number
  npc_count?: number
  created_at: string
  updated_at: string
}

export interface SceneNpcLink {
  npc_id: number
  role_note: string | null
  npc_name?: string
  /** NPC 头像（后端 JOIN npc 表带出） */
  npc_avatar?: string | null
  /** NPC 分类（便于沙盒着色） */
  npc_category?: string | null
  /** 2D 沙盒坐标 */
  pos_x?: number | null
  pos_y?: number | null
  /** 外部仿真回写；沙盒读取其中 latest_say/latest_action 显示气泡 */
  simulation_meta?: Record<string, unknown> | null
}

export interface SceneDetail extends Scene {
  npcs: SceneNpcLink[]
}

export interface SceneListResult {
  list: Scene[]
  total: number
  page: number
  pageSize: number
}

export interface CreateScenePayload {
  name: string
  description?: string
  category?: string
  tags?: string[]
  background_image?: string | null
  width?: number
  height?: number
  status?: number
  sort?: number
}

/** 沙盒布局保存请求 */
export interface LayoutPosition {
  npc_id: number
  pos_x: number | null
  pos_y: number | null
}
