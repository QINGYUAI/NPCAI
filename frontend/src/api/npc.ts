/**
 * 角色 NPC API
 */
import { api } from './client.js'
import type { ApiResponse } from './client.js'
import { uploadAvatar } from './upload.js'
import type { Npc, CreateNpcForm } from '../types/npc.js'

export type { ApiResponse }

/** 获取 NPC 列表 */
export function getNpcList(params?: { category?: string; status?: number }) {
  return api.get<ApiResponse<Npc[]>>('/npc', { params })
}

/** 获取单个 NPC */
export function getNpcById(id: number) {
  return api.get<ApiResponse<Npc>>(`/npc/${id}`)
}

/** 新增 NPC */
export function createNpc(data: CreateNpcForm) {
  return api.post<ApiResponse<{ id: number }>>('/npc', data)
}

/** 更新 NPC */
export function updateNpc(id: number, data: Partial<CreateNpcForm>) {
  return api.put<ApiResponse<void>>(`/npc/${id}`, data)
}

/** 删除 NPC */
export function deleteNpc(id: number) {
  return api.delete<ApiResponse<void>>(`/npc/${id}`)
}

/** AI 自动生成角色内容 */
export interface GenerateNpcParams {
  ai_config_id: number
  name?: string
  hint?: string
}

export interface GenerateNpcResult {
  description: string
  background: string
  personality: string
  gender?: string
  age?: string
  occupation?: string
  voice_tone?: string
  system_prompt: string
}

/** AI 生成接口超时 60 秒（LLM 调用较慢） */
export function generateNpcContent(params: GenerateNpcParams) {
  return api.post<ApiResponse<GenerateNpcResult>>('/npc/generate', params, { timeout: 60000 })
}

/** 上传头像，返回 url 路径（使用统一 upload API） */
export { uploadAvatar }
