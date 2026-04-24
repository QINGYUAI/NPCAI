/**
 * 沙盒纯函数单测
 */
import { describe, it, expect } from 'vitest'
import {
  categoryCss,
  clamp,
  colorOfCategory,
  extractBubbleText,
  fallbackPosition,
  snapTo,
  CATEGORY_COLOR_DEFAULT,
} from './sandbox'

describe('colorOfCategory', () => {
  it('已知分类返回预设色', () => {
    expect(colorOfCategory('task')).toBe(0x3fb950)
    expect(colorOfCategory('plot')).toBe(0xd29922)
    expect(colorOfCategory('custom')).toBe(CATEGORY_COLOR_DEFAULT)
  })

  it('未知 / 空值回退默认色', () => {
    expect(colorOfCategory(null)).toBe(CATEGORY_COLOR_DEFAULT)
    expect(colorOfCategory(undefined)).toBe(CATEGORY_COLOR_DEFAULT)
    expect(colorOfCategory('unknown')).toBe(CATEGORY_COLOR_DEFAULT)
  })
})

describe('categoryCss', () => {
  it('返回合法的 CSS 十六进制颜色字符串', () => {
    expect(categoryCss('task')).toBe('#3fb950')
    expect(categoryCss(null)).toBe('#58a6ff')
    expect(categoryCss('unknown')).toBe('#58a6ff')
  })
})

describe('clamp', () => {
  it('数值在区间内时原样返回', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })
  it('越界则截断到边界', () => {
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})

describe('fallbackPosition', () => {
  it('生成网格坐标在 [pad, world-pad] 范围内', () => {
    const W = 800
    const H = 600
    for (let total = 1; total <= 12; total += 1) {
      for (let i = 0; i < total; i += 1) {
        const p = fallbackPosition(i, total, W, H)
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x).toBeLessThanOrEqual(W)
        expect(p.y).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeLessThanOrEqual(H)
      }
    }
  })
  it('单个节点放在左上 pad 处', () => {
    const p = fallbackPosition(0, 1, 1000, 1000)
    expect(p.x).toBeCloseTo(100)
    expect(p.y).toBeCloseTo(100)
  })
})

describe('snapTo', () => {
  it('正常吸附到最接近的步长倍数', () => {
    expect(snapTo(17, 20)).toBe(20)
    expect(snapTo(9, 20)).toBe(0)
    expect(snapTo(30, 20)).toBe(40)
  })
  it('步长 <=0 时原样返回', () => {
    expect(snapTo(17, 0)).toBe(17)
    expect(snapTo(17, -5)).toBe(17)
  })
})

describe('extractBubbleText', () => {
  it('空 meta 返回空串', () => {
    expect(extractBubbleText(null)).toBe('')
    expect(extractBubbleText(undefined)).toBe('')
    expect(extractBubbleText({})).toBe('')
  })
  it('优先取 latest_say', () => {
    expect(extractBubbleText({ latest_say: '你好', latest_action: '走路' })).toBe('你好')
  })
  it('无 latest_say 时取 latest_action 并加前缀', () => {
    expect(extractBubbleText({ latest_action: '走路' })).toBe('・走路')
  })
  it('非字符串或空白被忽略', () => {
    expect(extractBubbleText({ latest_say: '' })).toBe('')
    expect(extractBubbleText({ latest_say: 123 })).toBe('')
    expect(extractBubbleText({ latest_say: '   ' })).toBe('')
  })
  /** [M4.3.1.c] replyTo 追加"💬 回应 <actor>"一行 */
  it('replyTo 非空时在 latest_say 下方追加「💬 回应 <actor>」', () => {
    expect(extractBubbleText({ latest_say: '你好' }, '小美')).toBe('你好\n💬 回应 小美')
  })
  it('replyTo 为 null/空串/纯空白 或 latest_say 缺失 时不追加', () => {
    expect(extractBubbleText({ latest_say: '你好' }, null)).toBe('你好')
    expect(extractBubbleText({ latest_say: '你好' }, '')).toBe('你好')
    expect(extractBubbleText({ latest_say: '你好' }, '   ')).toBe('你好')
    /** latest_action 分支（非 say）不追加回应 */
    expect(extractBubbleText({ latest_action: '走路' }, '小美')).toBe('・走路')
  })

  /** [M4.4.1.b] scheduledActivity 闲时回退（仅在无 say/action 时生效） */
  it('无 say/action 且有 scheduledActivity：显示「📅 当前日程: <activity> @ <location>」', () => {
    expect(
      extractBubbleText({}, null, { activity: '工作', location: '书房' }),
    ).toBe('📅 当前日程: 工作 @ 书房')
    expect(
      extractBubbleText({}, null, { activity: '散步', location: null }),
    ).toBe('📅 当前日程: 散步')
  })

  it('有 latest_say 时忽略 scheduledActivity（say 优先级最高）', () => {
    expect(
      extractBubbleText({ latest_say: '你好' }, null, { activity: '工作', location: '书房' }),
    ).toBe('你好')
    /** say + replyTo + schedule 三者同时存在时仍不显示日程行 */
    expect(
      extractBubbleText({ latest_say: '你好' }, '小美', { activity: '工作', location: '书房' }),
    ).toBe('你好\n💬 回应 小美')
  })

  it('scheduledActivity 为 null/空对象/activity 空白 → 不回退', () => {
    expect(extractBubbleText({}, null, null)).toBe('')
    expect(extractBubbleText({}, null, undefined)).toBe('')
    expect(extractBubbleText({}, null, { activity: '', location: '书房' })).toBe('')
    expect(extractBubbleText({}, null, { activity: '   ', location: null })).toBe('')
  })

  /** [M4.5.1.b] 四级回退：say > action > goal > schedule */
  it('无 say/action + 有 activeGoal → 显示「🎯 目标: <title>」，优先于 schedule', () => {
    expect(
      extractBubbleText(
        {},
        null,
        { activity: '工作', location: '书房' },
        { title: '去找小美和好' },
      ),
    ).toBe('🎯 目标: 去找小美和好')
  })

  it('有 latest_say 时忽略 activeGoal（say 始终最高级）', () => {
    expect(
      extractBubbleText({ latest_say: '你好' }, null, null, { title: '去找小美' }),
    ).toBe('你好')
  })

  it('有 latest_action 时忽略 activeGoal（action 第二级）', () => {
    expect(
      extractBubbleText({ latest_action: '走路' }, null, null, { title: '去找小美' }),
    ).toBe('・走路')
  })

  it('activeGoal.title 空白 → 回退到 schedule（第三级失效跌回第四级）', () => {
    expect(
      extractBubbleText({}, null, { activity: '午餐', location: '餐厅' }, { title: '   ' }),
    ).toBe('📅 当前日程: 午餐 @ 餐厅')
  })

  it('activeGoal 与 schedule 皆空 → 空串（无任何回退）', () => {
    expect(extractBubbleText({}, null, null, null)).toBe('')
    expect(extractBubbleText({}, null, null, { title: '' })).toBe('')
  })
})
