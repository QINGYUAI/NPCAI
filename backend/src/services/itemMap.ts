/**
 * 物品-地图相关服务
 * 根据 item_map_binding + item.footprint 推导 tile_data
 */
import { pool } from '../db/connection.js';

/** 用于推导的 binding 结构（含 item 信息） */
export interface BindingInput {
  item_id?: number;
  pos_x: number;
  pos_y: number;
  rotation?: number;
  /** 完整定义时使用 */
  name?: string;
  category?: string;
  description?: string;
  footprint?: number[][];
  tile_value?: number;
}

/** 旋转变换 footprint：0=不转, 1=90°顺, 2=180°, 3=270°顺，(0,0)为锚点 */
function rotateFootprint(footprint: number[][], rotation: number): number[][] {
  if (rotation === 0) return footprint;
  let rows = footprint.length;
  let cols = rows > 0 ? (footprint[0]?.length ?? 0) : 0;
  let grid = footprint.map((r) => [...r]);

  for (let r = 0; r < rotation; r++) {
    const next: number[][] = [];
    for (let x = 0; x < cols; x++) {
      const row: number[] = [];
      for (let y = rows - 1; y >= 0; y--) {
        row.push(grid[y]?.[x] ?? 0);
      }
      next.push(row);
    }
    grid = next;
    rows = grid.length;
    cols = grid[0]?.length ?? 0;
  }
  return grid;
}

/**
 * 根据 mapId 的 item_map_binding 推导 tile_data
 * 合并规则：先全 0，再按 binding.id 升序遍历，footprint 中为 1 的格子写入 item.tile_value
 */
export async function deriveTileDataFromItems(
  mapId: number,
  width: number,
  height: number
): Promise<number[][]> {
  const [rows] = await pool.execute(
    `SELECT b.id, b.pos_x, b.pos_y, COALESCE(b.rotation, 0) as rotation, i.footprint, i.tile_value
     FROM item_map_binding b
     JOIN item i ON b.item_id = i.id
     WHERE b.map_id = ?
     ORDER BY b.id ASC`,
    [mapId]
  );
  const bindings = rows as { id: number; pos_x: number; pos_y: number; rotation: number; footprint: string | number[][]; tile_value: number }[];

  const grid: number[][] = Array.from({ length: height }, () => Array(width).fill(0));

  for (const b of bindings) {
    let footprint: number[][];
    try {
      footprint = typeof b.footprint === 'string' ? JSON.parse(b.footprint) : b.footprint;
    } catch {
      continue;
    }
    if (!Array.isArray(footprint) || footprint.length === 0) continue;

    const rotated = rotateFootprint(footprint, Number(b.rotation) || 0);
    const fh = rotated.length;
    const fw = rotated[0]?.length ?? 0;
    const px = Number(b.pos_x) || 0;
    const py = Number(b.pos_y) || 0;
    const tv = Number(b.tile_value) || 1;

    for (let fy = 0; fy < fh; fy++) {
      for (let fx = 0; fx < fw; fx++) {
        if (rotated[fy]?.[fx] !== 1) continue;
        const gx = px + fx;
        const gy = py + fy;
        if (gx >= 0 && gx < width && gy >= 0 && gy < height) {
          grid[gy]![gx] = tv;
        }
      }
    }
  }
  return grid;
}

/** 收集地图上使用的 tile_value 对应的 tile_types（用于 metadata） */
export async function getTileTypesForMap(mapId: number): Promise<Record<number, { name: string; color: string }>> {
  const [rows] = await pool.execute(
    `SELECT DISTINCT i.tile_value, i.name, i.metadata
     FROM item_map_binding b
     JOIN item i ON b.item_id = i.id
     WHERE b.map_id = ? AND i.tile_value > 0`,
    [mapId]
  );
  const list = rows as { tile_value: number; name: string; metadata: string | null }[];
  const result: Record<number, { name: string; color: string }> = {};
  const defaultColors: Record<number, string> = {
    1: '#444444',
    2: '#5dade2',
    3: '#2874a6',
    4: '#27ae60',
    5: '#e74c3c',
  };
  for (const r of list) {
    const v = Number(r.tile_value);
    if (v > 0 && !result[v]) {
      let color = defaultColors[v] ?? '#444444';
      try {
        const meta = r.metadata ? JSON.parse(r.metadata) : null;
        if (meta?.color) color = String(meta.color).replace(/^#?/, '#');
      } catch {
        /* ignore */
      }
      result[v] = { name: r.name || `障碍${v}`, color };
    }
  }
  return result;
}

/**
 * 从 tile_data 二维数组推导 tile_data（用于内存中的 items 合并，不入库）
 * bindings 含 item 的 footprint、tile_value、pos、rotation
 */
export function deriveTileDataFromBindings(
  width: number,
  height: number,
  bindings: { footprint: number[][]; tile_value: number; pos_x: number; pos_y: number; rotation?: number }[]
): number[][] {
  const grid: number[][] = Array.from({ length: height }, () => Array(width).fill(0));
  for (const b of bindings) {
    const rotated = rotateFootprint(b.footprint, Number(b.rotation) || 0);
    const fh = rotated.length;
    const fw = rotated[0]?.length ?? 0;
    const px = Number(b.pos_x) || 0;
    const py = Number(b.pos_y) || 0;
    const tv = Number(b.tile_value) || 1;
    for (let fy = 0; fy < fh; fy++) {
      for (let fx = 0; fx < fw; fx++) {
        if (rotated[fy]?.[fx] !== 1) continue;
        const gx = px + fx;
        const gy = py + fy;
        if (gx >= 0 && gx < width && gy >= 0 && gy < height) {
          grid[gy]![gx] = tv;
        }
      }
    }
  }
  return grid;
}

/** 获取 binding 在世界上障碍格子的坐标集合（用于 nearby 判定） */
export function getBindingWorldObstacleCells(b: {
  footprint: number[][] | string;
  pos_x: number;
  pos_y: number;
  rotation?: number;
}): Set<string> {
  let footprint: number[][];
  try {
    footprint = typeof b.footprint === 'string' ? JSON.parse(b.footprint) : b.footprint;
  } catch {
    return new Set();
  }
  if (!Array.isArray(footprint) || footprint.length === 0) return new Set();
  const rotated = rotateFootprint(footprint, Number(b.rotation) || 0);
  const px = Number(b.pos_x) || 0;
  const py = Number(b.pos_y) || 0;
  const cells = new Set<string>();
  for (let fy = 0; fy < rotated.length; fy++) {
    for (let fx = 0; fx < (rotated[0]?.length ?? 0); fx++) {
      if (rotated[fy]?.[fx] === 1) cells.add(`${px + fx},${py + fy}`);
    }
  }
  return cells;
}

/** 检查 (nx,ny) 是否在 cells 的 1 格范围内（曼哈顿距离） */
export function isWithin1OfCells(nx: number, ny: number, cells: Set<string>): boolean {
  for (const c of cells) {
    const [cx, cy] = c.split(',').map(Number);
    if (Math.abs(nx - cx) + Math.abs(ny - cy) <= 1) return true;
  }
  return false;
}

/** 地图物品 binding 结构（用于 NPC 附近物品判定） */
export interface MapItemBindingForNearby {
  name: string;
  footprint: string | number[][];
  pos_x: number;
  pos_y: number;
  rotation?: number;
}

/**
 * 获取地图上所有物品 binding（含名称、footprint、位置），供 NPC 附近物品判定
 */
export async function getMapItemBindingsForNearby(mapId: number): Promise<MapItemBindingForNearby[]> {
  const [rows] = await pool.execute(
    `SELECT i.name, i.footprint, b.pos_x, b.pos_y, COALESCE(b.rotation, 0) as rotation
     FROM item_map_binding b
     JOIN item i ON b.item_id = i.id
     WHERE b.map_id = ?
     ORDER BY b.id ASC`,
    [mapId]
  );
  return rows as MapItemBindingForNearby[];
}

/**
 * 根据 NPC 位置与物品 bindings，返回其 1 格范围内的物品名称列表
 */
export function getNearbyItemNames(
  nx: number,
  ny: number,
  bindings: MapItemBindingForNearby[]
): string[] {
  const names: string[] = [];
  for (const b of bindings) {
    const cells = getBindingWorldObstacleCells(b);
    if (isWithin1OfCells(nx, ny, cells)) {
      const name = (b.name || '').trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** 按 name + footprint(JSON) 查找或创建 item，返回 item_id */
export async function findOrCreateItem(def: {
  name: string;
  category?: string;
  description?: string;
  footprint: number[][];
  tile_value?: number;
  metadata?: Record<string, unknown>;
}): Promise<number> {
  const footprintStr = JSON.stringify(def.footprint);
  const [rows] = await pool.execute(
    'SELECT id FROM item WHERE name = ? AND footprint = ? LIMIT 1',
    [def.name, footprintStr]
  );
  const list = rows as { id: number }[];
  if (list.length > 0) return list[0]!.id;

  const metaStr = def.metadata ? JSON.stringify(def.metadata) : null;
  const [ins] = await pool.execute(
    `INSERT INTO item (name, category, description, footprint, tile_value, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      def.name,
      def.category || 'object',
      def.description || null,
      footprintStr,
      def.tile_value ?? 1,
      metaStr,
    ]
  );
  return (ins as { insertId: number }).insertId;
}
