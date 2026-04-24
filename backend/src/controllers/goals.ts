/**
 * [M4.5.1.a] 动态目标 REST 控制器
 *
 * 路由
 *   POST   /api/engine/goals              —— 创建目标
 *   PATCH  /api/engine/goals/:id          —— 更新状态 / 优先级 / 过期 / payload
 *   GET    /api/engine/goals              —— 列表查询（支持 npc_id / status / limit）
 *   DELETE /api/engine/goals/:id          —— 硬删
 *
 * 设计取舍
 *   - 不做 goal 生命周期事件广播（WS）：避免同链路噪音；真正的"goal 激活"应当是 tick 消费那一刻（M4.5.1.b）
 *   - 所有响应统一 `{ code, data, message? }` 形式，复用 reflection controller 的风格
 *   - GOAL_ENABLED=false 时仍允许 GET（运维可查历史），POST/PATCH/DELETE 返 503（写操作屏蔽）
 */
import type { Request, Response } from 'express';
import { pool } from '../db/connection.js';
import type { RowDataPacket } from 'mysql2';
import { getGoalConfig } from '../engine/goal/config.js';
import {
  createGoal,
  deleteGoal,
  getGoalById,
  listGoals,
  updateGoal,
} from '../engine/goal/crud.js';
import type {
  CreateGoalInput,
  GoalKind,
  GoalStatus,
  UpdateGoalInput,
} from '../engine/goal/types.js';

const VALID_KIND: readonly GoalKind[] = ['scene', 'player', 'npc', 'self'];
const VALID_STATUS: readonly GoalStatus[] = ['active', 'paused', 'done', 'dropped'];

function err(res: Response, http: number, code: string, message: string) {
  return res.status(http).json({ code: -1, error: code, message });
}

function toPositiveInt(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

function requireWriteEnabled(res: Response): boolean {
  if (!getGoalConfig().enabled) {
    err(res, 503, 'GOAL_DISABLED', 'GOAL_ENABLED=false，写操作已禁用');
    return false;
  }
  return true;
}

/** POST /api/engine/goals */
export async function postGoal(req: Request, res: Response) {
  if (!requireWriteEnabled(res)) return;
  const body = (req.body || {}) as Record<string, unknown>;
  const npc_id = toPositiveInt(body.npc_id);
  if (!npc_id) return err(res, 400, 'INVALID_PARAM', 'npc_id 必须为正整数');
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return err(res, 400, 'INVALID_PARAM', 'title 不可为空');
  if (title.length > 128) return err(res, 400, 'INVALID_PARAM', 'title 长度需 ≤ 128');

  const kind = body.kind;
  if (kind !== undefined && !(typeof kind === 'string' && VALID_KIND.includes(kind as GoalKind))) {
    return err(res, 400, 'INVALID_PARAM', `kind 必须 ∈ ${VALID_KIND.join('|')}`);
  }
  const priority = body.priority;
  if (priority !== undefined) {
    const p = Number(priority);
    if (!Number.isFinite(p) || !Number.isInteger(p) || p < 1 || p > 10) {
      return err(res, 400, 'INVALID_PARAM', 'priority 必须是 1..10 的整数');
    }
  }

  /** NPC 存在性校验；不存在直接 404，避免写进没人的 id */
  const [npcs] = await pool.query<RowDataPacket[]>(`SELECT id FROM npc WHERE id=? LIMIT 1`, [
    npc_id,
  ]);
  if (npcs.length === 0) return err(res, 404, 'NPC_NOT_FOUND', `npc_id=${npc_id} 不存在`);

  try {
    const input: CreateGoalInput = {
      npc_id,
      title,
      kind: (kind as GoalKind) ?? undefined,
      priority: priority === undefined ? undefined : Number(priority),
      expires_in_seconds:
        body.expires_in_seconds === undefined ? undefined : Number(body.expires_in_seconds),
      expires_at:
        body.expires_at === undefined || body.expires_at === null
          ? (body.expires_at as null | undefined)
          : String(body.expires_at),
      payload:
        body.payload && typeof body.payload === 'object'
          ? (body.payload as Record<string, unknown>)
          : undefined,
    };
    const entity = await createGoal(input);
    return res.json({ code: 0, data: entity });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('INVALID_PARAM')) {
      return err(res, 400, 'INVALID_PARAM', msg);
    }
    console.error('postGoal:', e);
    return err(res, 500, 'INTERNAL', msg || 'create goal 失败');
  }
}

/** PATCH /api/engine/goals/:id */
export async function patchGoal(req: Request, res: Response) {
  if (!requireWriteEnabled(res)) return;
  const id = toPositiveInt(req.params['id']);
  if (!id) return err(res, 400, 'INVALID_PARAM', 'id 必须为正整数');
  const body = (req.body || {}) as Record<string, unknown>;

  const patch: UpdateGoalInput = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') return err(res, 400, 'INVALID_PARAM', 'title 必须为字符串');
    patch.title = body.title;
  }
  if (body.kind !== undefined) {
    if (!(typeof body.kind === 'string' && VALID_KIND.includes(body.kind as GoalKind))) {
      return err(res, 400, 'INVALID_PARAM', `kind 必须 ∈ ${VALID_KIND.join('|')}`);
    }
    patch.kind = body.kind as GoalKind;
  }
  if (body.priority !== undefined) {
    const p = Number(body.priority);
    if (!Number.isFinite(p) || !Number.isInteger(p) || p < 1 || p > 10) {
      return err(res, 400, 'INVALID_PARAM', 'priority 必须是 1..10');
    }
    patch.priority = p;
  }
  if (body.status !== undefined) {
    if (!(typeof body.status === 'string' && VALID_STATUS.includes(body.status as GoalStatus))) {
      return err(res, 400, 'INVALID_PARAM', `status 必须 ∈ ${VALID_STATUS.join('|')}`);
    }
    patch.status = body.status as GoalStatus;
  }
  if (body.expires_in_seconds !== undefined) {
    const v = body.expires_in_seconds;
    patch.expires_in_seconds = v === null ? null : Number(v);
  }
  if (body.expires_at !== undefined) {
    patch.expires_at = body.expires_at === null ? null : String(body.expires_at);
  }
  if (body.payload !== undefined) {
    patch.payload =
      body.payload === null
        ? null
        : typeof body.payload === 'object'
          ? (body.payload as Record<string, unknown>)
          : null;
  }

  try {
    const entity = await updateGoal(id, patch);
    if (!entity) return err(res, 404, 'GOAL_NOT_FOUND', `goal id=${id} 不存在`);
    return res.json({ code: 0, data: entity });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('INVALID_PARAM')) return err(res, 400, 'INVALID_PARAM', msg);
    console.error('patchGoal:', e);
    return err(res, 500, 'INTERNAL', msg || 'update goal 失败');
  }
}

/** GET /api/engine/goals */
export async function getGoalList(req: Request, res: Response) {
  const npc_id = req.query['npc_id'] !== undefined ? toPositiveInt(req.query['npc_id']) : null;
  const statusQ = req.query['status'];
  const status =
    typeof statusQ === 'string' && VALID_STATUS.includes(statusQ as GoalStatus)
      ? (statusQ as GoalStatus)
      : undefined;
  const limit = req.query['limit'] !== undefined ? toPositiveInt(req.query['limit']) : null;

  try {
    const { items, total } = await listGoals({
      npc_id: npc_id ?? undefined,
      status,
      limit: limit ?? undefined,
    });
    return res.json({ code: 0, data: { items, total } });
  } catch (e) {
    console.error('getGoalList:', e);
    return err(res, 500, 'INTERNAL', (e as Error).message || 'list goal 失败');
  }
}

/** GET /api/engine/goals/:id */
export async function getGoalDetail(req: Request, res: Response) {
  const id = toPositiveInt(req.params['id']);
  if (!id) return err(res, 400, 'INVALID_PARAM', 'id 必须为正整数');
  try {
    const entity = await getGoalById(id);
    if (!entity) return err(res, 404, 'GOAL_NOT_FOUND', `goal id=${id} 不存在`);
    return res.json({ code: 0, data: entity });
  } catch (e) {
    console.error('getGoalDetail:', e);
    return err(res, 500, 'INTERNAL', (e as Error).message || 'get goal 失败');
  }
}

/** DELETE /api/engine/goals/:id */
export async function deleteGoalById(req: Request, res: Response) {
  if (!requireWriteEnabled(res)) return;
  const id = toPositiveInt(req.params['id']);
  if (!id) return err(res, 400, 'INVALID_PARAM', 'id 必须为正整数');
  try {
    const ok = await deleteGoal(id);
    if (!ok) return err(res, 404, 'GOAL_NOT_FOUND', `goal id=${id} 不存在`);
    return res.json({ code: 0, data: { id } });
  } catch (e) {
    console.error('deleteGoalById:', e);
    return err(res, 500, 'INTERNAL', (e as Error).message || 'delete goal 失败');
  }
}
