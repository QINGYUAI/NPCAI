/**
 * M4.1 引擎相关表迁移
 * 执行: npx tsx src/db/migrate-engine.ts
 *
 * 幂等：
 *   - 创建 npc_tick_log（若不存在）
 *   - 所有变更均可重复执行
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

  await conn.query(`
    CREATE TABLE IF NOT EXISTS npc_tick_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
      scene_id BIGINT NOT NULL COMMENT '场景ID',
      npc_id BIGINT NOT NULL COMMENT 'NPC ID',
      tick BIGINT NOT NULL COMMENT '场景内单调递增的 tick 序号',
      started_at DATETIME(3) NOT NULL COMMENT 'tick 开始时间',
      finished_at DATETIME(3) DEFAULT NULL COMMENT 'tick 完成时间',
      status VARCHAR(16) NOT NULL COMMENT 'success / error / skipped',
      input_summary TEXT DEFAULT NULL COMMENT '本 tick 输入摘要',
      output_meta JSON DEFAULT NULL COMMENT '本 tick 产出 simulation_meta 快照',
      error_message TEXT DEFAULT NULL COMMENT '错误信息',
      duration_ms INT DEFAULT NULL COMMENT '耗时毫秒',
      INDEX idx_scene_tick (scene_id, tick),
      INDEX idx_npc (npc_id),
      CONSTRAINT fk_tick_scene FOREIGN KEY (scene_id) REFERENCES scene(id) ON DELETE CASCADE,
      CONSTRAINT fk_tick_npc FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC 单步决策归档'
  `);
  console.log('✅ npc_tick_log 表就绪');

  await conn.end();
  console.log('✅ 引擎相关迁移完成');
}

migrate().catch((e) => {
  console.error('❌ migrate-engine 失败:', e);
  process.exit(1);
});
