/**
 * 地图创建 Composable
 * AI 生成、布局图上传、创建表单
 */
import { ref, computed } from 'vue'
import {
  createMap,
  generateMapContent,
  convertLayoutToMap,
  type GenerateMapItem,
} from '../api/map'
import { getConfigList } from '../api/config'
import type { AiConfig } from '../types/config'

const DEFAULT_TILE_TYPES: Record<number, { name: string; color: string }> = {
  1: { name: '建筑', color: '#444444' },
  2: { name: '喷泉', color: '#5dade2' },
  3: { name: '水域', color: '#2874a6' },
}

export interface CreateFormState {
  name: string
  width: number
  height: number
  tile_data?: number[][]
  tile_types?: Record<number, { name: string; color: string }>
  items?: GenerateMapItem[]
}

export function useMapCreate() {
  const createForm = ref<CreateFormState>({
    name: '',
    width: 10,
    height: 10,
    tile_types: { ...DEFAULT_TILE_TYPES },
  })
  const aiConfigList = ref<AiConfig[]>([])
  const generateAiConfigId = ref<number>(0)
  const generateHint = ref('')
  const generateLoading = ref(false)

  const hasGeneratedMap = computed(
    () =>
      !!(
        createForm.value.name &&
        (createForm.value.items?.length ||
          (createForm.value.tile_data &&
            createForm.value.tile_data.some((row) => row.some((c) => c > 0))))
      )
  )

  const createTileCycleOrder = computed(() => {
    const types = createForm.value.tile_types ?? DEFAULT_TILE_TYPES
    const keys = Object.keys(types)
      .map(Number)
      .filter((n) => !isNaN(n) && n > 0)
      .sort((a, b) => a - b)
    return [0, ...keys]
  })

  const createValidTileValues = computed(() => {
    const types = createForm.value.tile_types ?? DEFAULT_TILE_TYPES
    const set = new Set([0])
    for (const k of Object.keys(types)) {
      const n = Number(k)
      if (!isNaN(n) && n > 0) set.add(n)
    }
    return set
  })

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
    createForm.value = {
      ...createForm.value,
      tile_data: grid,
      tile_types: tile_types ?? DEFAULT_TILE_TYPES,
    }
  }

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

  async function handleAiGenerateMap() {
    const aiConfigId = generateAiConfigId.value
    const hint = generateHint.value?.trim()
    if (!aiConfigId || !hint) return { ok: false, message: '请选择 AI 配置并填写描述' }
    try {
      generateLoading.value = true
      const params: Parameters<typeof generateMapContent>[0] = {
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
        return { ok: true }
      }
      return { ok: false, message: data?.message || '生成失败' }
    } catch {
      return { ok: false, message: 'AI 生成失败' }
    } finally {
      generateLoading.value = false
    }
  }

  async function handleLayoutUpload(file: File) {
    const aiConfigId = generateAiConfigId.value
    if (!aiConfigId) return { ok: false, message: '请先选择 AI 配置' }
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
        return { ok: true }
      }
      return { ok: false, message: data?.message || '转换失败' }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '布局图转换失败' }
    } finally {
      generateLoading.value = false
    }
  }

  async function doCreateMap() {
    const { name, width, height, tile_data, tile_types, items } = createForm.value
    if (!name || width < 1 || height < 1) return { ok: false, message: '参数无效' }
    try {
      const metadata = tile_types && Object.keys(tile_types).length > 0 ? { tile_types } : undefined
      if (items?.length) {
        await createMap({ name, width, height, items, metadata })
      } else {
        const validTileData =
          tile_data &&
          tile_data.length === height &&
          tile_data.every((row) => Array.isArray(row) && row.length === width)
        const finalTileData = validTileData
          ? tile_data
          : Array.from({ length: height }, () => Array(width).fill(0))
        await createMap({ name, width, height, tile_data: finalTileData, metadata })
      }
      createForm.value = {
        name: '',
        width: 10,
        height: 10,
        tile_types: { ...DEFAULT_TILE_TYPES },
        items: undefined,
      }
      generateHint.value = ''
      return { ok: true }
    } catch {
      return { ok: false, message: '创建地图失败' }
    }
  }

  function resetForm() {
    createForm.value = {
      name: '',
      width: 10,
      height: 10,
      tile_types: { ...DEFAULT_TILE_TYPES },
      items: undefined,
    }
    generateHint.value = ''
  }

  return {
    createForm,
    aiConfigList,
    generateAiConfigId,
    generateHint,
    generateLoading,
    hasGeneratedMap,
    createTileCycleOrder,
    createValidTileValues,
    DEFAULT_TILE_TYPES,
    loadAiConfigs,
    ensureCreateFormTileData,
    toggleCreateTile,
    handleAiGenerateMap,
    handleLayoutUpload,
    doCreateMap,
    resetForm,
  }
}
