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
  /**
   * [M4.2.3] 反思触发周期：tick % N === 0 触发一次反思（每个 NPC 独立判断）
   * - 0 = 关闭自动反思（仍支持 POST /api/engine/reflect 手动触发，M4.2.3.c）
   * - 默认 5：约 30s × 5 = 2.5min 一次，成本可控
   */
  REFLECT_EVERY_N_TICK: '5',
  /** [M4.2.3] 反思输入：从 npc_memory 按 created_at DESC 取最近 K 条（全 type） */
  REFLECT_RECENT_MEMORY_K: '20',
  /**
   * [M4.5.0 U-B] 记忆时间感：
   *   - true  = reflect 节点在 system prompt 追加【当前时段】一行，storeMemory 写入 npc_memory.slot_hour
   *   - false = 两处均跳过；列仍允许存在但写 NULL，完全回退 M4.4 行为
   */
  MEMORY_SLOT_HOUR_ENABLED: 'true',
  /** sync = 同步双写（拉票 Q3 a，默认）；async = fire-and-forget 留给 M4.2.5 */
  MEMORY_STORE_MODE: 'sync',
  /** 拉票 Q1 = a：prevSummary + 同场 NPC 名 */
  MEMORY_RETRIEVE_QUERY_MODE: 'prev_summary_plus_neighbors',
  /**
   * [M4.2.2.c] 指针式 embedding provider（Y2 方案）
   * - 空 / 0 = 不启用，embedText 复用 NPC 绑定的 chat ai_config（M4.2.2.a 行为）
   * - 正整数 = ai_config 表里一条记录的主键 id；retrieve/store 会按此 id 加载 api_key/base_url/provider
   *   并用 MEMORY_EMBED_MODEL 覆盖 model 字段（因为 ai_config.model 通常是 chat 模型名如 qwen-max）
   * - 典型场景：NPC chat 用 DeepSeek（无 embedding），embedding 另指通义千问/智谱这种支持 embedding 的 provider
   */
  MEMORY_EMBED_AI_CONFIG_ID: '0',
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
  /** [M4.2.3] 反思子系统配置（合并到 MemoryConfig 避免新建独立 config 文件） */
  reflection: {
    /** 0 = 关闭自动反思；>0 = tick % N === 0 触发一次 */
    everyNTick: number;
    /** 反思参考的最近 K 条 memory */
    recentMemoryK: number;
  };
  /** [M4.5.0 U-B] 记忆时间感总开关；false 时 reflect prompt / slot_hour 列均跳过 */
  slotHourEnabled: boolean;
  /**
   * [M4.2.2.c] Y2 指针式 embedding：ai_config 表的 id；0 = 禁用（fallback 到 chat aiCfg）
   */
  embedAiConfigId: number;
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
  /** 0 = 禁用指针（允许 0，不用 readInt 的 >0 校验） */
  const rawPtr = (process.env.MEMORY_EMBED_AI_CONFIG_ID ?? DEFAULTS.MEMORY_EMBED_AI_CONFIG_ID).trim();
  const embedAiConfigId = Number.parseInt(rawPtr || '0', 10);
  if (!Number.isFinite(embedAiConfigId) || embedAiConfigId < 0) {
    throw new Error(
      `[memory.config] MEMORY_EMBED_AI_CONFIG_ID 必须为 >=0 的整数，当前=${rawPtr}`,
    );
  }
  /** [M4.2.3] 反思 env 解析：允许 0（关闭），其余必须正整数 */
  const rawEvery = (process.env.REFLECT_EVERY_N_TICK ?? DEFAULTS.REFLECT_EVERY_N_TICK).trim();
  const reflectEveryN = Number.parseInt(rawEvery || '0', 10);
  if (!Number.isFinite(reflectEveryN) || reflectEveryN < 0) {
    throw new Error(`[memory.config] REFLECT_EVERY_N_TICK 必须为 >=0 的整数，当前=${rawEvery}`);
  }
  const reflectRecentK = readInt('REFLECT_RECENT_MEMORY_K');
  cached = {
    enabled: readBool('MEMORY_EMBED_ENABLED'),
    embedModel: readStr('MEMORY_EMBED_MODEL'),
    embedDim,
    topK: readInt('MEMORY_TOP_K'),
    retentionDays: readInt('MEMORY_RETENTION_DAYS'),
    storeMode,
    retrieveQueryMode: retrieveMode,
    embedAiConfigId,
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
    reflection: {
      everyNTick: reflectEveryN,
      recentMemoryK: reflectRecentK,
    },
    slotHourEnabled: readBool('MEMORY_SLOT_HOUR_ENABLED'),
  };
  return cached;
}

/** 测试专用：清缓存让下次 getMemoryConfig 重新解析 env */
export function resetMemoryConfig(): void {
  cached = null;
}
