/**
 * [M4.3.0] trace_id 贯穿 + [M4.3.1.a] 对话链字段迁移（幂等）
 * 执行：npx tsx src/db/migrate-m43.ts  或  npm run db:migrate:m43
 *
 * 本文件拉票 Q8a 锁定：M4.3 全部子节点共用一个迁移文件，分段幂等 ALTER
 *
 * 本次（M4.3.0）变更
 *   - 5 张表新增 trace_id CHAR(36) DEFAULT NULL：
 *       · npc_tick_log / ai_call_log / scene_event / npc_memory / npc_reflection
 *   - 每表补 idx_<tbl>_trace 单列 B-tree 索引，支撑 `/api/engine/trace/:id` 快速回溯
 *   - 历史行不回填（保留 NULL）；查询层用 COALESCE(trace_id, '<legacy>') 分组
 *
 * 预留（M4.3.1.a 到来时在同一文件续写）
 *   - scene_event 再加 parent_event_id BIGINT / conv_turn INT
 *   - idx_scene_event_parent 索引
 *
 * 回滚
 *   - ALTER TABLE <tbl> DROP COLUMN trace_id;（索引会随列一并删）
 *   - 以单列 + 单索引为单位，零破坏性
 */
import 'dotenv/config';
import mysql, { type RowDataPacket } from 'mysql2/promise';

async function hasColumn(conn: mysql.Connection, dbName: string, table: string, column: string) {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`,
    [dbName, table, column],
  );
  return Number((rows[0] as { c?: number } | undefined)?.c ?? 0) > 0;
}

async function hasIndex(conn: mysql.Connection, dbName: string, table: string, index: string) {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=?`,
    [dbName, table, index],
  );
  return Number((rows[0] as { c?: number } | undefined)?.c ?? 0) > 0;
}

async function hasTable(conn: mysql.Connection, dbName: string, table: string) {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?`,
    [dbName, table],
  );
  return Number((rows[0] as { c?: number } | undefined)?.c ?? 0) > 0;
}

/** trace_id 迁移配置：5 张表统一处理 */
const TRACE_TABLES: Array<{ table: string; indexName: string; afterColumn?: string }> = [
  { table: 'npc_tick_log', indexName: 'idx_npc_tick_log_trace', afterColumn: 'error_message' },
  { table: 'ai_call_log', indexName: 'idx_ai_call_log_trace' },
  { table: 'scene_event', indexName: 'idx_scene_event_trace', afterColumn: 'consumed_tick' },
  { table: 'npc_memory', indexName: 'idx_npc_memory_trace', afterColumn: 'access_count' },
  { table: 'npc_reflection', indexName: 'idx_npc_reflection_trace', afterColumn: 'memory_id' },
];

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

  console.log('📦 M4.3.0 trace_id 贯穿迁移开始');
  for (const { table, indexName, afterColumn } of TRACE_TABLES) {
    if (!(await hasTable(conn, dbName, table))) {
      /** 前置迁移未跑：提示但不失败（允许只升级部分功能） */
      console.warn(`⏭  ${table} 表尚未创建，跳过 trace_id 扩展（请先跑对应 migrate 脚本）`);
      continue;
    }

    /** 列：存在则跳 */
    if (await hasColumn(conn, dbName, table, 'trace_id')) {
      console.log(`⏭  ${table}.trace_id 已存在，跳过`);
    } else {
      const afterClause = afterColumn ? ` AFTER ${afterColumn}` : '';
      await conn.query(
        `ALTER TABLE ${table}
           ADD COLUMN trace_id CHAR(36) DEFAULT NULL COMMENT '[M4.3.0] tick 级 uuid v4，用于跨表回溯'${afterClause}`,
      );
      console.log(`✅ ${table}.trace_id 列已添加`);
    }

    /** 索引：存在则跳；若列刚加但旧索引库里没有会自动建立 */
    if (await hasIndex(conn, dbName, table, indexName)) {
      console.log(`⏭  ${table}.${indexName} 已存在，跳过`);
    } else {
      await conn.query(`CREATE INDEX ${indexName} ON ${table}(trace_id)`);
      console.log(`✅ ${table}.${indexName} 索引已创建`);
    }
  }

  await conn.end();
  console.log('✅ M4.3.0 迁移完成');
}

migrate().catch((e) => {
  console.error('❌ migrate-m43 失败:', e);
  process.exit(1);
});
