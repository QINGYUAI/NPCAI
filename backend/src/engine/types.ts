/**
 * 引擎模块类型定义
 */

export interface EngineConfig {
  /** tick 间隔 ms */
  interval_ms: number;
  /** 最大 tick 数；达到后自动 stop */
  max_ticks: number | null;
  /** 单 tick 内 NPC 并发推理数 */
  concurrency: number;
  /** 跳过 LLM 调用，仅走图结构（用于自测） */
  dry_run: boolean;
}

export interface EngineStatus {
  scene_id: number;
  running: boolean;
  tick: number;
  started_at: string | null;
  last_tick_at: string | null;
  last_duration_ms: number | null;
  npc_count: number;
  errors_recent: number;
  cost_usd_total: number;
  config: EngineConfig;
  /**
   * [M4.2.0] 最近 N 条 simulation_meta 软阈值越界告警
   * - 仅记录最近 20 条，溢出自动滚动
   * - 有任意一条在最近 5 分钟内写入时，REST 响应会带 `X-Meta-Warn: 1`
   */
  meta_warns: MetaWarn[];
  /**
   * [M4.2.1.b] WebSocket 订阅地址（相对路径）；未启用 WS 时不返回该字段
   * 前端据此优先走 WS，不支持则回落 3s 轮询
   */
  ws_endpoint?: string;
  /**
   * [M4.2.2.b] 记忆检索近期是否发生过降级（Qdrant 不可达 / embed 失败）
   * - 最近 5 分钟内有过任一 NPC 的 retrieve.degraded=true 即为 true
   * - 前端可据此在 UI 上展示"🧠 降级"提示（M4.2.2.c 才接 UI）
   * - 不影响功能，仅是可观测性信号
   */
  memory_degraded?: boolean;
}

/** [M4.2.0] simulation_meta 超软阈值告警记录 */
export interface MetaWarn {
  scene_id: number;
  npc_id: number;
  npc_name?: string;
  tick: number;
  bytes: number;
  soft_limit: number;
  at: string;
}

/** 单次 tick 对某 NPC 的产出，写入 simulation_meta 与 npc_tick_log */
export interface NpcTickOutput {
  npc_id: number;
  status: 'success' | 'error' | 'skipped';
  meta: SimulationMetaV1 | null;
  input_summary: string;
  duration_ms: number;
  error_message?: string;
}

/** simulation_meta v1.0 约定字段 */
export interface SimulationMetaV1 {
  version: '1.0';
  last_tick_at: string;
  latest_say?: string | null;
  latest_action?: string | null;
  emotion?: string | null;
  plan?: string[];
  memory_summary?: string | null;
  relations?: Record<string, string>;
  debug?: Record<string, unknown>;
}

/**
 * [M4.2.1.b] 事件总线消息（向后兼容扩展）
 * - `tick.npc.updated` 增补 status / duration_ms / tokens / cost_usd / meta_summary（时间线所需最小集）
 * - 新增 `meta.warn`：scheduler pushMetaWarn 时同步广播，前端即刻闪烁徽章（不等 3s 轮询）
 * - `tick.end` 增补 cost_usd_total，用于时间线滚动窗口的顶栏累计
 *
 * [M4.3.0] 全部成员新增可选 `trace_id?: string | null`
 *   - scheduler 在 tick 顶部生成后随 bus event 贯穿，wsServer.serializeEvent 透传给前端
 *   - 非 scheduler 触发路径（如 POST /api/scene/:id/events 手动注入）允许为 null/undefined
 */
export type TickEvent =
  | { type: 'tick.start'; scene_id: number; tick: number; at: string; trace_id?: string | null }
  | {
      type: 'tick.npc.updated';
      scene_id: number;
      tick: number;
      npc_id: number;
      npc_name?: string;
      meta: SimulationMetaV1;
      status?: 'success' | 'error' | 'skipped';
      duration_ms?: number;
      tokens?: { prompt: number; completion: number; total: number };
      cost_usd?: number | null;
      trace_id?: string | null;
    }
  | {
      type: 'tick.end';
      scene_id: number;
      tick: number;
      duration_ms: number;
      cost_usd_total?: number;
      trace_id?: string | null;
    }
  | {
      type: 'error';
      scene_id: number;
      tick: number;
      npc_id?: number;
      message: string;
      trace_id?: string | null;
    }
  | {
      type: 'meta.warn';
      scene_id: number;
      tick: number;
      npc_id: number;
      npc_name?: string;
      bytes: number;
      soft_limit: number;
      at: string;
      trace_id?: string | null;
    }
  /**
   * [M4.2.3.b] 反思生成事件
   * - 仅在 reflect 节点 status='generated' 时广播（skipped/failed 不广播）
   * - items 固定 3 条（goal/emotion/relation 各一），content 已被 zod 截到 <=200 字
   * - reflection_ids 对应 npc_reflection.id，与 items 同下标
   */
  | {
      type: 'reflection.created';
      scene_id: number;
      tick: number;
      npc_id: number;
      npc_name?: string;
      items: Array<{ theme: 'goal' | 'emotion' | 'relation'; content: string }>;
      reflection_ids: number[];
      source_memory_ids: number[];
      at: string;
      trace_id?: string | null;
    }
  /**
   * [M4.2.4.b] 场景事件创建广播（POST /api/scene/:id/events 成功后同步 emit）
   * - 前端多客户端同步 + 单客户端 POST caller 直接拿到 id 用于本地呈现
   * - wsServer.serializeEvent 走默认分支直接 JSON.stringify；不做摘要（事件本体已被 500 字 + 2KB payload 约束）
   * - actor / payload / visible_npcs 字段与 scene_event 行结构完全对齐，前端可直接入 ring buffer
   */
  | {
      type: 'scene.event.created';
      scene_id: number;
      event_id: number;
      event_type: 'weather' | 'dialogue' | 'system' | 'plot';
      actor: string | null;
      content: string;
      payload: Record<string, unknown> | null;
      visible_npcs: number[] | null;
      at: string;
      trace_id?: string | null;
      /** [M4.3.1.a] dialogue 回复链 parent；非 dialogue / 会话起点 = null */
      parent_event_id?: number | null;
      /** [M4.3.1.a] 对话轮序；起点=1，每回复 +1；非 dialogue = null */
      conv_turn?: number | null;
    };

/** 从数据库加载的 NPC 行（推理图节点所需最小集合） */
export interface NpcRow {
  id: number;
  name: string;
  personality: string | null;
  system_prompt: string | null;
  simulation_meta: unknown;
  ai_config_id: number;
}

export interface SceneRow {
  id: number;
  name: string;
  description: string | null;
  width: number;
  height: number;
}
