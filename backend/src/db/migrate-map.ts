/**
 * 创建 game_map、npc_map_binding、npc_npc_conversation、npc_npc_message 表
 * 执行: npm run db:migrate-map
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

  // 1. game_map（无外键，最先创建）
  await conn.query(`
    CREATE TABLE IF NOT EXISTS game_map (
      id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
      name VARCHAR(128) NOT NULL COMMENT '地图名称',
      width INT NOT NULL COMMENT '地图宽度（格子数）',
      height INT NOT NULL COMMENT '地图高度（格子数）',
      tile_data JSON NOT NULL COMMENT '2D 数组，0=可行走 1=障碍',
      metadata JSON DEFAULT NULL COMMENT '扩展：图块类型、图层等',
      status TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='游戏地图表'
  `);

  // 2. npc_map_binding
  await conn.query(`
    CREATE TABLE IF NOT EXISTS npc_map_binding (
      id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
      npc_id BIGINT NOT NULL COMMENT '关联 npc',
      map_id BIGINT NOT NULL COMMENT '关联 game_map',
      init_x INT NOT NULL DEFAULT 0 COMMENT '初始 X 坐标',
      init_y INT NOT NULL DEFAULT 0 COMMENT '初始 Y 坐标',
      UNIQUE KEY uk_npc_map (npc_id, map_id),
      FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE,
      FOREIGN KEY (map_id) REFERENCES game_map(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC与地图绑定及初始位置'
  `);

  // 3. npc_npc_conversation
  await conn.query(`
    CREATE TABLE IF NOT EXISTS npc_npc_conversation (
      id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
      map_id BIGINT DEFAULT NULL COMMENT '发生在地图上的对话',
      participant_ids JSON NOT NULL COMMENT '参与 NPC id 列表，如 [1,2,3]',
      status ENUM('active','ended') DEFAULT 'ended',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME DEFAULT NULL,
      INDEX idx_status (status),
      INDEX idx_map (map_id),
      FOREIGN KEY (map_id) REFERENCES game_map(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC之间对话会话表（持久化）'
  `);

  // 4. npc_npc_message
  await conn.query(`
    CREATE TABLE IF NOT EXISTS npc_npc_message (
      id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
      conversation_id BIGINT NOT NULL COMMENT '关联 npc_npc_conversation',
      speaker_npc_id BIGINT NOT NULL COMMENT '发言的 NPC',
      content TEXT NOT NULL COMMENT '消息内容',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_conversation_id (conversation_id),
      FOREIGN KEY (conversation_id) REFERENCES npc_npc_conversation(id) ON DELETE CASCADE,
      FOREIGN KEY (speaker_npc_id) REFERENCES npc(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC之间对话消息表（持久化）'
  `);

  console.log('✅ game_map、npc_map_binding、npc_npc_conversation、npc_npc_message 表已就绪');
  await conn.end();
}

migrate().catch(console.error);
