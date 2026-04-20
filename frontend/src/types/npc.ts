/**
 * 角色 NPC 类型定义
 */

/** NPC 侧查看「所属场景」列表（M2） */
export interface NpcSceneLink {
  scene_id: number
  scene_name: string
  scene_category: string | null
  role_note: string | null
}

export interface Npc {
  id: number
  name: string
  description: string | null
  background: string | null
  personality: string | null
  gender: string | null
  age: string | null
  occupation: string | null
  voice_tone: string | null
  avatar: string | null
  ai_config_id: number
  ai_config_name?: string
  provider?: string
  system_prompt: string | null
  category: string
  prompt_type: string
  status: number
  sort: number
  /** 外部仿真回写 JSON（结构自由） */
  simulation_meta?: Record<string, unknown> | null
  /** 关联场景数量（列表视图聚合，后端计算） */
  scene_count?: number
  created_at: string
  updated_at: string
}

export interface CreateNpcForm {
  name: string
  description: string
  background: string
  personality: string
  gender: string
  age: string
  occupation: string
  voice_tone: string
  avatar: string
  ai_config_id: number
  system_prompt: string
  category: string
  prompt_type: string
  status: number
  sort: number
  /** 可选：JSON 字符串或对象，提交时序列化 */
  simulation_meta?: string | Record<string, unknown> | null
}
