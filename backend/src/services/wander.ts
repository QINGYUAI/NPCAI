/**
 * NPC 自主移动与相遇逻辑
 * 1. 每个 NPC 基于 AI 思考决定移动，思考存入 npc_memory
 * 2. 多个 NPC 移动、思考互不干扰
 * 3. 相遇或看到对方时触发 NPC-NPC 对话思考
 */
import { randomUUID } from 'crypto';
import { pool } from '../db/connection.js';
import { redis } from '../db/redis.js';
import { chatCompletion } from '../utils/llmClient.js';

const WANDER_INTERVAL_MS = 5000;

/** 相遇/对话触发距离（格子数），≤ 此距离视为可对话 */
const TALK_RANGE = 2;

/** 防止同一地图 tick 重叠，确保每个 NPC 都能被处理 */
const mapLocks = new Map<string, Promise<void>>();

/** 是否启用 AI 决策（可通过环境变量关闭以省成本） */
const USE_AI = process.env.WANDER_USE_AI !== 'false';

/** 随机偏移（兜底用） */
function getRandomOffset(): [number, number] {
  const dirs: [number, number][] = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  return dirs[Math.floor(Math.random() * dirs.length)];
}

const DIR_MAP: Record<string, [number, number]> = {
  stay: [0, 0],
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/** 方向对应的中文描述，用于无 AI 时的兜底思考 */
function getDirectionName(dx: number, dy: number): string {
  const names: Record<string, string> = { '0,0': '停留', '0,-1': '北', '0,1': '南', '1,0': '东', '-1,0': '西' };
  return names[`${dx},${dy}`] ?? '随机方向';
}

function parseDirection(text: string): [number, number] | null {
  const lower = text.trim().toLowerCase().replace(/[^\w]/g, '');
  return DIR_MAP[lower] ?? DIR_MAP[lower.slice(0, 5)] ?? null;
}

/** 解析 LLM 返回：思考 + 行动。格式示例：想法：想去东边 行动：east */
function parseThoughtAndAction(resp: string): { thinking: string; direction: [number, number] | null } {
  const thinkingMatch = resp.match(/(?:想法|思考)[：:]\s*(.+?)(?=行动|$)/s);
  const actionMatch = resp.match(/(?:行动|动作)[：:]\s*(\w+)/i) || resp.match(/\b(stay|north|south|east|west)\b/i);
  const thinking = (thinkingMatch?.[1] || resp.split(/行动|动作/)[0] || '').trim().slice(0, 200) || '随意走动';
  const direction = actionMatch ? parseDirection(actionMatch[1] || actionMatch[0] || '') : null;
  return { thinking, direction };
}

/** 将 NPC 移动时的思考存入 npc_memory（type=wander） */
async function saveWanderThought(npcId: number, thinking: string): Promise<void> {
  try {
    await pool.execute(
      'INSERT INTO npc_memory (npc_id, type, description, importance) VALUES (?, ?, ?, ?)',
      [npcId, 'wander', thinking, 0.3]
    );
  } catch (e) {
    console.warn('[wander] 存储思考失败:', npcId, e);
  }
}

/** 按距离分组：返回「对话组」（2人以上且互相在 TALK_RANGE 内）与「可移动的 idle NPC」 */
async function divideIntoGroups(
  mapId: string,
  npcIds: string[]
): Promise<{ conversationGroups: string[][]; idleForWander: Set<string> }> {
  const positions = new Map<string, { x: number; y: number; state: string; groupId: string }>();
  for (const id of npcIds) {
    const data = await redis.hgetall(`map:${mapId}:npc:${id}`);
    if (!data) continue;
    positions.set(id, {
      x: Number(data.x || 0),
      y: Number(data.y || 0),
      state: data.state || 'idle',
      groupId: data.groupId || '',
    });
  }

  const inGroup = new Set<string>();
  const conversationGroups: string[][] = [];

  for (const a of npcIds) {
    if (inGroup.has(a)) continue;
    const pa = positions.get(a);
    if (!pa || pa.state !== 'idle' || pa.groupId) continue;

    const group: string[] = [a];
    for (const b of npcIds) {
      if (a === b || inGroup.has(b)) continue;
      const pb = positions.get(b);
      if (!pb || pb.state !== 'idle' || pb.groupId) continue;

      const dist = Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
      if (dist <= TALK_RANGE) {
        group.push(b);
        inGroup.add(b);
      }
    }
    if (group.length >= 2) {
      inGroup.add(a);
      conversationGroups.push(group);
    }
  }

  const idleForWander = new Set(npcIds.filter((id) => !inGroup.has(id)));
  return { conversationGroups, idleForWander };
}

/** NPC 相遇时的多轮对话回合数（每人至少 1 次发言） */
const CONVERSATION_ROUNDS = 6;

/** 相遇时：创建对话组、生成「看到对方的思考」、进行多轮聊天与思考对话 */
async function handleEncounter(
  mapId: string,
  group: string[],
  npcConfigMap: Map<number, { name: string; personality: string; aiConfigId: number; llmConfig: object | null }>
): Promise<void> {
  const groupId = randomUUID();
  const getOthersDesc = (excludeId: string) =>
    group
      .filter((id) => id !== excludeId)
      .map((id) => npcConfigMap.get(Number(id))?.name || `NPC${id}`)
      .filter(Boolean)
      .join('、');

  const now = Date.now().toString();
  for (const npcId of group) {
    const key = `map:${mapId}:npc:${npcId}`;
    await redis.hset(key, 'state', 'speaking');
    await redis.hset(key, 'groupId', groupId);
    await redis.hset(key, 'updatedAt', now);
  }
  await redis.sadd(`map:${mapId}:groups`, groupId);
  await redis.hset(`group:${groupId}`, 'memberIds', JSON.stringify(group));
  await redis.hset(`group:${groupId}`, 'createdAt', now);

  // 0. 先创建 NPC 对话记录，便于 encounter/chat 记忆都关联同一 conversation_id
  const participantIds = group.map(Number);
  const participantIdsJson = JSON.stringify(participantIds);
  let convId: number;
  try {
    const [insertResult] = await pool.execute(
      'INSERT INTO npc_npc_conversation (map_id, participant_ids, status) VALUES (?, ?, ?)',
      [Number(mapId), participantIdsJson, 'active']
    );
    convId = (insertResult as { insertId: number }).insertId;
  } catch (e) {
    console.warn('[wander] 创建 NPC 对话记录失败:', e);
    return;
  }

  // 1. 每个 NPC 并行生成「看到对方的思考」并存档（含关联 conversation_id）
  await Promise.all(
    group.map(async (npcId) => {
      try {
        const cfg = npcConfigMap.get(Number(npcId));
        const othersDesc = getOthersDesc(npcId);
        if (!othersDesc) return;

        let desc: string;
        if (cfg?.llmConfig) {
          const prompt = `你是${cfg.name}。你在地图上遇到了${othersDesc}，你们距离很近。请用1句话写出你此刻的想法（例如想打招呼、想聊什么、或想离开）。只输出这一句话。`;
          const thought = await chatCompletion(
            cfg.llmConfig as Parameters<typeof chatCompletion>[0],
            [{ role: 'user' as const, content: prompt }],
            {
              max_tokens: 60,
              timeout: 6000,
              logContext: {
                source: 'wander_encounter',
                ai_config_id: cfg.aiConfigId,
                context: { map_id: mapId, npc_id: Number(npcId) },
              },
            }
          );
          desc = (thought || '遇到了对方').trim().slice(0, 300);
        } else {
          desc = `看到了${othersDesc}`;
        }
        await pool.execute(
          'INSERT INTO npc_memory (npc_id, type, description, importance, related_ids) VALUES (?, ?, ?, ?, ?)',
          [
            Number(npcId),
            'conversation',
            `遇到${othersDesc}时想：${desc}`,
            0.5,
            JSON.stringify({ npc_npc_conversation_id: convId, encounter_group: group }),
          ]
        );
      } catch (e) {
        console.warn('[wander] 相遇思考失败:', npcId, e);
      }
    })
  );

  // 2. 多轮聊天与思考：持久化到 npc_npc_message，记忆含关联 npc_npc_conversation_id、npc_npc_message_id
  const nameMap = new Map(Array.from(npcConfigMap.entries()).map(([id, c]) => [id, c.name]));

  // 对话历史（用于 prompt）：{ speakerName: content }[]
  const history: { name: string; content: string }[] = [];

  for (let round = 0; round < CONVERSATION_ROUNDS; round++) {
    const speakerIdx = round % group.length;
    const speakerId = group[speakerIdx];
    const speakerNpcId = Number(speakerId);
    const cfg = npcConfigMap.get(speakerNpcId);
    const speakerName = cfg?.name ?? nameMap.get(speakerNpcId) ?? `NPC${speakerId}`;
    const othersNames = group
      .filter((id) => id !== speakerId)
      .map((id) => npcConfigMap.get(Number(id))?.name || `NPC${id}`)
      .join('、');

    let content: string;
    if (cfg?.llmConfig) {
      const historyStr =
        history.length === 0
          ? '（对话刚开始）'
          : history.map((h) => `${h.name}：${h.content}`).join('\n');
      const prompt = `你是${speakerName}${cfg.personality ? `，性格：${cfg.personality.slice(0, 100)}` : ''}。你正在与${othersNames}聊天。

当前对话记录：
${historyStr}

请用1-2句话自然回应（问候、闲聊、回应对方均可）。直接输出你要说的话，不要加「XXX说」等前缀。`;

      try {
        const resp = await chatCompletion(
          cfg.llmConfig as Parameters<typeof chatCompletion>[0],
          [{ role: 'user' as const, content: prompt }],
          {
            max_tokens: 80,
            timeout: 8000,
            logContext: {
              source: 'wander_npc_chat',
              ai_config_id: cfg.aiConfigId,
              context: { map_id: mapId, npc_id: speakerNpcId, round },
            },
          }
        );
        content = (resp || '...').trim().slice(0, 200);
      } catch (e) {
        console.warn('[wander] NPC 发言失败:', speakerId, e);
        content = '（点点头）';
      }
    } else {
      content = '（点头致意）';
    }

    history.push({ name: speakerName, content });

    try {
      const [msgResult] = await pool.execute(
        'INSERT INTO npc_npc_message (conversation_id, speaker_npc_id, content) VALUES (?, ?, ?)',
        [convId, speakerNpcId, content]
      );
      const msgId = (msgResult as { insertId: number }).insertId;
      await pool.execute(
        'INSERT INTO npc_memory (npc_id, type, description, importance, related_ids) VALUES (?, ?, ?, ?, ?)',
        [
          speakerNpcId,
          'conversation',
          `在对话中说：${content}`,
          0.5,
          JSON.stringify({ npc_npc_conversation_id: convId, npc_npc_message_id: msgId }),
        ]
      );
    } catch (e) {
      console.warn('[wander] 写入对话消息失败:', e);
    }
  }

  try {
    await pool.execute(
      "UPDATE npc_npc_conversation SET status = 'ended', ended_at = NOW() WHERE id = ?",
      [convId]
    );
  } catch (e) {
    console.warn('[wander] 结束对话失败:', e);
  }
}

/** 默认障碍名称（metadata 无 tile_types 时使用） */
const DEFAULT_TILE_NAMES: Record<number, string> = {
  1: '建筑',
  2: '喷泉',
  3: '水域',
};

/** 方向相对于当前位置的偏移：(dx,dy) -> 方位名 */
const ADJ_DIR_NAMES: Record<string, string> = {
  '0,-1': '北侧',
  '0,1': '南侧',
  '1,0': '东侧',
  '-1,0': '西侧',
};

/**
 * 根据 NPC 当前位置与 tile_data，生成周围环境描述（相邻格子的障碍类型）
 * tileTypeNames 来自 metadata.tile_types，由 AI 根据地图描述动态生成
 */
function getSurroundingContext(
  x: number,
  y: number,
  tileData: number[][],
  mapW: number,
  mapH: number,
  tileTypeNames?: Record<number, string>
): string {
  const typeNames = tileTypeNames ?? DEFAULT_TILE_NAMES;
  const dirs: [number, number][] = [
    [0, -1],
    [0, 1],
    [1, 0],
    [-1, 0],
  ];
  const items: string[] = [];
  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx >= mapW || ny < 0 || ny >= mapH) continue;
    const val = tileData[ny]?.[nx] ?? 0;
    if (val > 0) {
      const name = typeNames[val] ?? '障碍物';
      const dirName = ADJ_DIR_NAMES[`${dx},${dy}`] ?? '';
      items.push(`${dirName}有${name}`);
    }
  }
  if (items.length === 0) return '';
  return `你身旁：${items.join('，')}。请根据周围环境产生自然的观察或想法。`;
}

/** 根据当前坐标与地图尺寸，生成不可移动方向的提示 */
function getBoundaryHint(x: number, y: number, mapW: number, mapH: number): string {
  const blocked: string[] = [];
  if (y <= 0) blocked.push('north(北)');
  if (y >= mapH - 1) blocked.push('south(南)');
  if (x <= 0) blocked.push('west(西)');
  if (x >= mapW - 1) blocked.push('east(东)');
  if (blocked.length === 0) return '';
  return `注意：你已在地图边界，不能向 ${blocked.join('、')} 移动，请选择其他方向或停留。`;
}

/** 根据 NPC 的 AI 配置调用 LLM 决定移动方向，并返回思考内容 */
async function getAiDirection(
  npcName: string,
  personality: string,
  x: number,
  y: number,
  mapW: number,
  mapH: number,
  llmConfig: { api_key: string; base_url?: string | null; provider: string; model?: string; max_tokens?: number },
  options?: {
    logContext?: { map_id: string; npc_id: number; ai_config_id?: number };
    /** 周围环境描述（建筑、喷泉、水域等），用于让 NPC 产生与场景相关的思考 */
    surroundingContext?: string;
  }
): Promise<{ direction: [number, number] | null; thinking: string }> {
  if (!llmConfig.api_key?.trim()) return { direction: null, thinking: '' };
  const boundaryHint = getBoundaryHint(x, y, mapW, mapH);
  const envHint = options?.surroundingContext
    ? `\n${options.surroundingContext}\n`
    : '';
  const prompt = `你是${npcName}${personality ? `，性格：${personality.slice(0, 80)}` : ''}。你正在地图上自由活动，当前位置(${x},${y})，地图范围宽${mapW}高${mapH}。
${boundaryHint ? boundaryHint + '\n' : ''}${envHint}请先写一句话说明你此刻的想法（例如想去哪、为何停留、对周围环境的看法），再写你要做的行动。
格式：想法：(你的想法，1句话) 行动：(stay/north/south/east/west 五选一)`;
  try {
    const logContext = options?.logContext;
    const resp = await chatCompletion(llmConfig, [{ role: 'user', content: prompt }], {
      max_tokens: 120,
      timeout: 8000,
      logContext: logContext
        ? { source: 'wander_move', ai_config_id: logContext.ai_config_id, context: { map_id: logContext.map_id, npc_id: logContext.npc_id } }
        : undefined,
    });
    const { thinking, direction } = parseThoughtAndAction(resp);
    return { direction, thinking };
  } catch (err) {
    console.warn('[wander] AI 决策失败，降级随机:', npcName, err);
    return { direction: null, thinking: '' };
  }
}

/** 对话组超时（毫秒），超时后释放 NPC 回 idle（多轮聊天需更长时间） */
const GROUP_TTL_MS = 60000;

/** 清理超时的对话组，将成员恢复为 idle */
async function clearStaleGroups(mapId: string): Promise<void> {
  try {
    const groupIds = await redis.smembers(`map:${mapId}:groups`);
    const now = Date.now();
    for (const gid of groupIds) {
      const createdAt = await redis.hget(`group:${gid}`, 'createdAt');
      const memberIds = await redis.hget(`group:${gid}`, 'memberIds');
      if (!createdAt || !memberIds) continue;
      if (now - parseInt(createdAt, 10) < GROUP_TTL_MS) continue;

      const members = JSON.parse(memberIds) as string[];
      for (const npcId of members) {
        const key = `map:${mapId}:npc:${npcId}`;
        await redis.hset(key, 'state', 'idle');
        await redis.hset(key, 'groupId', '');
        await redis.hset(key, 'updatedAt', String(now));
      }
      await redis.srem(`map:${mapId}:groups`, gid);
      await redis.del(`group:${gid}`);
    }
  } catch (e) {
    console.warn('[wander] 清理对话组失败:', mapId, e);
  }
}

async function wanderOneMap(mapId: string) {
  try {
    const npcIds = await redis.smembers(`map:${mapId}:npcs`);
    if (npcIds.length === 0) return;

    // 先清理超时的对话组，释放 NPC
    await clearStaleGroups(mapId);

    const [mapRows] = await pool.execute(
      'SELECT width, height, tile_data, metadata FROM game_map WHERE id = ?',
      [mapId]
    );
    const list = mapRows as { width: number; height: number; tile_data: string; metadata: string | null }[];
    if (list.length === 0) return;

    const row = list[0];
    let tileData: number[][];
    try {
      tileData = typeof row.tile_data === 'string' ? JSON.parse(row.tile_data) : row.tile_data;
    } catch {
      return;
    }

    /** 从 metadata.tile_types 提取类型名，供 NPC 环境感知（AI 动态生成） */
    let tileTypeNames: Record<number, string> | undefined;
    try {
      const meta = row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : null;
      const tt = meta?.tile_types;
      if (tt && typeof tt === 'object') {
        tileTypeNames = {};
        for (const [k, v] of Object.entries(tt)) {
          const n = parseInt(k, 10);
          if (!isNaN(n) && n > 0 && v && typeof v === 'object') {
            const vv = v as { name?: string };
            tileTypeNames[n] = String(vv.name ?? '障碍');
          }
        }
      }
    } catch {
      /* ignore */
    }
    const mapW = Math.max(1, row.width);
    const mapH = Math.max(1, row.height);

    // 校验 tile_data 与地图尺寸一致，避免越界
    const tileRows = Array.isArray(tileData) ? tileData.length : 0;
    const tileCols = tileRows > 0 && Array.isArray(tileData[0]) ? (tileData[0] as number[]).length : 0;
    if (tileRows < mapH || tileCols < mapW) {
      console.warn(`[wander] 地图 ${mapId} tile_data 尺寸(${tileRows}x${tileCols}) 与 width×height(${mapW}x${mapH}) 不一致，跳过本 tick`);
      return;
    }

    const ids = npcIds.map(Number).filter(Boolean);
    if (ids.length === 0) return;

    // 获取所有 NPC 的配置（含无 ai_config 的），每个 NPC 独立判断
    const [npcRows] = await pool.execute(
      `SELECT n.id, n.name, n.personality, n.ai_config_id, c.api_key, c.base_url, c.provider, c.model, c.max_tokens
       FROM npc n
       LEFT JOIN ai_config c ON n.ai_config_id = c.id AND c.status = 1
       WHERE n.id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const npcConfigMap = new Map(
      (npcRows as { id: number; name: string; personality: string | null; ai_config_id: number; api_key: string | null; base_url: string | null; provider: string; model: string; max_tokens: number }[]).map((r) => [
        r.id,
        {
          name: r.name,
          personality: r.personality || '',
          aiConfigId: r.ai_config_id,
          llmConfig: r.api_key ? { api_key: r.api_key, base_url: r.base_url, provider: r.provider, model: r.model, max_tokens: r.max_tokens } : null,
        },
      ])
    );

    // 1. 顺序处理 idle NPC 移动，确保不重叠（目标格已有其他 NPC 则停留）
    /** 已占用格子：处理过程中实时更新 */
    const occupied = new Map<string, string>();
    const updateOccupied = async () => {
      occupied.clear();
      for (const id of npcIds) {
        const d = await redis.hgetall(`map:${mapId}:npc:${id}`);
        if (d?.x != null && d?.y != null) {
          occupied.set(`${d.x},${d.y}`, id);
        }
      }
    };

    await updateOccupied();

    for (const npcId of npcIds) {
      try {
        const key = `map:${mapId}:npc:${npcId}`;
        const data = await redis.hgetall(key);
        if (!data) continue;
        if (data.state && data.state !== 'idle') continue;

        const curX = Math.max(0, Math.min(mapW - 1, Number(data.x || 0)));
        const curY = Math.max(0, Math.min(mapH - 1, Number(data.y || 0)));
        occupied.delete(`${curX},${curY}`);

        let dx: number;
        let dy: number;
        let thinking = '';

        if (USE_AI) {
          const cfg = npcConfigMap.get(Number(npcId));
          if (cfg?.llmConfig) {
            const surroundingContext = getSurroundingContext(curX, curY, tileData, mapW, mapH, tileTypeNames);
            const result = await getAiDirection(cfg.name, cfg.personality, curX, curY, mapW, mapH, cfg.llmConfig, {
              logContext: { map_id: mapId, npc_id: Number(npcId), ai_config_id: cfg.aiConfigId },
              surroundingContext: surroundingContext || undefined,
            });
            thinking = result.thinking;
            if (result.direction) {
              [dx, dy] = result.direction;
            } else {
              [dx, dy] = getRandomOffset();
            }
          } else {
            [dx, dy] = getRandomOffset();
            thinking = `随机向${getDirectionName(dx, dy)}走动`;
          }
        } else {
          [dx, dy] = getRandomOffset();
          thinking = `随机向${getDirectionName(dx, dy)}走动`;
        }

        let nx = curX + dx;
        let ny = curY + dy;

        const inBounds = nx >= 0 && nx < mapW && ny >= 0 && ny < mapH;
        const walkable = inBounds && (tileData[ny]?.[nx] ?? 0) === 0;
        const notOccupied = !occupied.has(`${nx},${ny}`);

        if (!inBounds || !walkable || !notOccupied) {
          nx = curX;
          ny = curY;
        } else {
          occupied.set(`${nx},${ny}`, npcId);
        }

        if (thinking) {
          saveWanderThought(Number(npcId), thinking).catch(() => {});
        }

        await redis.hset(key, 'x', String(nx));
        await redis.hset(key, 'y', String(ny));
        await redis.hset(key, 'state', data.state || 'idle');
        await redis.hset(key, 'groupId', data.groupId || '');
        await redis.hset(key, 'updatedAt', Date.now().toString());
      } catch (e) {
        console.warn('[wander] NPC', npcId, '决策失败，跳过:', e);
      }
    }

    // 2. 按距离分组，相遇组生成「看到对方的思考」
    const { conversationGroups } = await divideIntoGroups(mapId, npcIds);
    for (const group of conversationGroups) {
      await handleEncounter(mapId, group, npcConfigMap);
    }
  } catch (err) {
    console.error('[wander] map:', mapId, err);
  }
}

/** Redis key：地图是否暂停（值为 "1" 表示暂停） */
export const PAUSED_KEY_PREFIX = 'map:';
export const PAUSED_KEY_SUFFIX = ':paused';

/** 检查地图是否被暂停 */
export async function isMapPaused(mapId: string): Promise<boolean> {
  const v = await redis.get(`${PAUSED_KEY_PREFIX}${mapId}${PAUSED_KEY_SUFFIX}`);
  return v === '1';
}

async function wanderTick() {
  try {
    const keys = await redis.keys('map:*:npcs');
    const mapIds = [...new Set(keys.map((k) => k.split(':')[1]))];
    for (const mapId of mapIds) {
      // 跳过已暂停的地图
      if (await isMapPaused(mapId)) continue;
      const prev = mapLocks.get(mapId) ?? Promise.resolve();
      const current = prev.then(() => wanderOneMap(mapId)).catch((e) => console.error('[wander] map error:', mapId, e));
      mapLocks.set(mapId, current);
      await current;
    }
  } catch (err) {
    console.error('[wander] tick error:', err);
  }
}

export function startWanderLoop() {
  setInterval(wanderTick, WANDER_INTERVAL_MS);
  console.log('[wander] NPC 自主移动已启动，间隔', WANDER_INTERVAL_MS, 'ms，AI 决策:', USE_AI ? '开启' : '关闭');
}

/** 暂停指定地图的 NPC 移动 */
export async function pauseMap(mapId: string): Promise<void> {
  await redis.set(`${PAUSED_KEY_PREFIX}${mapId}${PAUSED_KEY_SUFFIX}`, '1');
}

/** 恢复指定地图的 NPC 移动 */
export async function resumeMap(mapId: string): Promise<void> {
  await redis.del(`${PAUSED_KEY_PREFIX}${mapId}${PAUSED_KEY_SUFFIX}`);
}
