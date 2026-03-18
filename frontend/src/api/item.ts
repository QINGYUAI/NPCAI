/**
 * 物品 API 接口
 */
import { api } from './client.js'
import type { ApiResponse } from './client.js'

export type { ApiResponse }

/** 物品列表项 */
export interface Item {
  id: number
  name: string
  category: string
  description?: string
  footprint: number[][] | string
  tile_value: number
  is_blocking: number
  metadata?: string | Record<string, unknown>
  status: number
  sort: number
  created_at?: string
  updated_at?: string
}

/** 创建/编辑物品表单 */
export interface ItemForm {
  name: string
  category: string
  description?: string
  footprint: number[][]
  tile_value?: number
  is_blocking?: number
  metadata?: Record<string, unknown>
  status?: number
  sort?: number
}

/** 获取物品列表 */
export function getItemList() {
  return api.get<ApiResponse<Item[]>>('/item')
}

/** 获取单个物品 */
export function getItemById(id: number) {
  return api.get<ApiResponse<Item>>(`/item/${id}`)
}

/** 新增物品 */
export function createItem(data: ItemForm) {
  return api.post<ApiResponse<{ id: number }>>('/item', data)
}

/** 更新物品 */
export function updateItem(id: number, data: Partial<ItemForm>) {
  return api.put<ApiResponse<void>>(`/item/${id}`, data)
}

/** 删除物品 */
export function deleteItem(id: number) {
  return api.delete<ApiResponse<void>>(`/item/${id}`)
}
