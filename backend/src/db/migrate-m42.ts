/**
 * M4.2 系列迁移（幂等）
 * 执行: npx tsx src/db/migrate-m42.ts
 *
 * 覆盖范围（随子里程碑逐步扩充）：
 *   - [M4.2.0] ai_config.budget_tokens_per_tick —— 每 NPC 每 tick token 预算
 *
 * 后续 M4.2.1 ~ M4.2.4 会在这里继续追加（ai_call_log tokens、npc_memory、npc_reflection、scene_event 等）
 */
import 'dotenv/config';
import mysql, { type RowDataPacket } from 'mysql2/promise';

/** 工具：检查列是否已存在（幂等迁移核心） */
async function hasColumn(
  conn: mysql.Connection,
  dbName: string,
  table: string,
  column: string,
): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column],
  );
  return Number((rows[0] as { c?: number } | undefined)?.c ?? 0) > 0;
}

async function migrate() {
  const dbName = process.env.DB_NAME || 'ainpc';
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: dbName,
    multipleStatements: true,
  });

  /** M4.2.0：ai_config 追加 budget_tokens_per_tick */
  if (!(await hasColumn(conn, dbName, 'ai_config', 'budget_tokens_per_tick'))) {
    await conn.query(
      `ALTER TABLE ai_config
         ADD COLUMN budget_tokens_per_tick INT DEFAULT 2000
         COMMENT '[M4.2.0] 每 NPC 每 tick 的 token 预算上限；超支下一 tick 自动 skip'`,
    );
    console.log('✅ ai_config.budget_tokens_per_tick 已新增');
  } else {
    console.log('⏭  ai_config.budget_tokens_per_tick 已存在，跳过');
  }

  await conn.end();
  console.log('✅ M4.2 迁移完成');
}

migrate().catch((e) => {
  console.error('❌ migrate-m42 失败:', e);
  process.exit(1);
});
