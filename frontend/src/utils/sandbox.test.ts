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
})
