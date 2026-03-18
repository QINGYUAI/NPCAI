/**
 * 地图与场景 API
 */
import { api } from './client.js'
import type { ApiResponse } from './client.js'
import type { GameMap, MapBinding, NpcState, SceneState, MapItem } from '../types/map.js'

export type { ApiResponse, GameMap, MapBinding, NpcState, SceneState, MapItem }

/** 获取地图列表 */
export function getMapList() {
  return api.get<ApiResponse<Pick<GameMap, 'id' | 'name' | 'width' | 'height' | 'status'>[]>>('/map')
}

/** 获取地图详情 */
export function getMapById(id: number) {
  return api.get<ApiResponse<GameMap>>(`/map/${id}`)
}

/** 创建地图（支持 items 驱动或 tile_data 直接传入） */
export function createMap(data: {
  name: string
  width: number
  height: number
  /** 物品驱动：有 items 时优先使用，后端推导 tile_data */
  items?: Array<
    | { item_id: number; pos_x: number; pos_y: number; rotation?: number }
    | (GenerateMapItem & { pos_x: number; pos_y: number })
  >
  /** 直接传入格子弹窗（手动创建或预览） */
  tile_data?: number[][]
  metadata?: { tile_types?: Record<number, { name: string; color: string }> }
}) {
  return api.post<ApiResponse<{ id: number }>>('/map', data)
}

/** AI 生成地图配置（含动态 tile_types），支持多轮修改 */
export interface GenerateMapParams {
  ai_config_id: number
  hint?: string
  /** 多轮修改时传入当前地图，AI 将在其基础上调整（无需 tile_data，后端会从 items 推导） */
  current_map?: {
    name: string
    width: number
    height: number
    items?: GenerateMapItem[]
    tile_types?: Record<number, { name: string; color: string }>
  }
}

export interface TileTypeDef {
  name: string
  color: string
}

/** AI 生成的物品项 */
export interface GenerateMapItem {
  name: string
  category?: string
  description?: string
  footprint: number[][]
  tile_value: number
  pos_x: number
  pos_y: number
  rotation?: number
}

export interface GenerateMapResult {
  name: string
  width: number
  height: number
  /** AI 生成时返回 items，后端据此创建 item 和 binding */
  items?: GenerateMapItem[]
  tile_data: number[][]
  tile_types: Record<number, TileTypeDef>
}

/** AI 生成或修改地图，current_map 有值时表示多轮修改 */
export function generateMapContent(params: GenerateMapParams) {
  return api.post<ApiResponse<GenerateMapResult>>('/map/generate', params, { timeout: 95000 })
}

/** 上传室内布局图并转换为地图 */
export async function convertLayoutToMap(
  file: File,
  aiConfigId: number
): Promise<{ data?: ApiResponse<GenerateMapResult> }> {
  const baseURL = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api'
  const formData = new FormData()
  formData.append('file', file)
  formData.append('ai_config_id', String(aiConfigId))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)
  const res = await fetch(`${baseURL}/map/convert-layout`, {
    method: 'POST',
    body: formData,
    signal: controller.signal,
  })
  clearTimeout(timer)
  const json = (await res.json()) as ApiResponse<GenerateMapResult>
  if (res.ok) return { data: json }
  throw new Error(json?.message || '布局图转换失败')
}

/** 更新地图 */
export function updateMap(id: number, data: Partial<{ name: string; width: number; height: number; tile_data: number[][]; status: number }>) {
  return api.put<ApiResponse<void>>(`/map/${id}`, data)
}

/** 删除地图 */
export function deleteMap(id: number) {
  return api.delete<ApiResponse<void>>(`/map/${id}`)
}

/** 获取地图绑定的 NPC */
export function getMapBindings(mapId: number) {
  return api.get<ApiResponse<MapBinding[]>>(`/map/${mapId}/bindings`)
}

/** 获取地图上的物品列表 */
export function getMapItems(mapId: number) {
  return api.get<ApiResponse<MapItem[]>>(`/map/${mapId}/items`)
}

/** 添加 NPC 到地图 */
export function addMapBinding(mapId: number, data: { npc_id: number; init_x?: number; init_y?: number }) {
  return api.post<ApiResponse<void>>(`/map/${mapId}/bindings`, data)
}

/** 移除地图上的 NPC */
export function removeMapBinding(mapId: number, npcId: number) {
  return api.delete<ApiResponse<void>>(`/map/${mapId}/bindings/${npcId}`)
}

/** 初始化场景（写入 Redis） */
export function initScene(mapId: number) {
  return api.post<ApiResponse<{ npcCount: number }>>(`/map/${mapId}/init`)
}

/** 获取场景实时状态（含 running） */
export function getSceneState(mapId: number) {
  return api.get<ApiResponse<SceneState>>(`/map/${mapId}/state`)
}

/** 开始：初始化场景并启动 NPC 移动 */
export function startMap(mapId: number) {
  return api.post<ApiResponse<{ npcCount: number }>>(`/map/${mapId}/start`)
}

/** 暂停：停止该地图 NPC 移动 */
export function pauseMap(mapId: number) {
  return api.post<ApiResponse<void>>(`/map/${mapId}/pause`)
}

/** 恢复：恢复该地图 NPC 移动 */
export function resumeMap(mapId: number) {
  return api.post<ApiResponse<void>>(`/map/${mapId}/resume`)
}
