<script setup lang="ts">
/**
 * 地图视图 - Phaser 渲染地图与 NPC
 * 绿色=可行走，灰色=障碍；NPC 使用头像或默认圆点
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { toast } from 'vue3-toastify'
import Phaser from 'phaser'
import {
  getMapList,
  getMapById,
  getMapBindings,
  getMapItems,
  initScene,
  getSceneState,
  startMap,
  pauseMap,
  addMapBinding,
  removeMapBinding,
  createMap,
  updateMap,
  deleteMap,
  generateMapContent,
  convertLayoutToMap,
  type GameMap,
  type MapBinding,
  type MapItem,
  type NpcState,
  type GenerateMapItem,
} from '../api/map'
import { connectMapScene } from '../api/ws'
import { resolveAvatarUrl } from '../utils/avatar'
import { getNpcList } from '../api/npc'
import { getConfigList } from '../api/config'
import type { AiConfig } from '../types/config'
import type { Npc } from '../types/npc'
import NpcThinkingDrawer from './NpcThinkingDrawer.vue'

const TILE_SIZE = 32

/** 地图列表项（含 width/height 用于展示） */
interface MapListItem {
  id: number
  name: string
  width: number
  height: number
  status?: number
}
const mapList = ref<MapListItem[]>([])
const selectedMapId = ref<number | null>(null)
const currentMap = ref<GameMap | null>(null)
const bindings = ref<MapBinding[]>([])
/** 地图上的物品（建筑等），用于显示建筑名称 */
const mapItems = ref<MapItem[]>([])
const npcList = ref<Npc[]>([])
const sceneState = ref<{ npcs: NpcState[]; running?: boolean }>({ npcs: [] })
const gameRef = ref<HTMLDivElement | null>(null)
const showCreateDialog = ref(false)
/** 编辑地图：弹窗与表单 */
const showEditDialog = ref(false)
const editForm = ref({ name: '', width: 10, height: 10 })
const editMapId = ref<number | null>(null)
const editLoading = ref(false)
/** 默认障碍类型（手动创建时使用） */
const DEFAULT_TILE_TYPES: Record<number, { name: string; color: string }> = {
  1: { name: '建筑', color: '#444444' },
  2: { name: '喷泉', color: '#5dade2' },
  3: { name: '水域', color: '#2874a6' },
}

const createForm = ref<{
  name: string
  width: number
  height: number
  tile_data?: number[][]
  tile_types?: Record<number, { name: string; color: string }>
  /** AI 生成时的物品列表，创建时优先使用 */
  items?: GenerateMapItem[]
}>({
  name: '',
  width: 10,
  height: 10,
  tile_types: { ...DEFAULT_TILE_TYPES },
})
/** AI 生成：配置列表、选中的配置 ID、描述、加载状态 */
const aiConfigList = ref<AiConfig[]>([])
const generateAiConfigId = ref<number>(0)
const generateHint = ref('')
const generateLoading = ref(false)
/** 多轮对话：是否已有生成结果可继续完善 */
const hasGeneratedMap = computed(
  () => !!(createForm.value.name && (createForm.value.items?.length || (createForm.value.tile_data && createForm.value.tile_data.some((row) => row.some((c) => c > 0)))))
)
const bindingSelectValue = ref<number | null>(null)
const initLoading = ref(false)
/** 开始/暂停按钮加载状态 */
const startPauseLoading = ref(false)
const loadError = ref<string | null>(null)
/** 点击的 NPC ID，用于显示思考记录 */
const clickedNpcId = ref<number | null>(null)
const memoryDrawerVisible = ref(false)

/** 当前点击 NPC 的名称（用于思考记录抽屉标题） */
const clickedNpcName = computed(() => {
  if (!clickedNpcId.value) return ''
  const b = bindings.value.find((x) => x.npc_id === clickedNpcId.value)
  if (b?.npc_name) return b.npc_name
  const n = npcList.value.find((x) => x.id === clickedNpcId.value)
  return n?.name ?? '未知'
})
let game: Phaser.Game | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
/** WebSocket 断开函数，地图运行时优先用 WS 接收推送 */
let disconnectWs: (() => void) | null = null

/** 用于显示的 NPC 列表：优先 Redis 状态，否则用 binding 初始位置，并合并 avatar */
const displayNpcs = computed<NpcState[]>(() => {
  const bindingMap = new Map(bindings.value.map((b) => [b.npc_id, b]))
  const mergeAvatar = (n: { npc_id: number; x: number; y: number; state: string; groupId: string; avatar?: string; thinking?: string }) => ({
    ...n,
    avatar: n.avatar || bindingMap.get(n.npc_id)?.avatar,
  })
  if (sceneState.value.npcs?.length) return sceneState.value.npcs.map(mergeAvatar)
  return bindings.value.map((b) => mergeAvatar({
    npc_id: b.npc_id,
    x: b.init_x,
    y: b.init_y,
    state: 'idle',
    groupId: '',
    avatar: b.avatar,
  }))
})

/** 地图游戏区域尺寸（与 Phaser 一致） */
const gameSize = computed(() => {
  const m = currentMap.value
  if (!m) return { width: 0, height: 0 }
  return {
    width: Math.min(800, m.width * TILE_SIZE),
    height: Math.min(600, m.height * TILE_SIZE),
  }
})

/** 带思考的 NPC（用于 DOM 气泡展示） */
const npcsWithThinking = computed(() => {
  const m = currentMap.value
  const { width, height } = gameSize.value
  if (!width || !height || !m) return []
  const mapH = m.height
  return displayNpcs.value.filter((n) => n.thinking).map((n) => {
    const centerX = n.x * TILE_SIZE + TILE_SIZE / 2
    const centerY = n.y * TILE_SIZE + TILE_SIZE / 2
    // 偏移量需大于气泡半高+NPC半高，避免遮挡 NPC 形象（NPC 约 28px，气泡约 50px）
    const offset = 52
    // 顶行在下方显示，底行在上方显示，避免被裁剪
    const useBelow = n.y < 1.5
    const useAbove = n.y >= mapH - 1.5
    const bubbleY = useAbove ? centerY - offset : useBelow ? centerY + offset : centerY - offset
    return {
      ...n,
      bubbleX: centerX / width,
      bubbleY: bubbleY / height,
      displayText: (n.thinking!.length > 28 ? n.thinking!.slice(0, 28) + '…' : n.thinking!),
    }
  })
})

// NPC 显示类型（含 avatar、thinking）
interface NpcDisplay extends NpcState {
  avatar?: string
  thinking?: string
}

// Phaser 主场景
class MainScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainScene' })
  }

  tileData: number[][] = []
  mapW = 0
  mapH = 0
  /** 格子弹窗颜色（0=可行走，其余来自 metadata.tile_types，AI 动态生成） */
  tileColors: Record<number, number> = {}
  /** 地图上的物品（建筑等），用于显示名称 */
  mapItems: { name: string; pos_x: number; pos_y: number; footprint: number[][] }[] = []
  npcObjects: Map<number, Phaser.GameObjects.GameObject> = new Map()

  init(data: {
    tileData: number[][]
    mapW: number
    mapH: number
    tileColors?: Record<number, number>
    mapItems?: { name: string; pos_x: number; pos_y: number; footprint: number[][] }[]
  }) {
    this.tileData = data.tileData || []
    this.mapW = data.mapW || 0
    this.mapH = data.mapH || 0
    this.tileColors = data.tileColors || {}
    this.mapItems = data.mapItems || []
  }

  create() {
    const g = this.add.graphics()
    // 默认颜色（无 metadata 时使用）
    const defaults: Record<number, number> = {
      0: 0x2d5016,
      1: 0x444444,
      2: 0x5dade2,
      3: 0x2874a6,
    }
    const TILE_COLORS = { ...defaults, ...this.tileColors }
    for (let y = 0; y < this.mapH; y++) {
      for (let x = 0; x < this.mapW; x++) {
        const val = this.tileData[y]?.[x] ?? 0
        g.fillStyle(TILE_COLORS[val] ?? 0x444444, 1)
        g.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE - 1, TILE_SIZE - 1)
      }
    }

    // 在建筑位置显示建筑名称（纯展示，不参与碰撞，不影响 NPC 移动）
    for (const item of this.mapItems) {
      let fp = item.footprint
      if (typeof fp === 'string') {
        try {
          fp = JSON.parse(fp) as number[][]
        } catch {
          fp = []
        }
      }
      const rows = Array.isArray(fp) ? fp.length : 0
      const cols = rows > 0 && Array.isArray(fp[0]) ? (fp[0] as number[]).length : 0
      const centerX = (item.pos_x + cols / 2) * TILE_SIZE
      const centerY = (item.pos_y + rows / 2) * TILE_SIZE
      this.add
        .text(centerX, centerY, item.name, {
          fontSize: '12px',
          color: '#ffffff',
          fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
          backgroundColor: 'rgba(0,0,0,0.65)',
          padding: { x: 4, y: 2 },
        })
        .setOrigin(0.5, 0.5)
        .setDepth(1)
    }

    this.events.on('updateNpcs', this.syncNpcs, this)
  }

  /** 为 NPC 对象添加点击交互，点击时触发 game.events 'npcClicked' */
  makeNpcInteractive(obj: Phaser.GameObjects.GameObject, npcId: number) {
    obj.setInteractive({ useHandCursor: true })
    obj.on('pointerdown', () => {
      this.game.events.emit('npcClicked', npcId)
    })
  }

  addPlaceholder(npcId: number, x: number, y: number) {
    const g = this.add.graphics()
    g.fillStyle(0x3498db, 1)
    g.fillCircle(0, 0, 12)
    g.setPosition(x, y)
    this.makeNpcInteractive(g, npcId)
    return g
  }

  loadAndShowAvatar(npcId: number, avatarUrl: string, px: number, py: number) {
    const key = `npc_avatar_${npcId}`
    const url = resolveAvatarUrl(avatarUrl)
    if (!url) return this.addPlaceholder(npcId, px, py)

    if (this.textures.exists(key)) {
      const img = this.add.image(px, py, key)
      img.setDisplaySize(28, 28)
      this.makeNpcInteractive(img, npcId)
      return img
    }

    const placeholder = this.addPlaceholder(npcId, px, py)
    this.load.image(key, url)
    this.load.once('complete', () => {
      const curr = this.npcObjects.get(npcId)
      if (curr && curr === placeholder) {
        const cx = placeholder.x
        const cy = placeholder.y
        placeholder.destroy()
        if (this.textures.exists(key)) {
          const img = this.add.image(cx, cy, key)
          img.setDisplaySize(28, 28)
          this.makeNpcInteractive(img, npcId)
          this.npcObjects.set(npcId, img)
        } else {
          this.npcObjects.set(npcId, this.addPlaceholder(npcId, cx, cy))
        }
      }
    })
    this.load.start()
    return placeholder
  }

  syncNpcs(npcs: NpcDisplay[]) {
    const ids = new Set(npcs.map((n) => n.npc_id))
    for (const [id, obj] of this.npcObjects) {
      if (!ids.has(id)) {
        obj.destroy()
        this.npcObjects.delete(id)
      }
    }
    for (const n of npcs) {
      const px = n.x * TILE_SIZE + TILE_SIZE / 2
      const py = n.y * TILE_SIZE + TILE_SIZE / 2
      let obj = this.npcObjects.get(n.npc_id)
      if (!obj) {
        obj = n.avatar
          ? this.loadAndShowAvatar(n.npc_id, n.avatar, px, py)
          : this.addPlaceholder(n.npc_id, px, py)
        this.npcObjects.set(n.npc_id, obj)
      } else {
        ;(obj as unknown as { setPosition: (x: number, y: number) => void }).setPosition(px, py)
      }
    }
  }
}

async function loadMaps() {
  try {
    loadError.value = null
    const res = await getMapList()
    if (res.data?.data) {
      mapList.value = (res.data.data as { id: number; name: string; width?: number; height?: number; status?: number }[]).map((m) => ({
        id: m.id,
        name: m.name,
        width: m.width ?? 10,
        height: m.height ?? 10,
        status: m.status,
      }))
    }
  } catch (e) {
    loadError.value = '加载地图列表失败'
    toast.error('加载地图列表失败')
  }
}

/** 可行走的颜色（固定） */
const WALKABLE_COLOR = '#2d5016'

/** 根据 tile_types 生成格子弹窗的颜色与标签 */
const createTileDisplay = computed(() => {
  const types = createForm.value.tile_types ?? DEFAULT_TILE_TYPES
  const colors: Record<number, string> = { 0: WALKABLE_COLOR }
  const labels: Record<number, string> = { 0: '可行走' }
  for (const [k, v] of Object.entries(types)) {
    const n = Number(k)
    if (!isNaN(n) && n > 0) {
      colors[n] = v.color
      labels[n] = v.name
    }
  }
  return { colors, labels }
})

/** 切换顺序：0 → 类型1 → 类型2 → ... → 0 */
const createTileCycleOrder = computed(() => {
  const types = createForm.value.tile_types ?? DEFAULT_TILE_TYPES
  const keys = Object.keys(types)
    .map(Number)
    .filter((n) => !isNaN(n) && n > 0)
    .sort((a, b) => a - b)
  return [0, ...keys]
})

/** 有效的格子弹窗值集合（0 + tile_types 的 key） */
const createValidTileValues = computed(() => {
  const types = createForm.value.tile_types ?? DEFAULT_TILE_TYPES
  const set = new Set([0])
  for (const k of Object.keys(types)) {
    const n = Number(k)
    if (!isNaN(n) && n > 0) set.add(n)
  }
  return set
})

/** 确保 createForm.tile_data 与 width/height 一致，无则生成空白 */
function ensureCreateFormTileData() {
  const { width, height, tile_data, tile_types } = createForm.value
  const valid = createValidTileValues.value
  const rows = tile_data?.length ?? 0
  const cols = tile_data?.[0]?.length ?? 0
  if (rows === height && cols === width && Array.isArray(tile_data)) return
  const grid: number[][] = []
  for (let y = 0; y < height; y++) {
    grid.push([])
    for (let x = 0; x < width; x++) {
      const v = tile_data?.[y]?.[x]
      grid[y]!.push(valid.has(Number(v)) ? Number(v) : 0)
    }
  }
  createForm.value = { ...createForm.value, tile_data: grid, tile_types: tile_types ?? DEFAULT_TILE_TYPES }
}

/** 点击预览格子切换类型：按 createTileCycleOrder 循环 */
function toggleCreateTile(x: number, y: number) {
  ensureCreateFormTileData()
  const grid = createForm.value.tile_data!
  const order = createTileCycleOrder.value
  const curIdx = order.indexOf(grid[y]?.[x] ?? 0)
  const nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % order.length
  const nextVal = order[nextIdx] ?? 0
  const newGrid = grid.map((row, ry) =>
    row.map((v, rx) => (ry === y && rx === x ? nextVal : v))
  )
  createForm.value = { ...createForm.value, tile_data: newGrid }
}

/** 创建表单的预览格子弹窗（保证与表单一致） */
const createPreviewTiles = computed(() => {
  const { width, height, tile_data } = createForm.value
  const valid = createValidTileValues.value
  const grid: number[][] = []
  for (let y = 0; y < height; y++) {
    grid.push([])
    for (let x = 0; x < width; x++) {
      const v = tile_data?.[y]?.[x]
      grid[y]!.push(valid.has(Number(v)) ? Number(v) : 0)
    }
  }
  return grid
})

/** 加载 AI 配置列表（用于地图 AI 生成） */
async function loadAiConfigs() {
  try {
    const { data } = await getConfigList({ status: 1 })
    if (data?.code === 0 && data.data?.length) {
      aiConfigList.value = data.data
      if (!generateAiConfigId.value && aiConfigList.value[0]) {
        generateAiConfigId.value = aiConfigList.value[0].id
      }
    }
  } catch (e) {
    console.error('loadAiConfigs:', e)
  }
}

/** 室内布局图上传并转换为地图 */
async function handleLayoutUpload(info: { file?: { raw?: File }; fileList?: unknown[] }) {
  const file = info?.file?.raw
  if (!file) return
  const aiConfigId = generateAiConfigId.value
  if (!aiConfigId) {
    toast.error('请先选择 AI 配置')
    return
  }
  try {
    generateLoading.value = true
    const { data } = await convertLayoutToMap(file, aiConfigId)
    if (data?.code === 0 && data.data) {
      createForm.value = {
        name: data.data.name,
        width: data.data.width,
        height: data.data.height,
        tile_data: data.data.tile_data,
        tile_types: data.data.tile_types ?? { ...DEFAULT_TILE_TYPES },
        items: data.data.items?.length ? data.data.items : undefined,
      }
      toast.success('布局图已转换为地图，可修改后点击创建')
    } else {
      toast.error(data?.message || '转换失败')
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '布局图转换失败')
  } finally {
    generateLoading.value = false
  }
}

/** AI 生成或修改地图，支持多轮完善 */
async function handleAiGenerateMap() {
  const aiConfigId = generateAiConfigId.value
  const hint = generateHint.value?.trim()
  if (!aiConfigId) {
    toast.error('请选择 AI 配置')
    return
  }
  if (!hint) {
    toast.error(hasGeneratedMap.value ? '请填写修改要求' : '请填写地图描述')
    return
  }
  try {
    generateLoading.value = true
    const params: { ai_config_id: number; hint: string; current_map?: typeof createForm.value } = {
      ai_config_id: aiConfigId,
      hint,
    }
    if (hasGeneratedMap.value) {
      params.current_map = {
        name: createForm.value.name,
        width: createForm.value.width,
        height: createForm.value.height,
        tile_types: createForm.value.tile_types ?? undefined,
        items: createForm.value.items ?? undefined,
      }
    }
    const { data } = await generateMapContent(params)
    if (data?.code === 0 && data.data) {
      createForm.value = {
        name: data.data.name,
        width: data.data.width,
        height: data.data.height,
        tile_data: data.data.tile_data,
        tile_types: data.data.tile_types ?? { ...DEFAULT_TILE_TYPES },
        items: data.data.items?.length ? data.data.items : undefined,
      }
      toast.success(hasGeneratedMap.value ? '已根据修改要求更新' : 'AI 生成成功，可继续完善或点击创建')
    } else {
      toast.error(data?.message || '生成失败')
    }
  } catch (e) {
    toast.error('AI 生成失败')
  } finally {
    generateLoading.value = false
  }
}

async function doCreateMap() {
  const { name, width, height, tile_data, tile_types, items } = createForm.value
  if (!name || width < 1 || height < 1) return
  try {
    const metadata = tile_types && Object.keys(tile_types).length > 0 ? { tile_types } : undefined
    // 优先使用 items（AI 生成），后端据此创建 item/binding 并推导 tile_data
    if (items?.length) {
      await createMap({ name, width, height, items, metadata })
    } else {
      const validTileData = tile_data && tile_data.length === height
        && tile_data.every((row) => Array.isArray(row) && row.length === width)
      const finalTileData = validTileData
        ? tile_data
        : Array.from({ length: height }, () => Array(width).fill(0))
      await createMap({ name, width, height, tile_data: finalTileData, metadata })
    }
    showCreateDialog.value = false
    createForm.value = { name: '', width: 10, height: 10, tile_types: { ...DEFAULT_TILE_TYPES }, items: undefined }
    generateHint.value = ''
    await loadMaps()
    toast.success('地图创建成功')
  } catch (e) {
    toast.error('创建地图失败')
  }
}

async function loadNpcs() {
  const res = await getNpcList()
  if (res.data?.data) npcList.value = res.data.data
}

async function loadMapDetail() {
  if (!selectedMapId.value) return
  try {
    loadError.value = null
    const mapId = selectedMapId.value
    const [mapRes, bindRes, itemsRes] = await Promise.all([
      getMapById(mapId),
      getMapBindings(mapId),
      getMapItems(mapId),
    ])
    if (mapRes.data?.data) currentMap.value = mapRes.data.data
    if (bindRes.data?.data) bindings.value = bindRes.data.data
    if (itemsRes.data?.data) mapItems.value = itemsRes.data.data
    else mapItems.value = []
    await fetchSceneState()
  } catch (e) {
    loadError.value = '加载地图失败'
    toast.error('加载地图失败，请检查后端及 Redis 是否正常')
  }
}

async function doInitScene() {
  if (!selectedMapId.value) return
  try {
    initLoading.value = true
    await initScene(selectedMapId.value)
    await fetchSceneState()
    emitNpcsToScene()
    toast.success('场景已初始化')
  } catch (e: unknown) {
    const msg =
      (e as { response?: { data?: { message?: string } } })?.response?.data?.message ||
      (e instanceof Error ? e.message : '场景初始化失败')
    toast.error(msg)
  } finally {
    initLoading.value = false
  }
}

/** 开始：初始化并启动 NPC 移动 */
async function doStartMap() {
  if (!selectedMapId.value) return
  try {
    startPauseLoading.value = true
    await startMap(selectedMapId.value)
    await fetchSceneState()
    emitNpcsToScene()
    startPolling(true)
    toast.success('已启动')
  } catch (e: unknown) {
    const msg =
      (e as { response?: { data?: { message?: string } } })?.response?.data?.message ||
      (e instanceof Error ? e.message : '启动失败')
    toast.error(msg)
  } finally {
    startPauseLoading.value = false
  }
}

/** 暂停：停止 NPC 移动 */
async function doPauseMap() {
  if (!selectedMapId.value) return
  try {
    startPauseLoading.value = true
    await pauseMap(selectedMapId.value)
    await fetchSceneState()
    emitNpcsToScene()
    startPolling(false)
    toast.success('已暂停')
  } catch (e: unknown) {
    const msg =
      (e as { response?: { data?: { message?: string } } })?.response?.data?.message ||
      (e instanceof Error ? e.message : '暂停失败')
    toast.error(msg)
  } finally {
    startPauseLoading.value = false
  }
}

async function fetchSceneState() {
  if (!selectedMapId.value) return
  try {
    const res = await getSceneState(selectedMapId.value)
    if (res.data?.data) sceneState.value = res.data.data
  } catch {
    sceneState.value = { npcs: [] }
  }
}

function emitNpcsToScene() {
  if (!game) return
  const scene = game.scene.getScene('MainScene') as MainScene
  if (scene?.syncNpcs) scene.syncNpcs(displayNpcs.value)
}

/** 轮询间隔：WS 连接时作为兜底用长间隔，否则 3 秒 */
const POLL_FAST = 3000
const POLL_SLOW = 10000

function startPolling(useWs = false) {
  stopPolling()
  stopWs()
  if (useWs && selectedMapId.value) {
    disconnectWs = connectMapScene(selectedMapId.value, (state) => {
      sceneState.value = state
      emitNpcsToScene()
    })
  }
  pollTimer = setInterval(async () => {
    await fetchSceneState()
    emitNpcsToScene()
  }, useWs ? POLL_SLOW : POLL_FAST)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function stopWs() {
  if (disconnectWs) {
    disconnectWs()
    disconnectWs = null
  }
}

async function handleAddBinding(npcId: number) {
  if (!selectedMapId.value) return
  try {
    await addMapBinding(selectedMapId.value, { npc_id: npcId })
    bindingSelectValue.value = null
    await loadMapDetail()
    toast.success('已添加')
  } catch {
    toast.error('添加失败')
  }
}

async function handleRemoveBinding(npcId: number) {
  if (!selectedMapId.value) return
  try {
    await removeMapBinding(selectedMapId.value, npcId)
    await loadMapDetail()
    toast.success('已移除')
  } catch {
    toast.error('移除失败')
  }
}

/** 打开编辑地图 */
function openEditMap(m: MapListItem) {
  editMapId.value = m.id
  editForm.value = { name: m.name, width: m.width, height: m.height }
  showEditDialog.value = true
}

/** 保存地图编辑 */
async function handleUpdateMap() {
  if (!editMapId.value) return
  try {
    editLoading.value = true
    await updateMap(editMapId.value, editForm.value)
    showEditDialog.value = false
    await loadMaps()
    if (selectedMapId.value === editMapId.value) await loadMapDetail()
    toast.success('更新成功')
  } catch {
    toast.error('更新失败')
  } finally {
    editLoading.value = false
  }
}

/** 删除地图 */
async function handleDeleteMap(m: MapListItem) {
  try {
    await ElMessageBox.confirm(
      `确定删除地图「${m.name}」？该地图上的 NPC 绑定、物品等关联数据将一并移除。`,
      '提示',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' }
    )
    await deleteMap(m.id)
    if (selectedMapId.value === m.id) selectedMapId.value = null
    await loadMaps()
    toast.success('删除成功')
  } catch (e) {
    if (e !== 'cancel') toast.error('删除失败')
  }
}

watch(selectedMapId, (id) => {
  if (id) loadMapDetail()
})

watch(
  [currentMap, selectedMapId],
  () => {
    if (!currentMap.value || !selectedMapId.value || !gameRef.value) return
    if (game) {
      game.destroy(true)
      game = null
    }
    const m = currentMap.value
    game = new Phaser.Game({
      type: Phaser.AUTO,
      width: Math.min(800, m.width * TILE_SIZE),
      height: Math.min(600, m.height * TILE_SIZE),
      parent: gameRef.value,
      backgroundColor: '#1a1a2e',
      scene: [MainScene],
    })
    game.events.on('npcClicked', (npcId: number) => {
      clickedNpcId.value = npcId
      memoryDrawerVisible.value = true
    })
    // 从 metadata.tile_types 提取颜色（AI 动态生成），hex 转为 Phaser 数值
    const tileColors: Record<number, number> = {}
    const meta = m.metadata as { tile_types?: Record<number, { color?: string }> } | undefined
    const tt = meta?.tile_types
    if (tt && typeof tt === 'object') {
      for (const [k, v] of Object.entries(tt)) {
        const n = Number(k)
        if (!isNaN(n) && n > 0 && v?.color) {
          const hex = v.color.replace(/^#/, '')
          tileColors[n] = parseInt(hex, 16)
        }
      }
    }
    game.scene.start('MainScene', {
      tileData: m.tile_data,
      mapW: m.width,
      mapH: m.height,
      tileColors: Object.keys(tileColors).length ? tileColors : undefined,
      mapItems: mapItems.value.map((i) => ({
        name: i.name,
        pos_x: i.pos_x,
        pos_y: i.pos_y,
        footprint: i.footprint,
      })),
    })
    setTimeout(emitNpcsToScene, 150)
    startPolling(sceneState.value.running)
  },
  { flush: 'post' }
)

watch(displayNpcs, () => emitNpcsToScene(), { deep: true })

watch(showCreateDialog, (visible) => {
  if (visible) {
    loadAiConfigs()
    ensureCreateFormTileData()
  }
})

watch(
  () => `${createForm.value.width}x${createForm.value.height}`,
  () => ensureCreateFormTileData(),
  { immediate: false }
)

onMounted(() => {
  loadMaps()
  loadNpcs()
})

onUnmounted(() => {
  stopPolling()
  stopWs()
  if (game) {
    game.destroy(true)
    game = null
  }
})
</script>

<template>
  <div class="map-view">
    <div class="map-view-toolbar">
      <el-button type="success" @click="showCreateDialog = true">创建地图</el-button>
      <el-select
        v-model="selectedMapId"
        placeholder="选择地图"
        clearable
        style="width: 200px"
      >
        <el-option
          v-for="m in mapList"
          :key="m.id"
          :label="m.name"
          :value="m.id"
        />
      </el-select>
      <el-button
        v-if="selectedMapId"
        type="primary"
        :loading="initLoading"
        @click="doInitScene"
      >
        初始化场景
      </el-button>
      <el-button
        v-if="selectedMapId"
        :type="sceneState.running ? 'warning' : 'success'"
        :loading="startPauseLoading"
        @click="sceneState.running ? doPauseMap() : doStartMap()"
      >
        {{ sceneState.running ? '暂停' : '开始' }}
      </el-button>
    </div>

    <!-- 地图列表管理 -->
    <el-row v-if="mapList.length" :gutter="12" class="mb-6 map-cards">
      <el-col v-for="m in mapList" :key="m.id" :xs="24" :sm="12" :md="8" :lg="6">
        <el-card
          :class="['map-card', selectedMapId === m.id && 'map-card-selected']"
          shadow="hover"
          @click="selectedMapId = m.id"
        >
          <template #header>
            <span class="font-medium">{{ m.name }}</span>
          </template>
          <div class="text-sm text-gray-500 mb-3">{{ m.width }}×{{ m.height }}</div>
          <div class="flex gap-2" @click.stop>
            <el-button size="small" type="primary" plain @click="selectedMapId = m.id">选择</el-button>
            <el-button size="small" @click="openEditMap(m)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="handleDeleteMap(m)">删除</el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-alert
      v-if="loadError"
      type="error"
      :title="loadError"
      show-icon
      closable
      class="mb-4"
    />
    <div
      v-if="selectedMapId && currentMap"
      class="flex flex-col lg:flex-row gap-4"
    >
      <div class="flex-shrink-0 relative">
        <div
          ref="gameRef"
          class="game-canvas rounded border border-gray-600"
          :style="{ width: gameSize.width + 'px', height: gameSize.height + 'px' }"
        />
        <!-- DOM 气泡叠加层：原生渲染、智能定位避免裁剪 -->
        <div
          v-if="gameSize.width && gameSize.height"
          class="absolute top-0 left-0 pointer-events-none rounded overflow-hidden"
          :style="{ width: gameSize.width + 'px', height: gameSize.height + 'px' }"
        >
          <div
            v-for="n in npcsWithThinking"
            :key="n.npc_id"
            class="npc-bubble absolute -translate-x-1/2 -translate-y-1/2 px-3 py-2 rounded-lg text-white shadow-xl max-w-[160px] text-center whitespace-pre-wrap break-words"
            :style="{
              left: n.bubbleX * 100 + '%',
              top: n.bubbleY * 100 + '%',
              fontSize: '14px',
              fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
            }"
          >
            {{ n.displayText }}
          </div>
        </div>
        <p class="text-sm text-gray-400 mt-2">
          {{ currentMap.name }} ({{ currentMap.width }}×{{ currentMap.height }})
        </p>
      </div>
      <div class="flex-shrink-0 w-full lg:w-auto lg:min-w-[260px] rounded-lg border border-gray-600 bg-gray-800/50 p-4">
        <h4 class="text-sm font-medium mb-3">地图 NPC 配置</h4>
        <div class="space-y-3">
          <template v-if="bindings.length">
            <div
              v-for="b in bindings"
              :key="b.id"
              class="flex items-center justify-between py-2 px-3 bg-gray-800 rounded"
            >
              <span class="text-sm font-medium">{{ b.npc_name }}</span>
              <el-button size="small" type="danger" text @click="handleRemoveBinding(b.npc_id)">
                移除
              </el-button>
            </div>
          </template>
          <template v-else>
            <p class="text-xs text-gray-500 py-2">暂无绑定 NPC，请从下方选择添加</p>
          </template>
          <div v-if="npcList.length" class="pt-2 border-t border-gray-600">
            <span class="text-xs text-gray-400 block mb-2">添加 NPC</span>
            <el-select
              v-model="bindingSelectValue"
              placeholder="选择要添加的 NPC"
              filterable
              clearable
              style="width: 100%"
              @change="(v: number) => v && handleAddBinding(v)"
            >
              <el-option
                v-for="n in npcList.filter((n) => !bindings.some((b) => b.npc_id === n.id))"
                :key="n.id"
                :label="n.name"
                :value="n.id"
              />
            </el-select>
          </div>
          <p v-else class="text-xs text-amber-500/90 pt-2">
            请先在「角色 NPC」中创建 NPC，再返回此地添加并配置位置
          </p>
        </div>
      </div>
    </div>

    <el-empty
      v-else-if="!mapList.length"
      description="暂无地图，请点击「创建地图」"
    />
    <p
      v-else-if="selectedMapId && !currentMap"
      class="text-gray-400"
    >
      加载中…
    </p>

    <el-dialog
      v-model="showCreateDialog"
      title="创建地图"
      width="540px"
      class="create-map-dialog"
      align-center
    >
      <!-- AI 生成区域 -->
      <div class="create-dialog-ai-section">
        <h4 class="create-dialog-section-title">AI 创建</h4>
        <el-select
          v-model="generateAiConfigId"
          placeholder="选择 AI 配置"
          size="default"
          class="create-dialog-select"
        >
          <el-option
            v-for="c in aiConfigList"
            :key="c.id"
            :label="c.name"
            :value="c.id"
          />
        </el-select>
        <el-input
          v-model="generateHint"
          type="textarea"
          :rows="2"
          :placeholder="hasGeneratedMap
            ? '输入修改要求，如：把喷泉移到左边、增加一个咖啡厅、扩大广场面积'
            : '描述地图，如：现代街角咖啡馆、创意园区、城市公园、联合办公空间'"
          class="create-dialog-textarea"
        />
        <div class="create-dialog-actions">
          <el-button
            type="primary"
            size="default"
            :loading="generateLoading"
            @click="handleAiGenerateMap"
          >
            {{ hasGeneratedMap ? '继续完善' : 'AI 生成' }}
          </el-button>
        </div>
        <p v-if="hasGeneratedMap" class="create-dialog-hint">
          已生成地图，可输入修改要求进行多轮完善
        </p>
        <!-- 室内布局图上传 -->
        <div class="create-dialog-divider">
          <span class="create-dialog-divider-text">或上传室内布局图</span>
        </div>
        <div class="create-dialog-upload-row">
          <el-upload
            :auto-upload="false"
            :show-file-list="false"
            accept="image/jpeg,image/png,image/gif,image/webp"
            :limit="1"
            :disabled="generateLoading"
            @change="handleLayoutUpload"
          >
            <el-button type="success" size="default" :loading="generateLoading" class="create-dialog-upload-btn">
              选择布局图并转换
            </el-button>
          </el-upload>
          <p class="create-dialog-upload-hint">
            支持户型图、平面图。建议使用 OpenAI、Groq、通义千问、智谱 等支持视觉的配置
          </p>
        </div>
      </div>
      <el-form :model="createForm" label-width="72px" class="create-dialog-form">
        <el-row :gutter="16">
          <el-col :span="24">
            <el-form-item label="名称">
              <el-input v-model="createForm.name" placeholder="地图名称" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="宽度">
              <el-input-number v-model="createForm.width" :min="1" :max="200" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="高度">
              <el-input-number v-model="createForm.height" :min="1" :max="200" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="地图预览">
          <div class="create-preview-wrapper">
            <p class="create-preview-hint">点击格子循环切换类型（由 AI 生成或默认）</p>
            <div
              class="create-preview-grid"
              :style="{
                gridTemplateColumns: `repeat(${createForm.width}, 16px)`,
                gridTemplateRows: `repeat(${createForm.height}, 16px)`,
                width: Math.min(createForm.width * 17, 340) + 'px',
                height: Math.min(createForm.height * 17, 272) + 'px',
              }"
            >
              <template v-for="(row, y) in createPreviewTiles" :key="'row' + y">
                <button
                  v-for="(val, x) in row"
                  :key="'cell' + y + '-' + x"
                  type="button"
                  class="create-preview-cell"
                  :style="{ backgroundColor: createTileDisplay.colors[val] ?? '#333' }"
                  :title="`(${x},${y}) ${createTileDisplay.labels[val] ?? '未知'}`"
                  @click="toggleCreateTile(x, y)"
                />
              </template>
            </div>
            <div class="create-preview-legend">
              <span class="create-preview-legend-item">
                <span class="create-preview-legend-dot" :style="{ backgroundColor: WALKABLE_COLOR }" />
                可行走
              </span>
              <span
                v-for="(def, k) in (createForm.tile_types ?? DEFAULT_TILE_TYPES)"
                :key="k"
                class="create-preview-legend-item"
              >
                <span class="create-preview-legend-dot" :style="{ backgroundColor: def.color }" />
                {{ def.name }}
              </span>
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="create-dialog-footer">
          <el-button @click="showCreateDialog = false">取消</el-button>
          <el-button type="primary" @click="doCreateMap">创建</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 编辑地图 -->
    <el-dialog v-model="showEditDialog" title="编辑地图" width="360px">
      <el-form :model="editForm" label-width="80px">
        <el-form-item label="名称">
          <el-input v-model="editForm.name" placeholder="地图名称" />
        </el-form-item>
        <el-form-item label="宽度">
          <el-input-number v-model="editForm.width" :min="1" :max="200" />
        </el-form-item>
        <el-form-item label="高度">
          <el-input-number v-model="editForm.height" :min="1" :max="200" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditDialog = false">取消</el-button>
        <el-button type="primary" :loading="editLoading" @click="handleUpdateMap">保存</el-button>
      </template>
    </el-dialog>

    <!-- 点击地图 NPC 展示思考记录（轮询实时更新） -->
    <NpcThinkingDrawer
      :visible="memoryDrawerVisible"
      :npc-id="clickedNpcId"
      :npc-name="clickedNpcName"
      @close="memoryDrawerVisible = false; clickedNpcId = null"
    />
  </div>
</template>

<style scoped>
.game-canvas {
  min-width: 320px;
  min-height: 240px;
}
.game-canvas canvas {
  display: block;
  border-radius: 4px;
}
.map-cards :deep(.el-card) {
  margin-bottom: 12px;
  cursor: pointer;
}
.map-card-selected {
  border-color: var(--el-color-primary);
}
.npc-bubble {
  background: rgba(26, 26, 46, 0.97);
  border: 1px solid rgba(74, 85, 104, 0.9);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  line-height: 1.4;
}

/* 创建地图弹窗样式 */
.create-map-dialog :deep(.el-dialog__header) {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--el-border-color);
}
.create-map-dialog :deep(.el-dialog__body) {
  padding: 20px 24px;
}
.create-map-dialog :deep(.el-dialog__footer) {
  padding: 12px 24px 16px;
  border-top: 1px solid var(--el-border-color);
}

.create-dialog-ai-section {
  padding: 16px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  margin-bottom: 20px;
}

.create-dialog-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin: 0 0 12px;
  letter-spacing: 0.02em;
}

.create-dialog-select {
  width: 100%;
  margin-bottom: 10px;
}

.create-dialog-textarea {
  margin-bottom: 10px;
}

.create-dialog-textarea :deep(.el-textarea__inner) {
  border-radius: 6px;
}

.create-dialog-actions {
  margin-bottom: 8px;
}

.create-dialog-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 0 0 4px;
  line-height: 1.4;
}

.create-dialog-divider {
  margin: 14px 0 12px;
  display: flex;
  align-items: center;
}
.create-dialog-divider::before,
.create-dialog-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--el-border-color-lighter);
}
.create-dialog-divider-text {
  padding: 0 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.create-dialog-upload-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.create-dialog-upload-btn {
  width: 100%;
}
.create-dialog-upload-hint {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  line-height: 1.3;
}

.create-dialog-form :deep(.el-form-item) {
  margin-bottom: 16px;
}
.create-dialog-form :deep(.el-form-item__label) {
  font-weight: 500;
}

.create-preview-wrapper {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.create-preview-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 0;
}

.create-preview-grid {
  display: grid;
  gap: 1px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--el-border-color);
  background: var(--el-border-color-lighter);
  padding: 1px;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.15);
}

.create-preview-cell {
  border: none;
  cursor: pointer;
  transition: box-shadow 0.15s, transform 0.1s;
  min-width: 14px;
  min-height: 14px;
}
.create-preview-cell:hover {
  box-shadow: inset 0 0 0 2px var(--el-color-primary);
}

.create-preview-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.create-preview-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.create-preview-legend-dot {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  flex-shrink: 0;
}

.create-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.map-view-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-bottom: 1.5rem;
}
</style>
