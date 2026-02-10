/**
 * 创建 npc_conversation 与 npc_message 表
 * 执行: npx tsx src/db/migrate-conversation.ts
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
    CREATE TABLE IF NOT EXISTS npc_conversation (
      id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
      npc_id BIGINT NOT NULL COMMENT '关联 npc',
      user_id VARCHAR(64) DEFAULT NULL COMMENT '可选：用户标识',
      session_id VARCHAR(64) NOT NULL COMMENT '会话唯一标识',
      status TINYINT(1) DEFAULT 1 COMMENT '状态',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_npc_id (npc_id),
      INDEX idx_session_id (session_id),
      FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC对话会话表'
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS npc_message (
      id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
      conversation_id BIGINT NOT NULL COMMENT '关联 npc_conversation',
      role ENUM('user','assistant') NOT NULL COMMENT 'user=用户 assistant=NPC',
      content TEXT NOT NULL COMMENT '消息内容',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_conversation_id (conversation_id),
      FOREIGN KEY (conversation_id) REFERENCES npc_conversation(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='对话消息表'
  `);

  console.log('✅ npc_conversation、npc_message 表已就绪');
  await conn.end();
}

migrate().catch(console.error);
