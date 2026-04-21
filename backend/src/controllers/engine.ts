/**
 * 引擎 REST 控制器
 * POST /api/engine/start
 * POST /api/engine/stop
 * GET  /api/engine/status
 * GET  /api/engine/ticks
 */
import type { Request, Response } from 'express';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../db/connection.js';
import { createScheduler, getScheduler, removeScheduler } from '../engine/registry.js';
import { isEngineEnabled } from '../engine/index.js';
import { isWsEnabled } from '../engine/wsServer.js';
import type { EngineConfig } from '../engine/types.js';

/** [M4.2.1.b] WS 启用时附加 ws_endpoint；关闭时不返回该字段，前端自动回落轮询 */
const WS_ENDPOINT = '/ws/engine';
function withWsEndpoint<T extends object>(data: T): T & { ws_endpoint?: string } {
  return isWsEnabled() ? { ...data, ws_endpoint: WS_ENDPOINT } : data;
}

const MIN_INTERVAL = 2000;
const MAX_INTERVAL = 3600_000;
const MAX_CONCURRENCY = Number(process.env.ENGINE_MAX_CONCURRENCY) || 8;
const DEFAULT_INTERVAL = Number(process.env.ENGINE_DEFAULT_INTERVAL_MS) || 30_000;

function err(res: Response, http: number, code: string, message: string) {
  return res.status(http).json({ code: -1, error: code, message });
}

/**
 * [M4.2.0] 若 scheduler 近期有 simulation_meta 软阈值越界，在响应头带 X-Meta-Warn: 1
 * - 前端据此显示气泡提示，不改变业务语义
 * - 这里只负责写头；抑制频次由 scheduler.hasFreshMetaWarn 控制
 */
function attachMetaWarnHeader(
  res: Response,
  scheduler: { hasFreshMetaWarn: () => boolean } | null | undefined,
) {
  if (scheduler && scheduler.hasFreshMetaWarn()) {
    res.setHeader('X-Meta-Warn', '1');
    res.setHeader('Access-Control-Expose-Headers', 'X-Meta-Warn');
  }
}

function toInt(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function parseEngineConfig(body: Record<string, unknown>): EngineConfig | { error: string } {
  const interval_ms = toInt(body.interval_ms, DEFAULT_INTERVAL);
  if (interval_ms < MIN_INTERVAL || interval_ms > MAX_INTERVAL) {
    return { error: `interval_ms 必须在 [${MIN_INTERVAL}, ${MAX_INTERVAL}]` };
  }
  const max_ticks_raw = body.max_ticks;
  const max_ticks =
    max_ticks_raw === undefined || max_ticks_raw === null || max_ticks_raw === ''
      ? null
      : toInt(max_ticks_raw, 0);
  if (max_ticks !== null && max_ticks <= 0) {
    return { error: 'max_ticks 必须为正整数或省略' };
  }
  const concurrency = toInt(body.concurrency, 2);
  if (concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    return { error: `concurrency 必须在 [1, ${MAX_CONCURRENCY}]` };
  }
  const dry_run = body.dry_run === true;
  return { interval_ms, max_ticks, concurrency, dry_run };
}

/** POST /api/engine/start */
export async function startEngine(req: Request, res: Response) {
  if (!isEngineEnabled()) {
    return err(res, 503, 'ENGINE_DISABLED', '引擎已被禁用（ENGINE_ENABLED=false）');
  }
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const scene_id = toInt(body.scene_id, NaN);
    if (!Number.isFinite(scene_id) || scene_id <= 0) {
      return err(res, 400, 'INVALID_PARAM', 'scene_id 非法');
    }
    const parsed = parseEngineConfig(body);
    if ('error' in parsed) {
      return err(res, 400, 'INVALID_PARAM', parsed.error);
    }

    /** 场景是否存在 */
    const [scenes] = await pool.query<RowDataPacket[]>('SELECT id FROM scene WHERE id = ?', [scene_id]);
    if (scenes.length === 0) {
      return err(res, 400, 'INVALID_PARAM', `scene_id=${scene_id} 不存在`);
    }

    /** 场景下是否有 NPC */
    const [cntRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM scene_npc WHERE scene_id = ?',
      [scene_id],
    );
    const npcCount = Number((cntRows as { c: number }[])[0]?.c ?? 0);
    if (npcCount === 0) {
      return err(res, 422, 'NO_NPC_IN_SCENE', '场景下无关联 NPC');
    }

    /** 幂等：已在跑则返回当前状态 */
    let scheduler = getScheduler(scene_id);
    if (scheduler && scheduler.isRunning) {
      attachMetaWarnHeader(res, scheduler);
      return res.json({ code: 0, data: withWsEndpoint(scheduler.status()) });
    }

    scheduler = createScheduler(scene_id, parsed);
    await scheduler.start();
    attachMetaWarnHeader(res, scheduler);
    return res.json({ code: 0, data: withWsEndpoint(scheduler.status()) });
  } catch (e) {
    console.error('startEngine:', e);
    return err(res, 500, 'INTERNAL', (e as Error).message || '启动失败');
  }
}

/** POST /api/engine/stop */
export async function stopEngine(req: Request, res: Response) {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const scene_id = toInt(body.scene_id, NaN);
    if (!Number.isFinite(scene_id) || scene_id <= 0) {
      return err(res, 400, 'INVALID_PARAM', 'scene_id 非法');
    }
    const force = body.force === true;
    const reason = typeof body.reason === 'string' ? body.reason : 'user';
    const scheduler = getScheduler(scene_id);
    if (!scheduler) {
      return res.json({ code: 0, data: { scene_id, running: false, tick: 0 } });
    }
    await scheduler.stop((reason as 'user' | 'error' | 'max_ticks') || 'user', force);
    const snap = scheduler.status();
    removeScheduler(scene_id);
    return res.json({ code: 0, data: snap });
  } catch (e) {
    console.error('stopEngine:', e);
    return err(res, 500, 'INTERNAL', (e as Error).message || '停止失败');
  }
}

/** GET /api/engine/status?scene_id= */
export async function getEngineStatus(req: Request, res: Response) {
  const scene_id = toInt(req.query.scene_id, NaN);
  if (!Number.isFinite(scene_id) || scene_id <= 0) {
    return err(res, 400, 'INVALID_PARAM', 'scene_id 非法');
  }
  const scheduler = getScheduler(scene_id);
  if (!scheduler) {
    return res.json({
      code: 0,
      data: withWsEndpoint({
        scene_id,
        running: false,
        tick: 0,
        started_at: null,
        last_tick_at: null,
        last_duration_ms: null,
        npc_count: 0,
        errors_recent: 0,
        cost_usd_total: 0,
        config: null,
        meta_warns: [],
      }),
    });
  }
  attachMetaWarnHeader(res, scheduler);
  return res.json({ code: 0, data: withWsEndpoint(scheduler.status()) });
}

/** GET /api/engine/ticks?scene_id=&after=&limit=&order= */
export async function getEngineTicks(req: Request, res: Response) {
  try {
    const scene_id = toInt(req.query.scene_id, NaN);
    if (!Number.isFinite(scene_id) || scene_id <= 0) {
      return err(res, 400, 'INVALID_PARAM', 'scene_id 非法');
    }
    const after = toInt(req.query.after, 0);
    const limit = Math.min(200, Math.max(1, toInt(req.query.limit, 50)));
    const order = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const where: string[] = ['scene_id = ?'];
    const params: unknown[] = [scene_id];
    if (after > 0) {
      where.push(order === 'ASC' ? 'tick > ?' : 'tick < ?');
      params.push(after);
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, scene_id, npc_id, tick, started_at, finished_at, status,
              input_summary, output_meta, duration_ms, error_message
       FROM npc_tick_log
       WHERE ${where.join(' AND ')}
       ORDER BY tick ${order}, id ${order}
       LIMIT ?`,
      [...params, limit],
    );
    return res.json({ code: 0, data: rows });
  } catch (e) {
    console.error('getEngineTicks:', e);
    return err(res, 500, 'INTERNAL', (e as Error).message || '查询失败');
  }
}

/** POST /api/engine/step  {scene_id} — 手动触发单次 tick（未启动则按 dry_run 临时创建） */
export async function stepEngine(req: Request, res: Response) {
  if (!isEngineEnabled()) {
    return err(res, 503, 'ENGINE_DISABLED', '引擎已被禁用');
  }
  const body = (req.body || {}) as Record<string, unknown>;
  const scene_id = toInt(body.scene_id, NaN);
  if (!Number.isFinite(scene_id) || scene_id <= 0) {
    return err(res, 400, 'INVALID_PARAM', 'scene_id 非法');
  }
  let scheduler = getScheduler(scene_id);
  if (!scheduler) {
    /** 临时创建（dry_run），仅跑一次 */
    scheduler = createScheduler(scene_id, {
      interval_ms: DEFAULT_INTERVAL,
      max_ticks: null,
      concurrency: 2,
      dry_run: body.dry_run !== false,
    });
  }
  await scheduler.stepOnce();
  attachMetaWarnHeader(res, scheduler);
  return res.json({ code: 0, data: withWsEndpoint(scheduler.status()) });
}
