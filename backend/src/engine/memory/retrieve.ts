/**
 * [M4.2.2.b] memory-retrieve 节点
 *
 * 定位
 * - 在 plan 节点之前运行：基于 prev_summary + 同场 NPC 名 构造 query → embed → Qdrant search
 *   → 反查 MySQL 取原文 → 注入后续 prompt 的「相关记忆」段
 * - 任何一步失败都走"空 entries + degraded=true"，决不阻断 tick
 *
 * 设计要点
 * - Q1 a 方案（锁定）：query = `${prevSummary} ${neighbors.join(' ')}`；零额外 LLM 成本
 * - Qdrant 不可达（QdrantUnavailableError）→ 降级 MySQL「importance DESC, created_at DESC」
 * - embedText 失败 → 连降级检索都跳过（因为我们不认为 MySQL 排序有足够价值时应付出一次 DB 查询）；
 *   目前保守做法：embed 失败 **也** 走 MySQL 排序，前端能感知到记忆为空 + warn
 * - 命中后异步更新 last_accessed_at + access_count+1（非阻塞）
 */
import type { RowDataPacket } from 'mysql2';
import { pool } from '../../db/connection.js';
import { embedText, type LogContext } from '../../utils/llmClient.js';
import type { NpcRow, SceneRow } from '../types.js';
import { getMemoryConfig } from './config.js';
import { getQdrantMemoryStore, QdrantUnavailableError } from './qdrantClient.js';
import type { MemoryEntry, MemoryType, RetrieveResult } from './types.js';

export interface RetrieveInput {
  scene: SceneRow;
  npc: NpcRow;
  neighbors: Array<{ id: number; name: string }>;
  /** 上一 tick 的 memory_summary（可为空） */
  prevSummary: string;
  tick: number;
  /** chatCompletion 用到的 ai_config（embedText 复用同一套 api_key / base_url / provider） */
  aiCfg: { id?: number; api_key: string; base_url: string | null; provider: string };
  signal?: AbortSignal;
  /** 给 llmClient 做统计用（embed 也会产生 ai_call_log） */
  onMetrics?: (m: { total_tokens: number; cost_usd: number | null }) => void;
}

/** 组装 query 文本；保持短（<=400 字符），避免 embedding 8000 截断损语义 */
function buildQueryText(input: RetrieveInput): string {
  const parts: string[] = [];
  if (input.prevSummary?.trim()) parts.push(input.prevSummary.trim());
  const neighborNames = input.neighbors.map((n) => n.name).filter(Boolean);
  if (neighborNames.length) parts.push(neighborNames.join(' '));
  /** 都空时用 NPC+场景兜底，保证 embed 输入非空 */
  if (parts.length === 0) parts.push(`${input.npc.name} ${input.scene.name}`);
  return parts.join(' ').slice(0, 400);
}

export async function retrieveMemories(input: RetrieveInput): Promise<RetrieveResult> {
  const cfg = getMemoryConfig();

  /** 全局开关：MEMORY_EMBED_ENABLED=false 时跳过（用于本地调试或 provider 不支持 embeddings） */
  if (!cfg.enabled) {
    return { entries: [], degraded: false };
  }

  if (input.signal?.aborted) return { entries: [], degraded: false };

  const queryText = buildQueryText(input);
  const topK = cfg.topK;
  const logContext: LogContext = {
    source: 'engine.memory.retrieve',
    ai_config_id: input.aiCfg.id,
    context: {
      scene_id: input.scene.id,
      npc_id: input.npc.id,
      tick: input.tick,
      node: 'memory-retrieve',
    },
  };

  let vector: number[] | null = null;
  try {
    const emb = await embedText(input.aiCfg, queryText, {
      logContext,
      timeout: 8000,
    });
    vector = emb.vector;
  } catch (e) {
    /** embed 失败：保守走 MySQL 降级（让调用方能收到 entries，但标记 degraded） */
    console.warn(
      `[memory.retrieve] embedText 失败，降级 MySQL：${(e as Error)?.message ?? e}`,
    );
  }

  if (input.signal?.aborted) return { entries: [], degraded: true };

  /** 主路径：Qdrant 有向量 → 语义检索 */
  if (vector) {
    const store = getQdrantMemoryStore();
    try {
      const hits = await store.search(input.npc.id, vector, topK);
      if (hits.length === 0) {
        return { entries: [], degraded: false };
      }
      const ids = hits.map((h) => h.id);
      const entries = await fetchMemoriesByIds(ids);
      /** 按 Qdrant 返回顺序（相关度降序）重排 MySQL 反查结果 */
      const byId = new Map(entries.map((e) => [e.id, e]));
      const ordered = ids.map((id) => byId.get(id)).filter((e): e is MemoryEntry => !!e);
      /** 非阻塞更新 access 统计 */
      void touchAccess(ids).catch((err) => {
        console.warn('[memory.retrieve] touchAccess 失败（忽略）：', (err as Error).message);
      });
      return { entries: ordered, degraded: false };
    } catch (e) {
      if (e instanceof QdrantUnavailableError) {
        console.warn(`[memory.retrieve] Qdrant 不可达，降级 MySQL：${e.message}`);
      } else {
        console.warn(`[memory.retrieve] Qdrant 异常，降级 MySQL：${(e as Error).message}`);
      }
      /** 继续走降级 */
    }
  }

  /** 降级路径：MySQL importance 排序 */
  const fallback = await fetchFallbackMemories(input.npc.id, topK);
  return { entries: fallback, degraded: true };
}

/** 批量反查原文；列数和 npc_memory 表结构对齐 */
async function fetchMemoriesByIds(ids: number[]): Promise<MemoryEntry[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, npc_id, scene_id, tick, type, content, importance, created_at
       FROM npc_memory
      WHERE id IN (${placeholders})`,
    ids,
  );
  return (rows as RowDataPacket[]).map(rowToEntry);
}

/** 降级：无语义检索，按 importance DESC, created_at DESC 取 top-K */
async function fetchFallbackMemories(npcId: number, topK: number): Promise<MemoryEntry[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, npc_id, scene_id, tick, type, content, importance, created_at
       FROM npc_memory
      WHERE npc_id = ?
      ORDER BY importance DESC, created_at DESC
      LIMIT ?`,
    [npcId, topK],
  );
  return (rows as RowDataPacket[]).map(rowToEntry);
}

function rowToEntry(row: RowDataPacket): MemoryEntry {
  return {
    id: Number(row.id),
    npc_id: Number(row.npc_id),
    scene_id: row.scene_id == null ? null : Number(row.scene_id),
    tick: row.tick == null ? null : Number(row.tick),
    type: String(row.type) as MemoryType,
    content: String(row.content ?? ''),
    importance: Number(row.importance ?? 5),
    created_at: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

/** 异步触发：更新 last_accessed_at + access_count+1；失败静默（不影响主路径） */
async function touchAccess(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await pool.query(
    `UPDATE npc_memory
        SET last_accessed_at = NOW(3),
            access_count = access_count + 1
      WHERE id IN (${placeholders})`,
    ids,
  );
}
