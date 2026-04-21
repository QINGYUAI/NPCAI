/**
 * [M4.2.3] 反思循环数据层迁移（幂等）
 * 执行：npx tsx src/db/migrate-m423.ts  或  npm run db:migrate:m423
 *
 * 变更
 *   - 新建 npc_reflection 表：反思归档（高层抽象，与 npc_memory 原文观察区分）
 *   - 每次反思写入 3 条 {theme, content} 记录（theme ∈ goal/emotion/relation）
 *   - source_memory_ids JSON 保存本次反思参考的 npc_memory.id 列表，用于溯源
 *
 * 与 M4.2.2 关系
 *   - 反思产物同时也会作为 memory 入 npc_memory（type='reflection', importance=8），
 *     由 storeMemory 走 Qdrant 向量化路径；npc_reflection 是人类可读归档，不冗余向量
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

  if (!(await hasTable(conn, dbName, 'npc_reflection'))) {
    await conn.query(`
      CREATE TABLE npc_reflection (
        id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
        npc_id BIGINT NOT NULL COMMENT 'NPC ID',
        scene_id BIGINT NOT NULL COMMENT '场景ID',
        tick BIGINT NOT NULL COMMENT '触发反思的 tick',
        theme VARCHAR(32) NOT NULL COMMENT '反思主题：goal/emotion/relation',
        content TEXT NOT NULL COMMENT '反思产物：第一人称短段（<=200 字）',
        source_memory_ids JSON DEFAULT NULL COMMENT '参考的 npc_memory.id 数组，用于溯源/审计',
        memory_id BIGINT DEFAULT NULL COMMENT '对应 npc_memory.id（反思入库后双向索引）',
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        INDEX idx_npc_tick (npc_id, tick DESC),
        INDEX idx_npc_theme_time (npc_id, theme, created_at DESC),
        CONSTRAINT fk_ref_npc FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE,
        CONSTRAINT fk_ref_scene FOREIGN KEY (scene_id) REFERENCES scene(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='[M4.2.3] NPC 反思归档（与 npc_memory 反向双写，theme 固定枚举 3 种）'
    `);
    console.log('✅ npc_reflection 表已创建');
  } else {
    console.log('⏭  npc_reflection 表已存在，跳过');
  }

  await conn.end();
  console.log('✅ M4.2.3 迁移完成');
}

migrate().catch((e) => {
  console.error('❌ migrate-m423 失败:', e);
  process.exit(1);
});
