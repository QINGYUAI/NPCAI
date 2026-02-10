/**
 * 头像 URL 解析 - 相对路径转为完整后端地址
 */
const API_BASE = (import.meta.env.VITE_API_BASE || 'http://localhost:3000/api').replace(/\/api\/?$/, '')

/** 将头像字段转为可用的图片 URL（支持相对路径 /uploads/...） */
export function resolveAvatarUrl(avatar: string | null | undefined): string {
  if (!avatar) return ''
  if (avatar.startsWith('http') || avatar.startsWith('//')) return avatar
  if (avatar.startsWith('/')) return API_BASE + avatar
  return avatar
}
