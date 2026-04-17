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
  <div class="ainpc-list-inner">
    <!-- 设置页说明：与 Tab 标题区分，强调本页职责 -->
    <header class="ainpc-intro">
      <h2 class="ainpc-intro-title">AI 连接配置</h2>
      <p class="ainpc-intro-desc">
        维护多套提供商与模型参数；列表中可设默认、做连通性测试。敏感信息仅在编辑弹窗中填写。
      </p>
    </header>

    <!-- 工具条：独立面板，筛选与主操作分区 -->
    <section class="ainpc-toolbar" aria-label="筛选与操作">
      <div class="flex gap-2 items-center flex-wrap">
        <el-select v-model="filterProvider" placeholder="全部提供商" clearable size="default" class="!w-36">
          <el-option v-for="p in PROVIDER_OPTIONS" :key="p" :label="p" :value="p" />
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
        新增配置
      </el-button>
    </section>

    <!-- 配置卡片网格 -->
    <el-skeleton v-if="loading" :rows="6" animated />
    <el-empty v-else-if="list.length === 0" description="暂无配置，点击「新增配置」添加">
      <template #image>
        <el-icon :size="48" class="text-[var(--ainpc-muted)]">
          <Setting />
        </el-icon>
      </template>
    </el-empty>
    <el-row v-else :gutter="16" class="ainpc-list-cards">
      <el-col v-for="item in list" :key="item.id" :xs="24" :sm="12" :lg="8">
        <el-card :class="[
          item.is_default && 'ainpc-card--highlight',
          item.status === 0 && 'ainpc-card--muted',
        ]" shadow="hover">
          <template #header>
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <div class="flex items-center gap-2 min-w-0">
                <span class="font-semibold text-[#f0f6fc] truncate">{{ item.name }}</span>
                <el-tag v-if="item.is_default" type="success" size="small">默认</el-tag>
                <el-tag v-if="item.status === 0" type="info" size="small">已禁用</el-tag>
              </div>
            </div>
          </template>
          <dl class="config-meta text-sm space-y-2 mb-3">
            <div class="flex justify-between gap-2">
              <dt class="text-[var(--ainpc-muted)] shrink-0">提供商</dt>
              <dd class="text-[#c9d1d9] text-right truncate">{{ item.provider }}</dd>
            </div>
            <div class="flex justify-between gap-2 items-baseline">
              <dt class="text-[var(--ainpc-muted)] shrink-0">模型</dt>
              <dd class="font-mono-nums text-xs text-[#79c0ff] text-right break-all">{{ item.model }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-[var(--ainpc-muted)] shrink-0">采样</dt>
              <dd class="text-[#c9d1d9] font-mono-nums text-xs">
                temp {{ item.temperature }} · max {{ item.max_tokens }}
              </dd>
            </div>
          </dl>
          <p v-if="item.remark"
            class="text-xs text-[var(--ainpc-muted)] mb-3 line-clamp-2 border-l-2 border-[var(--ainpc-border)] pl-2">
            {{ item.remark }}
          </p>
          <div class="config-actions flex flex-wrap gap-2 pt-3 border-t border-[var(--ainpc-border)]">
            <el-button v-if="!item.is_default" type="primary" plain size="small" @click="handleSetDefault(item)">
              设为默认
            </el-button>
            <el-button type="info" plain size="small" :loading="testingId === item.id" @click="handleTest(item)">
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

  <ConfigForm v-if="formVisible" :id="editId" @close="formVisible = false" @success="onFormSuccess" />
</template>

<style scoped>
.config-meta dt {
  font-size: 0.8125rem;
}

.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
