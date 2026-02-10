/**
 * 仅创建 npc 表（当 ai_config 已存在时使用）
 * 执行: npx tsx src/db/migrate-npc.ts
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
    CREATE TABLE IF NOT EXISTS npc (
      id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
      name VARCHAR(128) NOT NULL COMMENT '角色名称',
      description VARCHAR(512) DEFAULT NULL COMMENT '角色简介',
      background TEXT DEFAULT NULL COMMENT '角色背景',
      personality VARCHAR(512) DEFAULT NULL COMMENT '角色性格',
      avatar VARCHAR(512) DEFAULT NULL COMMENT '头像 URL',
      ai_config_id BIGINT NOT NULL COMMENT '关联 ai_config',
      system_prompt TEXT DEFAULT NULL COMMENT '系统提示词',
      category VARCHAR(32) DEFAULT 'custom' COMMENT '分类',
      prompt_type VARCHAR(16) DEFAULT 'high' COMMENT '约束类型',
      status TINYINT(1) DEFAULT 1 COMMENT '状态 0禁用 1启用',
      sort INT DEFAULT 0 COMMENT '排序',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ai_config_id (ai_config_id),
      INDEX idx_category (category),
      INDEX idx_status (status),
      FOREIGN KEY (ai_config_id) REFERENCES ai_config(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='角色NPC表'
  `);

  console.log('✅ npc 表已就绪（已存在则跳过）');
  await conn.end();
}

migrate().catch(console.error);
