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

/**
 * 创建基础 axios 实例
 * baseURL 解析（与 Vite proxy 协作，方案 D）：
 *   - 未设置 VITE_API_BASE → '/api'（同源相对路径，浏览器直接走 Vite proxy / 反向代理）
 *   - 显式 "/api" 或空串 → 同上
 *   - 完整 URL（形如 "http://10.0.0.2:3000/api"）→ 直连；需后端放开 CORS
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').toString().trim() || '/api'

export const api = axios.create({
  baseURL: API_BASE,
  timeout: DEFAULT_TIMEOUT,
  headers: { 'Content-Type': 'application/json' },
})
