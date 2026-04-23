/**
 * [M4.3.1.a] speak.latest_say → scene_event{type:'dialogue'} 自动注入
 *
 * 入口
 *   emitDialogueFromSay({ scene_id, actor, content, eventItems, trace_id })
 *     - actor 约定为 NPC.name（actor 在 scene_event 是自由字符串，与 NPC id 非强绑定）
 *     - eventItems 为本 NPC 本 tick 的 pickEventsForNpc 结果；用来就地筛 parent
 *     - 返回新写入的 event_id / parent_event_id / conv_turn；失败返回 null（不抛，不阻主链路）
 *
 * parent / conv_turn 推导（roadmap §5.1.1 + §5.2）
 *   - 在 eventItems 里筛 type==='dialogue' 且 actor!=null 且 actor!==self 的 dialogue
 *   - 取其中 conv_turn 最大值（并列时取 id 最大 = 最新）作为 parent
 *     · parent_event_id = 该事件 id；conv_turn = parent.conv_turn + 1
 *   - 若无满足条件 → parent=null，conv_turn=1（会话起点）
 *
 * 并发/失败策略
 *   - insert 失败 → console.warn + 返回 null；上游 build.ts 只读返回值做 log，不影响 storeMemory/reflect
 *   - bus.emitEvent 失败不会抛（bus 内部吞错）
 *   - DIALOGUE_AUTO_EVENT_ENABLED=false 时**本函数不应被调用**；双保险：若被调用则返回 null
 *
 * 与 M4.2.4 controllers/sceneEvents.ts 的关系
 *   - 两者共用 scene_event 表；字段集一致
 *   - 差别：这里不走 Express handler / zod schema；内部 insert + bus emit（等效于 createSceneEvent 去 HTTP 层）
 *   - 两者都用 bus.emitEvent('scene.event.created') 让 WS 同步广播
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../db/connection.js';
import { bus } from '../bus.js';
import type { EventBlockItem } from '../event/types.js';
import { getDialogueConfig } from './config.js';

export interface EmitDialogueInput {
  scene_id: number;
  /** 说话人 NPC 名（actor 字段在 scene_event 层是自由字符串） */
  actor: string;
  /** speakSchema.latest_say 原文；本函数会按 contentMaxLen 截断 */
  content: string;
  /** 本 NPC 本 tick 的 eventBlock items（用于筛 parent）；空数组/undefined = 视为无 parent */
  eventItems?: EventBlockItem[] | null;
  /** [M4.3.0] tick 级 trace_id；null 走 M4.2 行为（写 NULL） */
  trace_id?: string | null;
}

export interface EmitDialogueResult {
  event_id: number;
  parent_event_id: number | null;
  conv_turn: number;
  content: string;
}

/** 截断 + 加省略号；contentMaxLen 下限 1，超出原串长度则返回原串 */
function truncate(s: string, max: number): string {
  if (!s) return s;
  if (max <= 0) return s;
  if (s.length <= max) return s;
  /** -1 给省略号让位，保证总长严格等于 max */
  return s.slice(0, Math.max(1, max - 1)) + '…';
}

/**
 * 就地筛 parent：从 eventItems 里挑 actor!=self 的 dialogue，取 conv_turn 最大（并列取 id 最大）
 * - 返回 { parent_event_id, conv_turn } 或 { null, 1 }
 * - 纯函数，便于单测
 */
export function pickDialogueParent(
  items: EventBlockItem[] | null | undefined,
  self_actor: string,
): { parent_event_id: number | null; conv_turn: number } {
  if (!items || items.length === 0) {
    return { parent_event_id: null, conv_turn: 1 };
  }

  let best: EventBlockItem | null = null;
  for (const it of items) {
    if (it.type !== 'dialogue') continue;
    if (!it.actor || it.actor === self_actor) continue;
    if (!best) {
      best = it;
      continue;
    }
    const bestTurn = best.conv_turn ?? 0;
    const itTurn = it.conv_turn ?? 0;
    /** 先比 conv_turn，再比 id（id 越大越新） */
    if (itTurn > bestTurn || (itTurn === bestTurn && it.id > best.id)) {
      best = it;
    }
  }

  if (!best) {
    return { parent_event_id: null, conv_turn: 1 };
  }
  const parentTurn = best.conv_turn ?? 0;
  return { parent_event_id: best.id, conv_turn: parentTurn + 1 };
}

/**
 * 写 scene_event{type:'dialogue'} + 同步 WS 广播
 * - 失败（DB 异常 / 回读不到）一律 warn + 返回 null，不抛
 * - 配置 disabled 时返回 null 且不打 warn（调用方会读开关后短路，这里只是双保险）
 */
export async function emitDialogueFromSay(
  input: EmitDialogueInput,
): Promise<EmitDialogueResult | null> {
  const cfg = getDialogueConfig();
  if (!cfg.enabled) return null;

  const raw = String(input.content ?? '').trim();
  if (!raw) return null;
  const content = truncate(raw, cfg.contentMaxLen);

  const { parent_event_id, conv_turn } = pickDialogueParent(
    input.eventItems ?? null,
    input.actor,
  );

  try {
    const [ins] = await pool.execute<ResultSetHeader>(
      `INSERT INTO scene_event
         (scene_id, type, actor, content, payload, visible_npcs, trace_id, parent_event_id, conv_turn)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.scene_id,
        'dialogue',
        input.actor,
        content,
        null,
        /** V2=a: visible_npcs=NULL 同场全可见；自我过滤由 intake 侧 self_actor_name 实现 */
        null,
        input.trace_id ?? null,
        parent_event_id,
        conv_turn,
      ],
    );
    const event_id = Number(ins.insertId);

    /** 回读 created_at 给 WS 用（与 controllers/sceneEvents.ts 口径一致） */
    let created_at: Date | string = new Date();
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT created_at FROM scene_event WHERE id = ?`,
        [event_id],
      );
      const row = rows[0] as { created_at?: Date | string } | undefined;
      if (row?.created_at) created_at = row.created_at;
    } catch {
      /** 回读失败不影响主流程；WS 用本地 new Date() 做兜底 */
    }

    /** 同步 WS 广播；与 M4.2.4.b createSceneEvent 完全同构，前端无需区分来源 */
    bus.emitEvent({
      type: 'scene.event.created',
      scene_id: input.scene_id,
      event_id,
      event_type: 'dialogue',
      actor: input.actor,
      content,
      payload: null,
      visible_npcs: null,
      at: created_at instanceof Date ? created_at.toISOString() : String(created_at),
      /** [M4.3.0] WS 带 trace_id，便于前端时间线按 trace 归集 */
      trace_id: input.trace_id ?? null,
    });

    return { event_id, parent_event_id, conv_turn, content };
  } catch (e) {
    console.warn('[dialogue.emit] 写 scene_event 失败，降级不中断主链路:', (e as Error).message);
    return null;
  }
}
