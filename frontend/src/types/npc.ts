/**
 * 角色 NPC 类型定义
 */
export interface Npc {
  id: number
  name: string
  description: string | null
  background: string | null
  personality: string | null
  avatar: string | null
  ai_config_id: number
  ai_config_name?: string
  provider?: string
  system_prompt: string | null
  category: string
  prompt_type: string
  status: number
  sort: number
  created_at: string
  updated_at: string
}

export interface CreateNpcForm {
  name: string
  description: string
  background: string
  personality: string
  avatar: string
  ai_config_id: number
  system_prompt: string
  category: string
  prompt_type: string
  status: number
  sort: number
}
