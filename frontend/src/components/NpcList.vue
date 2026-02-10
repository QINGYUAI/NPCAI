<script setup lang="ts">
/**
 * 角色 NPC 列表组件
 */
import { ref, onMounted } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Plus, User } from '@element-plus/icons-vue'
import { toast } from 'vue3-toastify'
import type { Npc } from '../types/npc'
import { getNpcList, deleteNpc } from '../api/npc'
import { NPC_CATEGORIES } from '../constants/npc'
import NpcForm from './NpcForm.vue'

const list = ref<Npc[]>([])
const loading = ref(false)
const filterCategory = ref('')
const filterStatus = ref<number | ''>('')
const formVisible = ref(false)
const editId = ref<number | null>(null)

async function loadList() {
  loading.value = true
  try {
    const { data } = await getNpcList({
      category: filterCategory.value || undefined,
      status: filterStatus.value === '' ? undefined : filterStatus.value,
    })
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

function openAdd() {
  editId.value = null
  formVisible.value = true
}

function openEdit(item: Npc) {
  editId.value = item.id
  formVisible.value = true
}

async function handleDelete(item: Npc) {
  try {
    await ElMessageBox.confirm(`确定删除角色「${item.name}」？`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    })
    const { data } = await deleteNpc(item.id)
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

function onFormSuccess() {
  formVisible.value = false
  loadList()
  toast.success('保存成功')
}

onMounted(loadList)
</script>

<template>
  <div class="npc-list">
    <div class="flex flex-wrap justify-between items-center gap-3 mb-6">
      <div class="flex gap-2 items-center flex-wrap">
        <el-select
          v-model="filterCategory"
          placeholder="全部分类"
          clearable
          size="default"
          class="!w-32"
        >
          <el-option
            v-for="c in NPC_CATEGORIES"
            :key="c.value"
            :label="c.label"
            :value="c.value"
          />
        </el-select>
        <el-select
          v-model="filterStatus"
          placeholder="全部状态"
          clearable
          size="default"
          class="!w-28"
        >
          <el-option label="启用" :value="1" />
          <el-option label="禁用" :value="0" />
        </el-select>
        <el-button size="default" @click="loadList">刷新</el-button>
      </div>
      <el-button type="primary" @click="openAdd">
        <el-icon class="mr-1"><Plus /></el-icon>
        新增角色
      </el-button>
    </div>

    <el-skeleton v-if="loading" :rows="6" animated />
    <el-empty v-else-if="list.length === 0" description="暂无角色，点击「新增角色」添加">
      <template #image>
        <el-icon :size="48" class="text-gray-500"><User /></el-icon>
      </template>
    </el-empty>
    <el-row v-else :gutter="16" class="npc-cards">
      <el-col v-for="item in list" :key="item.id" :xs="24" :sm="12" :lg="8">
        <el-card
          :class="['npc-card', item.status === 0 && 'opacity-70']"
          shadow="hover"
        >
          <template #header>
            <div class="flex items-center gap-2">
              <el-avatar v-if="item.avatar" :src="item.avatar" :size="28" />
              <el-avatar v-else :size="28">{{ item.name?.charAt(0) }}</el-avatar>
              <span class="font-semibold">{{ item.name }}</span>
              <el-tag v-if="item.category" size="small" type="info">
                {{ NPC_CATEGORIES.find((c) => c.value === item.category)?.label || item.category }}
              </el-tag>
              <el-tag v-if="item.status === 0" type="info" size="small">已禁用</el-tag>
            </div>
          </template>
          <p v-if="item.description" class="text-sm text-gray-500 mb-2 line-clamp-2">
            {{ item.description }}
          </p>
          <div class="text-xs text-gray-500 mb-2">
            <span class="opacity-80">AI 配置</span> {{ item.ai_config_name || '-' }} · {{ item.provider }}
          </div>
          <p v-if="item.personality" class="text-xs text-gray-600 mb-3 line-clamp-1">
            性格：{{ item.personality }}
          </p>
          <div class="flex flex-wrap gap-2 pt-3 border-t border-gray-700">
            <el-button size="small" @click="openEdit(item)">编辑</el-button>
            <el-button type="danger" plain size="small" @click="handleDelete(item)">删除</el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>

  <NpcForm v-if="formVisible" :id="editId" @close="formVisible = false" @success="onFormSuccess" />
</template>

<style scoped>
.npc-list {
  max-width: 960px;
  margin: 0 auto;
}
.npc-cards :deep(.el-card) {
  margin-bottom: 16px;
}
.line-clamp-1 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
