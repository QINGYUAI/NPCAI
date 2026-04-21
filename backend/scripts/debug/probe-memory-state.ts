/**
 * [M4.2.2.c] 运维探针：npc_memory 表 + Qdrant collection 健康快照
 *
 * 用法
 *   cd backend && npx tsx scripts/debug/probe-memory-state.ts
 *
 * 输出
 *   - npc_memory 表的 embed_status 分布 + 最近 5 条概要
 *   - Qdrant collection 是否存在 / points_count / vector 维度
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

async function main() {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  const [cntRows] = await c.query(
    `SELECT embed_status, COUNT(*) AS cnt FROM npc_memory GROUP BY embed_status`,
  );
  const [recentRows] = await c.query(
    `SELECT id, npc_id, scene_id, tick, type, importance, embed_status,
            LEFT(content, 48) AS content_preview, created_at
       FROM npc_memory
       ORDER BY id DESC
       LIMIT 5`,
  );
  await c.end();
  console.log('=== npc_memory 分布 ===');
  console.log(JSON.stringify(cntRows, null, 2));
  console.log('=== 最近 5 条 ===');
  console.log(JSON.stringify(recentRows, null, 2));

  const qUrl = (process.env.QDRANT_URL || 'http://localhost:6333').replace(/\/$/, '');
  const qColl = process.env.QDRANT_COLLECTION || 'npc_memory';
  try {
    const resp = await fetch(`${qUrl}/collections/${qColl}`);
    const j: any = await resp.json();
    if (resp.ok) {
      console.log(`=== Qdrant collection "${qColl}" ===`);
      console.log(JSON.stringify({
        status: j.result?.status,
        points_count: j.result?.points_count,
        vectors_count: j.result?.vectors_count,
        vector_size: j.result?.config?.params?.vectors?.size,
        distance: j.result?.config?.params?.vectors?.distance,
      }, null, 2));
    } else {
      console.log(`=== Qdrant collection "${qColl}" ===`);
      console.log(`(不存在) HTTP=${resp.status}  body=${JSON.stringify(j).slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`=== Qdrant 请求失败 ===`);
    console.log((e as Error).message);
  }
}
main().catch((e) => { console.error('[probe] FAIL:', e); process.exit(1); });
