/**
 * 物品分类常量（与 物品.md 设计一致）
 */
export const ITEM_CATEGORIES = [
  { value: 'building', label: '建筑' },
  { value: 'object', label: '物品' },
  { value: 'utensil', label: '用具' },
  { value: 'furniture', label: '家具' },
  { value: 'decoration', label: '装饰' },
] as const

/** tile_value 常用值及说明（用于渲染区分） */
export const TILE_VALUE_LABELS: Record<number, string> = {
  1: '建筑灰',
  2: '喷泉蓝',
  3: '水域',
  4: '绿地',
  5: '其他',
}
