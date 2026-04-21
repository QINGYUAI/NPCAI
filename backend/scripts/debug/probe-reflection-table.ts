/**
 * [M4.2.3.a] 运维探针：确认 npc_reflection 表结构 + 索引
 *
 * 用法
 *   cd backend && npx tsx scripts/debug/probe-reflection-table.ts
 *
 * 只读
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
  const [cols] = await c.query('SHOW FULL COLUMNS FROM npc_reflection');
  const [idx] = await c.query('SHOW INDEX FROM npc_reflection');
  const [cnt] = await c.query<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM npc_reflection',
  );
  await c.end();
  console.log('=== columns ===');
  console.log(JSON.stringify(cols, null, 2));
  console.log('=== indexes ===');
  const names = (idx as mysql.RowDataPacket[]).map((r) => `${r.Key_name}(${r.Column_name})`);
  console.log(JSON.stringify(names, null, 2));
  console.log('=== row count ===');
  console.log(cnt[0]?.total ?? 0);
}
main().catch((e) => { console.error('[probe] FAIL:', e); process.exit(1); });
