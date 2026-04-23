/**
 * [M4.2.4.b] 场景事件 REST 控制器
 *
 * 路由映射
 *   POST   /api/scene/:id/events            创建事件 + 同步 WS emit scene.event.created（拉票 Q3c）
 *   GET    /api/scene/:id/events            分页查最近事件
 *   DELETE /api/scene/:id/events/:eid       物理删除（FK 级联清 scene_event_consumed）
 *
 * 入库校验
 *   - 复用 engine/event/prompts.ts 的 createSceneEventSchema，五字段边界严格一致
 *   - 存入前把 payload / visible_npcs 做 JSON.stringify（mysql2 driver 也会做，但显式更可控）
 *
 * 错误码体系（对齐 reflectOnce 风格）
 *   INVALID_PARAM       - path 参数非法
 *   INVALID_BODY        - zod 校验失败（返回第一条 issue 的 path + message）
 *   SCENE_NOT_FOUND     - scene_id 不在 scene 表
 *   EVENT_NOT_FOUND     - DELETE 路径的 event 不存在或不属于该 scene
 *   INTERNAL            - 其他 DB 错误
 */
import type { Request, Response } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../db/connection.js';
import { bus } from '../engine/bus.js';
import { createSceneEventSchema } from '../engine/event/prompts.js';
import type { EventType, SceneEventRow } from '../engine/event/types.js';

/** 统一错误响应 */
function err(res: Response, http: number, code: string, message: string) {
  return res.status(http).json({ code: -1, error: code, message });
}

function toPositiveInt(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

interface SceneEventDbRow extends RowDataPacket {
  id: number;
  scene_id: number;
  type: EventType;
  actor: string | null;
  content: string;
  payload: unknown;
  visible_npcs: unknown;
  created_at: Date | string;
  consumed_tick: number | null;
  /** [M4.3.0] / [M4.3.1.a] 扩字段 */
  trace_id: string | null;
  parent_event_id: number | null;
  conv_turn: number | null;
}

/** DB 行 → API row，确保 payload/visible_npcs 是 JS 原生对象/数组或 null */
function normalize(r: SceneEventDbRow): SceneEventRow {
  return {
    id: Number(r.id),
    scene_id: Number(r.scene_id),
    type: r.type,
    actor: r.actor ?? null,
    content: r.content,
    payload: r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)
      ? (r.payload as Record<string, unknown>)
      : null,
    visible_npcs: Array.isArray(r.visible_npcs)
      ? (r.visible_npcs as number[]).filter((v) => Number.isFinite(v))
      : null,
    created_at: r.created_at,
    consumed_tick: r.consumed_tick ?? null,
    trace_id: r.trace_id ?? null,
    parent_event_id: r.parent_event_id ?? null,
    conv_turn: r.conv_turn ?? null,
  };
}

async function assertSceneExists(scene_id: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM scene WHERE id = ? LIMIT 1',
    [scene_id],
  );
  return (rows as unknown[]).length > 0;
}

/**
 * POST /api/scene/:id/events
 * body: { type, content, actor?, payload?, visible_npcs? }
 * 返回：{ code:0, data: SceneEventRow }；同时 bus.emit 'scene.event.created'（拉票 Q3c + Q4a 命名）
 */
export async function createSceneEvent(req: Request, res: Response) {
  const scene_id = toPositiveInt(req.params.id);
  if (!scene_id) return err(res, 400, 'INVALID_PARAM', 'scene_id 必须为正整数');

  const parsed = createSceneEventSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || '<unknown>';
    return err(res, 400, 'INVALID_BODY', `${field}: ${issue?.message ?? '字段非法'}`);
  }
  const body = parsed.data;

  try {
    if (!(await assertSceneExists(scene_id))) {
      return err(res, 404, 'SCENE_NOT_FOUND', `scene_id=${scene_id} 不存在`);
    }

    const payloadJson = body.payload == null ? null : JSON.stringify(body.payload);
    const visibleJson =
      body.visible_npcs === undefined || body.visible_npcs === null
        ? null
        : JSON.stringify(body.visible_npcs);

    const [ins] = await pool.execute<ResultSetHeader>(
      `INSERT INTO scene_event (scene_id, type, actor, content, payload, visible_npcs)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [scene_id, body.type, body.actor ?? null, body.content, payloadJson, visibleJson],
    );
    const eventId = ins.insertId;

    /** 回查刚写入行，返回真实 created_at + 所有字段 */
    const [rows] = await pool.query<SceneEventDbRow[]>(
      `SELECT id, scene_id, type, actor, content, payload, visible_npcs, created_at, consumed_tick,
              trace_id, parent_event_id, conv_turn
         FROM scene_event WHERE id = ?`,
      [eventId],
    );
    if (rows.length === 0) {
      return err(res, 500, 'INTERNAL', `刚创建的事件 id=${eventId} 读回失败`);
    }
    const row = normalize(rows[0] as SceneEventDbRow);

    /** 同步 WS 广播（拉票 Q3c + Q4a）：多客户端自动同步；单客户端 caller 则通过响应 body 拿到完整行 */
    bus.emitEvent({
      type: 'scene.event.created',
      scene_id,
      event_id: row.id,
      event_type: row.type,
      actor: row.actor,
      content: row.content,
      payload: row.payload,
      visible_npcs: row.visible_npcs,
      at: new Date().toISOString(),
      /** [M4.3.0 / M4.3.1.c] WS 下发 trace 与对话链字段；手动注入的 dialogue 亦可被前端展示回复徽章 */
      trace_id: row.trace_id ?? null,
      parent_event_id: row.parent_event_id ?? null,
      conv_turn: row.conv_turn ?? null,
    });

    return res.json({ code: 0, data: row });
  } catch (e) {
    console.error('createSceneEvent:', e);
    return err(res, 500, 'INTERNAL', (e as Error).message || '创建事件失败');
  }
}

/**
 * GET /api/scene/:id/events?limit=50&since=<id>
 * - 按 created_at DESC 分页；since = 返回 id > since 的最新事件（用于增量同步）
 * - limit 上限 200 + 默认 50
 */
export async function listSceneEvents(req: Request, res: Response) {
  const scene_id = toPositiveInt(req.params.id);
  if (!scene_id) return err(res, 400, 'INVALID_PARAM', 'scene_id 必须为正整数');

  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;
  const sinceRaw = req.query.since;
  const since = sinceRaw !== undefined ? toPositiveInt(sinceRaw) : null;

  try {
    if (!(await assertSceneExists(scene_id))) {
      return err(res, 404, 'SCENE_NOT_FOUND', `scene_id=${scene_id} 不存在`);
    }
    const where = since ? 'WHERE scene_id = ? AND id > ?' : 'WHERE scene_id = ?';
    const args: unknown[] = since ? [scene_id, since, limit] : [scene_id, limit];
    const [rows] = await pool.query<SceneEventDbRow[]>(
      `SELECT id, scene_id, type, actor, content, payload, visible_npcs, created_at, consumed_tick,
              trace_id, parent_event_id, conv_turn
         FROM scene_event ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      args,
    );
    return res.json({
      code: 0,
      data: {
        list: rows.map((r) => normalize(r as SceneEventDbRow)),
        limit,
        since: since ?? null,
      },
    });
  } catch (e) {
    console.error('listSceneEvents:', e);
    return err(res, 500, 'INTERNAL', (e as Error).message || '查询事件失败');
  }
}

/**
 * DELETE /api/scene/:id/events/:eid
 * - 仅允许删除属于 scene_id 的事件（防越权）
 * - FK ON DELETE CASCADE 级联清 scene_event_consumed
 */
export async function deleteSceneEvent(req: Request, res: Response) {
  const scene_id = toPositiveInt(req.params.id);
  const event_id = toPositiveInt(req.params.eid);
  if (!scene_id) return err(res, 400, 'INVALID_PARAM', 'scene_id 必须为正整数');
  if (!event_id) return err(res, 400, 'INVALID_PARAM', 'event_id 必须为正整数');

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      'DELETE FROM scene_event WHERE id = ? AND scene_id = ?',
      [event_id, scene_id],
    );
    if (result.affectedRows === 0) {
      return err(res, 404, 'EVENT_NOT_FOUND', `event_id=${event_id} 不属于 scene_id=${scene_id}`);
    }
    return res.json({ code: 0, data: { id: event_id } });
  } catch (e) {
    console.error('deleteSceneEvent:', e);
    return err(res, 500, 'INTERNAL', (e as Error).message || '删除事件失败');
  }
}
