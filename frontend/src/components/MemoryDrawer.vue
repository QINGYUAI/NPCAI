<script setup lang="ts">
/**
 * 记忆管理抽屉 - 查看、编辑、删除 NPC 记忆
 */
import { ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { toast } from 'vue3-toastify'
import { getMemories, deleteMemory, updateMemory, reflectMemories } from '../api/memory'
import type { MemoryItem } from '../api/conversation'

const props = defineProps<{
  visible: boolean
  npcId: number | null
  npcName: string
}>()

const emit = defineEmits<{ close: [] }>()

const list = ref<MemoryItem[]>([])
const loading = ref(false)
const reflecting = ref(false)
const editingId = ref<number | null>(null)
const editingDesc = ref('')
const editingImp = ref(0.5)

async function load() {
  if (!props.npcId) {
    list.value = []
    return
  }
  loading.value = true
  try {
    const { data } = await getMemories(props.npcId)
    list.value = data.code === 0 && data.data ? data.data : []
  } catch {
    list.value = []
    toast.error('加载记忆失败')
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.visible, props.npcId],
  () => {
    if (props.visible && props.npcId) load()
    else editingId.value = null
  }
)

function startEdit(item: MemoryItem) {
  editingId.value = item.id
  editingDesc.value = item.description
  editingImp.value = Number(item.importance) || 0.5
}

async function saveEdit() {
  if (!editingId.value) return
  try {
    const { data } = await updateMemory(editingId.value, {
      description: editingDesc.value,
      importance: editingImp.value,
    })
    if (data.code === 0) {
      const idx = list.value.findIndex((m) => m.id === editingId.value)
      if (idx >= 0) {
        list.value[idx] = { ...list.value[idx], description: editingDesc.value, importance: editingImp.value }
      }
      editingId.value = null
      toast.success('已更新')
    } else {
      toast.error(data.message || '更新失败')
    }
  } catch {
    toast.error('更新失败')
  }
}

function cancelEdit() {
  editingId.value = null
}

async function handleDelete(item: MemoryItem) {
  try {
    await ElMessageBox.confirm(`确定删除该记忆？`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    })
    const { data } = await deleteMemory(item.id)
    if (data.code === 0) {
      list.value = list.value.filter((m) => m.id !== item.id)
      toast.success('已删除')
    } else {
      toast.error(data.message || '删除失败')
    }
  } catch (e) {
    if (e !== 'cancel') toast.error('删除失败')
  }
}

function typeLabel(t: string) {
  const m: Record<string, string> = { conversation: '对话', reflection: '反思', relationship: '关系' }
  return m[t] || t
}

async function doReflect() {
  if (!props.npcId || reflecting.value) return
  reflecting.value = true
  try {
    const { data } = await reflectMemories(props.npcId)
    if (data?.code === 0) {
      toast.success(data.message || '反思完成')
      load()
    } else {
      toast.error(data?.message || '反思失败')
    }
  } catch {
    toast.error('反思失败')
  } finally {
    reflecting.value = false
  }
}
</script>

<template>
  <el-drawer
    :model-value="visible"
    :title="`${npcName} 的记忆`"
    direction="rtl"
    size="400"
    @close="emit('close')"
  >
    <el-skeleton v-if="loading" :rows="5" animated />
    <div v-else class="space-y-3">
      <div class="flex items-center justify-between">
        <p class="text-sm text-gray-500">共 {{ list.length }} 条</p>
        <el-button size="small" :loading="reflecting" :disabled="list.length < 3" @click="doReflect">
          反思
        </el-button>
      </div>
      <div v-for="item in list" :key="item.id" class="rounded border border-gray-700 p-3">
        <div v-if="editingId === item.id" class="space-y-2">
          <el-input v-model="editingDesc" type="textarea" :rows="3" />
          <div class="flex items-center gap-2">
            <span class="text-xs text-gray-500">重要度</span>
            <el-slider v-model="editingImp" :min="0" :max="1" :step="0.1" style="width:120px" />
          </div>
          <div class="flex gap-2">
            <el-button size="small" type="primary" @click="saveEdit">保存</el-button>
            <el-button size="small" @click="cancelEdit">取消</el-button>
          </div>
        </div>
        <div v-else>
          <div class="flex items-center justify-between mb-1">
            <el-tag size="small" type="info">{{ typeLabel(item.type) }}</el-tag>
            <span class="text-xs text-gray-500">重要度 {{ (Number(item.importance) || 0).toFixed(2) }}</span>
          </div>
          <p class="text-sm mb-2">{{ item.description }}</p>
          <div class="flex gap-2 text-xs text-gray-500">
            {{ new Date(item.created_at).toLocaleString('zh-CN') }}
          </div>
          <div class="mt-2 flex gap-2">
            <el-button size="small" @click="startEdit(item)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="handleDelete(item)">删除</el-button>
          </div>
        </div>
      </div>
      <el-empty v-if="!loading && list.length === 0" description="暂无记忆，对话后将自动生成" />
    </div>
  </el-drawer>
</template>
