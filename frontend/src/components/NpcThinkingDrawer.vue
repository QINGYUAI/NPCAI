<script setup lang="ts">
/**
 * 地图 NPC 点击 - 思考记录抽屉
 * 通过轮询实时展示当前 NPC 的最近思考（wander/对话），不复用 MemoryDrawer
 */
import { ref, watch, onUnmounted } from 'vue'
import { getRecentThoughts } from '../api/memory'
import type { ThoughtItem } from '../api/memory'

const props = defineProps<{
  visible: boolean
  npcId: number | null
  npcName: string
}>()

const emit = defineEmits<{ close: [] }>()

const list = ref<ThoughtItem[]>([])
const loading = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

const POLL_INTERVAL_MS = 3000

async function fetchThoughts() {
  if (!props.npcId) {
    list.value = []
    return
  }
  try {
    const { data } = await getRecentThoughts(props.npcId)
    list.value = data?.code === 0 && data?.data ? data.data : []
  } catch {
    list.value = []
  }
}

function startPolling() {
  stopPolling()
  if (!props.npcId) return
  fetchThoughts().finally(() => {
    loading.value = false
  })
  pollTimer = setInterval(() => {
    if (props.visible && props.npcId) fetchThoughts()
  }, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function typeLabel(t: string) {
  const m: Record<string, string> = { wander: '移动', conversation: '相遇' }
  return m[t] || t
}

watch(
  () => [props.visible, props.npcId],
  () => {
    if (props.visible && props.npcId) {
      loading.value = true
      startPolling()
    } else {
      stopPolling()
      list.value = []
    }
  }
)

onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <el-drawer
    :model-value="visible"
    :title="`${npcName} 的思考记录`"
    direction="rtl"
    size="400"
    @close="emit('close')"
  >
    <el-skeleton v-if="loading && list.length === 0" :rows="5" animated />
    <div v-else class="space-y-3">
      <p class="text-sm text-gray-500">每 {{ POLL_INTERVAL_MS / 1000 }} 秒自动刷新</p>
      <div v-for="item in list" :key="item.id" class="rounded border border-gray-700 p-3">
        <div class="flex items-center justify-between mb-1">
          <el-tag size="small" type="info">{{ typeLabel(item.type) }}</el-tag>
          <span class="text-xs text-gray-500">
            {{ new Date(item.created_at).toLocaleString('zh-CN') }}
          </span>
        </div>
        <p class="text-sm">{{ item.description }}</p>
      </div>
      <el-empty
        v-if="!loading && list.length === 0"
        description="暂无思考记录，NPC 移动或相遇后会生成"
      />
    </div>
  </el-drawer>
</template>
