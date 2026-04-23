/**
 * [M4.4.0] 对话链窗口治理 + [M4.4.1] NPC 日程 迁移（幂等）
 * 执行：npx tsx src/db/migrate-m44.ts  或  npm run db:migrate:m44
 *
 * 本文件拉票 Q6a 锁定：M4.4 全部子节点共用一个迁移文件，分段幂等 ALTER / CREATE
 *
 * M4.4.0 段（本次落地）
 *   - scene_event 追加 created_tick INT NULL
 *       · 用途：让 echo 判据按 tick 差（DIALOGUE_ECHO_WINDOW_TICK）精确判窗口（解 L-4）
 *       · 历史行：NULL；新写入由 emitDialogueFromSay / createSceneEvent 填充
 *   - idx_scene_event_created_tick 单列索引（便于按 tick 扫描 / 过期清理）
 *
 * M4.4.1 段（后续批次续写占位）
 *   - 新表 npc_schedule(id, npc_id, hour, activity, location, priority, updated_at)
 *   - seed 脚本：为现有 NPC 生成 24h 默认模板
 *
 * 回滚
 *   - ALTER TABLE scene_event DROP COLUMN created_tick;
 *   - DROP TABLE npc_schedule;
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

  console.log('📦 M4.4.0 scene_event.created_tick 迁移开始');
  if (!(await hasTable(conn, dbName, 'scene_event'))) {
    console.warn('⏭  scene_event 表尚未创建，跳过 created_tick 扩展（请先跑 M4.2.4 迁移）');
  } else {
    if (await hasColumn(conn, dbName, 'scene_event', 'created_tick')) {
      console.log('⏭  scene_event.created_tick 已存在，跳过');
    } else {
      await conn.query(
        `ALTER TABLE scene_event
           ADD COLUMN created_tick INT DEFAULT NULL
           COMMENT '[M4.4.0] 事件产生时的 tick 序号；用于 DIALOGUE_ECHO_WINDOW_TICK 精确判窗口'
           AFTER conv_turn`,
      );
      console.log('✅ scene_event.created_tick 列已添加');
    }
    if (await hasIndex(conn, dbName, 'scene_event', 'idx_scene_event_created_tick')) {
      console.log('⏭  scene_event.idx_scene_event_created_tick 已存在，跳过');
    } else {
      await conn.query(
        `CREATE INDEX idx_scene_event_created_tick ON scene_event(created_tick)`,
      );
      console.log('✅ scene_event.idx_scene_event_created_tick 索引已创建');
    }
  }

  await conn.end();
  console.log('✅ M4.4 迁移完成（0 段）');
}

migrate().catch((e) => {
  console.error('❌ migrate-m44 失败:', e);
  process.exit(1);
});
