/** [M4.2.3.c] 快速查一个 scene+npc+ai_config 齐全的候选 */
import { pool } from '../../src/db/connection.js';
const [rows] = await pool.query<{
  scene_id: number;
  npc_id: number;
  name: string;
  ai_config_id: number;
}[] & unknown[]>(
  `SELECT sn.scene_id, sn.npc_id, n.name, n.ai_config_id
     FROM scene_npc sn
     JOIN npc n ON n.id = sn.npc_id
     JOIN ai_config c ON c.id = n.ai_config_id AND c.status = 1
    LIMIT 5`,
);
console.log(JSON.stringify(rows, null, 2));
await pool.end();
