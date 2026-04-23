/**
 * [M4.3.0] trace_id 贯穿 + [M4.3.1.a] 对话链字段迁移（幂等）
 * 执行：npx tsx src/db/migrate-m43.ts  或  npm run db:migrate:m43
 *
 * 本文件拉票 Q8a 锁定：M4.3 全部子节点共用一个迁移文件，分段幂等 ALTER
 *
 * M4.3.0 段
 *   - 5 张表新增 trace_id CHAR(36) DEFAULT NULL
 *   - idx_<tbl>_trace B-tree，支撑 `/api/engine/trace/:id`
 *
 * M4.3.1.a 段（本次续写）
 *   - scene_event 追加 parent_event_id BIGINT NULL（对话链 parent，NULL=起点）
 *   - scene_event 追加 conv_turn INT NULL（链上轮序：起点=1，每回复 +1；非 dialogue=NULL）
 *   - idx_scene_event_parent 单列索引，支撑「打开一条 say 查回复链」
 *   - 不加外键：M4.2 既有表风格一致（插入性能优先）
 *
 * 回滚
 *   - ALTER TABLE scene_event DROP COLUMN parent_event_id, DROP COLUMN conv_turn;
 *   - 所有列/索引零破坏性独立
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

  /**
   * [M4.3.1.a] scene_event 对话链字段：parent_event_id + conv_turn + idx_scene_event_parent
   *   - 历史行：parent_event_id=NULL，conv_turn=NULL；不回填
   *   - 新写入：dialogue 事件按 emitDialogueFromSay 逻辑写入真实值；其他事件保持 NULL
   */
  console.log('📦 M4.3.1.a 对话链字段迁移开始');
  if (!(await hasTable(conn, dbName, 'scene_event'))) {
    console.warn('⏭  scene_event 表尚未创建，跳过对话链字段扩展');
  } else {
    if (await hasColumn(conn, dbName, 'scene_event', 'parent_event_id')) {
      console.log('⏭  scene_event.parent_event_id 已存在，跳过');
    } else {
      await conn.query(
        `ALTER TABLE scene_event
           ADD COLUMN parent_event_id BIGINT DEFAULT NULL
           COMMENT '[M4.3.1.a] 对话链 parent event id；NULL=起点，非 dialogue 恒为 NULL'
           AFTER trace_id`,
      );
      console.log('✅ scene_event.parent_event_id 列已添加');
    }
    if (await hasColumn(conn, dbName, 'scene_event', 'conv_turn')) {
      console.log('⏭  scene_event.conv_turn 已存在，跳过');
    } else {
      await conn.query(
        `ALTER TABLE scene_event
           ADD COLUMN conv_turn INT DEFAULT NULL
           COMMENT '[M4.3.1.a] 对话轮序；起点=1，每回复 +1；非 dialogue 恒为 NULL'
           AFTER parent_event_id`,
      );
      console.log('✅ scene_event.conv_turn 列已添加');
    }
    if (await hasIndex(conn, dbName, 'scene_event', 'idx_scene_event_parent')) {
      console.log('⏭  scene_event.idx_scene_event_parent 已存在，跳过');
    } else {
      await conn.query(
        `CREATE INDEX idx_scene_event_parent ON scene_event(parent_event_id)`,
      );
      console.log('✅ scene_event.idx_scene_event_parent 索引已创建');
    }
  }

  await conn.end();
  console.log('✅ M4.3 迁移完成（0 + 1.a）');
}

migrate().catch((e) => {
  console.error('❌ migrate-m43 失败:', e);
  process.exit(1);
});
