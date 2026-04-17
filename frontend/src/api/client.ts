/**
 * 统一 API 客户端
 * 封装 axios 实例及通用类型，避免各模块重复定义
 */
import axios from 'axios'

/** 默认 10 秒超时，特殊接口可在调用时覆盖 */
const DEFAULT_TIMEOUT = 10000

/** API 响应格式（与后端约定 code: 0 为成功） */
export interface ApiResponse<T> {
  code: number
  data?: T
  message?: string
}

/** 创建基础 axios 实例 */
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:3000/api',
  timeout: DEFAULT_TIMEOUT,
  headers: { 'Content-Type': 'application/json' },
})
