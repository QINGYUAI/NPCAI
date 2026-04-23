/**
 * [M4.2.4.a] 事件总线共享类型
 *
 * 职责
 * - 定义 scene_event 表行、API 输入/输出、event-intake 节点的 IR 结构
 * - 供 prompts.ts（zod schema）、event-intake 节点、controllers、WS 事件复用
 *
 * 非职责
 * - 不直接暴露给前端；M4.2.4.c 前端会有独立 `frontend/src/types/event.ts`（字段保持一致即可）
 *
 * 约束
 * - type 锁定 4 枚举（拉票 Q3a），MySQL 层是 ENUM，应用层是字面量联合
 * - actor 自由字符串（拉票 Q4a），prompt 里直接拼读
 * - visible_npcs = null 表示全场景可见；数组表示定向投递（拉票 Q1a）
 */

/** 事件类型锁定 4 枚举；与 MySQL ENUM + zod schema 严格一致 */
export const EVENT_TYPES = ['weather', 'dialogue', 'system', 'plot'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * scene_event 表的行结构（MySQL RowDataPacket 解码后）
 * - `visible_npcs` / `payload` 解析后为 JS 对象（驱动会自动 JSON.parse）
 * - 插入时的 `id` 由 MySQL 自动分配；此类型用于读路径
 */
export interface SceneEventRow {
  id: number;
  scene_id: number;
  type: EventType;
  actor: string | null;
  content: string;
  payload: Record<string, unknown> | null;
  /** NULL=全场景可见；number[]=仅指定 NPC 可见（拉票 Q1a） */
  visible_npcs: number[] | null;
  created_at: Date | string;
  consumed_tick: number | null;
  /** [M4.3.0] tick 级 uuid v4；历史行为 NULL */
  trace_id?: string | null;
  /** [M4.3.1.a] 对话链 parent；NULL=起点，非 dialogue 恒为 NULL */
  parent_event_id?: number | null;
  /** [M4.3.1.a] 对话轮序；起点=1，每回复 +1；非 dialogue 恒为 NULL */
  conv_turn?: number | null;
}

/**
 * 注入 API 的入参（`POST /api/scene/:id/events` 的 body 对应字段）
 * - `scene_id` 来自 URL 路径参数，不在 body
 * - 所有字段做 zod trim + 长度/范围校验（见 prompts.ts 的 schema）
 */
export interface CreateSceneEventInput {
  type: EventType;
  content: string;
  /** 可选；最长 64 字（与 DB 列长一致），缺省 = 'system' */
  actor?: string | null;
  /** 可选结构化附加信息；<=2KB（JSON.stringify 后），超过直接 reject */
  payload?: Record<string, unknown> | null;
  /**
   * 可选；undefined/null = 全场景可见；数组 = 仅指定 NPC 可见
   * 传空数组 `[]` 视为「无人可见」（仍入库用于审计，但不会投递）
   */
  visible_npcs?: number[] | null;
}

/**
 * event-intake 节点的输出：单个 NPC 本 tick 实际要注入 prompt 的事件
 * - 经过 visible_npcs 过滤 + scene_event_consumed 去重 + maxPerTick 截断
 * - `id` 会进入 consumed 写回，供后续 tick 识别已消费
 */
export interface EventBlockItem {
  id: number;
  type: EventType;
  /** 处理过的自然语言描述；prompt 里直接拼 */
  content: string;
  /** 可空；存在则 prompt 里加 `[来自 {actor}]` 前缀 */
  actor: string | null;
  created_at: Date | string;
  /**
   * [M4.3.1.a] 对话链回溯字段（仅 dialogue 事件非空）
   *   - emitDialogueFromSay 需要在本 NPC 的 eventBlock 里找 `actor≠self 且 type==='dialogue'`
   *     的最新 dialogue event 作为 parent，所以要原样透传 conv_turn / parent_event_id
   *   - 非 dialogue 事件保持 null；pickEventsForNpc 侧只做字段透传，不做赋值
   */
  conv_turn?: number | null;
  parent_event_id?: number | null;
}

/**
 * event-intake 节点的全量返回（供 scheduler 做 consumed 写回与调试日志）
 * - status='injected'：至少 1 条事件被真实注入
 * - status='empty'：本 NPC 本 tick 无可消费事件（正常态，不计失败）
 * - status='skipped'：enabled=false / 传入 NPC 为空等配置原因短路
 * - status='failed'：DB 查询失败等异常；event-intake 内已吞，plan 仍正常跑（拉票 Q8a）
 */
export interface EventIntakeResult {
  status: 'injected' | 'empty' | 'skipped' | 'failed';
  items: EventBlockItem[];
  /** 本次要写回 scene_event_consumed 的 event.id 列表（=items.map(i=>i.id)） */
  consumed_ids: number[];
  /** 调试/观测：本次查询命中但被丢弃的事件（例如 visible_npcs 过滤失败 / 超 maxPerTick） */
  dropped_count: number;
}
