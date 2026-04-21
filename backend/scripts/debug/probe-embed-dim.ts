/**
 * [M4.2.2.c] 运维探针：真实调用 DashScope(text-embedding-v1) 验证凭据 + 向量维度
 *
 * 用法
 *   cd backend && npx tsx scripts/debug/probe-embed-dim.ts
 *
 * 输出
 *   provider/base_url/model/dim/usage 的一行 JSON；dim 必须 === QDRANT_VECTOR_SIZE（默认 1536）
 *
 * 安全
 * - 不打印完整 api_key，仅长度 + 前 6 位
 * - 只读，不触碰 Qdrant / npc_memory
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { PROVIDER_BASE_URLS } from '../../src/utils/providerDefaults.js';

async function main() {
  const id = Number(process.env.MEMORY_EMBED_AI_CONFIG_ID) || 0;
  if (!id) throw new Error('MEMORY_EMBED_AI_CONFIG_ID 未配置或=0');
  const model = process.env.MEMORY_EMBED_MODEL || 'text-embedding-v1';

  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  const [rows] = await c.query(
    'SELECT id,name,provider,base_url,api_key,status FROM ai_config WHERE id=? LIMIT 1',
    [id],
  );
  await c.end();
  const row = (rows as any[])[0];
  if (!row) throw new Error(`ai_config id=${id} 不存在`);
  if (row.status !== 1) throw new Error(`ai_config id=${id} status=${row.status} 非启用`);

  const base = (row.base_url || PROVIDER_BASE_URLS[row.provider] || '').replace(/\/$/, '');
  if (!base) throw new Error(`无法定位 base_url：provider=${row.provider}`);
  const url = base + '/embeddings';

  console.log(JSON.stringify({
    id: row.id, name: row.name, provider: row.provider,
    base, model,
    key_len: row.api_key.length, key_prefix: row.api_key.slice(0, 6),
    target_url: url,
  }, null, 2));

  const t0 = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${row.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: '通义千问 text-embedding-v1 维度探针（中英混杂 short）' }),
  });
  const json: any = await resp.json();
  const vec = json?.data?.[0]?.embedding;
  console.log(JSON.stringify({
    http: resp.status,
    model_returned: json.model,
    dim: Array.isArray(vec) ? vec.length : null,
    usage: json.usage,
    error: json.error?.message || null,
    latency_ms: Date.now() - t0,
  }, null, 2));
}

main().catch((e) => { console.error('[probe] FAIL:', e); process.exit(1); });
