/**
 * 为 npc_memory 添加 embedding 列（向量，用于语义检索）
 * 执行: npm run db:migrate-memory-embedding
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

  const [cols] = await conn.execute(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'npc_memory' AND COLUMN_NAME = 'embedding'",
    [process.env.DB_NAME || 'ainpc']
  );
  const exists = (cols as { COLUMN_NAME: string }[]).length > 0;
  if (!exists) {
    await conn.query('ALTER TABLE npc_memory ADD COLUMN embedding JSON DEFAULT NULL COMMENT "向量 embedding"');
    console.log('✅ 已添加列: embedding');
  } else {
    console.log('⏭️ 列 embedding 已存在，跳过');
  }
  await conn.end();
}

migrate().catch(console.error);
