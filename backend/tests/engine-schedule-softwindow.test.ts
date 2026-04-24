/**
 * [M4.5.0 U-N] schedule soft window 单测
 *
 * 覆盖：
 *   - computeEffectiveHour：windowMin=0 退化 / 未进入窗口 / 进入窗口 / 跨日绕环 / 非法值降级
 *   - resolveEffectiveHourFromClock：override 注入优先 / fallback 到 now
 *   - getScheduleConfig.softWindowMin：默认值 15 / env 覆盖 / 越界回 0
 *
 * 不碰 DB / 不碰 process mutation（env 用 beforeEach 备份）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeEffectiveHour,
  resolveEffectiveHourFromClock,
} from '../src/engine/schedule/softWindow.js';
import {
  getScheduleConfig,
  resetScheduleConfig,
} from '../src/engine/schedule/config.js';

describe('[M4.5.0 U-N] computeEffectiveHour', () => {
  it('windowMin=0：任何 minute 都返回 baseHour（退化为整点硬切）', () => {
    expect(computeEffectiveHour({ baseHour: 10, minute: 0, windowMin: 0 })).toBe(10);
    expect(computeEffectiveHour({ baseHour: 10, minute: 30, windowMin: 0 })).toBe(10);
    expect(computeEffectiveHour({ baseHour: 10, minute: 59, windowMin: 0 })).toBe(10);
  });

  it('windowMin=15：未进入窗口 → baseHour；进入窗口 → baseHour+1', () => {
    expect(computeEffectiveHour({ baseHour: 10, minute: 44, windowMin: 15 })).toBe(10);
    expect(computeEffectiveHour({ baseHour: 10, minute: 45, windowMin: 15 })).toBe(11);
    expect(computeEffectiveHour({ baseHour: 10, minute: 59, windowMin: 15 })).toBe(11);
    expect(computeEffectiveHour({ baseHour: 11, minute: 0, windowMin: 15 })).toBe(11);
  });

  it('跨日绕环：23:55 + windowMin=15 → 0', () => {
    expect(computeEffectiveHour({ baseHour: 23, minute: 50, windowMin: 15 })).toBe(0);
    expect(computeEffectiveHour({ baseHour: 23, minute: 30, windowMin: 15 })).toBe(23);
  });

  it('非法 baseHour 回 0；非法 minute 按 0 处理；非法 windowMin 按 0 处理', () => {
    expect(computeEffectiveHour({ baseHour: -1, minute: 50, windowMin: 15 })).toBe(0);
    expect(computeEffectiveHour({ baseHour: 24, minute: 50, windowMin: 15 })).toBe(0);
    expect(
      computeEffectiveHour({ baseHour: 10, minute: Number.NaN as unknown as number, windowMin: 15 }),
    ).toBe(10);
    expect(
      computeEffectiveHour({ baseHour: 10, minute: 45, windowMin: -5 as unknown as number }),
    ).toBe(10);
  });
});

describe('[M4.5.0 U-N] resolveEffectiveHourFromClock', () => {
  it('override 优先：overrideHour=10 overrideMinute=50 windowMin=15 → 11', () => {
    const h = resolveEffectiveHourFromClock({
      overrideHour: 10,
      overrideMinute: 50,
      windowMin: 15,
      now: new Date(2025, 0, 1, 3, 0, 0),
    });
    expect(h).toBe(11);
  });

  it('overrideHour=null overrideMinute=null → 使用 now', () => {
    const fake = new Date(2025, 0, 1, 23, 55, 0);
    const h = resolveEffectiveHourFromClock({
      overrideHour: null,
      overrideMinute: null,
      windowMin: 15,
      now: fake,
    });
    expect(h).toBe(0);
  });

  it('windowMin=0 即使 minute=59 也返回 overrideHour', () => {
    expect(
      resolveEffectiveHourFromClock({
        overrideHour: 14,
        overrideMinute: 59,
        windowMin: 0,
      }),
    ).toBe(14);
  });
});

describe('[M4.5.0 U-N] ScheduleConfig.softWindowMin', () => {
  const saved: Record<string, string | undefined> = {};
  const KEY = 'SCHEDULE_SOFT_WINDOW_MIN';
  beforeEach(() => {
    resetScheduleConfig();
    saved[KEY] = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved[KEY] === undefined) delete process.env[KEY];
    else process.env[KEY] = saved[KEY];
    resetScheduleConfig();
  });

  it('默认值 = 15', () => {
    expect(getScheduleConfig().softWindowMin).toBe(15);
  });

  it('env=0 禁用 soft window', () => {
    process.env[KEY] = '0';
    expect(getScheduleConfig().softWindowMin).toBe(0);
  });

  it('env=31（越界 [0,30]）降级为 0', () => {
    process.env[KEY] = '31';
    expect(getScheduleConfig().softWindowMin).toBe(0);
  });

  it('env=abc（非整数）降级为 0', () => {
    process.env[KEY] = 'abc';
    expect(getScheduleConfig().softWindowMin).toBe(0);
  });
});
