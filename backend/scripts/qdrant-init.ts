/**
 * [M4.2.2] Qdrant collection 幂等初始化脚本
 * 执行：npm run qdrant:init
 *
 * 行为
 * - 先做一次 health() 探活；失败直接退出码 1 并给提示
 * - 幂等 ensureCollection()（不存在则建；已存在且维度冲突则抛）
 * - 打印最终 collection 配置供人工核对
 */
import 'dotenv/config';
import { QdrantMemoryStore } from '../src/engine/memory/qdrantClient.js';
import { getMemoryConfig } from '../src/engine/memory/config.js';

async function main() {
  const cfg = getMemoryConfig();
  console.log(`[qdrant:init] 目标 URL=${cfg.qdrant.url} collection=${cfg.qdrant.collection} dim=${cfg.qdrant.vectorSize}`);

  const store = new QdrantMemoryStore();
  const alive = await store.health();
  if (!alive) {
    console.error('❌ Qdrant 不可达，请先启动 docker: docker run -d -p 6333:6333 qdrant/qdrant');
    process.exit(1);
  }
  console.log('✅ health() ok');

  await store.ensureCollection();
  console.log('✅ ensureCollection() 完成（已存在则跳过创建；payload index 幂等）');

  // 打印当前 collection 元信息，便于运维人工核对
  try {
    const { QdrantClient } = await import('@qdrant/js-client-rest');
    const c = new QdrantClient({ url: cfg.qdrant.url, apiKey: cfg.qdrant.apiKey, checkCompatibility: false });
    const info = await c.getCollection(cfg.qdrant.collection);
    const vectors = info.config?.params?.vectors as Record<string, unknown> | undefined;
    console.log(
      `ℹ  collection 状态: points=${info.points_count ?? 0} vectors=${JSON.stringify(vectors ?? {})}`,
    );
  } catch (e) {
    console.warn('⚠  获取 collection 详情失败（不影响功能）:', (e as Error).message);
  }
}

main().catch((e) => {
  console.error('❌ qdrant:init 失败:', e);
  process.exit(1);
});
