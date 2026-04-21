/**
 * [M4.2.2] 记忆子系统配置与 env 解析
 *
 * 职责
 * - 集中解析 MEMORY_* / QDRANT_* / EMBED_CACHE_* 环境变量并做类型兜底
 * - 启动期硬校验：MEMORY_EMBED_DIM 必须 === QDRANT_VECTOR_SIZE，错配直接 throw
 * - 所有 getter 都是 pure function + 懒加载（process.env 可被测试覆写）
 *
 * 非职责
 * - 不负责读写数据库 / 调用 LLM / 调用 Qdrant；仅提供纯配置
 */
const DEFAULTS = {
  MEMORY_EMBED_ENABLED: 'true',
  MEMORY_EMBED_MODEL: 'text-embedding-3-small',
  MEMORY_EMBED_DIM: '1536',
  MEMORY_TOP_K: '5',
  MEMORY_RETENTION_DAYS: '30',
  /** sync = 同步双写（拉票 Q3 a，默认）；async = fire-and-forget 留给 M4.2.5 */
  MEMORY_STORE_MODE: 'sync',
  /** 拉票 Q1 = a：prevSummary + 同场 NPC 名 */
  MEMORY_RETRIEVE_QUERY_MODE: 'prev_summary_plus_neighbors',
  QDRANT_URL: 'http://localhost:6333',
  QDRANT_API_KEY: '',
  QDRANT_COLLECTION: 'npc_memory',
  QDRANT_VECTOR_SIZE: '1536',
  EMBED_CACHE_ENABLED: 'true',
  EMBED_CACHE_TTL_DAYS: '30',
  EMBED_CACHE_DIR: '.cache/embed',
} as const;

function readStr(key: keyof typeof DEFAULTS): string {
  const v = process.env[key];
  return (v && v.trim()) || DEFAULTS[key];
}
function readBool(key: keyof typeof DEFAULTS): boolean {
  return readStr(key).toLowerCase() === 'true';
}
function readInt(key: keyof typeof DEFAULTS): number {
  const n = Number.parseInt(readStr(key), 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`[memory.config] env ${key} 必须是正整数，当前=${readStr(key)}`);
  }
  return n;
}

export interface MemoryConfig {
  enabled: boolean;
  embedModel: string;
  embedDim: number;
  topK: number;
  retentionDays: number;
  storeMode: 'sync' | 'async';
  retrieveQueryMode: 'prev_summary_plus_neighbors' | 'prev_summary_only';
  qdrant: {
    url: string;
    apiKey: string | undefined;
    collection: string;
    vectorSize: number;
  };
  embedCache: {
    enabled: boolean;
    ttlDays: number;
    dir: string;
  };
}

let cached: MemoryConfig | null = null;

/** 解析并校验；启动期调用触发校验，后续调用走缓存。测试可 resetMemoryConfig() 刷新 */
export function getMemoryConfig(): MemoryConfig {
  if (cached) return cached;
  const embedDim = readInt('MEMORY_EMBED_DIM');
  const vectorSize = readInt('QDRANT_VECTOR_SIZE');
  if (embedDim !== vectorSize) {
    throw new Error(
      `[memory.config] MEMORY_EMBED_DIM(${embedDim}) !== QDRANT_VECTOR_SIZE(${vectorSize})；` +
      '换模型须重建 Qdrant collection',
    );
  }
  const storeMode = readStr('MEMORY_STORE_MODE');
  if (storeMode !== 'sync' && storeMode !== 'async') {
    throw new Error(`[memory.config] MEMORY_STORE_MODE 仅支持 sync|async，当前=${storeMode}`);
  }
  const retrieveMode = readStr('MEMORY_RETRIEVE_QUERY_MODE');
  if (retrieveMode !== 'prev_summary_plus_neighbors' && retrieveMode !== 'prev_summary_only') {
    throw new Error(
      `[memory.config] MEMORY_RETRIEVE_QUERY_MODE 仅支持 prev_summary_plus_neighbors|prev_summary_only，当前=${retrieveMode}`,
    );
  }
  cached = {
    enabled: readBool('MEMORY_EMBED_ENABLED'),
    embedModel: readStr('MEMORY_EMBED_MODEL'),
    embedDim,
    topK: readInt('MEMORY_TOP_K'),
    retentionDays: readInt('MEMORY_RETENTION_DAYS'),
    storeMode,
    retrieveQueryMode: retrieveMode,
    qdrant: {
      url: readStr('QDRANT_URL'),
      apiKey: readStr('QDRANT_API_KEY') || undefined,
      collection: readStr('QDRANT_COLLECTION'),
      vectorSize,
    },
    embedCache: {
      enabled: readBool('EMBED_CACHE_ENABLED'),
      ttlDays: readInt('EMBED_CACHE_TTL_DAYS'),
      dir: readStr('EMBED_CACHE_DIR'),
    },
  };
  return cached;
}

/** 测试专用：清缓存让下次 getMemoryConfig 重新解析 env */
export function resetMemoryConfig(): void {
  cached = null;
}
