/**
 * 地图与场景控制器
 * game_map CRUD、npc_map_binding、场景初始化（写入 Redis）
 */
import { Request, Response } from 'express';
import { pool } from '../db/connection.js';
import { redis } from '../db/redis.js';
import { chatCompletion } from '../utils/llmClient.js';
import { pauseMap, resumeMap, isMapPaused } from '../services/wander.js';

/** 获取地图列表 */
export async function getMapList(req: Request, res: Response) {
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, width, height, status, created_at
       FROM game_map ORDER BY id DESC`
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    console.error('getMapList:', err);
    res.status(500).json({ code: -1, message: '获取地图列表失败' });
  }
}

/** 根据 ID 获取地图详情（含 tile_data） */
export async function getMapById(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT * FROM game_map WHERE id = ?`,
      [id]
    );
    const list = rows as Record<string, unknown>[];
    if (list.length === 0) {
      return res.status(404).json({ code: -1, message: '地图不存在' });
    }
    const row = list[0];
    if (typeof row.tile_data === 'string') {
      row.tile_data = JSON.parse(row.tile_data as string);
    }
    res.json({ code: 0, data: row });
  } catch (err) {
    console.error('getMapById:', err);
    res.status(500).json({ code: -1, message: '获取地图失败' });
  }
}

/**
 * AI 生成地图配置（名称、尺寸、tile_data）
 * 入参：ai_config_id, hint（描述，如「小镇广场，中间有喷泉」）
 */
export async function generateMapContent(req: Request, res: Response) {
  try {
    const body = req.body as { ai_config_id: number; hint?: string };
    const { ai_config_id, hint } = body;

    if (!ai_config_id) {
      return res.status(400).json({ code: -1, message: '请选择 AI 配置' });
    }
    const inputText = (hint?.trim() || '').replace(/\s+/g, ' ');
    if (!inputText) {
      return res.status(400).json({ code: -1, message: '请填写地图描述' });
    }

    const [rows] = await pool.execute(
      'SELECT id, provider, api_key, base_url, model, max_tokens FROM ai_config WHERE id = ? AND status = 1',
      [ai_config_id]
    );
    const list = rows as unknown[];
    if (list.length === 0) {
      return res.status(404).json({ code: -1, message: 'AI 配置不存在或已禁用' });
    }
    const cfg = list[0] as { api_key: string | null; base_url: string | null; provider: string; model: string; max_tokens: number };

    const prompt = `你是游戏地图设计助手，根据用户描述生成 2D 地图配置。需符合现实空间逻辑。

用户描述：${inputText}

【数据格式】
- name：地图名称，与描述相符
- width、height：8～200
- tile_data：二维数组，行数=height，每行长度=width
- tile_types：障碍类型定义，key 为 "1"、"2" 等，value 含 name、color（十六进制如 #444444）

【格子语义】
- 0：可行走（道路、室内地板、门）
- 非 0：障碍（墙体、喷泉、水域、树木等不可通过）

【建筑规则】建筑（房屋、商店、庙宇等）必须可出入：
1. 墙体用障碍值围成闭合轮廓，内部用 0 表示室内
2. 门：墙体上至少有一格 0 作为门洞，且门洞必须紧邻室外道路（0），与室内 0 连通
3. 门应朝向前方道路，不可朝向墙或死胡同
4. 室内至少 2×2 可行走空间
5. 所有建筑内部须能从室外通过门进入，不可出现孤岛

【其他元素】喷泉、池塘、树木、石雕等：用障碍值完全填充，不可穿越

【连通性】室外道路（0）应连通各建筑门洞，形成可达路网

请只返回 JSON，不要其他文字。示例（小镇广场，左有房屋右有喷泉）：
{
  "name": "小镇广场",
  "width": 14,
  "height": 10,
  "tile_types": {
    "1": {"name":"建筑墙体","color":"#444444"},
    "2": {"name":"喷泉","color":"#5dade2"}
  },
  "tile_data": [
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,1,1,1,1,0,0,0,0,0,2,2,0],
    [0,0,1,0,0,1,0,0,0,0,0,2,2,0],
    [0,0,1,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,1,1,1,1,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0]
  ]
}`;

    const content = await chatCompletion(
      {
        api_key: cfg.api_key!,
        base_url: cfg.base_url,
        provider: cfg.provider,
        model: cfg.model,
        max_tokens: cfg.max_tokens,
      },
      [{ role: 'user', content: prompt }],
      { timeout: 45000, max_tokens: 2000, logContext: { source: 'map_generate', ai_config_id } }
    );

    const parsed = parseMapGenerateJson(content);
    res.json({ code: 0, data: parsed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '生成失败';
    console.error('generateMapContent:', err);
    res.status(500).json({ code: -1, message: msg });
  }
}

export type TileTypeDef = { name: string; color: string };

/** 从 LLM 返回文本中提取并解析地图 JSON，含动态 tile_types */
function parseMapGenerateJson(text: string): {
  name: string;
  width: number;
  height: number;
  tile_data: number[][];
  tile_types: Record<number, TileTypeDef>;
} {
  let raw = text.trim();
  const jsonBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlock) {
    raw = jsonBlock[1]!.trim();
  }
  const defaultTileTypes: Record<number, TileTypeDef> = {
    1: { name: '建筑', color: '#444444' },
    2: { name: '喷泉', color: '#5dade2' },
    3: { name: '水域', color: '#2874a6' },
  };
  const fallback = {
    name: '未命名地图',
    width: 10,
    height: 10,
    tile_data: Array.from({ length: 10 }, () => Array(10).fill(0)),
    tile_types: defaultTileTypes,
  };
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const name = String(obj.name ?? '未命名地图');
    const width = Math.max(8, Math.min(200, Number(obj.width) || 10));
    const height = Math.max(8, Math.min(200, Number(obj.height) || 10));

    // 解析 tile_types：AI 根据描述动态生成
    let tileTypes: Record<number, TileTypeDef> = {};
    const tt = obj.tile_types;
    if (tt && typeof tt === 'object' && !Array.isArray(tt)) {
      for (const [k, v] of Object.entries(tt)) {
        const n = parseInt(k, 10);
        if (!isNaN(n) && n > 0 && v && typeof v === 'object') {
          const vv = v as Record<string, unknown>;
          tileTypes[n] = {
            name: String(vv.name ?? '障碍'),
            color: String(vv.color ?? '#444444').replace(/^#?/, '#'),
          };
        }
      }
    }
    if (Object.keys(tileTypes).length === 0) tileTypes = defaultTileTypes;

    let tileData = obj.tile_data;
    if (!Array.isArray(tileData)) {
      tileData = Array.from({ length: height }, () => Array(width).fill(0));
    }
    const rows = tileData as unknown[];
    const grid: number[][] = [];
    const typeKeys = new Set(Object.keys(tileTypes).map(Number));
    for (let y = 0; y < height; y++) {
      const row = Array.isArray(rows[y]) ? (rows[y] as unknown[]) : [];
      grid.push([]);
      for (let x = 0; x < width; x++) {
        const v = Number(row[x]) || 0;
        grid[y]!.push(v === 0 || typeKeys.has(v) ? v : 0);
      }
    }
    return { name, width, height, tile_data: grid, tile_types: tileTypes };
  } catch {
    return fallback;
  }
}

/** 新增地图 */
export async function createMap(req: Request, res: Response) {
  try {
    const { name, width, height, tile_data, metadata } = req.body;
    if (!name || width == null || height == null || !tile_data) {
      return res.status(400).json({ code: -1, message: 'name、width、height、tile_data 为必填' });
    }
    const tileDataStr = typeof tile_data === 'string' ? tile_data : JSON.stringify(tile_data);
    const metaStr = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;

    const [result] = await pool.execute(
      `INSERT INTO game_map (name, width, height, tile_data, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [name, width, height, tileDataStr, metaStr]
    );
    const r = result as { insertId: number };
    res.json({ code: 0, data: { id: r.insertId }, message: '创建成功' });
  } catch (err) {
    console.error('createMap:', err);
    res.status(500).json({ code: -1, message: '创建地图失败' });
  }
}

/** 更新地图 */
export async function updateMap(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { name, width, height, tile_data, metadata, status } = req.body;
    const updates: string[] = [];
    const params: unknown[] = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (width !== undefined) { updates.push('width = ?'); params.push(width); }
    if (height !== undefined) { updates.push('height = ?'); params.push(height); }
    if (tile_data !== undefined) {
      updates.push('tile_data = ?');
      params.push(typeof tile_data === 'string' ? tile_data : JSON.stringify(tile_data));
    }
    if (metadata !== undefined) {
      updates.push('metadata = ?');
      params.push(metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null);
    }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }

    if (updates.length === 0) {
      return res.status(400).json({ code: -1, message: '无有效更新字段' });
    }
    params.push(id);
    await pool.execute(
      `UPDATE game_map SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    res.json({ code: 0, message: '更新成功' });
  } catch (err) {
    console.error('updateMap:', err);
    res.status(500).json({ code: -1, message: '更新地图失败' });
  }
}

/** 删除地图 */
export async function deleteMap(req: Request, res: Response) {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM game_map WHERE id = ?', [id]);
    // 清理 Redis 中该地图相关 key
    const keys = await redis.keys(`map:${id}:*`);
    if (keys.length > 0) await redis.del(...keys);
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    console.error('deleteMap:', err);
    res.status(500).json({ code: -1, message: '删除地图失败' });
  }
}

/** 获取地图绑定的 NPC 列表 */
export async function getMapBindings(req: Request, res: Response) {
  try {
    const { mapId } = req.params;
    const [rows] = await pool.execute(
      `SELECT b.id, b.npc_id, b.map_id, b.init_x, b.init_y, n.name as npc_name, n.avatar
       FROM npc_map_binding b
       JOIN npc n ON b.npc_id = n.id
       WHERE b.map_id = ? ORDER BY b.id`,
      [mapId]
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    console.error('getMapBindings:', err);
    res.status(500).json({ code: -1, message: '获取绑定列表失败' });
  }
}

/** 添加 NPC 到地图 */
export async function addMapBinding(req: Request, res: Response) {
  try {
    const { mapId } = req.params;
    const { npc_id, init_x = 0, init_y = 0 } = req.body;
    if (!npc_id) {
      return res.status(400).json({ code: -1, message: 'npc_id 为必填' });
    }
    await pool.execute(
      `INSERT INTO npc_map_binding (npc_id, map_id, init_x, init_y)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE init_x = ?, init_y = ?`,
      [npc_id, mapId, init_x, init_y, init_x, init_y]
    );
    res.json({ code: 0, message: '添加成功' });
  } catch (err) {
    console.error('addMapBinding:', err);
    res.status(500).json({ code: -1, message: '添加绑定失败' });
  }
}

/** 移除地图上的 NPC */
export async function removeMapBinding(req: Request, res: Response) {
  try {
    const { mapId, npcId } = req.params;
    await pool.execute(
      'DELETE FROM npc_map_binding WHERE map_id = ? AND npc_id = ?',
      [mapId, npcId]
    );
    await redis.del(`map:${mapId}:npc:${npcId}`);
    await redis.srem(`map:${mapId}:npcs`, npcId);
    res.json({ code: 0, message: '移除成功' });
  } catch (err) {
    console.error('removeMapBinding:', err);
    res.status(500).json({ code: -1, message: '移除绑定失败' });
  }
}

/**
 * 场景初始化核心逻辑：从 npc_map_binding 加载到 Redis
 * @returns 写入的 NPC 数量
 */
async function initSceneData(mapId: string): Promise<{ npcCount: number }> {
  const [bindings] = await pool.execute(
    'SELECT npc_id FROM npc_map_binding WHERE map_id = ?',
    [mapId]
  );
  const list = bindings as { npc_id: number }[];
  if (list.length === 0) {
    return { npcCount: 0 };
  }

  const [mapRow] = await pool.execute(
    'SELECT width, height, tile_data FROM game_map WHERE id = ?',
    [mapId]
  );
  const row = (mapRow as { width: number; height: number; tile_data: string }[])[0];
  if (!row) return { npcCount: 0 };

  const mapW = Math.max(1, row.width);
  const mapH = Math.max(1, row.height);

  let tileData: number[][];
  try {
    tileData = typeof row.tile_data === 'string' ? JSON.parse(row.tile_data) : (row.tile_data as unknown as number[][]);
  } catch {
    tileData = [];
  }
  const tileRows = Array.isArray(tileData) ? tileData.length : 0;
  const tileCols = tileRows > 0 && Array.isArray(tileData[0]) ? (tileData[0] as number[]).length : 0;
  const effectiveW = tileCols >= mapW ? mapW : Math.max(1, tileCols);
  const effectiveH = tileRows >= mapH ? mapH : Math.max(1, tileRows);

  /** 可行走格子列表（0=可行走） */
  const walkable: [number, number][] = [];
  for (let y = 0; y < effectiveH; y++) {
    for (let x = 0; x < effectiveW; x++) {
      const val = tileData[y]?.[x] ?? 0;
      if (val === 0) walkable.push([x, y]);
    }
  }

  if (walkable.length < list.length) {
    console.warn('[initScene] 可行走格子不足，NPC 数:', list.length, '可走:', walkable.length);
  }

  /** 打乱可行走格子，随机分配且不重叠 */
  for (let i = walkable.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [walkable[i], walkable[j]] = [walkable[j], walkable[i]];
  }

  const now = Date.now().toString();
  const keyNpcs = `map:${mapId}:npcs`;
  await redis.del(keyNpcs);

  const used = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const [initX, initY] = walkable[i] ?? [
      Math.floor(Math.random() * effectiveW),
      Math.floor(Math.random() * effectiveH),
    ];
    const posKey = `${initX},${initY}`;
    let finalX = initX;
    let finalY = initY;
    if (used.has(posKey)) {
      for (let y = 0; y < effectiveH; y++) {
        let found = false;
        for (let x = 0; x < effectiveW; x++) {
          const pk = `${x},${y}`;
          if (!used.has(pk) && (tileData[y]?.[x] ?? 0) === 0) {
            finalX = x;
            finalY = y;
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }
    used.add(`${finalX},${finalY}`);

    const key = `map:${mapId}:npc:${b.npc_id}`;
    await redis.hset(key, 'x', String(finalX));
    await redis.hset(key, 'y', String(finalY));
    await redis.hset(key, 'state', 'idle');
    await redis.hset(key, 'groupId', '');
    await redis.hset(key, 'updatedAt', now);
    await redis.sadd(keyNpcs, String(b.npc_id));
  }

  return { npcCount: list.length };
}

/** 场景初始化：从 npc_map_binding 加载到 Redis */
export async function initScene(req: Request, res: Response) {
  try {
    const { mapId } = req.params;
    const { npcCount } = await initSceneData(mapId);
    if (npcCount === 0) {
      return res.json({ code: 0, data: { npcCount: 0 }, message: '空地图，未启动' });
    }
    res.json({ code: 0, data: { npcCount }, message: '场景已初始化' });
  } catch (err) {
    console.error('initScene:', err);
    const msg = err instanceof Error ? err.message : '场景初始化失败';
    const hint = msg.includes('ECONNREFUSED')
      ? 'Redis 未启动，请先运行 redis-server'
      : msg.includes('auth') || msg.includes('NOAUTH')
        ? 'Redis 密码错误，请检查 REDIS_URL'
        : msg;
    res.status(500).json({ code: -1, message: hint });
  }
}

/** 开始：按当前所在位置继续移动（有 Redis 数据则保留位置只恢复；无则首次初始化） */
export async function startMap(req: Request, res: Response) {
  try {
    const { mapId } = req.params;
    const npcIds = await redis.smembers(`map:${mapId}:npcs`);
    if (npcIds.length === 0) {
      // 首次启动：从 npc_map_binding 初始化到 Redis
      const { npcCount } = await initSceneData(mapId);
      if (npcCount === 0) {
        return res.json({ code: 0, data: { npcCount: 0 }, message: '空地图，无法启动' });
      }
      await resumeMap(mapId);
      return res.json({ code: 0, data: { npcCount }, message: '已启动' });
    }
    // 已有数据：不重置位置，仅恢复 wander
    await resumeMap(mapId);
    res.json({ code: 0, data: { npcCount: npcIds.length }, message: '已恢复' });
  } catch (err) {
    console.error('startMap:', err);
    const msg = err instanceof Error ? err.message : '启动失败';
    const hint = msg.includes('ECONNREFUSED')
      ? 'Redis 未启动，请先运行 redis-server'
      : msg.includes('auth') || msg.includes('NOAUTH')
        ? 'Redis 密码错误，请检查 REDIS_URL'
        : msg;
    res.status(500).json({ code: -1, message: hint });
  }
}

/** 暂停：停止该地图 NPC 移动 */
export async function pauseMapController(req: Request, res: Response) {
  try {
    const { mapId } = req.params;
    await pauseMap(mapId);
    res.json({ code: 0, message: '已暂停' });
  } catch (err) {
    console.error('pauseMap:', err);
    res.status(500).json({ code: -1, message: '暂停失败' });
  }
}

/** 恢复：恢复该地图 NPC 移动 */
export async function resumeMapController(req: Request, res: Response) {
  try {
    const { mapId } = req.params;
    await resumeMap(mapId);
    res.json({ code: 0, message: '已恢复' });
  } catch (err) {
    console.error('resumeMap:', err);
    res.status(500).json({ code: -1, message: '恢复失败' });
  }
}

/** 获取场景内 NPC 实时状态（从 Redis 读取，合并 npc.avatar；Redis 空时从 npc_map_binding 兜底） */
export async function getSceneState(req: Request, res: Response) {
  try {
    const { mapId } = req.params;
    let npcIds = await redis.smembers(`map:${mapId}:npcs`);

    // Redis 无数据时，从 npc_map_binding 兜底返回初始位置（需先调用 init 才会写入 Redis）
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
      }));
      // 未初始化到 Redis 时视为未启动，显示「开始」按钮
      return res.json({ code: 0, data: { npcs, running: false, _source: 'binding' } });
    }

    const [avatarRows] = await pool.execute(
      `SELECT id, avatar FROM npc WHERE id IN (${npcIds.map(() => '?').join(',')})`,
      npcIds.map(Number)
    );
    const avatarMap = new Map(
      (avatarRows as { id: number; avatar: string | null }[]).map((r) => [r.id, r.avatar])
    );

    const npcs: { npc_id: number; x: number; y: number; state: string; groupId: string; avatar?: string; thinking?: string }[] = [];
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
          thinking: undefined, // 下面批量查询填充
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

    const running = !(await isMapPaused(mapId));
    res.json({ code: 0, data: { npcs, running } });
  } catch (err) {
    console.error('getSceneState:', err);
    res.status(500).json({ code: -1, message: '获取场景状态失败' });
  }
}
