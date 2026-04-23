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

  /**
   * ─────────────────── [M4.4.1.a] npc_schedule 表 + seed ───────────────────
   * 建表幂等：IF NOT EXISTS；seed 幂等：INSERT ... ON DUPLICATE KEY UPDATE（以 uk_npc_hour 为唯一键）
   * 默认模板（拉票 Q3=a 小时级 24 槽）：
   *   0..5   睡眠        | 卧室
   *   6..7   起床早餐    | 厨房
   *   8..11  工作/学习   | 书房
   *   12     午餐        | 餐厅
   *   13..17 工作/学习   | 书房
   *   18     晚餐        | 餐厅
   *   19..22 休闲/社交   | 客厅
   *   23     准备就寝    | 卧室
   */
  console.log('\n📦 M4.4.1.a npc_schedule 迁移开始');
  if (await hasTable(conn, dbName, 'npc_schedule')) {
    console.log('⏭  npc_schedule 表已存在，跳过建表');
  } else {
    await conn.query(`
      CREATE TABLE npc_schedule (
        id          BIGINT PRIMARY KEY AUTO_INCREMENT,
        npc_id      BIGINT NOT NULL COMMENT 'NPC 主键（不加外键，便于冷启动 seed）',
        hour        TINYINT NOT NULL COMMENT '0..23 小时槽',
        activity    VARCHAR(128) NOT NULL COMMENT '活动名，如 "工作"/"早餐"/"休闲"',
        location    VARCHAR(64) DEFAULT NULL COMMENT '地点提示；NULL 表示不限',
        priority    TINYINT DEFAULT 5 COMMENT '1..10 优先级；默认 5',
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_npc_hour (npc_id, hour),
        INDEX idx_npc_schedule_npc (npc_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COMMENT='[M4.4.1.a] NPC 24h 日程基线，供 plan 节点在无事件时驱动长期规划'
    `);
    console.log('✅ npc_schedule 表已创建');
  }

  /** seed：为现有所有 NPC 生成 24h 默认模板；幂等 ON DUPLICATE KEY UPDATE */
  const [npcRows] = await conn.query<RowDataPacket[]>('SELECT id FROM npc ORDER BY id');
  const npcs = (npcRows as Array<{ id: number }>).map((r) => Number(r.id));
  if (npcs.length === 0) {
    console.log('⏭  无 NPC，跳过 seed');
  } else {
    const template: Array<{ activity: string; location: string | null; priority?: number }> = [
      { activity: '睡眠', location: '卧室', priority: 3 }, // 0
      { activity: '睡眠', location: '卧室', priority: 3 }, // 1
      { activity: '睡眠', location: '卧室', priority: 3 }, // 2
      { activity: '睡眠', location: '卧室', priority: 3 }, // 3
      { activity: '睡眠', location: '卧室', priority: 3 }, // 4
      { activity: '睡眠', location: '卧室', priority: 3 }, // 5
      { activity: '起床早餐', location: '厨房', priority: 5 }, // 6
      { activity: '起床早餐', location: '厨房', priority: 5 }, // 7
      { activity: '工作', location: '书房', priority: 7 }, // 8
      { activity: '工作', location: '书房', priority: 7 }, // 9
      { activity: '工作', location: '书房', priority: 7 }, // 10
      { activity: '工作', location: '书房', priority: 7 }, // 11
      { activity: '午餐', location: '餐厅', priority: 6 }, // 12
      { activity: '工作', location: '书房', priority: 7 }, // 13
      { activity: '工作', location: '书房', priority: 7 }, // 14
      { activity: '工作', location: '书房', priority: 7 }, // 15
      { activity: '工作', location: '书房', priority: 7 }, // 16
      { activity: '工作', location: '书房', priority: 7 }, // 17
      { activity: '晚餐', location: '餐厅', priority: 6 }, // 18
      { activity: '休闲', location: '客厅', priority: 4 }, // 19
      { activity: '休闲', location: '客厅', priority: 4 }, // 20
      { activity: '社交', location: '客厅', priority: 5 }, // 21
      { activity: '社交', location: '客厅', priority: 5 }, // 22
      { activity: '准备就寝', location: '卧室', priority: 3 }, // 23
    ];
    const values: Array<[number, number, string, string | null, number]> = [];
    for (const npcId of npcs) {
      for (let h = 0; h < 24; h += 1) {
        const t = template[h];
        if (!t) continue;
        values.push([npcId, h, t.activity, t.location ?? null, t.priority ?? 5]);
      }
    }
    const placeholders = values.map(() => '(?,?,?,?,?)').join(',');
    const flat = values.flat();
    await conn.query(
      `INSERT INTO npc_schedule (npc_id, hour, activity, location, priority)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
         activity = VALUES(activity),
         location = VALUES(location),
         priority = VALUES(priority)`,
      flat,
    );
    console.log(`✅ npc_schedule seed 完成：${npcs.length} NPC × 24h = ${values.length} 行（幂等）`);
  }

  await conn.end();
  console.log('\n✅ M4.4 迁移完成');
}

migrate().catch((e) => {
  console.error('❌ migrate-m44 失败:', e);
  process.exit(1);
});
