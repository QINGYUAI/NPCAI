/**
 * 文件上传 API
 * 统一处理头像等上传，与其他接口风格一致
 */
import type { ApiResponse } from './client.js'

const baseURL = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api'
const origin = baseURL.replace(/\/api\/?$/, '')
const uploadEndpoint = `${origin}/api/upload/avatar`

/** 上传头像，返回完整 url */
export async function uploadAvatar(file: File): Promise<string> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(uploadEndpoint, {
    method: 'POST',
    body: formData,
  })
  const json = (await res.json()) as ApiResponse<{ url?: string }>
  if (json.code !== 0) throw new Error(json.message || '上传失败')
  const url = json.data?.url
  if (!url) throw new Error('未返回地址')
  return origin + url
}
