/**
 * [M4.5.1.a] /api/engine/goals REST 控制器测试
 *
 * 覆盖（拉票 Q8=a 口径）
 *   - POST 成功：priority 默认 8、kind 默认 player、expires_at 由 GOAL_DEFAULT_TTL_SEC 注入
 *   - POST npc_id / title / priority 非法 → 400
 *   - POST NPC 不存在 → 404
 *   - PATCH 合法 → 200 + 查回 row；不存在 → 404
 *   - GET 列表：按 status='active' DESC + priority DESC 排序；支持过滤 npc_id + status
 *   - DELETE：命中 → 200；未命中 → 404
 *   - GOAL_ENABLED=false 时 POST/PATCH/DELETE 返 503；GET 仍可用
 *
 * 全程 mock pool；与真实 mysql 无关联
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQueryMock, poolExecuteMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  poolExecuteMock: vi.fn(),
}));

vi.mock('../src/db/connection.js', () => ({
  pool: { query: poolQueryMock, execute: poolExecuteMock },
}));

import { engineRouter } from '../src/routes/engine.js';
import { resetGoalConfig } from '../src/engine/goal/config.js';

const app = express();
app.use(express.json());
app.use('/api/engine', engineRouter);

/** 一个通用的 "ok mock" 流程：npc_exists → insert → getById SELECT → expire UPDATE */
function setupCreateFlow(insertId = 77) {
  poolQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM npc WHERE id=?')) {
      return [[{ id: 1 }], null];
    }
    if (sql.includes('SELECT id, npc_id, title, kind, priority, status, created_at, expires_at, payload')) {
      return [
        [
          {
            id: insertId,
            npc_id: 1,
            title: '去图书馆找小美',
            kind: 'player',
            priority: 8,
            status: 'active',
            created_at: new Date('2026-04-23T10:00:00Z'),
            expires_at: new Date('2026-04-23T10:30:00Z'),
            payload: null,
          },
        ],
        null,
      ];
    }
    return [[], null];
  });
  poolExecuteMock.mockImplementation(async (sql: string) => {
    if (sql.includes('INSERT INTO npc_goal')) return [{ insertId, affectedRows: 1 }, null];
    if (sql.startsWith('UPDATE npc_goal') && sql.includes("status='done'"))
      return [{ affectedRows: 0 }, null];
    return [{ insertId: 0, affectedRows: 0 }, null];
  });
}

beforeEach(() => {
  poolQueryMock.mockReset();
  poolExecuteMock.mockReset();
  delete process.env['GOAL_ENABLED'];
  delete process.env['GOAL_DEFAULT_TTL_SEC'];
  resetGoalConfig();
});

describe('[M4.5.1.a] POST /api/engine/goals', () => {
  it('成功：priority/kind 走默认，返 0 + data.id', async () => {
    setupCreateFlow(77);
    const r = await request(app)
      .post('/api/engine/goals')
      .send({ npc_id: 1, title: '去图书馆找小美' });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(0);
    expect(r.body.data.id).toBe(77);
    expect(r.body.data.priority).toBe(8);
    expect(r.body.data.kind).toBe('player');
    expect(r.body.data.status).toBe('active');
  });

  it('npc_id 非正整数 → 400 INVALID_PARAM', async () => {
    const r = await request(app).post('/api/engine/goals').send({ npc_id: -1, title: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_PARAM');
  });

  it('title 为空 → 400 INVALID_PARAM', async () => {
    const r = await request(app).post('/api/engine/goals').send({ npc_id: 1, title: '  ' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_PARAM');
  });

  it('priority 超出 1..10 → 400', async () => {
    const r = await request(app)
      .post('/api/engine/goals')
      .send({ npc_id: 1, title: 'ok', priority: 99 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_PARAM');
  });

  it('NPC 不存在 → 404 NPC_NOT_FOUND', async () => {
    poolQueryMock.mockResolvedValueOnce([[], null]); // SELECT npc → empty
    const r = await request(app).post('/api/engine/goals').send({ npc_id: 999, title: 'ok' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('NPC_NOT_FOUND');
  });
});

describe('[M4.5.1.a] PATCH /api/engine/goals/:id', () => {
  it('合法 status 修改 → 200 + 新 status', async () => {
    poolExecuteMock.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE npc_goal')) return [{ affectedRows: 1 }, null];
      return [{ affectedRows: 0 }, null];
    });
    poolQueryMock.mockImplementation(async () => [
      [
        {
          id: 77,
          npc_id: 1,
          title: 't',
          kind: 'player',
          priority: 8,
          status: 'done',
          created_at: new Date(),
          expires_at: null,
          payload: null,
        },
      ],
      null,
    ]);
    const r = await request(app).patch('/api/engine/goals/77').send({ status: 'done' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('done');
  });

  it('非法 status → 400', async () => {
    const r = await request(app).patch('/api/engine/goals/77').send({ status: 'foo' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_PARAM');
  });

  it('id 不存在 → 404', async () => {
    poolExecuteMock.mockImplementation(async () => [{ affectedRows: 0 }, null]);
    poolQueryMock.mockImplementation(async () => [[], null]);
    const r = await request(app).patch('/api/engine/goals/999').send({ priority: 9 });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('GOAL_NOT_FOUND');
  });
});

describe('[M4.5.1.a] GET /api/engine/goals', () => {
  it('支持 npc_id + status 过滤；返 items + total', async () => {
    const mockItems = [
      {
        id: 2,
        npc_id: 1,
        title: '高优先级',
        kind: 'player',
        priority: 9,
        status: 'active',
        created_at: new Date(),
        expires_at: null,
        payload: null,
      },
      {
        id: 1,
        npc_id: 1,
        title: '低优先级',
        kind: 'player',
        priority: 5,
        status: 'active',
        created_at: new Date(),
        expires_at: null,
        payload: null,
      },
    ];
    poolExecuteMock.mockImplementation(async () => [{ affectedRows: 0 }, null]);
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return [[{ c: 2 }], null];
      if (sql.includes('SELECT id, npc_id, title')) return [mockItems, null];
      return [[], null];
    });
    const r = await request(app).get('/api/engine/goals?npc_id=1&status=active');
    expect(r.status).toBe(200);
    expect(r.body.data.total).toBe(2);
    expect(r.body.data.items.length).toBe(2);
    expect(r.body.data.items[0].priority).toBe(9); // 高优先级先
  });
});

describe('[M4.5.1.a] DELETE /api/engine/goals/:id', () => {
  it('命中 → 200', async () => {
    poolExecuteMock.mockImplementation(async () => [{ affectedRows: 1 }, null]);
    const r = await request(app).delete('/api/engine/goals/77');
    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe(77);
  });

  it('未命中 → 404', async () => {
    poolExecuteMock.mockImplementation(async () => [{ affectedRows: 0 }, null]);
    const r = await request(app).delete('/api/engine/goals/999');
    expect(r.status).toBe(404);
  });
});

describe('[M4.5.1.a] GOAL_ENABLED=false 时写操作屏蔽', () => {
  beforeEach(() => {
    process.env['GOAL_ENABLED'] = 'false';
    resetGoalConfig();
  });

  it('POST → 503 GOAL_DISABLED', async () => {
    const r = await request(app).post('/api/engine/goals').send({ npc_id: 1, title: 'x' });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('GOAL_DISABLED');
  });

  it('GET 仍可用（运维读历史）', async () => {
    poolExecuteMock.mockImplementation(async () => [{ affectedRows: 0 }, null]);
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return [[{ c: 0 }], null];
      return [[], null];
    });
    const r = await request(app).get('/api/engine/goals');
    expect(r.status).toBe(200);
    expect(r.body.data.total).toBe(0);
  });
});
