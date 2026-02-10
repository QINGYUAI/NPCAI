/**
 * MySQL 数据库连接池
 */
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ainpc',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export { pool };
