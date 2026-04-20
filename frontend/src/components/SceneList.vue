<script setup lang="ts">
/**
 * 场景列表：分页、筛选、增删改
 */
import { ref, onMounted, inject, watch, type Ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Plus, Location } from '@element-plus/icons-vue'
import { toast } from 'vue3-toastify'
import type { Scene } from '../types/scene'
import { getSceneList, deleteScene, exportSceneNpcsFile } from '../api/scene'
import { NPC_CATEGORIES } from '../constants/npc'
import SceneForm from './SceneForm.vue'

const list = ref<Scene[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const pageSize = ref(12)
const keyword = ref('')
const filterCategory = ref('')
const filterStatus = ref<number | ''>('')
const filterTag = ref('')
const formVisible = ref(false)
const editId = ref<number | null>(null)

function parseTags(raw: unknown): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) return raw.map((x) => String(x))
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw) as unknown
      if (Array.isArray(p)) return p.map((x) => String(x))
    } catch {
      return raw ? [raw] : []
    }
  }
  return []
}

async function loadList() {
  loading.value = true
  try {
    const { data } = await getSceneList({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value.trim() || undefined,
      category: filterCategory.value || undefined,
      status: filterStatus.value === '' ? undefined : Number(filterStatus.value),
      tag: filterTag.value.trim() || undefined,
    })
    if (data.code === 0 && data.data) {
      total.value = data.data.total
      list.value = data.data.list.map((row) => ({
        ...row,
        tags: parseTags(row.tags),
      }))
    } else {
      toast.error(data.message || '加载失败')
    }
  } catch (e) {
    console.error(e)
    toast.error('加载失败，请检查网络与是否已执行数据库迁移')
  } finally {
    loading.value = false
  }
}

function openAdd() {
  editId.value = null
  formVisible.value = true
}

function openEdit(item: Scene) {
  editId.value = item.id
  formVisible.value = true
}

async function handleDelete(item: Scene) {
  try {
    await ElMessageBox.confirm(`确定删除场景「${item.name}」？关联的角色档案不会被删除。`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    })
    const { data } = await deleteScene(item.id)
    if (data.code === 0) {
      toast.success('删除成功')
      loadList()
    } else {
      toast.error(data.message || '删除失败')
    }
  } catch (e) {
    if (e !== 'cancel') toast.error('删除失败')
  }
}

function onFormSuccess() {
  formVisible.value = false
  loadList()
  toast.success('保存成功')
}

function onPageChange(p: number) {
  page.value = p
  loadList()
}

/** App 从 NPC 页跳转：打开指定场景编辑 */
const sceneOpenId = inject<Ref<number | null>>('sceneOpenId')
if (sceneOpenId) {
  watch(
    sceneOpenId,
    (id) => {
      if (id != null && id > 0) {
        editId.value = id
        formVisible.value = true
        sceneOpenId.value = null
      }
    },
    { flush: 'sync' },
  )
}

async function downloadExport(item: Scene, format: 'json' | 'csv') {
  try {
    const res = await exportSceneNpcsFile(item.id, format)
    const blob = res.data
    const ext = format === 'json' ? 'json' : 'csv'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `scene-${item.id}-npcs.${ext}`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('已开始下载')
  } catch (e) {
    console.error(e)
    toast.error('导出失败')
  }
}

onMounted(loadList)
</script>

<template>
  <div class="ainpc-list-inner">
    <header class="ainpc-intro">
      <h2 class="ainpc-intro-title">场景</h2>
      <p class="ainpc-intro-desc">
        编排剧情/空间情境，并将角色 NPC 关联到同一场景（多对多）；与「斯坦福 AI 小镇」式数据层对齐。
      </p>
    </header>

    <section class="ainpc-toolbar" aria-label="筛选与操作">
      <div class="flex gap-2 items-center flex-wrap">
        <el-input v-model="keyword" placeholder="名称/简介关键词" clearable class="!w-44" @keyup.enter="loadList" />
        <el-input v-model="filterTag" placeholder="标签（含于 tags 数组）" clearable class="!w-40" @keyup.enter="loadList" />
        <el-select v-model="filterCategory" placeholder="全部分类" clearable size="default" class="!w-32">
          <el-option v-for="c in NPC_CATEGORIES" :key="c.value" :label="c.label" :value="c.value" />
        </el-select>
        <el-select v-model="filterStatus" placeholder="全部状态" clearable size="default" class="!w-28">
          <el-option label="启用" :value="1" />
          <el-option label="禁用" :value="0" />
        </el-select>
        <el-button size="default" @click="loadList">刷新</el-button>
      </div>
      <el-button type="primary" @click="openAdd">
        <el-icon class="mr-1">
          <Plus />
        </el-icon>
        新增场景
      </el-button>
    </section>

    <el-skeleton v-if="loading" :rows="6" animated />
    <el-empty v-else-if="list.length === 0" description="暂无场景，请先执行后端迁移 db:migrate-scene 后新增">
      <template #image>
        <el-icon :size="48" class="text-[var(--ainpc-muted)]">
          <Location />
        </el-icon>
      </template>
    </el-empty>
    <el-row v-else :gutter="16" class="ainpc-list-cards">
      <el-col v-for="item in list" :key="item.id" :xs="24" :sm="12" :lg="8">
        <el-card :class="[item.status === 0 && 'ainpc-card--muted']" shadow="hover">
          <template #header>
            <div class="flex items-center gap-2 min-w-0 flex-wrap">
              <span class="font-semibold text-[#f0f6fc] truncate">{{ item.name }}</span>
              <el-tag v-if="item.category" size="small" type="info">
                {{NPC_CATEGORIES.find((c) => c.value === item.category)?.label || item.category}}
              </el-tag>
              <el-tag v-if="item.status === 0" type="info" size="small">已禁用</el-tag>
            </div>
          </template>
          <p v-if="item.description" class="text-sm text-[#c9d1d9] mb-2 line-clamp-2 leading-relaxed">
            {{ item.description }}
          </p>
          <div v-if="item.tags?.length" class="flex flex-wrap gap-1 mb-2">
            <el-tag v-for="t in item.tags" :key="t" size="small" effect="plain">{{ t }}</el-tag>
          </div>
          <p class="text-xs text-[var(--ainpc-muted)] mb-3">
            关联角色：{{ item.npc_count ?? 0 }} 个
          </p>
          <div class="flex flex-wrap gap-2 pt-3 border-t border-[var(--ainpc-border)]">
            <el-button size="small" @click="openEdit(item)">编辑</el-button>
            <el-button size="small" link type="primary" @click="downloadExport(item, 'json')">
              导出 JSON
            </el-button>
            <el-button size="small" link type="primary" @click="downloadExport(item, 'csv')">
              导出 CSV
            </el-button>
            <el-button type="danger" plain size="small" @click="handleDelete(item)">删除</el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <div v-if="total > 0" class="flex justify-center mt-6">
      <el-pagination v-model:current-page="page" :page-size="pageSize" :total="total" layout="total, prev, pager, next"
        background @current-change="onPageChange" />
    </div>
  </div>

  <SceneForm v-if="formVisible" :id="editId" @close="formVisible = false" @success="onFormSuccess" />
</template>

<style scoped>
.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
