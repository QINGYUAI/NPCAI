/**
 * [M4.2.4.b] /api/scene/:id/events REST 控制器测试（mock pool + bus）
 *
 * 覆盖用例
 *   POST
 *     - 路径参数非正整数 → 400 INVALID_PARAM
 *     - body 非法（type 枚举 / content 空）→ 400 INVALID_BODY
 *     - scene 不存在 → 404 SCENE_NOT_FOUND
 *     - 成功：insertId 返回 + 查回 row + emit scene.event.created + response.data 完整
 *   GET
 *     - scene 不存在 → 404
 *     - 默认 limit=50；自定义 limit+since 合并到 SQL 参数
 *     - normalize：非法 payload/visible_npcs 降级为 null
 *   DELETE
 *     - 不属于本场景 → 404 EVENT_NOT_FOUND
 *     - 成功：affectedRows=1 → 200 + data.id
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQueryMock, poolExecuteMock, busEmitMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  poolExecuteMock: vi.fn(),
  busEmitMock: vi.fn(),
}));

vi.mock('../src/db/connection.js', () => ({
  pool: { query: poolQueryMock, execute: poolExecuteMock },
}));

vi.mock('../src/engine/bus.js', () => ({
  bus: { emitEvent: busEmitMock },
}));

import { sceneRouter } from '../src/routes/scene.js';

const app = express();
app.use(express.json());
app.use('/api/scene', sceneRouter);

beforeEach(() => {
  poolQueryMock.mockReset();
  poolExecuteMock.mockReset();
  busEmitMock.mockReset();
});

/* ------------------------------- POST 创建 -------------------------------- */

describe('POST /api/scene/:id/events', () => {
  it('scene_id 非正整数 → 400 INVALID_PARAM', async () => {
    const r = await request(app).post('/api/scene/abc/events').send({
      type: 'weather',
      content: 'rain',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_PARAM');
  });

  it('body type 非枚举 → 400 INVALID_BODY', async () => {
    const r = await request(app).post('/api/scene/1/events').send({
      type: 'fire',
      content: '起火',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_BODY');
  });

  it('body content 全空白 → 400 INVALID_BODY（字段名 content 在 message 里）', async () => {
    const r = await request(app).post('/api/scene/1/events').send({
      type: 'weather',
      content: '   ',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_BODY');
    expect(r.body.message).toContain('content');
  });

  it('scene 不存在 → 404 SCENE_NOT_FOUND', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM scene WHERE id')) return [[], null];
      return [[], null];
    });
    const r = await request(app).post('/api/scene/999/events').send({
      type: 'weather',
      content: 'rain',
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('SCENE_NOT_FOUND');
  });

  it('成功：insert → 回查完整 row → emit bus + 返回 data', async () => {
    const now = '2026-04-21T00:00:00.000Z';
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM scene WHERE id')) return [[{ id: 1 }], null];
      if (sql.includes('FROM scene_event WHERE id')) {
        return [
          [
            {
              id: 42,
              scene_id: 1,
              type: 'plot',
              actor: '旁白',
              content: '喧闹声',
              payload: { intensity: 3 },
              visible_npcs: [10, 11],
              created_at: now,
              consumed_tick: null,
            },
          ],
          null,
        ];
      }
      return [[], null];
    });
    poolExecuteMock.mockResolvedValueOnce([{ insertId: 42 }, null]);

    const r = await request(app).post('/api/scene/1/events').send({
      type: 'plot',
      content: '  喧闹声  ',
      actor: '旁白',
      payload: { intensity: 3 },
      visible_npcs: [10, 11],
    });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(0);
    expect(r.body.data.id).toBe(42);
    expect(r.body.data.type).toBe('plot');
    expect(r.body.data.content).toBe('喧闹声');
    expect(r.body.data.visible_npcs).toEqual([10, 11]);

    expect(busEmitMock).toHaveBeenCalledTimes(1);
    const ev = busEmitMock.mock.calls[0]![0];
    expect(ev.type).toBe('scene.event.created');
    expect(ev.event_id).toBe(42);
    expect(ev.event_type).toBe('plot');
    expect(ev.visible_npcs).toEqual([10, 11]);

    /** insert SQL 的参数传递正确（actor trim 后 = '旁白'，payload/visible_npcs 被 JSON.stringify） */
    const insArgs = poolExecuteMock.mock.calls[0]![1];
    expect(insArgs[0]).toBe(1); // scene_id
    expect(insArgs[1]).toBe('plot'); // type
    expect(insArgs[2]).toBe('旁白'); // actor trim 后
    expect(insArgs[3]).toBe('喧闹声'); // content trim 后
    expect(insArgs[4]).toBe(JSON.stringify({ intensity: 3 })); // payload
    expect(insArgs[5]).toBe(JSON.stringify([10, 11])); // visible_npcs
  });

  it('visible_npcs 不传 → JSON 列为 null（全场景可见）', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM scene WHERE id')) return [[{ id: 1 }], null];
      if (sql.includes('FROM scene_event WHERE id')) {
        return [
          [
            {
              id: 1,
              scene_id: 1,
              type: 'weather',
              actor: null,
              content: 'rain',
              payload: null,
              visible_npcs: null,
              created_at: '2026-04-21',
              consumed_tick: null,
            },
          ],
          null,
        ];
      }
      return [[], null];
    });
    poolExecuteMock.mockResolvedValueOnce([{ insertId: 1 }, null]);

    const r = await request(app).post('/api/scene/1/events').send({
      type: 'weather',
      content: 'rain',
    });
    expect(r.status).toBe(200);
    const insArgs = poolExecuteMock.mock.calls[0]![1];
    expect(insArgs[5]).toBe(null);
  });
});

/* -------------------------------- GET list ------------------------------- */

describe('GET /api/scene/:id/events', () => {
  it('scene 不存在 → 404', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM scene WHERE id')) return [[], null];
      return [[], null];
    });
    const r = await request(app).get('/api/scene/999/events');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('SCENE_NOT_FOUND');
  });

  it('默认 limit=50；无 since；normalize 非法字段', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM scene WHERE id')) return [[{ id: 1 }], null];
      if (sql.includes('FROM scene_event')) {
        return [
          [
            {
              id: 1,
              scene_id: 1,
              type: 'weather',
              actor: null,
              content: 'a',
              payload: 'notObject',
              visible_npcs: 'notArray',
              created_at: '2026-04-21',
              consumed_tick: null,
            },
          ],
          null,
        ];
      }
      return [[], null];
    });
    const r = await request(app).get('/api/scene/1/events');
    expect(r.status).toBe(200);
    expect(r.body.data.list[0].payload).toBe(null);
    expect(r.body.data.list[0].visible_npcs).toBe(null);
    expect(r.body.data.limit).toBe(50);

    const args = poolQueryMock.mock.calls.find((c) => String(c[0]).includes('FROM scene_event'))![1];
    expect(args).toEqual([1, 50]);
  });

  it('自定义 limit + since → SQL 参数化正确', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM scene WHERE id')) return [[{ id: 1 }], null];
      if (sql.includes('FROM scene_event')) return [[], null];
      return [[], null];
    });
    await request(app).get('/api/scene/1/events?limit=10&since=5');
    const args = poolQueryMock.mock.calls.find((c) => String(c[0]).includes('FROM scene_event'))!;
    expect(String(args[0])).toContain('id > ?');
    expect(args[1]).toEqual([1, 5, 10]);
  });

  it('limit 超 200 → 截到 200', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM scene WHERE id')) return [[{ id: 1 }], null];
      if (sql.includes('FROM scene_event')) return [[], null];
      return [[], null];
    });
    await request(app).get('/api/scene/1/events?limit=999');
    const args = poolQueryMock.mock.calls.find((c) => String(c[0]).includes('FROM scene_event'))![1];
    expect(args[1]).toBe(200);
  });
});

/* -------------------------------- DELETE --------------------------------- */

describe('DELETE /api/scene/:id/events/:eid', () => {
  it('不属于本 scene（affectedRows=0）→ 404 EVENT_NOT_FOUND', async () => {
    poolExecuteMock.mockResolvedValueOnce([{ affectedRows: 0 }, null]);
    const r = await request(app).delete('/api/scene/1/events/99');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('EVENT_NOT_FOUND');
  });

  it('成功删除 → 200 + data.id', async () => {
    poolExecuteMock.mockResolvedValueOnce([{ affectedRows: 1 }, null]);
    const r = await request(app).delete('/api/scene/1/events/42');
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(0);
    expect(r.body.data.id).toBe(42);

    const [sql, args] = poolExecuteMock.mock.calls[0]!;
    expect(String(sql)).toContain('DELETE FROM scene_event WHERE id = ? AND scene_id = ?');
    expect(args).toEqual([42, 1]);
  });

  it('event_id 非正整数 → 400', async () => {
    const r = await request(app).delete('/api/scene/1/events/abc');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_PARAM');
  });
});
