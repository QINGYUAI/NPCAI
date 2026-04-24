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
   * ─────────────────── [M4.5.1.a] npc_goal 动态目标表 ───────────────────
   * 拉票 Q3=a：独立 `npc_goal` 表（与 `npc_schedule` 职责正交）
   *   - 字段组合 = (npc_id, kind, title, priority, status, created_at, expires_at, payload JSON)
   *   - 索引设计：
   *       · (npc_id, status)          —— 查 active goal 的主路径（ORDER BY priority DESC LIMIT 1）
   *       · (expires_at)              —— 懒过期扫描 / 后台 cron 批量切 done
   *       · (npc_id, status, priority) —— 可选优化，插入/维护成本比上面两个低一档
   *   - 无 seed：goal 由 REST 或未来 scene_event 派生创建；空表是正常状态
   *   - 不加外键：沿用 npc_schedule 风格，便于冷启动 / 数据迁移时宽容
   */
  console.log('\n📦 M4.5.1.a npc_goal 建表迁移开始');
  if (await hasTable(conn, dbName, 'npc_goal')) {
    console.log('⏭  npc_goal 表已存在，跳过建表');
  } else {
    await conn.query(`
      CREATE TABLE npc_goal (
        id          BIGINT PRIMARY KEY AUTO_INCREMENT,
        npc_id      BIGINT NOT NULL COMMENT 'NPC 主键（不加外键，便于冷启动）',
        title       VARCHAR(128) NOT NULL COMMENT '目标短文本，直接注入 plan prompt',
        kind        ENUM('scene','player','npc','self') NOT NULL DEFAULT 'player'
                    COMMENT '来源：场景事件 / 玩家下发 / 其他 NPC 驱动 / 自主产生',
        priority    TINYINT NOT NULL DEFAULT 8 COMMENT '1..10；与 schedule.priority 同轴比较',
        status      ENUM('active','paused','done','dropped') NOT NULL DEFAULT 'active',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at  DATETIME DEFAULT NULL COMMENT '到期自动切 done；NULL 表示手动关闭',
        payload     JSON DEFAULT NULL COMMENT '附加上下文：target_npc_id / target_location / 进度等',
        INDEX idx_npc_goal_npc_status (npc_id, status),
        INDEX idx_npc_goal_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COMMENT='[M4.5.1.a] NPC 动态目标（覆盖 schedule）；REST / scene_event 均可创建'
    `);
    console.log('✅ npc_goal 表已创建');
  }

  await conn.end();
  console.log('\n✅ M4.5 迁移完成');
}

migrate().catch((e) => {
  console.error('❌ migrate-m45 失败:', e);
  process.exit(1);
});
