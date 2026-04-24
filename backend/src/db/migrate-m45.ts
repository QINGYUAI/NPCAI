/**
 * [M4.5.0] 记忆时间感 + 日程 soft window 迁移（幂等）
 * 执行：npx tsx src/db/migrate-m45.ts  或  npm run db:migrate:m45
 *
 * 本文件拉票 Q6=a 锁定：M4.5 所有子节点共用一个迁移文件，分段幂等 ALTER / CREATE
 *
 * M4.5.0 段（本次落地）
 *   - npc_memory 追加 slot_hour TINYINT NULL
 *       · 用途：U-B 记忆带时间感；冗余列便于后续按时段做 RAG 过滤
 *       · 历史行：NULL；新写入由 storeMemory(input.slotHour) / reflect 反哺时填入
 *   - idx_npc_memory_npc_slot 复合索引（npc_id, slot_hour）便于按时段检索
 *
 * M4.5.1.a 段（后续批次续写占位）
 *   - 新表 npc_goal(id, npc_id, title, kind, priority, status, expires_at, payload, ...)
 *
 * 回滚
 *   - ALTER TABLE npc_memory DROP COLUMN slot_hour;
 *   - DROP TABLE npc_goal;
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

  console.log('📦 M4.5.0 npc_memory.slot_hour 迁移开始');
  if (!(await hasTable(conn, dbName, 'npc_memory'))) {
    console.warn('⏭  npc_memory 表尚未创建，跳过 slot_hour 扩展（请先跑 M4.2.2 迁移）');
  } else {
    if (await hasColumn(conn, dbName, 'npc_memory', 'slot_hour')) {
      console.log('⏭  npc_memory.slot_hour 已存在，跳过');
    } else {
      await conn.query(
        `ALTER TABLE npc_memory
           ADD COLUMN slot_hour TINYINT DEFAULT NULL
           COMMENT '[M4.5.0 U-B] 产生此记忆时 NPC 所处的时段 hour（0..23，已考虑 soft window）'`,
      );
      console.log('✅ npc_memory.slot_hour 列已添加');
    }
    if (await hasIndex(conn, dbName, 'npc_memory', 'idx_npc_memory_npc_slot')) {
      console.log('⏭  npc_memory.idx_npc_memory_npc_slot 已存在，跳过');
    } else {
      await conn.query(
        `CREATE INDEX idx_npc_memory_npc_slot ON npc_memory(npc_id, slot_hour)`,
      );
      console.log('✅ npc_memory.idx_npc_memory_npc_slot 索引已创建');
    }
  }

  /**
   * ─────────────────── [M4.5.1.a] npc_goal 表 占位 ───────────────────
   * 本文件 M4.5.0 阶段仅建 npc_memory.slot_hour；
   * 动态目标系统的数据层（npc_goal 建表 + seed skip）将在 M4.5.1.a 批次续写到此处。
   */

  await conn.end();
  console.log('\n✅ M4.5 迁移完成');
}

migrate().catch((e) => {
  console.error('❌ migrate-m45 失败:', e);
  process.exit(1);
});
