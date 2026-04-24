/**
 * [M4.5.1.a] 动态目标 CRUD（DB 层，controller 之下的纯逻辑）
 *
 * 约定
 *   - 所有查询在进入前做懒过期：expireLapsedGoals 把 status='active' 但 expires_at <= now 的行批量切 'done'
 *     - 由 list/getById 主动调用，低频 cron 可省（演示环境够用）
 *   - 时间戳对外统一 ISO 字符串；DB 原生 DATETIME 由 mysql2 回成 Date，toISO 再转
 *   - payload JSON：DB 层 mysql2 传入 / 返回自动做 JSON.parse/stringify；此处兜底
 *
 * 错误处理
 *   - create 参数非法 → throw 'INVALID_PARAM'
 *   - update id 不存在 → 返回 null（controller 转 404）
 *   - DB 连接异常抛出，由 controller 的 try/catch 转 500
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../db/connection.js';
import { getGoalConfig } from './config.js';
import type {
  CreateGoalInput,
  GoalEntity,
  GoalKind,
  GoalStatus,
  ListGoalFilter,
  UpdateGoalInput,
} from './types.js';

const VALID_KIND: readonly GoalKind[] = ['scene', 'player', 'npc', 'self'];
const VALID_STATUS: readonly GoalStatus[] = ['active', 'paused', 'done', 'dropped'];

/** 把 DB 行映射为对外 GoalEntity（时间统一 ISO，payload 统一 object|null） */
function rowToEntity(r: RowDataPacket): GoalEntity {
  const rawPayload = r['payload'];
  let payload: Record<string, unknown> | null = null;
  if (rawPayload != null) {
    if (typeof rawPayload === 'string') {
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        payload = null;
      }
    } else if (typeof rawPayload === 'object') {
      payload = rawPayload as Record<string, unknown>;
    }
  }
  const createdAt = r['created_at'] instanceof Date ? r['created_at'].toISOString() : String(r['created_at']);
  const expiresRaw = r['expires_at'];
  const expiresAt =
    expiresRaw == null
      ? null
      : expiresRaw instanceof Date
        ? expiresRaw.toISOString()
        : String(expiresRaw);
  return {
    id: Number(r['id']),
    npc_id: Number(r['npc_id']),
    title: String(r['title']),
    kind: String(r['kind']) as GoalKind,
    priority: Number(r['priority']),
    status: String(r['status']) as GoalStatus,
    created_at: createdAt,
    expires_at: expiresAt,
    payload,
  };
}

/** 懒过期：把 active 且 expires_at<=NOW() 的行切成 done；返回被切的行数 */
export async function expireLapsedGoals(): Promise<number> {
  try {
    const [res] = await pool.execute<ResultSetHeader>(
      `UPDATE npc_goal
          SET status='done'
        WHERE status='active'
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()`,
    );
    return Number(res.affectedRows || 0);
  } catch (e) {
    console.warn('[goal.crud] expireLapsedGoals 失败（吞错继续）:', (e as Error).message);
    return 0;
  }
}

function normalizePriority(p: number | undefined, fallback = 8): number {
  const n = typeof p === 'number' && Number.isFinite(p) ? Math.trunc(p) : fallback;
  return Math.max(1, Math.min(10, n));
}

function resolveExpiresAt(
  expires_in_seconds: number | null | undefined,
  expires_at: string | Date | null | undefined,
  fallbackTtlSec: number,
): Date | null {
  if (typeof expires_in_seconds === 'number' && Number.isFinite(expires_in_seconds)) {
    const s = Math.trunc(expires_in_seconds);
    if (s <= 0) return null;
    return new Date(Date.now() + s * 1000);
  }
  if (expires_at !== undefined) {
    if (expires_at === null) return null;
    const d = expires_at instanceof Date ? expires_at : new Date(expires_at);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }
  if (fallbackTtlSec > 0) return new Date(Date.now() + fallbackTtlSec * 1000);
  return null;
}

export async function createGoal(input: CreateGoalInput): Promise<GoalEntity> {
  if (!Number.isInteger(input.npc_id) || input.npc_id <= 0) {
    throw new Error('INVALID_PARAM:npc_id');
  }
  const title = (input.title ?? '').toString().trim();
  if (!title || title.length > 128) {
    throw new Error('INVALID_PARAM:title');
  }
  const kind: GoalKind = input.kind && VALID_KIND.includes(input.kind) ? input.kind : 'player';
  const priority = normalizePriority(input.priority);
  const cfg = getGoalConfig();
  const expiresAtDate = resolveExpiresAt(
    input.expires_in_seconds,
    input.expires_at,
    cfg.defaultTtlSec,
  );
  const payloadJson =
    input.payload == null
      ? null
      : typeof input.payload === 'object'
        ? JSON.stringify(input.payload)
        : null;

  const [res] = await pool.execute<ResultSetHeader>(
    `INSERT INTO npc_goal
       (npc_id, title, kind, priority, status, expires_at, payload)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [input.npc_id, title, kind, priority, expiresAtDate, payloadJson],
  );
  const id = Number(res.insertId);
  const entity = await getGoalById(id, /* skipExpire */ true);
  if (!entity) throw new Error(`INSERT npc_goal 后查不到 id=${id}`);
  return entity;
}

export async function getGoalById(id: number, skipExpire = false): Promise<GoalEntity | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!skipExpire) await expireLapsedGoals();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, npc_id, title, kind, priority, status, created_at, expires_at, payload
       FROM npc_goal WHERE id=? LIMIT 1`,
    [id],
  );
  if (rows.length === 0) return null;
  return rowToEntity(rows[0]!);
}

export async function listGoals(filter: ListGoalFilter = {}): Promise<{
  items: GoalEntity[];
  total: number;
}> {
  await expireLapsedGoals();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.npc_id && Number.isInteger(filter.npc_id) && filter.npc_id > 0) {
    where.push('npc_id=?');
    params.push(filter.npc_id);
  }
  if (filter.status && VALID_STATUS.includes(filter.status)) {
    where.push('status=?');
    params.push(filter.status);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(
    1,
    Math.min(200, Number.isInteger(filter.limit) ? Number(filter.limit) : 50),
  );

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM npc_goal ${whereSql}`,
    params,
  );
  const total = Number((countRows[0] as { c?: number } | undefined)?.c ?? 0);

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, npc_id, title, kind, priority, status, created_at, expires_at, payload
       FROM npc_goal
       ${whereSql}
       ORDER BY status='active' DESC, priority DESC, created_at DESC
       LIMIT ?`,
    [...params, limit],
  );
  return { items: rows.map(rowToEntity), total };
}

export async function updateGoal(
  id: number,
  patch: UpdateGoalInput,
): Promise<GoalEntity | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t || t.length > 128) throw new Error('INVALID_PARAM:title');
    sets.push('title=?');
    params.push(t);
  }
  if (patch.kind !== undefined) {
    if (!VALID_KIND.includes(patch.kind)) throw new Error('INVALID_PARAM:kind');
    sets.push('kind=?');
    params.push(patch.kind);
  }
  if (patch.priority !== undefined) {
    sets.push('priority=?');
    params.push(normalizePriority(patch.priority));
  }
  if (patch.status !== undefined) {
    if (!VALID_STATUS.includes(patch.status)) throw new Error('INVALID_PARAM:status');
    sets.push('status=?');
    params.push(patch.status);
  }
  if (patch.expires_in_seconds !== undefined || patch.expires_at !== undefined) {
    const d = resolveExpiresAt(
      patch.expires_in_seconds ?? undefined,
      patch.expires_at ?? undefined,
      0,
    );
    sets.push('expires_at=?');
    params.push(d);
  }
  if (patch.payload !== undefined) {
    sets.push('payload=?');
    params.push(patch.payload == null ? null : JSON.stringify(patch.payload));
  }
  if (sets.length === 0) {
    return getGoalById(id, true);
  }

  const [res] = await pool.execute<ResultSetHeader>(
    `UPDATE npc_goal SET ${sets.join(', ')} WHERE id=?`,
    [...params, id],
  );
  if (!res.affectedRows) return null;
  return getGoalById(id, true);
}

export async function deleteGoal(id: number): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false;
  const [res] = await pool.execute<ResultSetHeader>(`DELETE FROM npc_goal WHERE id=?`, [id]);
  return (res.affectedRows || 0) > 0;
}
