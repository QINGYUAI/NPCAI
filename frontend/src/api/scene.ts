/**
 * 场景 API
 */
import { api } from './client.js'
import type { ApiResponse } from './client.js'
import type {
  CreateScenePayload,
  LayoutPosition,
  SceneDetail,
  SceneListResult,
} from '../types/scene.js'

export function getSceneList(params?: {
  page?: number
  pageSize?: number
  keyword?: string
  status?: number
  category?: string
  tag?: string
}) {
  return api.get<ApiResponse<SceneListResult>>('/scene', { params })
}

export function getSceneById(id: number) {
  return api.get<ApiResponse<SceneDetail>>(`/scene/${id}`)
}

export function createScene(data: CreateScenePayload) {
  return api.post<ApiResponse<{ id: number }>>('/scene', data)
}

export function updateScene(id: number, data: Partial<CreateScenePayload>) {
  return api.put<ApiResponse<void>>(`/scene/${id}`, data)
}

export function deleteScene(id: number) {
  return api.delete<ApiResponse<void>>(`/scene/${id}`)
}

/** 覆盖该场景下全部 NPC 关联 */
export function replaceSceneNpcs(
  id: number,
  npcs: Array<{ npc_id: number; role_note?: string | null }>,
) {
  return api.put<ApiResponse<void>>(`/scene/${id}/npcs`, { npcs })
}

/** 沙盒：仅更新已关联 NPC 的坐标（不影响关联关系/备注） */
export function updateSceneLayout(id: number, positions: LayoutPosition[]) {
  return api.put<ApiResponse<void>>(`/scene/${id}/layout`, { positions })
}

/** 导出场景下 NPC 列表（文件下载） */
export function exportSceneNpcsFile(id: number, format: 'json' | 'csv') {
  return api.get<Blob>(`/scene/${id}/export`, {
    params: { format },
    responseType: 'blob',
  })
}
