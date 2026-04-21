/**
 * M4.2 系列迁移（幂等）
 * 执行: npx tsx src/db/migrate-m42.ts
 *
 * 覆盖范围（随子里程碑逐步扩充）：
 *   - [M4.2.0] ai_config.budget_tokens_per_tick —— 每 NPC 每 tick token 预算
 *   - [M4.2.1.a] ai_call_log.prompt_tokens / completion_tokens / total_tokens / cost_usd
 *
 * 后续 M4.2.2 ~ M4.2.4 会在这里继续追加（npc_memory、npc_reflection、scene_event 等）
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

  /** M4.2.1.a：ai_call_log 追加 tokens / cost 列（真实观测性计费） */
  const aiCallLogCols: Array<{ name: string; ddl: string; comment: string }> = [
    { name: 'prompt_tokens', ddl: 'INT DEFAULT NULL', comment: '[M4.2.1.a] 输入 tokens（来自 provider usage 或本地 tiktoken 估算）' },
    { name: 'completion_tokens', ddl: 'INT DEFAULT NULL', comment: '[M4.2.1.a] 输出 tokens' },
    { name: 'total_tokens', ddl: 'INT DEFAULT NULL', comment: '[M4.2.1.a] 总 tokens = prompt + completion' },
    { name: 'cost_usd', ddl: 'DECIMAL(10,6) DEFAULT NULL', comment: '[M4.2.1.a] 本次调用费用（美元，硬编码单价表换算；未匹配模型为 NULL）' },
  ];
  for (const col of aiCallLogCols) {
    if (!(await hasColumn(conn, dbName, 'ai_call_log', col.name))) {
      await conn.query(
        `ALTER TABLE ai_call_log
           ADD COLUMN ${col.name} ${col.ddl}
           COMMENT ${JSON.stringify(col.comment)}`,
      );
      console.log(`✅ ai_call_log.${col.name} 已新增`);
    } else {
      console.log(`⏭  ai_call_log.${col.name} 已存在，跳过`);
    }
  }

  /** M4.2.1.a：ai_call_log 补一个 (source, created_at) 复合索引，scheduler 按 tick 聚合时更快 */
  const [idxRows] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'ai_call_log' AND INDEX_NAME = 'idx_source_created'`,
    [dbName],
  );
  if (Number((idxRows[0] as { c?: number } | undefined)?.c ?? 0) === 0) {
    await conn.query('ALTER TABLE ai_call_log ADD INDEX idx_source_created (source, created_at)');
    console.log('✅ ai_call_log.idx_source_created 已创建');
  } else {
    console.log('⏭  ai_call_log.idx_source_created 已存在，跳过');
  }

  await conn.end();
  console.log('✅ M4.2 迁移完成');
}

migrate().catch((e) => {
  console.error('❌ migrate-m42 失败:', e);
  process.exit(1);
});
