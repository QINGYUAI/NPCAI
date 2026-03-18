/**
 * 物品系统迁移：创建 item、item_map_binding、npc_map_item 表
 * 执行: npm run db:migrate-item
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

  // 1. item 表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS item (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      category VARCHAR(32) NOT NULL DEFAULT 'object',
      description VARCHAR(512) DEFAULT NULL,
      footprint JSON NOT NULL COMMENT '2D数组 [[1,1],[1,0]] 1=障碍0=可行走',
      tile_value TINYINT DEFAULT 1 COMMENT '合并到tile_data时的障碍值，用于渲染区分',
      is_blocking TINYINT(1) DEFAULT 1,
      metadata JSON DEFAULT NULL,
      status TINYINT(1) DEFAULT 1,
      sort INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='物品表'
  `);

  // 2. item_map_binding 表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS item_map_binding (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      item_id BIGINT NOT NULL,
      map_id BIGINT NOT NULL,
      pos_x INT NOT NULL DEFAULT 0,
      pos_y INT NOT NULL DEFAULT 0,
      rotation TINYINT DEFAULT 0,
      extra JSON DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_map (map_id),
      FOREIGN KEY (item_id) REFERENCES item(id) ON DELETE CASCADE,
      FOREIGN KEY (map_id) REFERENCES game_map(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='物品与地图关联'
  `);

  // 3. npc_map_item 表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS npc_map_item (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      npc_id BIGINT NOT NULL,
      map_id BIGINT NOT NULL,
      item_binding_id BIGINT NOT NULL,
      relation_type VARCHAR(32) NOT NULL DEFAULT 'nearby',
      metadata JSON DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_npc_map (npc_id, map_id),
      FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE,
      FOREIGN KEY (map_id) REFERENCES game_map(id) ON DELETE CASCADE,
      FOREIGN KEY (item_binding_id) REFERENCES item_map_binding(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC与地图上物品的关联'
  `);

  console.log('✅ item、item_map_binding、npc_map_item 表已就绪');
  await conn.end();
}

migrate().catch(console.error);
