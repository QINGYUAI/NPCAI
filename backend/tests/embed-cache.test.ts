/**
 * [M4.2.2.a] Embed 磁盘缓存单测
 * - 同 (model, text) 二次读命中：第二次直接返回向量且 memorySize>0
 * - 换模型不命中：同文本不同 model → cache miss
 * - 过期条目被删除（构造 ttlDays=0 让任何写入立刻过期）
 * - hashKey 稳定：同入参 → 同输出；不同入参 → 不同输出
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { EmbedCache } from '../src/utils/embedCache.js';

async function mkTmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ainpc-embed-cache-'));
  return dir;
}

describe('[M4.2.2.a] EmbedCache', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkTmpDir();
  });

  it('hashKey 对相同 model+text 稳定，对不同入参不同', () => {
    const a = EmbedCache.hashKey('text-embedding-3-small', 'hello');
    const b = EmbedCache.hashKey('text-embedding-3-small', 'hello');
    const c = EmbedCache.hashKey('text-embedding-3-large', 'hello');
    const d = EmbedCache.hashKey('text-embedding-3-small', 'hello!');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it('同 model+text 二次读命中磁盘缓存', async () => {
    const cache = new EmbedCache({ dir, ttlDays: 30 });
    const vec = Array.from({ length: 1536 }, (_, i) => (i % 7) * 0.01);
    await cache.set('text-embedding-3-small', 'hello world', vec);
    cache.clearMemory();
    const hit = await cache.get('text-embedding-3-small', 'hello world');
    expect(hit).not.toBeNull();
    expect(hit!.length).toBe(1536);
    expect(hit![0]).toBeCloseTo(vec[0]!);
  });

  it('换模型不命中（相同文本不同 model）', async () => {
    const cache = new EmbedCache({ dir, ttlDays: 30 });
    const vec = Array.from({ length: 8 }, () => 0.5);
    await cache.set('text-embedding-3-small', 'text', vec);
    const miss = await cache.get('text-embedding-3-large', 'text');
    expect(miss).toBeNull();
  });

  it('ttl=0 时任何条目立刻过期并被删除', async () => {
    const cache = new EmbedCache({ dir, ttlDays: 0 });
    const vec = [0.1, 0.2, 0.3];
    await cache.set('m', 'x', vec);
    const hit = await cache.get('m', 'x');
    expect(hit).toBeNull();
  });

  it('memorySize 在命中/未命中时正确变化', async () => {
    const cache = new EmbedCache({ dir, ttlDays: 30 });
    expect(cache.memorySize).toBe(0);
    await cache.set('m', 'a', [1, 2, 3]);
    expect(cache.memorySize).toBe(1);
    cache.clearMemory();
    expect(cache.memorySize).toBe(0);
    const hit = await cache.get('m', 'a');
    expect(hit).not.toBeNull();
    expect(cache.memorySize).toBe(1);
  });
});
