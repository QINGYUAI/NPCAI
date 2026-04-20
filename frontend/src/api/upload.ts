/**
 * 文件上传 API
 * 统一处理头像等上传，与其他接口风格一致
 */
import type { ApiResponse } from './client.js'

const baseURL = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api'
const origin = baseURL.replace(/\/api\/?$/, '')

/** 内部：上传至指定路径并返回完整 URL；失败抛错 */
async function uploadToEndpoint(endpoint: string, file: File): Promise<string> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(`${origin}${endpoint}`, {
    method: 'POST',
    body: formData,
  })
  const json = (await res.json()) as ApiResponse<{ url?: string }>
  if (json.code !== 0) throw new Error(json.message || '上传失败')
  const url = json.data?.url
  if (!url) throw new Error('未返回地址')
  return origin + url
}

/** 上传头像（2MB 上限），返回完整 url */
export function uploadAvatar(file: File): Promise<string> {
  return uploadToEndpoint('/api/upload/avatar', file)
}

/** 上传通用图片（8MB 上限；沙盒底图等），返回完整 url */
export function uploadImage(file: File): Promise<string> {
  return uploadToEndpoint('/api/upload/image', file)
}
