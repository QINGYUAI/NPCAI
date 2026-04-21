/**
 * [M4.2.2.b] memory-store 节点
 *
 * 定位
 * - speak 节点产出 latest_say / latest_action 后、memory-summary 节点之前
 * - Q2 a 方案（锁定）：say / action 各一条独立 store 调用（非合并）
 * - Q3 a 方案（锁定）：sync 双写（MySQL 先 INSERT 拿 id → embed → Qdrant upsert → UPDATE status）
 *
 * 失败降级
 * - embedText 抛错 → MySQL 落库成功但 embed_status='failed'（由日后 cron 重嵌）
 * - Qdrant upsert 抛错 → MySQL 落库成功但 embed_status='pending'
 * - content 极短（<5 字符）或为空 → 直接 return，不入库、不报错
 * - 所有 catch 都在本节点内部吃掉，调用方（runGraph）永远拿到正常 Promise
 */
import type { ResultSetHeader } from 'mysql2';
import { pool } from '../../db/connection.js';
import { embedText, type LogContext } from '../../utils/llmClient.js';
import type { NpcRow, SceneRow } from '../types.js';
import { getMemoryConfig } from './config.js';
import { resolveEmbedAiConfig } from './embedAiConfig.js';
import { getQdrantMemoryStore, QdrantUnavailableError } from './qdrantClient.js';
import type { MemoryType, StoreResult } from './types.js';

export interface StoreInput {
  scene: SceneRow;
  npc: NpcRow;
  tick: number;
  /** 记忆类型；本期由调用方显式传入（observation / dialogue 为主） */
  type: MemoryType;
  /** 记忆原文，<=1000 字；超出本节点自动截断 */
  content: string;
  /** 显式重要度（调用方有把握时传入）；不传则规则打分 */
  importance?: number;
  aiCfg: { id?: number; api_key: string; base_url: string | null; provider: string };
  signal?: AbortSignal;
  onMetrics?: (m: { total_tokens: number; cost_usd: number | null }) => void;
}

const MIN_CONTENT_LEN = 5;
const MAX_CONTENT_LEN = 1000;

/**
 * 规则打分：本期 baseline；后期由 reflection LLM 接管。
 * - 类型权重：event(7) > reflection(6) > dialogue(5) > manual(5) > observation(3)
 * - 长度加分：>40 字 +1，>100 字 +1
 * - 感情强度：含 !/?/！/？ 各 +1
 * - clamp 到 [1, 10]
 */
export function ruleBasedImportance(content: string, type: MemoryType): number {
  const baseByType: Record<MemoryType, number> = {
    event: 7,
    reflection: 6,
    dialogue: 5,
    manual: 5,
    observation: 3,
  };
  let score = baseByType[type] ?? 5;
  const len = content.length;
  if (len > 40) score += 1;
  if (len > 100) score += 1;
  if (/[!?！？]/.test(content)) score += 1;
  return Math.min(10, Math.max(1, score));
}

export async function storeMemory(input: StoreInput): Promise<StoreResult> {
  const cfg = getMemoryConfig();

  /** 全局关闭 / content 空 / 过短：跳过，返回"未入库" */
  if (!cfg.enabled) return { id: null, embedded: false, status: null };
  const raw = (input.content ?? '').trim();
  if (raw.length < MIN_CONTENT_LEN) {
    return { id: null, embedded: false, status: null };
  }
  if (input.signal?.aborted) return { id: null, embedded: false, status: null };

  const content = raw.slice(0, MAX_CONTENT_LEN);
  const importance = input.importance ?? ruleBasedImportance(content, input.type);

  /** Step 1：MySQL INSERT with embed_status='pending'，拿到 id */
  let rowId: number;
  try {
    const [res] = await pool.execute<ResultSetHeader>(
      `INSERT INTO npc_memory
         (npc_id, scene_id, tick, type, content, importance, embed_status, embed_model)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)`,
      [input.npc.id, input.scene.id, input.tick, input.type, content, importance],
    );
    rowId = Number(res.insertId);
    if (!rowId) throw new Error('INSERT 返回 insertId=0');
  } catch (e) {
    /** MySQL 本身失败：放弃本条记忆（连 pending 状态都写不进去），但不抛错 */
    console.warn(`[memory.store] MySQL INSERT 失败：${(e as Error).message}`);
    return { id: null, embedded: false, status: null };
  }

  /**
   * [M4.2.2.c] Y2 指针式 embedding；和 retrieve 保持一致
   */
  const embedResolved = await resolveEmbedAiConfig();
  const embedCfg = embedResolved ?? input.aiCfg;
  const embedModelOverride = embedResolved?.model;

  const logContext: LogContext = {
    source: 'engine.memory.store',
    ai_config_id: embedResolved?.id ?? input.aiCfg.id,
    context: {
      scene_id: input.scene.id,
      npc_id: input.npc.id,
      tick: input.tick,
      node: 'memory-store',
      memory_id: rowId,
      type: input.type,
    },
  };

  /** Step 2：embed content → 向量 */
  let vector: number[] | null = null;
  let embedModel: string | null = null;
  try {
    const emb = await embedText(
      { api_key: embedCfg.api_key, base_url: embedCfg.base_url, provider: embedCfg.provider },
      content,
      {
        logContext,
        timeout: 8000,
        ...(embedModelOverride ? { model: embedModelOverride } : {}),
      },
    );
    vector = emb.vector;
    embedModel = emb.model;
  } catch (e) {
    console.warn(
      `[memory.store] embedText 失败（memory_id=${rowId}），embed_status=failed：${(e as Error).message}`,
    );
    await safeUpdateStatus(rowId, 'failed', null);
    return { id: rowId, embedded: false, status: 'failed' };
  }

  if (input.signal?.aborted) {
    /** signal 中断：已拿向量但未 upsert，保持 pending 让 cron 重试 */
    return { id: rowId, embedded: false, status: 'pending' };
  }

  /** Step 3：Qdrant upsert */
  try {
    const store = getQdrantMemoryStore();
    await store.upsert(rowId, vector, {
      npc_id: input.npc.id,
      scene_id: input.scene.id ?? null,
      type: input.type,
      importance,
      tick: input.tick ?? null,
      created_at: Date.now(),
    });
  } catch (e) {
    const kind = e instanceof QdrantUnavailableError ? '不可达' : '异常';
    console.warn(
      `[memory.store] Qdrant upsert ${kind}（memory_id=${rowId}），embed_status=pending：${(e as Error).message}`,
    );
    /** pending 而非 failed：向量已算好，后续 cron 只需 upsert；避免重复 embed 计费 */
    await safeUpdateStatus(rowId, 'pending', embedModel);
    return { id: rowId, embedded: false, status: 'pending' };
  }

  /** Step 4：UPDATE status=embedded */
  await safeUpdateStatus(rowId, 'embedded', embedModel);
  return { id: rowId, embedded: true, status: 'embedded' };
}

/** 状态更新出错不影响主流程，打 warn 即可 */
async function safeUpdateStatus(
  id: number,
  status: 'embedded' | 'pending' | 'failed',
  embedModel: string | null,
): Promise<void> {
  try {
    await pool.execute(
      `UPDATE npc_memory SET embed_status = ?, embed_model = ? WHERE id = ?`,
      [status, embedModel, id],
    );
  } catch (e) {
    console.warn(
      `[memory.store] 更新 npc_memory.embed_status=${status} 失败（id=${id}）：${(e as Error).message}`,
    );
  }
}
