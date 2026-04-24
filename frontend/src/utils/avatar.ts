/**
 * 头像 URL 解析 - 相对路径转为可访问地址
 * 方案 D：
 *   - VITE_API_BASE 为 '/api' 或空 → 返回相对路径（浏览器同源访问，经 Vite proxy 到后端 /uploads）
 *   - VITE_API_BASE 是完整 URL → 剥掉 '/api' 得到后端 origin，直连
 */
const BASE_RAW = (import.meta.env.VITE_API_BASE ?? '').toString().trim()
const API_BASE = BASE_RAW.startsWith('http') ? BASE_RAW.replace(/\/api\/?$/, '') : ''

/** 将头像字段转为可用的图片 URL（支持相对路径 /uploads/...） */
export function resolveAvatarUrl(avatar: string | null | undefined): string {
  if (!avatar) return ''
  if (avatar.startsWith('http') || avatar.startsWith('//')) return avatar
  if (avatar.startsWith('/')) return API_BASE + avatar
  return avatar
}
