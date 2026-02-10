/**
 * AI 配置 API 接口
 */
import axios from 'axios'
import type { AiConfig, CreateConfigForm } from '../types/config'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:3000/api',
  timeout: 10000,
})

export interface ApiResponse<T> {
  code: number
  data?: T
  message?: string
}

/** 获取配置列表 */
export function getConfigList(params?: { provider?: string; status?: number }) {
  return api.get<ApiResponse<AiConfig[]>>('/config', { params })
}

/** 获取单个配置 */
export function getConfigById(id: number) {
  return api.get<ApiResponse<AiConfig>>(`/config/${id}`)
}

/** 新增配置 */
export function createConfig(data: CreateConfigForm) {
  return api.post<ApiResponse<{ id: number }>>('/config', data)
}

/** 更新配置 */
export function updateConfig(id: number, data: Partial<CreateConfigForm>) {
  return api.put<ApiResponse<void>>(`/config/${id}`, data)
}

/** 删除配置 */
export function deleteConfig(id: number) {
  return api.delete<ApiResponse<void>>(`/config/${id}`)
}

/** 设为默认配置 */
export function setDefaultConfig(id: number) {
  return api.patch<ApiResponse<void>>(`/config/${id}/default`)
}

/** 连接测试 */
export function testConnection(id: number) {
  return api.post<ApiResponse<{ message?: string }>>(`/config/${id}/test`)
}
