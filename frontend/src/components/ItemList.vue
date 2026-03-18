<script setup lang="ts">
/**
 * 物品管理列表 - 建筑、喷泉、家具等地图物品的增删改查
 */
import { ref, onMounted, computed } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Plus, Box } from '@element-plus/icons-vue'
import { toast } from 'vue3-toastify'
import type { Item } from '../api/item'
import { getItemList, deleteItem } from '../api/item'
import { ITEM_CATEGORIES, TILE_VALUE_LABELS } from '../constants/item'
import ItemForm from './ItemForm.vue'

const list = ref<Item[]>([])
const loading = ref(false)
const filterCategory = ref('')
const formVisible = ref(false)
const editId = ref<number | null>(null)

/** 分类选项（含“全部”） */
const categoryOptions = computed(() => [
  { value: '', label: '全部分类' },
  ...ITEM_CATEGORIES,
])

async function loadList() {
  loading.value = true
  try {
    const { data } = await getItemList()
    if (data.code === 0 && data.data) {
      list.value = data.data
    } else {
      toast.error(data.message || '加载失败')
    }
  } catch (e) {
    console.error(e)
    toast.error('加载失败，请检查网络')
  } finally {
    loading.value = false
  }
}

/** 按分类筛选 */
const filteredList = computed(() => {
  if (!filterCategory.value) return list.value
  return list.value.filter((i) => i.category === filterCategory.value)
})

function openAdd() {
  editId.value = null
  formVisible.value = true
}

function openEdit(item: Item) {
  editId.value = item.id
  formVisible.value = true
}

async function handleDelete(item: Item) {
  try {
    await ElMessageBox.confirm(`确定删除物品「${item.name}」？该物品若已放置在地图上，相关绑定也会被移除。`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    })
    const { data } = await deleteItem(item.id)
    if (data.code === 0) {
      loadList()
      toast.success('删除成功')
    } else {
      toast.error(data.message || '删除失败')
    }
  } catch (e) {
    if (e !== 'cancel') toast.error('删除失败')
  }
}

/** 解析 footprint 用于预览尺寸 */
function getFootprintSize(item: Item): string {
  let fp: number[][]
  try {
    const val = item.footprint
    fp = typeof val === 'string' ? JSON.parse(val) : val
  } catch {
    return '-'
  }
  if (!Array.isArray(fp) || fp.length === 0) return '-'
  const rows = fp.length
  const cols = fp[0]?.length ?? 0
  return `${rows}×${cols}`
}

function getCategoryLabel(cat: string) {
  return ITEM_CATEGORIES.find((c) => c.value === cat)?.label ?? cat
}

function getTileValueLabel(tv: number) {
  return TILE_VALUE_LABELS[tv] ?? `值${tv}`
}

function onFormSuccess() {
  formVisible.value = false
  loadList()
  toast.success('保存成功')
}

onMounted(loadList)
</script>

<template>
  <div class="item-list">
    <!-- 筛选栏 -->
    <div class="flex flex-wrap justify-between items-center gap-3 mb-6">
      <div class="flex gap-2 items-center flex-wrap">
        <el-select
          v-model="filterCategory"
          placeholder="全部分类"
          clearable
          size="default"
          class="!w-36"
        >
          <el-option
            v-for="opt in categoryOptions"
            :key="opt.value || 'all'"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <el-button size="default" @click="loadList">刷新</el-button>
      </div>
      <el-button type="primary" @click="openAdd">
        <el-icon class="mr-1"><Plus /></el-icon>
        新增物品
      </el-button>
    </div>

    <!-- 列表 -->
    <el-skeleton v-if="loading" :rows="6" animated />
    <el-empty v-else-if="filteredList.length === 0" description="暂无物品，点击「新增物品」添加">
      <template #image>
        <el-icon :size="48" class="text-gray-500"><Box /></el-icon>
      </template>
    </el-empty>
    <el-row v-else :gutter="16" class="item-cards">
      <el-col v-for="item in filteredList" :key="item.id" :xs="24" :sm="12" :lg="8">
        <el-card
          :class="['item-card', item.status === 0 && 'opacity-70']"
          shadow="hover"
        >
          <template #header>
            <div class="flex items-center gap-2">
              <span class="font-semibold">{{ item.name }}</span>
              <el-tag size="small" type="info">{{ getCategoryLabel(item.category) }}</el-tag>
              <el-tag v-if="item.status === 0" type="info" size="small">已禁用</el-tag>
            </div>
          </template>
          <div class="text-sm text-gray-500 space-y-1 mb-3">
            <div><span class="opacity-80">占地</span> {{ getFootprintSize(item) }}</div>
            <div><span class="opacity-80">tile_value</span> {{ getTileValueLabel(item.tile_value) }}</div>
            <div v-if="item.is_blocking === 0"><span class="opacity-80">阻挡</span> 否</div>
          </div>
          <p v-if="item.description" class="text-xs text-gray-500 mb-3 line-clamp-2">
            {{ item.description }}
          </p>
          <div class="flex flex-wrap gap-2 pt-3 border-t border-gray-700">
            <el-button size="small" @click="openEdit(item)">编辑</el-button>
            <el-button type="danger" plain size="small" @click="handleDelete(item)">
              删除
            </el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>

  <ItemForm
    v-if="formVisible"
    :id="editId"
    @close="formVisible = false"
    @success="onFormSuccess"
  />
</template>

<style scoped>
.item-list {
  max-width: 960px;
  margin: 0 auto;
}
.item-cards :deep(.el-card) {
  margin-bottom: 16px;
}
</style>
