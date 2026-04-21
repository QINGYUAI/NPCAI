/**
 * [M4.2.3.b live smoke] 查看 npc_reflection 最新数据 + memory_id 回填率
 * 执行：npx tsx scripts/debug/probe-reflections-data.ts
 */
import 'dotenv/config';
import mysql, { type RowDataPacket } from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ainpc',
  });

  const [totalRows] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c,
            SUM(CASE WHEN memory_id IS NOT NULL THEN 1 ELSE 0 END) AS linked
       FROM npc_reflection`,
  );
  const total = totalRows[0] as { c: number; linked: number } | undefined;
  console.log('=== 总体 ===');
  console.log(`  rows=${total?.c ?? 0}  memory_id 回填=${total?.linked ?? 0}`);

  const [byTick] = await conn.query<RowDataPacket[]>(
    `SELECT npc_id, tick, COUNT(*) AS cnt,
            GROUP_CONCAT(theme ORDER BY theme SEPARATOR ',') AS themes
       FROM npc_reflection
      GROUP BY npc_id, tick
      ORDER BY tick DESC, npc_id
      LIMIT 10`,
  );
  console.log('\n=== 最近 10 组 (npc, tick) 反思分布 ===');
  for (const row of byTick as RowDataPacket[]) {
    console.log(
      `  npc=${row.npc_id}  tick=${row.tick}  cnt=${row.cnt}  themes=[${row.themes}]`,
    );
  }

  const [latest] = await conn.query<RowDataPacket[]>(
    `SELECT id, npc_id, tick, theme, LEFT(content, 80) AS preview,
            memory_id, JSON_LENGTH(source_memory_ids) AS src_cnt
       FROM npc_reflection
      ORDER BY id DESC
      LIMIT 9`,
  );
  console.log('\n=== 最新 9 条反思 ===');
  for (const row of latest as RowDataPacket[]) {
    console.log(
      `  #${row.id} npc=${row.npc_id} tick=${row.tick} ${row.theme.padEnd(8)} memory_id=${row.memory_id ?? '-'} src=${row.src_cnt}`,
    );
    console.log(`    ${row.preview}...`);
  }

  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
