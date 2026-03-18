/**
 * NPC 记忆管理 API
 */
import { api } from './client.js'
import type { ApiResponse } from './client.js'
import type { MemoryItem, ThoughtItem } from '../types/memory.js'

export type { ApiResponse, MemoryItem, ThoughtItem }

/** 获取某 NPC 的记忆列表 */
export function getMemories(npcId: number) {
  return api.get<ApiResponse<MemoryItem[]>>('/memory', { params: { npc_id: npcId } })
}

/** 获取某 NPC 的最近思考记录（wander/对话思考，按时间，供轮询实时展示） */
export function getRecentThoughts(npcId: number) {
  return api.get<ApiResponse<ThoughtItem[]>>('/memory/thoughts', { params: { npc_id: npcId } })
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
