/**
 * [M4.2.2.c] embedding 专用 ai_config 解析器（Y2 指针式方案）
 *
 * 职责
 * - 读 MEMORY_EMBED_AI_CONFIG_ID，从 ai_config 表加载专用 embedding 凭据
 * - model 字段用 MEMORY_EMBED_MODEL 覆盖（ai_config.model 通常是 chat 模型名）
 * - 60s TTL 进程内缓存，避免每个 retrieve/store 打一次表
 * - 指针未配置 / 加载失败 → 返回 null，调用方自行 fallback 到 chat aiCfg
 *
 * 失败不抛错：任何查询异常（表不存在、记录 status=0 等）都记 warn 回落，
 * 确保 M4.2.2.a 既有行为（chat/embed 共用 aiCfg）仍是最后兜底
 */
import type { RowDataPacket } from 'mysql2';
import { pool } from '../../db/connection.js';
import { getMemoryConfig } from './config.js';

/** embedText 需要的最小 config 形状 */
export interface EmbedAiConfig {
  id: number;
  api_key: string;
  base_url: string | null;
  provider: string;
  /** embedding 专用 model；来自 env 覆盖，不是 ai_config.model */
  model: string;
}

/** 60 秒 TTL 缓存，避免并发 tick 反复查表 */
const TTL_MS = 60_000;
interface CacheEntry {
  value: EmbedAiConfig | null;
  expireAt: number;
}
let cache: CacheEntry | null = null;

/**
 * 解析 embedding 专用 ai_config；返回 null 表示未启用或加载失败，调用方回退 chat aiCfg
 *
 * @param force 跳过缓存（测试或热重载用）
 */
export async function resolveEmbedAiConfig(force = false): Promise<EmbedAiConfig | null> {
  const now = Date.now();
  if (!force && cache && cache.expireAt > now) return cache.value;

  const cfg = getMemoryConfig();
  if (!cfg.embedAiConfigId || cfg.embedAiConfigId <= 0) {
    cache = { value: null, expireAt: now + TTL_MS };
    return null;
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, provider, api_key, base_url, model, status
         FROM ai_config WHERE id = ? LIMIT 1`,
      [cfg.embedAiConfigId],
    );
    const list = rows as Array<{
      id: number;
      provider: string;
      api_key: string;
      base_url: string | null;
      model: string;
      status: number;
    }>;
    const row = list[0];
    if (!row) {
      console.warn(
        `[memory.embedAiConfig] MEMORY_EMBED_AI_CONFIG_ID=${cfg.embedAiConfigId} 在 ai_config 表中不存在，fallback 到 chat aiCfg`,
      );
      cache = { value: null, expireAt: now + TTL_MS };
      return null;
    }
    if (row.status !== 1) {
      console.warn(
        `[memory.embedAiConfig] ai_config id=${row.id} status=${row.status} (非启用)，fallback`,
      );
      cache = { value: null, expireAt: now + TTL_MS };
      return null;
    }
    if (!row.api_key?.trim()) {
      console.warn(
        `[memory.embedAiConfig] ai_config id=${row.id} api_key 为空，fallback`,
      );
      cache = { value: null, expireAt: now + TTL_MS };
      return null;
    }
    const resolved: EmbedAiConfig = {
      id: row.id,
      api_key: row.api_key,
      base_url: row.base_url,
      provider: row.provider,
      /** model 走 env 覆盖；ai_config.model 字段此刻被忽略（因其通常是 chat 模型名） */
      model: cfg.embedModel,
    };
    cache = { value: resolved, expireAt: now + TTL_MS };
    return resolved;
  } catch (e) {
    console.warn(
      `[memory.embedAiConfig] 加载 ai_config id=${cfg.embedAiConfigId} 失败，fallback：${(e as Error).message}`,
    );
    cache = { value: null, expireAt: now + TTL_MS };
    return null;
  }
}

/** 测试专用：清缓存 */
export function resetEmbedAiConfigCache(): void {
  cache = null;
}
