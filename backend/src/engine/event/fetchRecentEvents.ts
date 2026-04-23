/**
 * [M4.2.4.b] 事件子系统 DB 查询工具（scheduler tick 头调用，scene 级一次查询 + 内存分发）
 *
 * 核心接口
 *   - fetchRecentSceneEvents：按 scene_id + lookbackSeconds 拉最近事件（不做可见性过滤，交给 intake）
 *   - fetchConsumedSet：一次查询拿到本批 (event_ids × npc_ids) 的已消费集合（返回 "event_id:npc_id" 字符串 Set）
 *   - writeConsumedBatch：批量插入 scene_event_consumed（INSERT IGNORE，幂等）
 *
 * 设计取舍（拉票 Q2b）
 *   - scheduler 一 tick 内只查 1 次事件 + 1 次 consumed，避免 N² 查询
 *   - visible_npcs / consumed 过滤完全在内存进行（见 intake.ts），SQL 走 idx_scene_time 命中率稳定
 *   - visible_npcs / payload 读出为 JS 值（mysql2 自动 JSON.parse），越界数据吞错返回 null
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../../db/connection.js';
import type { SceneEventRow, EventType } from './types.js';

/** DB 原始行（payload/visible_npcs 会被 mysql2 自动解析为 JS 对象/数组） */
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
  /** [M4.3.0] / [M4.3.1.a] / [M4.4.0] 扩字段，历史行为 NULL */
  trace_id: string | null;
  parent_event_id: number | null;
  conv_turn: number | null;
  created_tick: number | null;
}

/**
 * 把 DB 原始行转成 SceneEventRow：
 * - payload / visible_npcs 严格校验类型，非法值落成 null（防止 intake 崩溃）
 */
function normalizeRow(r: SceneEventDbRow): SceneEventRow {
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
    created_tick: r.created_tick ?? null,
  };
}

/**
 * [M4.4.0 Q2a] 混合窗口拉取某场景最近事件（按 created_at DESC）
 *
 * 混合窗口策略：
 *   - 时间窗：created_at > NOW() - lookbackSeconds 秒
 *   - 条数窗：最近 lookbackCount 条（按 id DESC，id 在 scene_event 里单调递增）
 *   - 两窗口取**并集**（UNION）：任一满足即返回 → 解 L-1（budget skip 拉长 tick 间隔致老事件 60s 外被丢）
 *   - lookbackCount = 0 时仅走纯时间窗（回 M4.3 行为）
 *
 * 参数：
 *   - `hardLimit` 是 SQL 层截断上限：防止极端场景下涌入成千上万事件把内存打爆
 *     典型值 = max(lookbackCount, maxPerTick × NPC 数量 × 2)；默认 500
 */
export async function fetchRecentSceneEvents(params: {
  scene_id: number;
  lookbackSeconds: number;
  lookbackCount?: number;
  hardLimit?: number;
}): Promise<SceneEventRow[]> {
  const { scene_id, lookbackSeconds } = params;
  const lookbackCount = params.lookbackCount && params.lookbackCount > 0 ? params.lookbackCount : 0;
  const hardLimit = params.hardLimit && params.hardLimit > 0 ? params.hardLimit : 500;

  /** 仅时间窗（lookbackCount=0）或关闭了条数窗，走 M4.3 单分支即可 */
  if (lookbackCount === 0) {
    const [rows] = await pool.query<SceneEventDbRow[]>(
      `SELECT id, scene_id, type, actor, content, payload, visible_npcs, created_at, consumed_tick,
              trace_id, parent_event_id, conv_turn, created_tick
         FROM scene_event
        WHERE scene_id = ?
          AND created_at > NOW(3) - INTERVAL ? SECOND
        ORDER BY created_at DESC
        LIMIT ?`,
      [scene_id, lookbackSeconds, hardLimit],
    );
    return rows.map(normalizeRow);
  }

  /**
   * 混合窗口：用 UNION DISTINCT 取时间窗 ∪ 条数窗
   * - 子查询 A：时间窗内
   * - 子查询 B：按 id DESC 取最近 lookbackCount 条
   * - 外层按 created_at DESC 再排 + hardLimit 截断
   */
  const [rows] = await pool.query<SceneEventDbRow[]>(
    `SELECT * FROM (
       (SELECT id, scene_id, type, actor, content, payload, visible_npcs, created_at, consumed_tick,
               trace_id, parent_event_id, conv_turn, created_tick
          FROM scene_event
         WHERE scene_id = ?
           AND created_at > NOW(3) - INTERVAL ? SECOND
         ORDER BY id DESC
         LIMIT ?)
       UNION DISTINCT
       (SELECT id, scene_id, type, actor, content, payload, visible_npcs, created_at, consumed_tick,
               trace_id, parent_event_id, conv_turn, created_tick
          FROM scene_event
         WHERE scene_id = ?
         ORDER BY id DESC
         LIMIT ?)
     ) u
     ORDER BY created_at DESC
     LIMIT ?`,
    [scene_id, lookbackSeconds, hardLimit, scene_id, lookbackCount, hardLimit],
  );
  return rows.map(normalizeRow);
}

/**
 * 查询 (event_ids × npc_ids) 的消费集合
 * - 返回 Set<`${event_id}:${npc_id}`>
 * - event_ids / npc_ids 任一为空 → 返回空 Set 不查 DB
 */
export async function fetchConsumedSet(params: {
  event_ids: number[];
  npc_ids: number[];
}): Promise<Set<string>> {
  const { event_ids, npc_ids } = params;
  const set = new Set<string>();
  if (event_ids.length === 0 || npc_ids.length === 0) return set;

  const evtPlaceholders = event_ids.map(() => '?').join(',');
  const npcPlaceholders = npc_ids.map(() => '?').join(',');
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT event_id, npc_id
       FROM scene_event_consumed
      WHERE event_id IN (${evtPlaceholders})
        AND npc_id IN (${npcPlaceholders})`,
    [...event_ids, ...npc_ids],
  );
  for (const r of rows as { event_id: number; npc_id: number }[]) {
    set.add(`${r.event_id}:${r.npc_id}`);
  }
  return set;
}

/**
 * 批量写入消费记录 + 同步更新首次消费 tick 号（调试用）
 * - INSERT IGNORE 保证幂等：重试或竞态写同样 (event_id, npc_id) 不报错
 * - consumed_tick：仅首次被任何 NPC 消费时写入（UPDATE ... WHERE consumed_tick IS NULL）
 * - pairs 为空直接 return，不发 SQL
 */
export async function writeConsumedBatch(params: {
  pairs: Array<{ event_id: number; npc_id: number }>;
  tick: number;
}): Promise<void> {
  const { pairs, tick } = params;
  if (pairs.length === 0) return;

  const values = pairs.map(() => '(?, ?, ?)').join(',');
  const args: (number)[] = [];
  for (const p of pairs) {
    args.push(p.event_id, p.npc_id, tick);
  }
  await pool.execute<ResultSetHeader>(
    `INSERT IGNORE INTO scene_event_consumed (event_id, npc_id, tick) VALUES ${values}`,
    args,
  );

  /** 首次消费 tick 标记：用最小 tick 覆盖 NULL；事件级聚合，同批写入使用同一 tick 即可 */
  const uniqueEventIds = Array.from(new Set(pairs.map((p) => p.event_id)));
  if (uniqueEventIds.length > 0) {
    const ph = uniqueEventIds.map(() => '?').join(',');
    await pool.execute<ResultSetHeader>(
      `UPDATE scene_event SET consumed_tick = ?
         WHERE id IN (${ph}) AND consumed_tick IS NULL`,
      [tick, ...uniqueEventIds],
    );
  }
}
