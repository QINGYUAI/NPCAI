/**
 * 仅用于 M4.2.0 本地验收：绕过 express 100KB 限制，直接用 mysql 写入超过 256KB 的 simulation_meta
 * 用来验证前端硬阈值拦截效果
 * 使用: npx tsx backend/scripts/tmp-put-hard-meta.ts 2 280000
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

async function main() {
  const id = Number(process.argv[2] || '2');
  const size = Number(process.argv[3] || '280000');
  const payload = { pad: 'x'.repeat(size), note: 'hard-threshold-acceptance' };
  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json, 'utf8');
  console.log(`will write ${bytes} bytes to npc.id=${id}`);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ainpc',
  });
  await conn.execute('UPDATE npc SET simulation_meta = ? WHERE id = ?', [json, id]);
  await conn.end();
  console.log(`✅ updated npc.id=${id} simulation_meta to ${bytes} bytes`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
