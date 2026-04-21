/**
 * [M4.2.2] 记忆向量化迁移（幂等）
 * 执行: npx tsx src/db/migrate-m422.ts  或  npm run db:migrate:m422
 *
 * 变更：
 *   - 新建 npc_memory 表（长期记忆元数据；向量实体在 Qdrant，id 严格对齐）
 *   - id 同时作为 Qdrant point_id，写入契约见 docs/engine-integration-m4.2.2.md §3
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

  if (!(await hasTable(conn, dbName, 'npc_memory'))) {
    await conn.query(`
      CREATE TABLE npc_memory (
        id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID（同步作为 Qdrant point_id）',
        npc_id BIGINT NOT NULL COMMENT 'NPC ID',
        scene_id BIGINT DEFAULT NULL COMMENT '来源场景，可空',
        tick BIGINT DEFAULT NULL COMMENT '来源 tick',
        type VARCHAR(16) NOT NULL COMMENT 'observation/dialogue/reflection/event/manual',
        content TEXT NOT NULL COMMENT '记忆原文，<=1000 字',
        importance TINYINT DEFAULT 5 COMMENT '1~10 重要度；本期用规则打分，后期交给 reflect LLM',
        embed_status VARCHAR(16) DEFAULT 'pending' COMMENT 'pending/embedded/failed',
        embed_model VARCHAR(64) DEFAULT NULL COMMENT '实际使用的 embedding 模型',
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        last_accessed_at DATETIME(3) DEFAULT NULL COMMENT '最近一次被 retrieve 命中的时间',
        access_count INT DEFAULT 0 COMMENT '被检索命中次数',
        INDEX idx_npc_time (npc_id, created_at),
        INDEX idx_npc_importance (npc_id, importance DESC),
        INDEX idx_embed_status (embed_status),
        CONSTRAINT fk_mem_npc FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='[M4.2.2] NPC 长期记忆元数据（向量在 Qdrant）'
    `);
    console.log('✅ npc_memory 表已创建');
  } else {
    console.log('⏭  npc_memory 表已存在，跳过');
  }

  await conn.end();
  console.log('✅ M4.2.2 迁移完成');
}

migrate().catch((e) => {
  console.error('❌ migrate-m422 失败:', e);
  process.exit(1);
});
