/**
 * [M4.2.2.c] 运维探针：列出 ai_config 全表（api_key 仅打印长度/前 6 位，不泄露完整 key）
 *
 * 用途
 * - 排查 MEMORY_EMBED_AI_CONFIG_ID 指针对应的记录是否存在、status 是否启用、api_key 是否有填
 * - 验证新接入的 embedding provider（如通义千问 text-embedding-v1）凭据状态
 *
 * 用法
 *   cd backend && npx tsx scripts/debug/probe-ai-config.ts
 *
 * 安全
 * - 只读，且 api_key 截断为长度 + 前 6 字符，日志里不会泄露完整凭据
 * - 不走 pool.ts，独立连接防止污染引擎连接池
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
  const [rows] = await c.query(
    `SELECT id, name, provider, base_url, model, max_tokens, budget_tokens_per_tick, status,
            LENGTH(api_key) AS key_len, SUBSTRING(api_key, 1, 6) AS key_prefix
       FROM ai_config ORDER BY id`,
  );
  console.log(JSON.stringify(rows, null, 2));
  await c.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
