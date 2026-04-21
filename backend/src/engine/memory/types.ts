/**
 * [M4.2.2.b] 记忆子系统共享类型定义
 *
 * 职责
 * - 定义 memory-retrieve / memory-store 节点通用的数据结构
 * - 与 Qdrant payload 字段（qdrantClient.MemoryPayload）对齐，但这里是"业务侧"表达
 *
 * 非职责
 * - 不定义 Qdrant wire-level 结构（那在 qdrantClient.ts）
 */

/** 记忆条目的类型枚举（与 npc_memory.type 列 + Qdrant payload.type 严格一致） */
export type MemoryType = 'observation' | 'dialogue' | 'reflection' | 'event' | 'manual';

/** 从 MySQL 反查回来、或降级时直接查出的一条记忆（带原文） */
export interface MemoryEntry {
  id: number;
  npc_id: number;
  scene_id: number | null;
  tick: number | null;
  type: MemoryType;
  content: string;
  importance: number;
  created_at: Date;
}

/** memory-retrieve 节点返回结构 */
export interface RetrieveResult {
  /** 已按相关度（Qdrant 成功）或重要度（MySQL 降级）排序 */
  entries: MemoryEntry[];
  /**
   * 是否走了降级路径：
   * - Qdrant 不可达 → true
   * - embedText 失败导致直接空返回 → true
   * - Qdrant 正常 → false
   */
  degraded: boolean;
}

/** memory-store 节点返回结构 */
export interface StoreResult {
  /** MySQL 行 id（同时是 Qdrant point_id）；内容过短直接跳过时为 null */
  id: number | null;
  /** 是否写入了 Qdrant；MySQL 落库但 embed/upsert 失败时为 false */
  embedded: boolean;
  /**
   * 对应 npc_memory.embed_status 的最终取值；外部只读用于调试
   * - 'embedded': 完整双写成功
   * - 'pending': MySQL OK 但 Qdrant 未写成功（网络/重试均失败）
   * - 'failed': embedText 本身失败
   * - null: 未入库（content 过短等）
   */
  status: 'embedded' | 'pending' | 'failed' | null;
}
