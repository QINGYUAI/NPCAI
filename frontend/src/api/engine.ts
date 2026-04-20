/**
 * 引擎 API：/api/engine/*
 */
import { api } from './client.js'
import type { ApiResponse } from './client.js'
import type { EngineStatus, StartEngineParams, TickLogRow } from '../types/engine.js'

export function startEngine(params: StartEngineParams) {
  return api.post<ApiResponse<EngineStatus>>('/engine/start', params)
}

export function stopEngine(scene_id: number, force = false) {
  return api.post<ApiResponse<EngineStatus>>('/engine/stop', { scene_id, force })
}

export function stepEngine(scene_id: number, dry_run = true) {
  return api.post<ApiResponse<EngineStatus>>('/engine/step', { scene_id, dry_run })
}

export function getEngineStatus(scene_id: number) {
  return api.get<ApiResponse<EngineStatus>>('/engine/status', { params: { scene_id } })
}

export function getEngineTicks(params: {
  scene_id: number
  after?: number
  limit?: number
  order?: 'asc' | 'desc'
}) {
  return api.get<ApiResponse<TickLogRow[]>>('/engine/ticks', { params })
}
