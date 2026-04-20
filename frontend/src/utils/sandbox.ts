/**
 * 2D 沙盒纯工具函数（与 Phaser/DOM 无关，可单测）
 */

/** 分类 → 节点颜色（默认蓝）。沙盒与卡片保持一致的 tag 色系 */
export const CATEGORY_COLOR_DEFAULT = 0x58a6ff
export const CATEGORY_COLOR: Record<string, number> = {
  task: 0x3fb950,
  plot: 0xd29922,
  custom: CATEGORY_COLOR_DEFAULT,
}

/** 分类取色（未知分类回退默认） */
export function colorOfCategory(v: string | null | undefined): number {
  if (v && Object.prototype.hasOwnProperty.call(CATEGORY_COLOR, v)) {
    return CATEGORY_COLOR[v] as number
  }
  return CATEGORY_COLOR_DEFAULT
}

/** CSS 颜色字符串（用于 DOM 侧面板 dot） */
export function categoryCss(v: string | null | undefined): string {
  return '#' + colorOfCategory(v).toString(16).padStart(6, '0')
}

/** 生成备选默认坐标（世界尺寸内网格排布，避免重叠 0,0） */
export function fallbackPosition(index: number, total: number, worldW: number, worldH: number) {
  const perRow = Math.max(1, Math.ceil(Math.sqrt(total)))
  const col = index % perRow
  const row = Math.floor(index / perRow)
  const pad = Math.min(worldW, worldH) * 0.1
  const stepX = (worldW - pad * 2) / Math.max(1, perRow - 1 || 1)
  const stepY = (worldH - pad * 2) / Math.max(1, perRow - 1 || 1)
  return {
    x: pad + col * stepX,
    y: pad + row * stepY,
  }
}

/** 将数值限制在 [min, max] */
export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

/** 吸附到网格步长（step>0），并保留小数精度；step<=0 时原样返回 */
export function snapTo(n: number, step: number) {
  if (!Number.isFinite(step) || step <= 0) return n
  return Math.round(n / step) * step
}

/** 从 simulation_meta 中提取气泡文本（约定字段，非强制） */
export function extractBubbleText(meta: Record<string, unknown> | null | undefined): string {
  if (!meta || typeof meta !== 'object') return ''
  const say = (meta as Record<string, unknown>).latest_say
  if (typeof say === 'string' && say.trim()) return say.trim()
  const act = (meta as Record<string, unknown>).latest_action
  if (typeof act === 'string' && act.trim()) return '・' + act.trim()
  return ''
}
