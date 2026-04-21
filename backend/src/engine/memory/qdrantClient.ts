/**
 * [M4.2.2] Qdrant 客户端封装（记忆向量主存储）
 *
 * 设计要点
 * - 不直接依赖 `@qdrant/js-client-rest` 的全部 API，只暴露引擎需要的 4 个方法：
 *   ensureCollection / upsert / search / deleteByIds / health
 * - 每个方法内部 timeout=3s + 1 次重试；失败抛 QdrantUnavailableError，让调用方降级
 * - point_id 使用 npc_memory.id (BIGINT)，与 Qdrant 的 unsigned integer id 对齐
 * - payload 字段严格：{ npc_id, scene_id?, type, importance, tick?, created_at }
 *
 * 不做的事
 * - 不做批量 upsert（M4.2.5 再做）
 * - 不做 rate-limit 退避（本地 Docker 无限流）
 */
import { QdrantClient } from '@qdrant/js-client-rest';
import { getMemoryConfig } from './config.js';

export class QdrantUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'QdrantUnavailableError';
  }
}

export interface MemoryPayload {
  npc_id: number;
  scene_id?: number | null;
  type: 'observation' | 'dialogue' | 'reflection' | 'event' | 'manual';
  importance: number;
  tick?: number | null;
  /** unix ms */
  created_at: number;
}

export interface SearchHit {
  id: number;
  score: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_RETRY = 1;

export class QdrantMemoryStore {
  private readonly client: QdrantClient;
  private readonly collection: string;
  private readonly vectorSize: number;
  private collectionEnsured = false;

  constructor(opts?: { url?: string; apiKey?: string; collection?: string; vectorSize?: number }) {
    const cfg = getMemoryConfig();
    this.client = new QdrantClient({
      url: opts?.url ?? cfg.qdrant.url,
      apiKey: opts?.apiKey ?? cfg.qdrant.apiKey,
      checkCompatibility: false,
    });
    this.collection = opts?.collection ?? cfg.qdrant.collection;
    this.vectorSize = opts?.vectorSize ?? cfg.qdrant.vectorSize;
  }

  /** 带超时 + 1 次重试的通用调用封装 */
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        return await this.timeboxed(fn);
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_RETRY) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
    throw new QdrantUnavailableError(`Qdrant ${label} 失败: ${(lastErr as Error)?.message ?? lastErr}`, lastErr);
  }

  private async timeboxed<T>(fn: () => Promise<T>): Promise<T> {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout ${DEFAULT_TIMEOUT_MS}ms`)), DEFAULT_TIMEOUT_MS),
      ),
    ]);
  }

  /** 快速健康检查；不抛错，返回 boolean 供启动期与降级判据使用 */
  async health(): Promise<boolean> {
    try {
      await this.timeboxed(async () => {
        await this.client.getCollections();
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 幂等创建 collection + payload 索引。
   * 已存在但配置冲突（向量维度不一致）会抛 QdrantUnavailableError，防止脏写
   */
  async ensureCollection(): Promise<void> {
    if (this.collectionEnsured) return;
    await this.withRetry('ensureCollection', async () => {
      const existsInfo = await this.client.getCollections();
      const found = existsInfo.collections.some((c) => c.name === this.collection);
      if (!found) {
        await this.client.createCollection(this.collection, {
          vectors: { size: this.vectorSize, distance: 'Cosine' },
        });
      } else {
        const info = await this.client.getCollection(this.collection);
        const vecCfg = (info.config?.params?.vectors ?? {}) as Record<string, unknown>;
        const existingSize =
          typeof vecCfg.size === 'number'
            ? vecCfg.size
            : typeof (vecCfg as { size?: number }).size === 'number'
              ? (vecCfg as { size: number }).size
              : undefined;
        if (existingSize && existingSize !== this.vectorSize) {
          throw new Error(
            `collection ${this.collection} 向量维度 ${existingSize} 与期望 ${this.vectorSize} 不一致`,
          );
        }
      }

      const indices: Array<[keyof MemoryPayload, 'integer' | 'keyword']> = [
        ['npc_id', 'integer'],
        ['scene_id', 'integer'],
        ['type', 'keyword'],
        ['importance', 'integer'],
      ];
      for (const [field, schema] of indices) {
        try {
          await this.client.createPayloadIndex(this.collection, {
            field_name: field as string,
            field_schema: schema,
          });
        } catch (e) {
          const msg = (e as Error)?.message ?? '';
          if (!/already exists|already indexed/i.test(msg)) {
            throw e;
          }
        }
      }
    });
    this.collectionEnsured = true;
  }

  /** 写入单条向量；payload 严格裁剪，避免透传意外字段到 Qdrant */
  async upsert(id: number, vector: number[], payload: MemoryPayload): Promise<void> {
    if (vector.length !== this.vectorSize) {
      throw new QdrantUnavailableError(
        `向量维度 ${vector.length} 与 collection ${this.vectorSize} 不一致`,
      );
    }
    await this.ensureCollection();
    await this.withRetry('upsert', async () => {
      await this.client.upsert(this.collection, {
        wait: true,
        points: [
          {
            id,
            vector,
            payload: this.sanitizePayload(payload),
          },
        ],
      });
    });
  }

  /**
   * 近邻搜索；filter 固定 npc_id 精确匹配（暂不暴露更多过滤器，本期够用）
   * 返回按相似度降序的 {id, score} 列表
   */
  async search(npcId: number, vector: number[], topK: number): Promise<SearchHit[]> {
    await this.ensureCollection();
    return await this.withRetry('search', async () => {
      const res = await this.client.search(this.collection, {
        vector,
        limit: topK,
        filter: {
          must: [{ key: 'npc_id', match: { value: npcId } }],
        },
        with_payload: false,
        with_vector: false,
      });
      return res.map((p) => ({ id: Number(p.id), score: p.score }));
    });
  }

  async deleteByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureCollection();
    await this.withRetry('deleteByIds', async () => {
      await this.client.delete(this.collection, { wait: true, points: ids });
    });
  }

  private sanitizePayload(p: MemoryPayload): Record<string, unknown> {
    const out: Record<string, unknown> = {
      npc_id: p.npc_id,
      type: p.type,
      importance: p.importance,
      created_at: p.created_at,
    };
    if (p.scene_id != null) out.scene_id = p.scene_id;
    if (p.tick != null) out.tick = p.tick;
    return out;
  }
}

/** 单例 + 测试可覆写 */
let singleton: QdrantMemoryStore | null = null;

export function getQdrantMemoryStore(): QdrantMemoryStore {
  if (!singleton) singleton = new QdrantMemoryStore();
  return singleton;
}

export function setQdrantMemoryStoreForTest(store: QdrantMemoryStore | null): void {
  singleton = store;
}
