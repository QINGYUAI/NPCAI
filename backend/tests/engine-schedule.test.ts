/**
 * [M4.4.1.a] schedule 子系统单测
 *   - getScheduleConfig：默认值 / env 覆盖 / reset
 *   - resolveScheduledActivity：命中 / 未命中 / 多条按 priority / hour 越界 / 空 rows
 *
 * 覆盖目标：8 tests（与 roadmap §7.2.3 约定一致）
 * 不碰 DB；fetch.ts 的 mysql2 层依赖 DB 连接，留到 live smoke 验证
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getScheduleConfig, resetScheduleConfig } from '../src/engine/schedule/config.js';
import {
  resolveScheduledActivity,
  type ScheduleRow,
} from '../src/engine/schedule/resolve.js';

const ENV_KEYS = ['SCHEDULE_ENABLED', 'SCHEDULE_LLM_HINT'] as const;

describe('[M4.4.1.a] schedule.config', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    resetScheduleConfig();
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetScheduleConfig();
  });

  it('默认：enabled=true, llmHint=false（拉票 Q4=a，.a 批次只读不消费 hint）', () => {
    const cfg = getScheduleConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.llmHint).toBe(false);
  });

  it('env 覆盖：SCHEDULE_ENABLED=false + SCHEDULE_LLM_HINT=true 都读到', () => {
    process.env['SCHEDULE_ENABLED'] = 'false';
    process.env['SCHEDULE_LLM_HINT'] = 'true';
    resetScheduleConfig();
    const cfg = getScheduleConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.llmHint).toBe(true);
  });

  it('resetScheduleConfig 清缓存：env 变更后再读能拿到新值', () => {
    expect(getScheduleConfig().enabled).toBe(true);
    process.env['SCHEDULE_ENABLED'] = 'false';
    // 不 reset：仍读到旧缓存
    expect(getScheduleConfig().enabled).toBe(true);
    resetScheduleConfig();
    expect(getScheduleConfig().enabled).toBe(false);
  });
});

describe('[M4.4.1.a] schedule.resolve', () => {
  const tpl: ScheduleRow[] = [
    { hour: 0, activity: '睡眠', location: '卧室', priority: 3 },
    { hour: 8, activity: '工作', location: '书房', priority: 7 },
    { hour: 12, activity: '午餐', location: '餐厅', priority: 6 },
  ];

  it('命中 hour=8：返回对应 activity + location + priority', () => {
    const out = resolveScheduledActivity(tpl, 8);
    expect(out).toEqual({ activity: '工作', location: '书房', priority: 7 });
  });

  it('未覆盖 hour=5：返回 null（模板不含 5）', () => {
    expect(resolveScheduledActivity(tpl, 5)).toBeNull();
  });

  it('多条同 hour：按 priority DESC 取最高', () => {
    const rows: ScheduleRow[] = [
      { hour: 8, activity: '开会', location: null, priority: 5 },
      { hour: 8, activity: '工作', location: '书房', priority: 7 },
      { hour: 8, activity: '喝水', location: null, priority: 2 },
    ];
    const out = resolveScheduledActivity(rows, 8);
    expect(out?.activity).toBe('工作');
    expect(out?.priority).toBe(7);
  });

  it('hour 越界（<0 / >23 / NaN / 非整数）→ null', () => {
    expect(resolveScheduledActivity(tpl, -1)).toBeNull();
    expect(resolveScheduledActivity(tpl, 24)).toBeNull();
    expect(resolveScheduledActivity(tpl, 8.5)).toBeNull();
    expect(resolveScheduledActivity(tpl, Number.NaN)).toBeNull();
  });

  it('空 rows / null / undefined → null，且 priority 缺失时兜底 5', () => {
    expect(resolveScheduledActivity([], 8)).toBeNull();
    expect(resolveScheduledActivity(null, 8)).toBeNull();
    expect(resolveScheduledActivity(undefined, 8)).toBeNull();

    const rows: ScheduleRow[] = [{ hour: 8, activity: '工作', location: null }];
    const out = resolveScheduledActivity(rows, 8);
    expect(out).toEqual({ activity: '工作', location: null, priority: 5 });
  });
});
