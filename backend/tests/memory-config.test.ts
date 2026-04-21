/**
 * [M4.2.2.a] memory/config.ts 单测
 * - getMemoryConfig 默认值正确
 * - MEMORY_EMBED_DIM !== QDRANT_VECTOR_SIZE 时 throw
 * - MEMORY_STORE_MODE 非法值时 throw
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getMemoryConfig, resetMemoryConfig } from '../src/engine/memory/config.js';

// 保存并恢复全部相关环境变量，避免污染其他 test
const KEYS = [
  'MEMORY_EMBED_ENABLED',
  'MEMORY_EMBED_MODEL',
  'MEMORY_EMBED_DIM',
  'MEMORY_TOP_K',
  'MEMORY_RETENTION_DAYS',
  'MEMORY_STORE_MODE',
  'MEMORY_RETRIEVE_QUERY_MODE',
  'QDRANT_URL',
  'QDRANT_API_KEY',
  'QDRANT_COLLECTION',
  'QDRANT_VECTOR_SIZE',
  'EMBED_CACHE_ENABLED',
  'EMBED_CACHE_TTL_DAYS',
  'EMBED_CACHE_DIR',
] as const;

describe('[M4.2.2.a] memory.config', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    resetMemoryConfig();
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetMemoryConfig();
  });

  it('默认值符合细设 v0.2', () => {
    const cfg = getMemoryConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.embedModel).toBe('text-embedding-3-small');
    expect(cfg.embedDim).toBe(1536);
    expect(cfg.qdrant.vectorSize).toBe(1536);
    expect(cfg.topK).toBe(5);
    expect(cfg.storeMode).toBe('sync');
    expect(cfg.retrieveQueryMode).toBe('prev_summary_plus_neighbors');
    expect(cfg.qdrant.collection).toBe('npc_memory');
    expect(cfg.embedCache.enabled).toBe(true);
  });

  it('MEMORY_EMBED_DIM 与 QDRANT_VECTOR_SIZE 不一致时抛错', () => {
    process.env.MEMORY_EMBED_DIM = '1536';
    process.env.QDRANT_VECTOR_SIZE = '3072';
    expect(() => getMemoryConfig()).toThrow(/MEMORY_EMBED_DIM/);
  });

  it('MEMORY_STORE_MODE 非 sync|async 时抛错', () => {
    process.env.MEMORY_STORE_MODE = 'turbo';
    expect(() => getMemoryConfig()).toThrow(/MEMORY_STORE_MODE/);
  });

  it('MEMORY_EMBED_ENABLED=false 时 enabled=false，仍可正常返回其他字段', () => {
    process.env.MEMORY_EMBED_ENABLED = 'false';
    const cfg = getMemoryConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.embedModel).toBe('text-embedding-3-small');
  });
});
