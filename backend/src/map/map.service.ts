/**
 * 地图业务服务层
 * 抽离 controller 中的核心业务逻辑，便于复用与测试
 */
import { pool } from '../db/connection.js';
import { redis } from '../db/redis.js';
import {
  deriveTileDataFromBindings,
  deriveTileDataFromItems,
  findOrCreateItem,
  getTileTypesForMap,
} from '../services/itemMap.js';
import type { GenerateMapItem, GenerateMapResult, TileTypeDef } from './map.types.js';

/** 构建 AI 地图生成提示词（初稿） */
export function buildMapGeneratePrompt(hint: string): string {
  return `你是一位专业 2D 场景设计师，负责为游戏/模拟器生成地图布局。请根据用户描述，输出符合要求的 JSON 配置。

【用户需求】
${hint}

【设计要求】
- 贴合现代审美：可涵盖联合办公、咖啡馆、创意工作室、现代公寓、科技园区、城市公园、购物中心、大学校园等场景
- 避免刻板印象：不要千篇一律的「小镇广场」「两室一厅」等模板化布局，根据用户具体描述灵活设计
- 配色建议：使用协调的现代配色（如 #2c3e50 / #3498db / #ecf0f1 或 #1a1a2e / #16213e / #0f3460 等），避免过于刺眼或俗气的颜色
- 布局合理：建筑/设施之间有足够通道（≥1 格），可行走区域连通，不出现孤岛

【输出格式】仅返回 JSON，不要输出任何解释或 markdown。
{
  "name": "地图名称",
  "width": 12,
  "height": 12,
  "tile_types": { "1": {"name":"类型名","color":"#hex"} },
  "items": [
    {
      "name": "物品/建筑名",
      "category": "building|object",
      "description": "简短描述",
      "footprint": [[1,1,1],[1,0,1],[1,1,1]],
      "tile_value": 1,
      "pos_x": 0,
      "pos_y": 0
    }
  ]
}

【footprint 说明】二维数组：1=墙体/障碍物（不可行走），0=门洞/通道/室内空间（可行走）。多个物品的 footprint 会叠加到同一张地图上。

【尺寸参考】室内 10×10～14×16，室外 12×12～20×20，根据场景复杂度调整。

【示例-现代咖啡馆街区】
{"name":"街角咖啡馆区","width":14,"height":12,"tile_types":{"1":{"name":"建筑","color":"#34495e"},"2":{"name":"绿植","color":"#27ae60"},"3":{"name":"户外座位","color":"#95a5a6"}},"items":[{"name":"主咖啡馆","category":"building","description":"带落地窗的现代咖啡馆","footprint":[[1,1,1,1,1],[1,0,0,0,1],[1,0,0,0,1],[1,1,0,1,1]],"tile_value":1,"pos_x":1,"pos_y":2},{"name":"露天座椅区","category":"object","description":"遮阳伞桌椅","footprint":[[1,1,1],[1,0,1],[1,1,1]],"tile_value":3,"pos_x":7,"pos_y":4},{"name":"绿植花坛","category":"object","description":"街角绿化","footprint":[[1,1],[1,1]],"tile_value":2,"pos_x":10,"pos_y":2}]}`;
}

/** 室内布局图转地图的 Vision 提示词 */
export const LAYOUT_TO_MAP_PROMPT = `这是一张室内布局图/户型图/平面图。请识别图中的：
- 墙体（黑色/深色线条或填充）→ 对应 footprint 中的 1 或 tile_data 中的障碍
- 门洞、通道、室内空间（空白或浅色）→ 对应 footprint 中的 0 或 tile_data 中的可行走区域

将布局转换为游戏地图 JSON 格式。要求：
1. 保持大致比例和拓扑结构，房间、门洞、走廊需正确对应
2. 可适当简化细节（如忽略装饰线条），保证可行走区域连通
3. 若为多房间户型，每个房间用 item 表示，或合并为一个整户 item
4. tile_types 按墙体、门窗等类型区分，配色协调

【输出格式】仅返回 JSON，不要输出任何解释。
{
  "name": "地图名称（根据布局推断，如：两室一厅、办公室）",
  "width": 12,
  "height": 12,
  "tile_types": { "1": {"name":"墙体","color":"#34495e"}, "2": {"name":"门","color":"#7f8c8d"} },
  "items": [
    {
      "name": "房间/区域名",
      "category": "building",
      "description": "简短描述",
      "footprint": [[1,1,1],[1,0,1],[1,1,1]],
      "tile_value": 1,
      "pos_x": 0,
      "pos_y": 0
    }
  ]
}

footprint 规则：1=墙/障碍，0=门/通道/可行走。`;

/** 各 provider 进行图片识别时强制使用的 Vision 模型 */
export const VISION_MODEL_OVERRIDES: Record<string, string> = {
  OpenAI: 'gpt-4o',
  Groq: 'meta-llama/llama-4-scout-17b-16e-instruct',
  通义千问: 'qwen-vl-max',
  智谱: 'glm-4v',
};

/** 构建多轮修改时的提示词 */
export function buildMapRefinePrompt(hint: string, currentMapJson: string): string {
  return `用户希望对已有地图进行修改。请根据修改要求，输出**完整的**新地图 JSON（覆盖替换，而非增量）。

【当前地图】
${currentMapJson}

【用户修改要求】
${hint}

【输出要求】
- 仅返回完整 JSON，格式与初稿一致，不要输出解释
- 保留用户未要求改动的部分，按要求修改指定内容
- 修改后需保证：可行走区域连通、布局合理、尺寸合法`;
}

/** 从 LLM 返回文本中提取并解析地图 JSON */
export function parseMapGenerateJson(text: string): GenerateMapResult {
  let raw = text.trim();
  const jsonBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlock) raw = jsonBlock[1]!.trim();

  const defaultTileTypes: Record<number, TileTypeDef> = {
    1: { name: '建筑', color: '#444444' },
    2: { name: '喷泉', color: '#5dade2' },
    3: { name: '水域', color: '#2874a6' },
  };
  const fallback: GenerateMapResult = {
    name: '未命名地图',
    width: 10,
    height: 10,
    items: [],
    tile_types: defaultTileTypes,
    tile_data: Array.from({ length: 10 }, () => Array(10).fill(0)),
  };

  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const name = String(obj.name ?? '未命名地图');
    const width = Math.max(8, Math.min(200, Number(obj.width) || 10));
    const height = Math.max(8, Math.min(200, Number(obj.height) || 10));

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
    if (Object.keys(tileTypes).length === 0) tileTypes = { ...defaultTileTypes };

    const items: GenerateMapItem[] = [];
    const arr = obj.items;
    if (Array.isArray(arr)) {
      for (const it of arr) {
        const fp = it.footprint;
        if (!Array.isArray(fp) || fp.length === 0) continue;
        const rot = it.rotation != null ? Number(it.rotation) % 4 : 0;
        const rows = fp.length;
        const cols = fp[0]?.length ?? 0;
        const fw = rot === 1 || rot === 3 ? rows : cols;
        const fh = rot === 1 || rot === 3 ? cols : rows;
        let px = Math.max(0, Number(it.pos_x) || 0);
        let py = Math.max(0, Number(it.pos_y) || 0);
        if (px + fw > width) px = Math.max(0, width - fw);
        if (py + fh > height) py = Math.max(0, height - fh);
        items.push({
          name: String(it.name ?? '物品'),
          category: it.category ? String(it.category) : 'object',
          description: it.description ? String(it.description) : undefined,
          footprint: fp as number[][],
          tile_value: Math.max(1, Number(it.tile_value) || 1),
          pos_x: px,
          pos_y: py,
          rotation: it.rotation != null ? Number(it.rotation) : undefined,
        });
      }
    }

    for (const it of items) {
      const tv = it.tile_value;
      if (tv > 0 && !tileTypes[tv]) {
        tileTypes[tv] = defaultTileTypes[tv as keyof typeof defaultTileTypes] ?? { name: `类型${tv}`, color: '#444444' };
      }
    }

    const tileData = deriveTileDataFromBindings(
      width,
      height,
      items.map((i) => ({
        footprint: i.footprint,
        tile_value: i.tile_value,
        pos_x: i.pos_x,
        pos_y: i.pos_y,
        rotation: i.rotation,
      }))
    );
    return { name, width, height, items, tile_types: tileTypes, tile_data: tileData };
  } catch {
    return fallback;
  }
}

/**
 * 场景初始化核心逻辑：从 npc_map_binding 加载到 Redis
 * @returns 写入的 NPC 数量
 */
export async function initSceneData(mapId: string): Promise<{ npcCount: number }> {
  const [bindings] = await pool.execute(
    'SELECT npc_id FROM npc_map_binding WHERE map_id = ?',
    [mapId]
  );
  const list = bindings as { npc_id: number }[];
  if (list.length === 0) return { npcCount: 0 };

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

/**
 * 创建地图（物品驱动或 tile_data 直接传入）
 */
export async function createMapData(params: {
  name: string;
  width: number;
  height: number;
  items?: Array<{ item_id?: number; name?: string; category?: string; description?: string; footprint?: number[][]; tile_value?: number; pos_x: number; pos_y: number; rotation?: number }>;
  tile_data?: number[][];
  metadata?: Record<string, unknown>;
}): Promise<{ id: number }> {
  const { name, width, height, items, tile_data, metadata } = params;
  const w = Math.max(1, Math.min(200, width));
  const h = Math.max(1, Math.min(200, height));
  const metaStr = metadata ? JSON.stringify(metadata) : null;

  if (items && items.length > 0) {
    const [mapIns] = await pool.execute(
      'INSERT INTO game_map (name, width, height, tile_data, metadata) VALUES (?, ?, ?, ?, ?)',
      [name, w, h, JSON.stringify(Array.from({ length: h }, () => Array(w).fill(0))), metaStr]
    );
    const mapId = (mapIns as { insertId: number }).insertId;

    const tileTypes = metadata?.tile_types as Record<number, { name: string; color: string }> | undefined;
    for (const it of items) {
      let itemId: number;
      if (it.item_id) {
        itemId = Number(it.item_id);
        if (!itemId) continue;
      } else if (it.name && it.footprint) {
        const color = tileTypes?.[it.tile_value ?? 1]?.color;
        itemId = await findOrCreateItem({
          name: it.name,
          category: it.category,
          description: it.description,
          footprint: it.footprint,
          tile_value: it.tile_value,
          metadata: color ? { color } : undefined,
        });
      } else continue;

      await pool.execute(
        'INSERT INTO item_map_binding (item_id, map_id, pos_x, pos_y, rotation) VALUES (?, ?, ?, ?, ?)',
        [itemId, mapId, Number(it.pos_x) || 0, Number(it.pos_y) || 0, it.rotation ?? 0]
      );
    }

    const grid = await deriveTileDataFromItems(mapId, w, h);
    const finalMeta = tileTypes ? { tile_types: tileTypes } : await getTileTypesForMap(mapId);
    await pool.execute('UPDATE game_map SET tile_data = ?, metadata = ? WHERE id = ?', [
      JSON.stringify(grid),
      JSON.stringify(finalMeta),
      mapId,
    ]);
    return { id: mapId };
  }

  const tileDataStr = tile_data
    ? JSON.stringify(tile_data)
    : JSON.stringify(Array.from({ length: h }, () => Array(w).fill(0)));
  const [result] = await pool.execute(
    'INSERT INTO game_map (name, width, height, tile_data, metadata) VALUES (?, ?, ?, ?, ?)',
    [name, w, h, tileDataStr, metaStr]
  );
  const r = result as { insertId: number };
  return { id: r.insertId };
}
