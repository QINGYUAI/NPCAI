/**
 * [M4.2.4.b] event-intake 节点（纯函数 + scheduler 侧包装入口）
 *
 * 职责
 * - 给定某 NPC 在本 tick 的 (allEvents, consumedSet)，做 3 步过滤并产出 EventIntakeResult
 *   1) visible_npcs 过滤：NULL = 全场景可见；数组 = 只对指定 NPC 可见
 *   2) consumed 去重：Set 命中即剔除（已在过去 tick 消费过）
 *   3) 数量截断：按 created_at DESC 取前 maxPerTick 条，余下计入 dropped_count
 * - scheduler 调用 pickEventsForNpc 拿到每个 NPC 的 items + consumed_ids，用于 plan prompt 注入 + 写 consumed 表
 *
 * 非职责
 * - 不查 DB / 不写 DB：纯函数（见 fetchRecentEvents.ts 承担 IO）
 * - 不决定「节点是否被启用」：由 scheduler 根据 eventConfig.enabled 短路；本函数被调用即意味着启用
 *
 * 为什么是纯函数
 * - 单测无需 mock DB；且 scheduler tick 内调用 N 次（每 NPC 一次），复用一份 scene 级事件快照
 */
import { buildParentMap, isEchoBlocked, type EchoChainNode } from '../dialogue/echo.js';
import type { EventBlockItem, EventIntakeResult, SceneEventRow } from './types.js';

export interface PickEventsInput {
  /** 本 tick scheduler 预取的场景级事件快照（已按 created_at DESC 排序） */
  allEvents: SceneEventRow[];
  /** 本 NPC id */
  npc_id: number;
  /** 本批 (events × npcs) 已消费集合：`${event_id}:${npc_id}` */
  consumedSet: Set<string>;
  /** 单 NPC 单 tick 最多注入事件数 */
  maxPerTick: number;
  /**
   * [M4.3.1.a] 当前 NPC 名；用于过滤「自播 dialogue」
   *   - V2=b：actor 名称 === 本 NPC 名称 且 type==='dialogue' 的事件直接丢弃
   *   - 设计原因：避免 NPC A 下 tick 把自己 t-1 的话视作外部输入形成"自言自语循环"
   *   - undefined/null 时跳过该过滤（兼容老调用方 / 非 scheduler 入口）
   */
  self_actor_name?: string | null;
  /**
   * [M4.3.1.b] 回声保护上限（DialogueConfig.echoMaxTurn）
   *   - ≤0 / undefined 等价禁用（放行所有，回退 M4.3.1.a 行为）
   *   - 生效时：dialogue candidate 若构成 (A,B,A,B,…) 交替链且 conv_turn ≥ N+1 即拦
   */
  echoMaxTurn?: number;
  /**
   * [M4.3.1.b] 可选预构 parent map；不传时 intake 内部基于 allEvents 构一份
   *   - scheduler 侧多 NPC 并行时可复用一份 map 降低重复开销
   *   - 单测可直接传裁剪 map 断言
   */
  parentMap?: Map<number, EchoChainNode>;
}

/**
 * 单 NPC 视角的事件筛选
 * - 输入快照为空 → status='empty'
 * - 按顺序执行：visible_npcs 过滤 → consumed 去重 → maxPerTick 截断
 * - 丢弃的条数（visible_npcs 不通过 / consumed 命中 / 超 maxPerTick）累加进 dropped_count
 */
export function pickEventsForNpc(input: PickEventsInput): EventIntakeResult {
  const {
    allEvents,
    npc_id,
    consumedSet,
    maxPerTick,
    self_actor_name,
    echoMaxTurn,
    parentMap,
  } = input;
  if (!allEvents || allEvents.length === 0) {
    return { status: 'empty', items: [], consumed_ids: [], dropped_count: 0 };
  }

  let dropped = 0;
  const passed: SceneEventRow[] = [];

  /**
   * [M4.3.1.b] 回声保护：仅当 echoMaxTurn>0 时启用
   *   - parentMap 未传则现场构建一次（scene 级单次开销，N² NPC 无额外放大）
   *   - 失败时降级：任何异常都 catch 住，视为"禁用"并 warn（§5.4）
   */
  const echoEnabled = typeof echoMaxTurn === 'number' && echoMaxTurn > 0;
  let echoMap: Map<number, EchoChainNode> | null = null;
  if (echoEnabled) {
    try {
      echoMap = parentMap ?? buildParentMap(allEvents);
    } catch (e) {
      console.warn(
        '[intake.echo] buildParentMap 失败，降级为放行：',
        (e as Error).message,
      );
      echoMap = null;
    }
  }

  for (const ev of allEvents) {
    /** 1) 可见性过滤：null = 全场景可见；数组需包含当前 npc_id（空数组等价「无人可见」） */
    if (ev.visible_npcs !== null) {
      if (!ev.visible_npcs.includes(npc_id)) {
        dropped += 1;
        continue;
      }
    }
    /**
     * 2) [M4.3.1.a V2=b] 自播 dialogue 过滤：actor === self_actor_name 的 dialogue 丢弃
     *    - 仅对 type==='dialogue' 生效；weather/system/plot 不受影响（NPC 广播非对话本就不合理，留个空间）
     *    - self_actor_name 未传则跳过本步骤，保持 M4.2 行为
     */
    if (
      self_actor_name &&
      ev.type === 'dialogue' &&
      ev.actor != null &&
      ev.actor === self_actor_name
    ) {
      dropped += 1;
      continue;
    }
    /** 3) 已消费去重：`${event_id}:${npc_id}` 命中即跳过 */
    if (consumedSet.has(`${ev.id}:${npc_id}`)) {
      dropped += 1;
      continue;
    }
    /**
     * 4) [M4.3.1.b] 回声保护：沿 parent 链若构成 (A,B,A,B,…) N+1 轮 → 拦
     *    - 仅 dialogue 走判定；echoMaxTurn ≤0 或 map 构建失败时完全跳过
     *    - 拦截 dropped++ 并结构化 warn（给运维看）；chain 超 N+1 时告警级别仍为 warn 不升级
     */
    if (
      echoEnabled &&
      echoMap &&
      ev.type === 'dialogue' &&
      isEchoBlocked({
        candidate: {
          id: ev.id,
          type: ev.type,
          actor: ev.actor,
          parent_event_id: ev.parent_event_id ?? null,
          conv_turn: ev.conv_turn ?? null,
        },
        byId: echoMap,
        echoMaxTurn: echoMaxTurn as number,
      })
    ) {
      dropped += 1;
      console.warn(
        `[intake.echo] 回声拦截 npc_id=${npc_id} event_id=${ev.id} actor=${ev.actor ?? '<null>'} conv_turn=${ev.conv_turn ?? '<null>'} cap=${echoMaxTurn}`,
      );
      continue;
    }
    passed.push(ev);
  }

  /** 3) 数量截断：DB 查询已保证 created_at DESC，这里直接 slice；超出计入 dropped */
  const topN = passed.slice(0, Math.max(0, maxPerTick));
  if (passed.length > topN.length) {
    dropped += passed.length - topN.length;
  }

  if (topN.length === 0) {
    return { status: 'empty', items: [], consumed_ids: [], dropped_count: dropped };
  }

  const items: EventBlockItem[] = topN.map((ev) => ({
    id: ev.id,
    type: ev.type,
    content: ev.content,
    actor: ev.actor,
    created_at: ev.created_at,
    /** [M4.3.1.a] 原样透传对话链字段，emit 时就地筛 parent，零额外 DB IO */
    conv_turn: ev.conv_turn ?? null,
    parent_event_id: ev.parent_event_id ?? null,
  }));

  return {
    status: 'injected',
    items,
    consumed_ids: items.map((i) => i.id),
    dropped_count: dropped,
  };
}
