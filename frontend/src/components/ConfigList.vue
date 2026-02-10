<script setup lang="ts">
/**
 * AI 配置列表组件 - 使用 Element Plus 组件
 */
import { ref, onMounted } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Plus, Setting } from '@element-plus/icons-vue'
import { toast } from 'vue3-toastify'
import type { AiConfig } from '../types/config'
import { getConfigList, deleteConfig, setDefaultConfig, testConnection } from '../api/config'
import { PROVIDER_OPTIONS } from '../constants/providers'
import ConfigForm from './ConfigForm.vue'

const list = ref<AiConfig[]>([])
const loading = ref(false)
const filterProvider = ref('')
const filterStatus = ref<number | ''>('')
const formVisible = ref(false)
const editId = ref<number | null>(null)
const testingId = ref<number | null>(null)

async function loadList() {
  loading.value = true
  try {
    const { data } = await getConfigList({
      provider: filterProvider.value || undefined,
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

function openEdit(item: AiConfig) {
  editId.value = item.id
  formVisible.value = true
}

async function handleDelete(item: AiConfig) {
  try {
    await ElMessageBox.confirm(`确定删除配置「${item.name}」？`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    })
    const { data } = await deleteConfig(item.id)
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

async function handleSetDefault(item: AiConfig) {
  if (item.is_default) return
  try {
    const { data } = await setDefaultConfig(item.id)
    if (data.code === 0) {
      loadList()
      toast.success('已设为默认')
    } else {
      toast.error(data.message || '操作失败')
    }
  } catch (e) {
    toast.error('操作失败')
  }
}

async function handleTest(item: AiConfig) {
  testingId.value = item.id
  try {
    const { data } = await testConnection(item.id)
    if (data.code === 0) {
      toast.success('连接成功')
    } else {
      toast.error(data.message || '连接失败')
    }
  } catch (e) {
    toast.error('请求失败，请检查后端服务')
  } finally {
    testingId.value = null
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
  <div class="config-list">
    <!-- 筛选栏 -->
    <div class="flex flex-wrap justify-between items-center gap-3 mb-6">
      <div class="flex gap-2 items-center flex-wrap">
        <el-select
          v-model="filterProvider"
          placeholder="全部提供商"
          clearable
          size="default"
          class="!w-36"
        >
          <el-option v-for="p in PROVIDER_OPTIONS" :key="p" :label="p" :value="p" />
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
        新增配置
      </el-button>
    </div>

    <!-- 列表 -->
    <el-skeleton v-if="loading" :rows="6" animated />
    <el-empty v-else-if="list.length === 0" description="暂无配置，点击「新增配置」添加">
      <template #image>
        <el-icon :size="48" class="text-gray-500"><Setting /></el-icon>
      </template>
    </el-empty>
    <el-row v-else :gutter="16" class="config-cards">
      <el-col v-for="item in list" :key="item.id" :xs="24" :sm="12" :lg="8">
        <el-card
          :class="[
            'config-card',
            item.is_default && 'config-card-default',
            item.status === 0 && 'opacity-70',
          ]"
          shadow="hover"
        >
          <template #header>
            <div class="flex items-center gap-2">
              <span class="font-semibold">{{ item.name }}</span>
              <el-tag v-if="item.is_default" type="success" size="small">默认</el-tag>
              <el-tag v-if="item.status === 0" type="info" size="small">已禁用</el-tag>
            </div>
          </template>
          <div class="text-sm text-gray-500 space-y-1 mb-3">
            <div><span class="opacity-80">提供商</span> {{ item.provider }}</div>
            <div><span class="opacity-80">模型</span> {{ item.model }}</div>
            <div><span class="opacity-80">温度</span> {{ item.temperature }} · <span class="opacity-80">最大 Token</span> {{ item.max_tokens }}</div>
          </div>
          <p v-if="item.remark" class="text-xs text-gray-500 mb-3">{{ item.remark }}</p>
          <div class="flex flex-wrap gap-2 pt-3 border-t border-gray-700">
            <el-button
              v-if="!item.is_default"
              type="primary"
              plain
              size="small"
              @click="handleSetDefault(item)"
            >
              设为默认
            </el-button>
            <el-button
              type="info"
              plain
              size="small"
              :loading="testingId === item.id"
              @click="handleTest(item)"
            >
              {{ testingId === item.id ? '测试中' : '连接测试' }}
            </el-button>
            <el-button size="small" @click="openEdit(item)">编辑</el-button>
            <el-button type="danger" plain size="small" @click="handleDelete(item)">
              删除
            </el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>

  <ConfigForm
    v-if="formVisible"
    :id="editId"
    @close="formVisible = false"
    @success="onFormSuccess"
  />
</template>

<style scoped>
.config-list {
  max-width: 960px;
  margin: 0 auto;
}
.config-card-default {
  border-color: var(--el-color-primary);
}
.config-cards :deep(.el-card) {
  margin-bottom: 16px;
}
</style>
