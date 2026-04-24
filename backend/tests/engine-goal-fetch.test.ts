/**
 * [M4.5.1.a] goal.fetch + goal.config 单测
 *
 * 覆盖
 *   - fetchActiveGoalForNpc：命中 / 空 / DB 异常降级返回 null
 *   - GoalConfig：默认值 / env 覆盖 / 越界 TTL 回 0 / reset
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const { poolQueryMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
}));

vi.mock('../src/db/connection.js', () => ({
  pool: { query: poolQueryMock, execute: vi.fn() },
}));

import { fetchActiveGoalForNpc } from '../src/engine/goal/fetch.js';
import { getGoalConfig, resetGoalConfig } from '../src/engine/goal/config.js';

describe('[M4.5.1.a] fetchActiveGoalForNpc', () => {
  beforeEach(() => poolQueryMock.mockReset());

  it('命中 → 返回结构化对象', async () => {
    poolQueryMock.mockResolvedValueOnce([
      [
        {
          id: 10,
          title: '去图书馆',
          priority: 9,
          expires_at: new Date('2026-04-23T10:30:00Z'),
        },
      ],
      null,
    ]);
    const g = await fetchActiveGoalForNpc(1);
    expect(g).not.toBeNull();
    expect(g?.id).toBe(10);
    expect(g?.priority).toBe(9);
    expect(g?.expires_at).toBe('2026-04-23T10:30:00.000Z');
  });

  it('空 → null', async () => {
    poolQueryMock.mockResolvedValueOnce([[], null]);
    expect(await fetchActiveGoalForNpc(1)).toBeNull();
  });

  it('npc_id 非正整数 → null（不发查询）', async () => {
    expect(await fetchActiveGoalForNpc(0)).toBeNull();
    expect(await fetchActiveGoalForNpc(-1)).toBeNull();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('DB 异常 → 降级 null', async () => {
    poolQueryMock.mockRejectedValueOnce(new Error('conn refused'));
    const g = await fetchActiveGoalForNpc(1);
    expect(g).toBeNull();
  });
});

describe('[M4.5.1.a] GoalConfig', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['GOAL_ENABLED', 'GOAL_DEFAULT_TTL_SEC'] as const;
  beforeEach(() => {
    resetGoalConfig();
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetGoalConfig();
  });

  it('默认：enabled=true, defaultTtlSec=1800', () => {
    const cfg = getGoalConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.defaultTtlSec).toBe(1800);
  });

  it('GOAL_ENABLED=false 关闭写', () => {
    process.env['GOAL_ENABLED'] = 'false';
    expect(getGoalConfig().enabled).toBe(false);
  });

  it('GOAL_DEFAULT_TTL_SEC=0 表示永不过期', () => {
    process.env['GOAL_DEFAULT_TTL_SEC'] = '0';
    expect(getGoalConfig().defaultTtlSec).toBe(0);
  });

  it('GOAL_DEFAULT_TTL_SEC 非整数 / 负数 → 回 0', () => {
    process.env['GOAL_DEFAULT_TTL_SEC'] = '-10';
    expect(getGoalConfig().defaultTtlSec).toBe(0);
    resetGoalConfig();
    process.env['GOAL_DEFAULT_TTL_SEC'] = 'abc';
    expect(getGoalConfig().defaultTtlSec).toBe(0);
  });
});
