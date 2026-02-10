/**
 * 角色 NPC API
 */
import axios from 'axios'
import type { Npc, CreateNpcForm } from '../types/npc'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:3000/api',
  timeout: 10000,
})

export interface ApiResponse<T> {
  code: number
  data?: T
  message?: string
}

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
  system_prompt: string
}

/** AI 生成接口超时 60 秒（LLM 调用较慢） */
export function generateNpcContent(params: GenerateNpcParams) {
  return api.post<ApiResponse<GenerateNpcResult>>('/npc/generate', params, { timeout: 60000 })
}
