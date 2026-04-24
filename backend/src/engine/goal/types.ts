/**
 * [M4.5.1.a] 动态目标类型定义
 */

/** DB 枚举 kind：来源分类 */
export type GoalKind = 'scene' | 'player' | 'npc' | 'self';

/** DB 枚举 status：生命周期 */
export type GoalStatus = 'active' | 'paused' | 'done' | 'dropped';

/** REST / fetch 共用的目标实体；created_at / expires_at 使用 ISO string 统一对外 */
export interface GoalEntity {
  id: number;
  npc_id: number;
  title: string;
  kind: GoalKind;
  priority: number;
  status: GoalStatus;
  created_at: string;
  expires_at: string | null;
  payload: Record<string, unknown> | null;
}

/** 创建目标的输入；priority / kind / expires_in_seconds / payload 均为可选，走默认 */
export interface CreateGoalInput {
  npc_id: number;
  title: string;
  kind?: GoalKind;
  priority?: number;
  /** 相对过期秒数；优先级高于 expires_at（二选一）；0 = 永不过期 */
  expires_in_seconds?: number;
  /** 直接给绝对过期时间戳（ISO / Date） */
  expires_at?: string | Date | null;
  payload?: Record<string, unknown> | null;
}

/** PATCH /goals/:id 接受字段 */
export interface UpdateGoalInput {
  title?: string;
  kind?: GoalKind;
  priority?: number;
  status?: GoalStatus;
  /** 相对过期秒数；优先级高于 expires_at */
  expires_in_seconds?: number | null;
  expires_at?: string | Date | null;
  payload?: Record<string, unknown> | null;
}

/** 列表查询过滤条件 */
export interface ListGoalFilter {
  npc_id?: number;
  status?: GoalStatus;
  /** 最多返回条数，默认 50，上限 200 */
  limit?: number;
}
