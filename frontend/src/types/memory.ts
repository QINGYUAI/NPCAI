/**
 * 记忆相关共享类型
 */
export interface MemoryItem {
  id: number
  npc_id: number
  conversation_id: number | null
  type: string
  description: string
  importance: number
  created_at: string
}

export interface ThoughtItem {
  id: number
  npc_id: number
  type: string
  description: string
  created_at: string
}
