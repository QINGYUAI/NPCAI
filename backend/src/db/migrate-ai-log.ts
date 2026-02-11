/**
 * 创建 ai_call_log 表，用于记录 AI 接口调用日志
 * 执行: npx tsx src/db/migrate-ai-log.ts
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
    CREATE TABLE IF NOT EXISTS ai_call_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
      ai_config_id BIGINT DEFAULT NULL COMMENT '关联 ai_config（可选）',
      api_type VARCHAR(32) NOT NULL COMMENT 'chat/chat_stream/embed',
      provider VARCHAR(64) NOT NULL COMMENT '提供商',
      model VARCHAR(128) DEFAULT NULL COMMENT '模型名',
      request_info JSON DEFAULT NULL COMMENT '请求信息：消息数、输入长度等',
      response_info JSON DEFAULT NULL COMMENT '响应信息：输出长度、token 等',
      request_content TEXT DEFAULT NULL COMMENT '请求内容（输入，截断存储）',
      response_content TEXT DEFAULT NULL COMMENT '响应内容（输出，截断存储）',
      duration_ms INT DEFAULT NULL COMMENT '耗时(毫秒)',
      status VARCHAR(16) NOT NULL DEFAULT 'success' COMMENT 'success/error',
      error_message TEXT DEFAULT NULL COMMENT '错误信息',
      source VARCHAR(64) DEFAULT NULL COMMENT '调用来源：wander/conversation/memory/npc 等',
      context JSON DEFAULT NULL COMMENT '扩展上下文',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created (created_at),
      INDEX idx_api_type (api_type),
      INDEX idx_status (status),
      INDEX idx_ai_config (ai_config_id),
      FOREIGN KEY (ai_config_id) REFERENCES ai_config(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI接口调用日志表'
  `);

  // 兼容已存在的表：追加 request_content、response_content 列
  try {
    await conn.query('ALTER TABLE ai_call_log ADD COLUMN request_content TEXT DEFAULT NULL COMMENT "请求内容（输入）"');
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== 'ER_DUP_FIELDNAME') console.warn('migrate request_content:', e);
  }
  try {
    await conn.query('ALTER TABLE ai_call_log ADD COLUMN response_content TEXT DEFAULT NULL COMMENT "响应内容（输出）"');
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== 'ER_DUP_FIELDNAME') console.warn('migrate response_content:', e);
  }

  console.log('✅ ai_call_log 表已就绪');
  await conn.end();
}

migrate().catch(console.error);
