/**
 * 地图与场景控制器
 * game_map CRUD、item 驱动 tile_data、npc_map_binding、场景初始化（写入 Redis）
 */
import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { pool } from '../db/connection.js';
import { redis } from '../db/redis.js';
import { chatCompletion } from '../utils/llmClient.js';
import { pauseMap, resumeMap } from '../services/wander.js';
import {
  deriveTileDataFromItems,
  deriveTileDataFromBindings,
  findOrCreateItem,
  getTileTypesForMap,
} from '../services/itemMap.js';

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
 * 构建 AI 地图生成提示词（初稿）
 * 语义：footprint 中 1=障碍，0=可行走；tile_data 中 0=可行走，非0=障碍
 * 设计原则：现代多元、避免刻板、鼓励创意
 */
function buildMapGeneratePrompt(hint: string): string {
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

/**
 * 各 provider 进行图片识别时强制使用的 Vision 模型
 * 用户配置的 gpt-3.5、deepseek-chat 等文本模型不支持图片，此处覆盖为视觉模型
 */
const VISION_MODEL_OVERRIDES: Record<string, string> = {
  OpenAI: 'gpt-4o',
  Groq: 'meta-llama/llama-4-scout-17b-16e-instruct',
  通义千问: 'qwen-vl-max',
  智谱: 'glm-4v',
};

/**
 * 室内布局图转地图的 Vision 提示词
 * 配合图片输入，让 AI 识别墙体、房间、门洞等并输出地图 JSON
 */
const LAYOUT_TO_MAP_PROMPT = `这是一张室内布局图/户型图/平面图。请识别图中的：
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

/**
 * 构建多轮修改时的提示词
 * current_map_json: 当前地图的 JSON 字符串
 */
function buildMapRefinePrompt(hint: string, currentMapJson: string): string {
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

/**
 * AI 生成地图配置（支持多轮对话完善）
 * 入参：ai_config_id, hint, messages?（对话历史）, current_map?（当前地图，多轮修改时传入）
 */
export async function generateMapContent(req: Request, res: Response) {
  try {
    const body = req.body as {
      ai_config_id: number;
      hint?: string;
      /** 当前地图（多轮修改时传入，用于在现有基础上调整） */
      current_map?: { name: string; width: number; height: number; items?: unknown[]; tile_types?: Record<string, { name: string; color: string }> };
    };
    const { ai_config_id, hint, current_map } = body;

    if (!ai_config_id) {
      return res.status(400).json({ code: -1, message: '请选择 AI 配置' });
    }
    const inputText = (hint?.trim() || '').replace(/\s+/g, ' ');
    if (!inputText) {
      return res.status(400).json({ code: -1, message: '请填写地图描述或修改要求' });
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

    let messages: { role: 'user' | 'assistant'; content: string }[];
    if (current_map && current_map.name != null && current_map.width != null && current_map.height != null) {
      // 多轮修改：在现有地图基础上根据 hint 调整
      const currentJson = JSON.stringify({
        name: current_map.name,
        width: current_map.width,
        height: current_map.height,
        tile_types: current_map.tile_types ?? {},
        items: current_map.items ?? [],
      });
      const refinePrompt = buildMapRefinePrompt(inputText, currentJson);
      messages = [{ role: 'user', content: refinePrompt }];
    } else {
      // 初稿：根据描述生成新地图
      messages = [{ role: 'user', content: buildMapGeneratePrompt(inputText) }];
    }

    const content = await chatCompletion(
      {
        api_key: cfg.api_key!,
        base_url: cfg.base_url,
        provider: cfg.provider,
        model: cfg.model,
        max_tokens: Math.max(cfg.max_tokens, 3000),
      },
      messages,
      { timeout: 90000, max_tokens: 3000, logContext: { source: 'map_generate', ai_config_id } }
    );

    const parsed = parseMapGenerateJson(content);
    res.json({ code: 0, data: parsed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '生成失败';
    console.error('generateMapContent:', err);
    res.status(500).json({ code: -1, message: msg });
  }
}

/**
 * 室内布局图上传并转换为地图
 * 需要 Vision 模型（如 gpt-4o、gpt-4-vision、gemini-pro-vision 等）
 */
export async function convertLayoutImageToMap(req: Request, res: Response) {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ code: -1, message: '请上传室内布局图' });
    }

    const ai_config_id = Number(req.body?.ai_config_id);
    if (!ai_config_id) {
      return res.status(400).json({ code: -1, message: '请选择 AI 配置（需支持视觉的模型，如 gpt-4o）' });
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

    const fileBuffer = fs.readFileSync(file.path);
    const ext = path.extname(file.originalname || file.path).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const mime = mimeMap[ext] || file.mimetype || 'image/png';
    const base64 = fileBuffer.toString('base64');
    const dataUrl = `data:${mime};base64,${base64}`;

    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: LAYOUT_TO_MAP_PROMPT },
          { type: 'image_url' as const, image_url: { url: dataUrl } },
        ],
      },
    ];

    // 图片识别需视觉模型，对已知 provider 强制使用支持 Vision 的模型
    const visionModel = VISION_MODEL_OVERRIDES[cfg.provider];
    const modelForVision = visionModel ?? cfg.model;

    const content = await chatCompletion(
      {
        api_key: cfg.api_key!,
        base_url: cfg.base_url,
        provider: cfg.provider,
        model: modelForVision,
        max_tokens: Math.max(cfg.max_tokens, 3000),
      },
      messages,
      { timeout: 120000, max_tokens: 3000, logContext: { source: 'map_convert_layout', ai_config_id } }
    );

    const parsed = parseMapGenerateJson(content);
    res.json({ code: 0, data: parsed });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : '布局图转换失败';
    // 常见为模型不支持图片：引导用户使用支持视觉的配置（如 OpenAI gpt-4o）
    const hint = /vision|image|图片|multimodal|不支持/i.test(rawMsg)
      ? '当前 AI 配置的模型不支持图片识别，请选择支持视觉的配置（如 OpenAI 的 gpt-4o）'
      : rawMsg;
    console.error('convertLayoutImageToMap:', err);
    res.status(500).json({ code: -1, message: hint });
  } finally {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* 忽略清理失败 */
      }
    }
  }
}

export type TileTypeDef = { name: string; color: string };

/** AI 生成物品项 */
export interface GenerateMapItem {
  name: string;
  category?: string;
  description?: string;
  footprint: number[][];
  tile_value: number;
  pos_x: number;
  pos_y: number;
  rotation?: number;
}

/** 从 LLM 返回文本中提取并解析地图 JSON，含 items 和 tile_types */
function parseMapGenerateJson(text: string): {
  name: string;
  width: number;
  height: number;
  items: GenerateMapItem[];
  tile_types: Record<number, TileTypeDef>;
  tile_data: number[][];
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
    items: [] as GenerateMapItem[],
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

/** 新增地图（物品驱动：items 推导 tile_data；兼容 tile_data 直接传入以支持前端预览后创建） */
export async function createMap(req: Request, res: Response) {
  try {
    const { name, width, height, items, tile_data, metadata } = req.body;
    if (!name || width == null || height == null) {
      return res.status(400).json({ code: -1, message: 'name、width、height 为必填' });
    }
    const w = Math.max(1, Math.min(200, Number(width) || 10));
    const h = Math.max(1, Math.min(200, Number(height) || 10));

    let tileDataStr: string;
    let metaStr: string | null = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;

    if (items && Array.isArray(items) && items.length > 0) {
      const [mapIns] = await pool.execute(
        'INSERT INTO game_map (name, width, height, tile_data, metadata) VALUES (?, ?, ?, ?, ?)',
        [name, w, h, JSON.stringify(Array.from({ length: h }, () => Array(w).fill(0))), metaStr]
      );
      const mapId = (mapIns as { insertId: number }).insertId;

      for (const it of items) {
        let itemId: number;
        if (it.item_id) {
          itemId = Number(it.item_id);
          if (!itemId) continue;
        } else if (it.name && it.footprint) {
          const tileTypes = metaStr ? (JSON.parse(metaStr) as { tile_types?: Record<number, { name: string; color: string }> })?.tile_types : null;
          const color = tileTypes?.[it.tile_value]?.color;
          itemId = await findOrCreateItem({
            name: it.name,
            category: it.category,
            description: it.description,
            footprint: it.footprint,
            tile_value: it.tile_value,
            metadata: color ? { color } : undefined,
          });
        } else {
          continue;
        }
        await pool.execute(
          'INSERT INTO item_map_binding (item_id, map_id, pos_x, pos_y, rotation) VALUES (?, ?, ?, ?, ?)',
          [itemId, mapId, Number(it.pos_x) || 0, Number(it.pos_y) || 0, it.rotation ?? 0]
        );
      }

      const grid = await deriveTileDataFromItems(mapId, w, h);
      const tileTypes = metaStr ? (JSON.parse(metaStr) as { tile_types?: Record<number, { name: string; color: string }> })?.tile_types : null;
      const finalMeta = tileTypes ? { tile_types: tileTypes } : await getTileTypesForMap(mapId);
      await pool.execute('UPDATE game_map SET tile_data = ?, metadata = ? WHERE id = ?', [
        JSON.stringify(grid),
        JSON.stringify(finalMeta),
        mapId,
      ]);
      return res.json({ code: 0, data: { id: mapId }, message: '创建成功' });
    }

    if (tile_data) {
      tileDataStr = typeof tile_data === 'string' ? tile_data : JSON.stringify(tile_data);
    } else {
      tileDataStr = JSON.stringify(Array.from({ length: h }, () => Array(w).fill(0)));
    }
    const [result] = await pool.execute(
      `INSERT INTO game_map (name, width, height, tile_data, metadata) VALUES (?, ?, ?, ?, ?)`,
      [name, w, h, tileDataStr, metaStr]
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

/** 获取地图上的物品列表（含 item 详情） */
export async function getMapItems(req: Request, res: Response) {
  try {
    const { mapId } = req.params;
    const [rows] = await pool.execute(
      `SELECT b.id, b.item_id, b.map_id, b.pos_x, b.pos_y, b.rotation, i.name, i.category, i.description, i.footprint, i.tile_value
       FROM item_map_binding b
       JOIN item i ON b.item_id = i.id
       WHERE b.map_id = ?
       ORDER BY b.id`,
      [mapId]
    );
    const list = rows as Record<string, unknown>[];
    for (const r of list) {
      if (typeof r.footprint === 'string') r.footprint = JSON.parse(r.footprint as string);
    }
    res.json({ code: 0, data: list });
  } catch (err) {
    console.error('getMapItems:', err);
    res.status(500).json({ code: -1, message: '获取地图物品失败' });
  }
}

/** 在地图上放置物品，自动重算 tile_data */
export async function addMapItem(req: Request, res: Response) {
  try {
    const { mapId } = req.params;
    const body = req.body as { item_id?: number; name?: string; category?: string; description?: string; footprint?: number[][]; tile_value?: number; pos_x: number; pos_y: number; rotation?: number };
    const mapIdNum = Number(mapId);
    if (!mapIdNum) return res.status(400).json({ code: -1, message: '地图 ID 无效' });

    let itemId: number;
    if (body.item_id) {
      itemId = Number(body.item_id);
      if (!itemId) return res.status(400).json({ code: -1, message: 'item_id 无效' });
    } else if (body.name && body.footprint) {
      const meta = body.tile_value ? { color: '#444444' } : undefined;
      itemId = await findOrCreateItem({
        name: body.name,
        category: body.category,
        description: body.description,
        footprint: body.footprint,
        tile_value: body.tile_value,
        metadata: meta,
      });
    } else {
      return res.status(400).json({ code: -1, message: '需提供 item_id 或完整物品定义 (name, footprint)' });
    }

    await pool.execute(
      'INSERT INTO item_map_binding (item_id, map_id, pos_x, pos_y, rotation) VALUES (?, ?, ?, ?, ?)',
      [itemId, mapIdNum, Number(body.pos_x) || 0, Number(body.pos_y) || 0, body.rotation ?? 0]
    );

    const [mapRow] = await pool.execute('SELECT width, height FROM game_map WHERE id = ?', [mapIdNum]);
    const m = (mapRow as { width: number; height: number }[])[0];
    if (m) {
      const grid = await deriveTileDataFromItems(mapIdNum, m.width, m.height);
      const tileTypes = await getTileTypesForMap(mapIdNum);
      await pool.execute('UPDATE game_map SET tile_data = ?, metadata = ? WHERE id = ?', [
        JSON.stringify(grid),
        JSON.stringify({ tile_types: tileTypes }),
        mapIdNum,
      ]);
    }
    res.json({ code: 0, message: '放置成功' });
  } catch (err) {
    console.error('addMapItem:', err);
    res.status(500).json({ code: -1, message: '放置物品失败' });
  }
}

/** 移除地图上的物品，自动重算 tile_data */
export async function removeMapItem(req: Request, res: Response) {
  try {
    const { mapId, bindingId } = req.params;
    const mapIdNum = Number(mapId);
    const bindingIdNum = Number(bindingId);
    if (!mapIdNum || !bindingIdNum) return res.status(400).json({ code: -1, message: '参数无效' });

    await pool.execute('DELETE FROM item_map_binding WHERE id = ? AND map_id = ?', [bindingIdNum, mapIdNum]);

    const [mapRow] = await pool.execute('SELECT width, height FROM game_map WHERE id = ?', [mapIdNum]);
    const m = (mapRow as { width: number; height: number }[])[0];
    if (m) {
      const grid = await deriveTileDataFromItems(mapIdNum, m.width, m.height);
      const tileTypes = await getTileTypesForMap(mapIdNum);
      await pool.execute('UPDATE game_map SET tile_data = ?, metadata = ? WHERE id = ?', [
        JSON.stringify(grid),
        JSON.stringify({ tile_types: tileTypes }),
        mapIdNum,
      ]);
    }
    res.json({ code: 0, message: '移除成功' });
  } catch (err) {
    console.error('removeMapItem:', err);
    res.status(500).json({ code: -1, message: '移除物品失败' });
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

/** 获取场景内 NPC 实时状态（使用 mapScene 服务，Redis 空时从 npc_map_binding 兜底） */
export async function getSceneState(req: Request, res: Response) {
  try {
    const { mapId } = req.params;
    const { buildSceneState } = await import('../services/mapScene.js');
    const data = await buildSceneState(mapId);
    res.json({ code: 0, data });
  } catch (err) {
    console.error('getSceneState:', err);
    res.status(500).json({ code: -1, message: '获取场景状态失败' });
  }
}
