/**
 * 地图场景状态服务
 * 从 Redis 构建场景状态，供 getSceneState API 与 wander WebSocket 推送共用
 */
import { pool } from '../db/connection.js';
import { redis } from '../db/redis.js';

/** Redis key：地图暂停状态，与 wander 保持一致 */
const PAUSED_KEY = (mapId: string) => `map:${mapId}:paused`;

export interface NpcSceneState {
  npc_id: number;
  x: number;
  y: number;
  state: string;
  groupId: string;
  avatar?: string;
  thinking?: string;
}

export interface SceneStateData {
  npcs: NpcSceneState[];
  running: boolean;
}

/** 从 Redis 构建场景状态（含 avatar、thinking） */
export async function buildSceneState(mapId: string): Promise<SceneStateData> {
  let npcIds = await redis.smembers(`map:${mapId}:npcs`);

  if (npcIds.length === 0) {
    const [bindRows] = await pool.execute(
      `SELECT b.npc_id, b.init_x, b.init_y, n.avatar
       FROM npc_map_binding b
       JOIN npc n ON b.npc_id = n.id
       WHERE b.map_id = ?`,
      [mapId]
    );
    const list = bindRows as { npc_id: number; init_x: number; init_y: number; avatar: string | null }[];
    const npcs = list.map((r) => ({
      npc_id: r.npc_id,
      x: r.init_x,
      y: r.init_y,
      state: 'idle',
      groupId: '',
      avatar: r.avatar || undefined,
      thinking: undefined as string | undefined,
    }));
    const running = (await redis.get(PAUSED_KEY(mapId))) !== '1';
    return { npcs, running };
  }

  const [avatarRows] = await pool.execute(
    `SELECT id, avatar FROM npc WHERE id IN (${npcIds.map(() => '?').join(',')})`,
    npcIds.map(Number)
  );
  const avatarMap = new Map(
    (avatarRows as { id: number; avatar: string | null }[]).map((r) => [r.id, r.avatar])
  );

  const npcs: NpcSceneState[] = [];
  for (const id of npcIds) {
    const data = await redis.hgetall(`map:${mapId}:npc:${id}`);
    if (data) {
      npcs.push({
        npc_id: Number(id),
        x: Number(data.x || 0),
        y: Number(data.y || 0),
        state: data.state || 'idle',
        groupId: data.groupId || '',
        avatar: avatarMap.get(Number(id)) || undefined,
        thinking: undefined,
      });
    }
  }

  const ids = npcs.map((n) => n.npc_id);
  const thinkingMap = new Map<number, string>();
  if (ids.length > 0) {
    const [memRows] = await pool.execute(
      `SELECT npc_id, description FROM npc_memory
       WHERE npc_id IN (${ids.map(() => '?').join(',')}) AND type IN ('wander', 'conversation')
       ORDER BY id DESC`,
      ids
    );
    const memList = memRows as { npc_id: number; description: string }[];
    for (const row of memList) {
      if (!thinkingMap.has(row.npc_id)) {
        thinkingMap.set(row.npc_id, row.description?.slice(0, 80) || '');
      }
    }
  }
  for (const n of npcs) {
    n.thinking = thinkingMap.get(n.npc_id);
  }

  const running = (await redis.get(PAUSED_KEY(mapId))) !== '1';
  return { npcs, running };
}
