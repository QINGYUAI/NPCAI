/**
 * 为 npc 表添加性别、年龄、职业、说话风格等字段
 * 执行: npx tsx src/db/migrate-npc-fields.ts
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

  const columns = [
    ['gender', "VARCHAR(16) DEFAULT NULL COMMENT '性别: male/female/other/unknown'"],
    ['age', "VARCHAR(32) DEFAULT NULL COMMENT '年龄: 数字或描述如青年'"],
    ['occupation', "VARCHAR(128) DEFAULT NULL COMMENT '职业'"],
    ['voice_tone', "VARCHAR(128) DEFAULT NULL COMMENT '说话风格/语气'"],
  ];

  for (const [col, def] of columns) {
    try {
      await conn.query(`ALTER TABLE npc ADD COLUMN ${col} ${def}`);
      console.log(`✅ 已添加列: ${col}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Duplicate column')) {
        console.log(`⏭️ 列 ${col} 已存在，跳过`);
      } else {
        throw err;
      }
    }
  }

  console.log('✅ npc 扩展字段迁移完成');
  await conn.end();
}

migrate().catch(console.error);
