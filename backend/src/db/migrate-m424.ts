/**
 * [M4.2.4] 事件总线数据层迁移（幂等）
 * 执行：npx tsx src/db/migrate-m424.ts  或  npm run db:migrate:m424
 *
 * 变更
 *   - 新建 scene_event 表：场景事件流（外部注入 / 系统产生 / NPC 产生）
 *       · type 固定 4 枚举（weather / dialogue / system / plot，对应拉票 Q3a）
 *       · visible_npcs JSON：NULL=全场景可见；数组=指定 NPC 可见（拉票 Q1a 过滤依据）
 *       · consumed_tick BIGINT：首次被任何 NPC 消费的 tick 号（调试字段，不再用于去重判定）
 *   - 新建 scene_event_consumed 表：per-(event × npc) 精确去重（拉票 Q2b）
 *       · PRIMARY KEY(event_id, npc_id) 防重复消费
 *       · 记录消费 tick + 时间，用于事件审计与后续清理
 *
 * 与既有表关系
 *   - 外键级联删场景 → 事件 → 消费记录，单向下级级联清理
 *   - 不触及 npc_tick_log / npc_memory / npc_reflection
 *
 * 回滚
 *   - DROP TABLE scene_event_consumed; DROP TABLE scene_event;（顺序：先子表再父表）
 */
import 'dotenv/config';
import mysql, { type RowDataPacket } from 'mysql2/promise';

async function hasTable(conn: mysql.Connection, dbName: string, table: string): Promise<boolean> {
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

  /** scene_event：事件主表 */
  if (!(await hasTable(conn, dbName, 'scene_event'))) {
    await conn.query(`
      CREATE TABLE scene_event (
        id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID（同时作为 WS event_id 对外暴露）',
        scene_id BIGINT NOT NULL COMMENT '场景ID',
        type ENUM('weather','dialogue','system','plot') NOT NULL COMMENT '事件类型：锁定4枚举（拉票 Q3a）',
        actor VARCHAR(64) DEFAULT NULL COMMENT '事件发起者：system/user/NPC名 自由文本（拉票 Q4a），prompt 直接可读',
        content TEXT NOT NULL COMMENT '事件描述（给 LLM 看的自然语言；≤500 字）',
        payload JSON DEFAULT NULL COMMENT '结构化附加信息（可选，前端/后续扩展用）',
        visible_npcs JSON DEFAULT NULL COMMENT 'NULL=全场景可见；数组=指定 NPC 可见（拉票 Q1a，event-intake per-NPC 过滤）',
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        consumed_tick BIGINT DEFAULT NULL COMMENT '首次被任意 NPC 消费的 tick 号（仅调试，不参与去重判定）',
        INDEX idx_scene_time (scene_id, created_at DESC),
        INDEX idx_scene_type_time (scene_id, type, created_at DESC),
        CONSTRAINT fk_evt_scene FOREIGN KEY (scene_id) REFERENCES scene(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='[M4.2.4] 场景事件流（外部注入 / 系统产生 / NPC 产生）'
    `);
    console.log('✅ scene_event 表已创建');
  } else {
    console.log('⏭  scene_event 表已存在，跳过');
  }

  /** scene_event_consumed：per-(event × npc) 去重表 */
  if (!(await hasTable(conn, dbName, 'scene_event_consumed'))) {
    await conn.query(`
      CREATE TABLE scene_event_consumed (
        event_id BIGINT NOT NULL COMMENT '对应 scene_event.id',
        npc_id BIGINT NOT NULL COMMENT 'NPC ID',
        tick BIGINT NOT NULL COMMENT '消费时的 tick',
        consumed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '消费时间',
        PRIMARY KEY (event_id, npc_id),
        INDEX idx_npc_tick (npc_id, tick DESC),
        INDEX idx_event (event_id),
        CONSTRAINT fk_evt_consumed_event FOREIGN KEY (event_id) REFERENCES scene_event(id) ON DELETE CASCADE,
        CONSTRAINT fk_evt_consumed_npc FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='[M4.2.4] 事件消费去重表（per-event × npc 精确去重，拉票 Q2b）'
    `);
    console.log('✅ scene_event_consumed 表已创建');
  } else {
    console.log('⏭  scene_event_consumed 表已存在，跳过');
  }

  await conn.end();
  console.log('✅ M4.2.4 迁移完成');
}

migrate().catch((e) => {
  console.error('❌ migrate-m424 失败:', e);
  process.exit(1);
});
