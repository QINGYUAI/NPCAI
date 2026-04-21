/**
 * 仅用于 M4.2.0 本地验收：把 NPC.simulation_meta.memory_summary 塞到 70KB
 * 这样 dry_run tick 时 nextMeta 会复用该字段，触发 scheduler.pushMetaWarn
 * 使用: npx tsx backend/scripts/tmp-seed-big-memory.ts 2 70000
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

async function main() {
  const id = Number(process.argv[2] || '2');
  const size = Number(process.argv[3] || '70000');
  const meta = {
    version: '1.0' as const,
    memory_summary: 'M4.2.0-acceptance-' + 'x'.repeat(size),
    plan: ['acceptance tick'],
  };
  const json = JSON.stringify(meta);
  console.log(`will write ${Buffer.byteLength(json, 'utf8')} bytes to npc.id=${id}`);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ainpc',
  });
  await conn.execute('UPDATE npc SET simulation_meta = ? WHERE id = ?', [json, id]);
  await conn.end();
  console.log(`✅ updated`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
