/**
 * [M4.5.1.c] plan_path 徽章纯函数单测
 */
import { describe, it, expect } from 'vitest'
import {
  PLAN_PATH_STYLE,
  planPathBadgeText,
  normalizePlanPath,
  extractPlanFromMeta,
} from './planPath'

describe('PLAN_PATH_STYLE', () => {
  it('四枚举各自有 label / bg / fg', () => {
    const keys = ['event', 'goal', 'schedule', 'idle'] as const
    for (const k of keys) {
      const s = PLAN_PATH_STYLE[k]
      expect(typeof s.label).toBe('string')
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.bg).toMatch(/^rgba?\(/)
      expect(s.fg).toMatch(/^#[0-9a-fA-F]{3,8}$/)
    }
  })
})

describe('planPathBadgeText', () => {
  it('非 goal 路径仅返回 label', () => {
    expect(planPathBadgeText('event')).toBe('事件')
    expect(planPathBadgeText('schedule')).toBe('日程')
    expect(planPathBadgeText('idle')).toBe('闲置')
  })

  it('goal 路径无 title → 仅 label', () => {
    expect(planPathBadgeText('goal')).toBe('目标')
    expect(planPathBadgeText('goal', null)).toBe('目标')
    expect(planPathBadgeText('goal', '')).toBe('目标')
    expect(planPathBadgeText('goal', '   ')).toBe('目标')
  })

  it('goal 路径短 title 直接拼接', () => {
    expect(planPathBadgeText('goal', '找小美')).toBe('目标·找小美')
  })

  it('goal 路径长 title 截断到 8 字并补省略号', () => {
    expect(planPathBadgeText('goal', '去图书馆找小美聊一聊')).toBe('目标·去图书馆找小美聊…')
  })

  it('goal 路径 title 恰好 8 字不加省略号', () => {
    expect(planPathBadgeText('goal', '12345678')).toBe('目标·12345678')
  })
})

describe('normalizePlanPath', () => {
  it('合法枚举透传', () => {
    expect(normalizePlanPath('event')).toBe('event')
    expect(normalizePlanPath('goal')).toBe('goal')
    expect(normalizePlanPath('schedule')).toBe('schedule')
    expect(normalizePlanPath('idle')).toBe('idle')
  })

  it('非法 / 空 / 类型错 → null', () => {
    expect(normalizePlanPath('EVENT')).toBeNull()
    expect(normalizePlanPath('unknown')).toBeNull()
    expect(normalizePlanPath(null)).toBeNull()
    expect(normalizePlanPath(undefined)).toBeNull()
    expect(normalizePlanPath(0)).toBeNull()
    expect(normalizePlanPath({})).toBeNull()
  })
})

describe('extractPlanFromMeta', () => {
  it('null / undefined → 两字段皆 null（老后端降级）', () => {
    expect(extractPlanFromMeta(null)).toEqual({ plan_path: null, goal_title: null })
    expect(extractPlanFromMeta(undefined)).toEqual({ plan_path: null, goal_title: null })
  })

  it('plan_path=schedule + active_goal=null → goal_title=null', () => {
    const out = extractPlanFromMeta({ plan_path: 'schedule', active_goal: null })
    expect(out.plan_path).toBe('schedule')
    expect(out.goal_title).toBeNull()
  })

  it('plan_path=goal 且 active_goal.title 非空 → title trim 后返回', () => {
    const out = extractPlanFromMeta({
      plan_path: 'goal',
      active_goal: { id: 7, title: '  去图书馆找小美  ', priority: 9 },
    })
    expect(out.plan_path).toBe('goal')
    expect(out.goal_title).toBe('去图书馆找小美')
  })

  it('plan_path=goal 但 title 空白 → goal_title=null（后端降级语义）', () => {
    const out = extractPlanFromMeta({
      plan_path: 'goal',
      active_goal: { id: 7, title: '   ', priority: 9 },
    })
    expect(out.plan_path).toBe('goal')
    expect(out.goal_title).toBeNull()
  })

  it('plan_path 非法枚举 → plan_path=null，goal_title 仍按 active_goal 解析', () => {
    const out = extractPlanFromMeta({
      plan_path: 'weird',
      active_goal: { id: 1, title: '测试', priority: 5 },
    })
    expect(out.plan_path).toBeNull()
    expect(out.goal_title).toBe('测试')
  })
})
