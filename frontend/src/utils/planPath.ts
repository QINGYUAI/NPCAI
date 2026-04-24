/**
 * [M4.5.1.c] plan_path 徽章辅助 · 纯函数模块
 *
 * 职责
 *   - PLAN_PATH_STYLE：四路（event / goal / schedule / idle）颜色与短标签映射
 *   - planPathBadgeText：goal 路径追加目标 title 首 8 字后缀
 *   - extractPlanFromMeta：从 WS `meta_summary` 结构化解出 plan_path + goal_title
 *
 * 设计
 *   - 纯函数无副作用，便于 vitest 单测
 *   - 老后端（M4.5.1.b 前）不带 plan_path / active_goal：返回 null，组件据此不渲染徽章
 *   - goal_title trim 后空字符串视为"无目标"，与后端 `computePlanPath` 一致
 */

export type PlanPath = 'event' | 'goal' | 'schedule' | 'idle'

export interface PlanPathStyle {
  /** 徽章基础短标签（中文，<=2 字），goal 会再拼 title 首 8 字后缀 */
  label: string
  bg: string
  fg: string
}

export const PLAN_PATH_STYLE: Record<PlanPath, PlanPathStyle> = {
  event: { label: '事件', bg: 'rgba(163, 113, 247, 0.18)', fg: '#d2a8ff' },
  goal: { label: '目标', bg: 'rgba(255, 140, 0, 0.2)', fg: '#ffa657' },
  schedule: { label: '日程', bg: 'rgba(56, 139, 253, 0.18)', fg: '#79c0ff' },
  idle: { label: '闲置', bg: 'rgba(139, 148, 158, 0.18)', fg: '#8b949e' },
}

/** 徽章文案：goal 追加 title 首 8 字后缀（>8 字截断并补"…"） */
export function planPathBadgeText(path: PlanPath, goalTitle?: string | null): string {
  const base = PLAN_PATH_STYLE[path].label
  if (path === 'goal' && goalTitle) {
    const t = goalTitle.trim()
    if (!t) return base
    const short = t.length > 8 ? `${t.slice(0, 8)}…` : t
    return `${base}·${short}`
  }
  return base
}

/** 合法 plan_path 枚举校验；非法 / null / undefined 统一返回 null */
export function normalizePlanPath(raw: unknown): PlanPath | null {
  return raw === 'event' || raw === 'goal' || raw === 'schedule' || raw === 'idle' ? raw : null
}

/**
 * 从 WS tick.npc.updated.meta_summary 里提取徽章所需两字段。
 * 老后端（不带 plan_path）统一返回 { plan_path: null, goal_title: null }。
 */
export function extractPlanFromMeta(
  metaSummary: Record<string, unknown> | null | undefined,
): { plan_path: PlanPath | null; goal_title: string | null } {
  if (!metaSummary) return { plan_path: null, goal_title: null }
  const plan_path = normalizePlanPath(metaSummary['plan_path'])
  const goalRaw = metaSummary['active_goal'] as { title?: unknown } | null | undefined
  const title = goalRaw && typeof goalRaw.title === 'string' ? goalRaw.title.trim() : ''
  return { plan_path, goal_title: title ? title : null }
}
