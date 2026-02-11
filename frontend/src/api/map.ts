/**
 * 地图与场景 API
 */
import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:3000/api',
  timeout: 10000,
})

export interface ApiResponse<T> {
  code: number
  data?: T
  message?: string
}

export interface GameMap {
  id: number
  name: string
  width: number
  height: number
  tile_data: number[][]
  metadata?: Record<string, unknown>
  status: number
}

export interface MapBinding {
  id: number
  npc_id: number
  map_id: number
  init_x: number
  init_y: number
  npc_name: string
  avatar?: string
}

export interface NpcState {
  npc_id: number
  x: number
  y: number
  state: string
  groupId: string
  avatar?: string
  /** 当前最新思考（供地图气泡展示） */
  thinking?: string
}

export interface SceneState {
  npcs: NpcState[]
  /** 地图是否在运行（未暂停） */
  running?: boolean
}

/** 获取地图列表 */
export function getMapList() {
  return api.get<ApiResponse<Pick<GameMap, 'id' | 'name' | 'width' | 'height' | 'status'>[]>>('/map')
}

/** 获取地图详情 */
export function getMapById(id: number) {
  return api.get<ApiResponse<GameMap>>(`/map/${id}`)
}

/** 创建地图 */
export function createMap(data: {
  name: string
  width: number
  height: number
  tile_data: number[][]
  metadata?: { tile_types?: Record<number, { name: string; color: string }> }
}) {
  return api.post<ApiResponse<{ id: number }>>('/map', data)
}

/** AI 生成地图配置（含动态 tile_types） */
export interface GenerateMapParams {
  ai_config_id: number
  hint?: string
}

export interface TileTypeDef {
  name: string
  color: string
}

export interface GenerateMapResult {
  name: string
  width: number
  height: number
  tile_data: number[][]
  tile_types: Record<number, TileTypeDef>
}

export function generateMapContent(params: GenerateMapParams) {
  return api.post<ApiResponse<GenerateMapResult>>('/map/generate', params, { timeout: 60000 })
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
