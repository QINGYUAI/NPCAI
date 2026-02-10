/**
 * 数据库初始化脚本 - 创建 ai_config 表
 * 执行: npm run db:init
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function init() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  // 创建数据库（如不存在）
  await conn.query(`CREATE DATABASE IF NOT EXISTS ainpc DEFAULT CHARSET utf8mb4`);

  await conn.query('USE ainpc');

  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  const statements = schema
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('--'));

  for (const stmt of statements) {
    if (stmt) await conn.query(stmt);
  }

  console.log('✅ 数据库初始化完成');
  await conn.end();
}

init().catch(console.error);
