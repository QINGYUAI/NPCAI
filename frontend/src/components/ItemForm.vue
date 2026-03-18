<script setup lang="ts">
/**
 * 物品表单组件（新增/编辑）- 含 footprint 占地形状网格编辑
 */
import { ref, watch } from 'vue'
import { toast } from 'vue3-toastify'
import type { Item, ItemForm } from '../api/item'
import { getItemById, createItem, updateItem } from '../api/item'
import { ITEM_CATEGORIES } from '../constants/item'

const props = defineProps<{
  id: number | null
}>()

const emit = defineEmits<{
  close: []
  success: []
}>()

const loading = ref(false)
const form = ref<ItemForm>({
  name: '',
  category: 'object',
  description: '',
  footprint: [[1, 1], [1, 0]],
  tile_value: 1,
  is_blocking: 1,
  status: 1,
  sort: 0,
})

/** 解析 footprint（支持 JSON 字符串或二维数组） */
function parseFootprint(val: unknown): number[][] {
  if (Array.isArray(val) && val.length > 0) {
    const rows = val as unknown[][]
    return rows.map((r) => (Array.isArray(r) ? r.map((c) => Number(c) || 0) : [0]))
  }
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val)
      return parseFootprint(parsed)
    } catch {
      return [[1]]
    }
  }
  return [[1]]
}

async function loadDetail() {
  if (!props.id) return
  try {
    const { data } = await getItemById(props.id)
    if (data.code === 0 && data.data) {
      const d = data.data as Item
      form.value = {
        name: d.name,
        category: d.category || 'object',
        description: d.description || '',
        footprint: parseFootprint(d.footprint),
        tile_value: d.tile_value ?? 1,
        is_blocking: d.is_blocking ?? 1,
        status: d.status ?? 1,
        sort: d.sort ?? 0,
      }
    }
  } catch (e) {
    console.error(e)
  }
}

watch(
  () => props.id,
  (id) => {
    if (id) loadDetail()
    else resetForm()
  },
  { immediate: true }
)

function resetForm() {
  form.value = {
    name: '',
    category: 'object',
    description: '',
    footprint: [[1, 1], [1, 0]],
    tile_value: 1,
    is_blocking: 1,
    status: 1,
    sort: 0,
  }
}

/** 切换 footprint 格子：1=障碍 0=可行走 */
function toggleCell(rowIdx: number, colIdx: number) {
  const fp = form.value.footprint
  if (!fp[rowIdx]) return
  const v = fp[rowIdx]![colIdx] ?? 0
  fp[rowIdx]![colIdx] = v ? 0 : 1
  form.value.footprint = fp.map((r) => [...r])
}

/** 添加一行（复制最后一行或全 0） */
function addRow() {
  const fp = form.value.footprint
  const cols = fp[0]?.length ?? 1
  form.value.footprint = [...fp, Array(cols).fill(0)]
}

/** 删除一行（至少保留 1 行） */
function removeRow() {
  const fp = form.value.footprint
  if (fp.length <= 1) return
  form.value.footprint = fp.slice(0, -1)
}

/** 添加一列 */
function addCol() {
  form.value.footprint = form.value.footprint.map((r) => [...r, 0])
}

/** 删除一列（至少保留 1 列） */
function removeCol() {
  const fp = form.value.footprint
  const cols = fp[0]?.length ?? 1
  if (cols <= 1) return
  form.value.footprint = fp.map((r) => r.slice(0, -1))
}

async function submit() {
  if (!form.value.name.trim()) {
    toast.warning('请输入物品名称')
    return
  }
  const fp = form.value.footprint
  if (!fp?.length || !fp[0]?.length) {
    toast.warning('占地形状至少 1×1')
    return
  }
  loading.value = true
  try {
    if (props.id) {
      const { data } = await updateItem(props.id, form.value)
      if (data.code === 0) {
        emit('success')
      } else {
        toast.error(data.message || '更新失败')
      }
    } else {
      const { data } = await createItem(form.value)
      if (data.code === 0) {
        emit('success')
      } else {
        toast.error(data.message || '创建失败')
      }
    }
  } catch (e) {
    console.error(e)
    toast.error('请求失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-drawer
    :model-value="true"
    :title="id ? '编辑物品' : '新增物品'"
    direction="rtl"
    size="420px"
    :close-on-click-modal="false"
    @close="emit('close')"
  >
    <div class="px-2 pb-4">
      <el-form label-width="90px" label-position="left">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="如：甜品店、喷泉" maxlength="128" show-word-limit />
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="form.category" placeholder="选择分类" class="w-full">
            <el-option v-for="c in ITEM_CATEGORIES" :key="c.value" :label="c.label" :value="c.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="描述">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="2"
            placeholder="物品描述，用于 NPC 认知"
            maxlength="512"
            show-word-limit
          />
        </el-form-item>
        <el-form-item label="占地形状">
          <div class="space-y-2">
            <p class="text-xs text-gray-500">点击格子切换 1(障碍)/0(可行走)</p>
            <div class="inline-flex flex-col gap-0.5 p-2 rounded bg-gray-800/50">
              <div
                v-for="(row, ri) in form.footprint"
                :key="ri"
                class="flex gap-0.5"
              >
                <button
                  v-for="(cell, ci) in row"
                  :key="ci"
                  type="button"
                  :class="[
                    'w-7 h-7 rounded border transition-colors',
                    cell ? 'bg-amber-500/80 border-amber-400 text-amber-100' : 'bg-gray-700/50 border-gray-600 text-gray-400 hover:bg-gray-600',
                  ]"
                  @click="toggleCell(ri, ci)"
                >
                  {{ cell }}
                </button>
              </div>
            </div>
            <div class="flex gap-2">
              <el-button size="small" @click="addRow">加行</el-button>
              <el-button size="small" @click="removeRow">减行</el-button>
              <el-button size="small" @click="addCol">加列</el-button>
              <el-button size="small" @click="removeCol">减列</el-button>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="tile_value">
          <el-input-number v-model="form.tile_value" :min="1" :max="10" />
          <span class="ml-2 text-xs text-gray-500">用于地图渲染区分颜色</span>
        </el-form-item>
        <el-form-item label="阻挡通行">
          <el-switch v-model="form.is_blocking" :active-value="1" :inactive-value="0" />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio :value="1">启用</el-radio>
            <el-radio :value="0">禁用</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" />
        </el-form-item>
        <el-form-item>
          <div class="flex gap-2">
            <el-button type="primary" :loading="loading" @click="submit">保存</el-button>
            <el-button @click="emit('close')">取消</el-button>
          </div>
        </el-form-item>
      </el-form>
    </div>
  </el-drawer>
</template>
