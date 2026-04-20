/**
 * 场景表、scene_npc、npc.simulation_meta 迁移
 * 执行: npx tsx src/db/migrate-scene.ts
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
    multipleStatements: true,
  });

  try {
    await conn.query(`
      ALTER TABLE npc ADD COLUMN simulation_meta JSON DEFAULT NULL COMMENT '外部仿真回写：记忆/反思等摘要（自由 JSON）'
    `);
    console.log('✅ 已添加 npc.simulation_meta');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Duplicate column')) {
      console.log('⏭️ npc.simulation_meta 已存在，跳过');
    } else {
      throw err;
    }
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS scene (
      id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
      name VARCHAR(128) NOT NULL COMMENT '场景名称',
      description TEXT DEFAULT NULL COMMENT '简介',
      category VARCHAR(32) DEFAULT 'custom' COMMENT '分类 task/plot/custom',
      tags JSON DEFAULT NULL COMMENT '标签 JSON 数组',
      status TINYINT(1) DEFAULT 1 COMMENT '0禁用 1启用',
      sort INT DEFAULT 0 COMMENT '排序',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_scene_category (category),
      INDEX idx_scene_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='场景表'
  `);
  console.log('✅ scene 表就绪');

  await conn.query(`
    CREATE TABLE IF NOT EXISTS scene_npc (
      scene_id BIGINT NOT NULL COMMENT '场景ID',
      npc_id BIGINT NOT NULL COMMENT 'NPC ID',
      role_note VARCHAR(256) DEFAULT NULL COMMENT '本场景中身份/备注',
      pos_x DOUBLE DEFAULT NULL COMMENT '2D 沙盒 X 坐标',
      pos_y DOUBLE DEFAULT NULL COMMENT '2D 沙盒 Y 坐标',
      PRIMARY KEY (scene_id, npc_id),
      INDEX idx_scene_npc_npc (npc_id),
      CONSTRAINT fk_scene_npc_scene FOREIGN KEY (scene_id) REFERENCES scene(id) ON DELETE CASCADE,
      CONSTRAINT fk_scene_npc_npc FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='场景与角色关联'
  `);
  console.log('✅ scene_npc 表就绪');

  /** 为已存在旧库追加沙盒字段 */
  const alterStatements: { sql: string; label: string }[] = [
    {
      sql: `ALTER TABLE scene ADD COLUMN background_image VARCHAR(512) DEFAULT NULL COMMENT '2D 沙盒底图 URL' AFTER tags`,
      label: 'scene.background_image',
    },
    {
      sql: `ALTER TABLE scene ADD COLUMN width INT DEFAULT 800 COMMENT '2D 沙盒逻辑宽度' AFTER background_image`,
      label: 'scene.width',
    },
    {
      sql: `ALTER TABLE scene ADD COLUMN height INT DEFAULT 600 COMMENT '2D 沙盒逻辑高度' AFTER width`,
      label: 'scene.height',
    },
    {
      sql: `ALTER TABLE scene_npc ADD COLUMN pos_x DOUBLE DEFAULT NULL COMMENT '2D 沙盒 X 坐标'`,
      label: 'scene_npc.pos_x',
    },
    {
      sql: `ALTER TABLE scene_npc ADD COLUMN pos_y DOUBLE DEFAULT NULL COMMENT '2D 沙盒 Y 坐标'`,
      label: 'scene_npc.pos_y',
    },
  ];
  for (const stmt of alterStatements) {
    try {
      await conn.query(stmt.sql);
      console.log(`✅ 已添加 ${stmt.label}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Duplicate column')) {
        console.log(`⏭️ ${stmt.label} 已存在，跳过`);
      } else {
        throw err;
      }
    }
  }

  await conn.end();
  console.log('✅ 场景相关迁移完成');
}

migrate().catch(console.error);
