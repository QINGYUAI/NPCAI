/**
 * NPC 记忆管理 API
 */
import axios from 'axios'
import type { MemoryItem } from './conversation'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:3000/api',
  timeout: 10000,
})

export interface ApiResponse<T> {
  code: number
  data?: T
  message?: string
}

/** 获取某 NPC 的记忆列表 */
export function getMemories(npcId: number) {
  return api.get<ApiResponse<MemoryItem[]>>('/memory', { params: { npc_id: npcId } })
}

/** 删除记忆 */
export function deleteMemory(id: number) {
  return api.delete<ApiResponse<void>>(`/memory/${id}`)
}

/** 更新记忆 */
export function updateMemory(id: number, data: { description?: string; importance?: number }) {
  return api.patch<ApiResponse<void>>(`/memory/${id}`, data)
}

/** 手动触发反思（从近期记忆提炼洞察） */
export function reflectMemories(npcId: number) {
  return api.post<ApiResponse<{ added: number }>>('/memory/reflect', null, {
    params: { npc_id: npcId },
    timeout: 30000,
  })
}
