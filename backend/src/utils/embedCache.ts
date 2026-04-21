/**
 * [M4.2.2] Embedding 磁盘缓存（拉票 Q4 = a）
 *
 * 存储策略
 * - 文件：<dir>/<sha1>.json = { model, created_at, dim, vector:number[] }
 * - key = sha1(model + '\n' + text.slice(0,8000))
 * - 进程级内存 LRU（默认 1000 条）避免重复磁盘 IO；miss 时懒加载
 * - 30 天 TTL（由 config 注入）；过期文件在 miss 时清理，写入时重置
 *
 * 不做的事
 * - 不做跨进程锁：写入用 `wx` + rename 防撕裂就够；并发写同一 key 最差情况是覆盖，内容等价
 * - 不做 GC 扫描：过期靠 miss 时惰性删除；需要全量清理请 `rm -rf .cache/embed`
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface EmbedCacheEntry {
  model: string;
  /** unix ms */
  created_at: number;
  dim: number;
  vector: number[];
}

export interface EmbedCacheOptions {
  dir: string;
  ttlDays: number;
  /** 进程内 LRU 容量，超出丢弃最早进入的 key */
  memoryCapacity?: number;
}

/** 简单 LRU：Map 按插入顺序迭代，命中时删再插以刷新时序 */
class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly capacity: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.capacity) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
  }
  delete(k: K): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}

export class EmbedCache {
  private readonly lru: LruMap<string, EmbedCacheEntry>;
  private readonly ttlMs: number;
  private readonly dir: string;
  private dirEnsured = false;

  constructor(opts: EmbedCacheOptions) {
    this.lru = new LruMap(opts.memoryCapacity ?? 1000);
    this.ttlMs = opts.ttlDays * 24 * 60 * 60 * 1000;
    this.dir = opts.dir;
  }

  /** 生成 key：sha1(model + '\n' + text.slice(0,8000)) */
  static hashKey(model: string, text: string): string {
    return createHash('sha1').update(model + '\n' + text.slice(0, 8000)).digest('hex');
  }

  private filePath(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await fs.mkdir(this.dir, { recursive: true });
    this.dirEnsured = true;
  }

  private isExpired(entry: EmbedCacheEntry): boolean {
    return Date.now() - entry.created_at > this.ttlMs;
  }

  /**
   * 读取：memory → disk；未命中/过期/model 不匹配均返回 null
   * 过期 / 模型漂移时顺手删除磁盘文件
   */
  async get(model: string, text: string): Promise<number[] | null> {
    const key = EmbedCache.hashKey(model, text);
    const memHit = this.lru.get(key);
    if (memHit && memHit.model === model && !this.isExpired(memHit)) {
      return memHit.vector;
    }
    try {
      const raw = await fs.readFile(this.filePath(key), 'utf8');
      const entry = JSON.parse(raw) as EmbedCacheEntry;
      if (entry.model !== model || this.isExpired(entry)) {
        await fs.unlink(this.filePath(key)).catch(() => void 0);
        this.lru.delete(key);
        return null;
      }
      this.lru.set(key, entry);
      return entry.vector;
    } catch {
      return null;
    }
  }

  /** 写入：内存 + 磁盘；磁盘失败不抛（缓存属于优化，不该影响主流程） */
  async set(model: string, text: string, vector: number[]): Promise<void> {
    const key = EmbedCache.hashKey(model, text);
    const entry: EmbedCacheEntry = {
      model,
      created_at: Date.now(),
      dim: vector.length,
      vector,
    };
    this.lru.set(key, entry);
    try {
      await this.ensureDir();
      const tmp = this.filePath(key) + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(entry), 'utf8');
      await fs.rename(tmp, this.filePath(key));
    } catch (e) {
      console.warn('[embedCache] 写磁盘失败，仅内存生效:', (e as Error).message);
    }
  }

  /** 测试专用：清空内存层 */
  clearMemory(): void {
    this.lru.clear();
  }

  /** 当前内存层大小（调试/测试用） */
  get memorySize(): number {
    return this.lru.size;
  }
}

/** 进程级单例（首次调用时按当前 config 构建） */
let singleton: EmbedCache | null = null;

export function getEmbedCache(opts?: EmbedCacheOptions): EmbedCache {
  if (!singleton) {
    if (!opts) throw new Error('[embedCache] 首次获取必须传入 opts（由 llmClient 代理传入 config）');
    singleton = new EmbedCache(opts);
  }
  return singleton;
}

/** 测试专用：重置单例 + 可选覆写 */
export function resetEmbedCache(next?: EmbedCache | null): void {
  singleton = next ?? null;
}
