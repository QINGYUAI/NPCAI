/**
 * 创建 npc_memory 表（NPC 记忆系统）
 * 执行: npx tsx src/db/migrate-memory.ts
 * 或: npm run db:migrate-memory
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

async function migrate() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ainpc',
  });

  await conn.query(`
    CREATE TABLE IF NOT EXISTS npc_memory (
      id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
      npc_id BIGINT NOT NULL COMMENT '关联 npc',
      conversation_id BIGINT DEFAULT NULL COMMENT '关联 npc_conversation（可选）',
      type VARCHAR(32) NOT NULL COMMENT 'conversation/reflection/relationship',
      description TEXT NOT NULL COMMENT '记忆内容',
      importance DECIMAL(3,2) DEFAULT 0.5 COMMENT '重要度 0-1，用于筛选',
      related_ids JSON DEFAULT NULL COMMENT '关联记忆 id 列表',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_npc_type (npc_id, type),
      INDEX idx_npc_importance (npc_id, importance DESC),
      FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES npc_conversation(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC记忆表'
  `);

  console.log('✅ npc_memory 表已就绪');
  await conn.end();
}

migrate().catch(console.error);
