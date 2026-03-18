<script setup lang="ts">
/**
 * 对话页 - 选择 NPC 后与角色对话，支持多会话管理
 */
import { ref, onMounted } from 'vue'
import { toast } from 'vue3-toastify'
import { ElMessageBox } from 'element-plus'
import type { Npc } from '../types/npc'
import { getNpcList } from '../api/npc'
import { getConversations, createConversation, deleteConversation } from '../api/conversation'
import type { ConversationItem } from '../api/conversation'
import { resolveAvatarUrl } from '../utils/avatar'
import ChatPanel from './ChatPanel.vue'

const npcList = ref<Npc[]>([])
const selectedNpc = ref<Npc | null>(null)
const sessionId = ref<string | null>(null)
const conversationId = ref<number | null>(null)
const conversationList = ref<ConversationItem[]>([])
const loading = ref(false)
const convLoading = ref(false)

async function loadNpcs() {
  loading.value = true
  try {
    const { data } = await getNpcList({ status: 1 })
    if (data.code === 0 && data.data) {
      npcList.value = data.data.filter((n) => n.status === 1)
      if (selectedNpc.value && !npcList.value.find((n) => n.id === selectedNpc.value!.id)) {
        selectedNpc.value = null
        sessionId.value = null
        conversationId.value = null
      }
    }
  } catch {
    toast.error('加载角色列表失败')
  } finally {
    loading.value = false
  }
}

async function loadConversations() {
  if (!selectedNpc.value) {
    conversationList.value = []
    return
  }
  convLoading.value = true
  try {
    const { data } = await getConversations(selectedNpc.value.id)
    if (data.code === 0 && data.data) {
      conversationList.value = data.data
    } else {
      conversationList.value = []
    }
  } catch {
    conversationList.value = []
  } finally {
    convLoading.value = false
  }
}

async function selectNpc(npc: Npc) {
  if (selectedNpc.value?.id === npc.id) return
  selectedNpc.value = npc
  sessionId.value = null
  conversationId.value = null
  await loadConversations()
  if (conversationList.value.length > 0) {
    selectConversation(conversationList.value[0]!)
  } else {
    await newSession()
  }
}

function selectConversation(item: ConversationItem) {
  sessionId.value = item.session_id
  conversationId.value = item.id
}

async function newSession() {
  if (!selectedNpc.value) return
  try {
    const { data } = await createConversation(selectedNpc.value.id)
    if (data.code === 0 && data.data) {
      sessionId.value = data.data.session_id
      conversationId.value = data.data.id
      conversationList.value = [{ id: data.data.id, session_id: data.data.session_id, created_at: new Date().toISOString(), msg_count: 0, last_preview: null }, ...conversationList.value]
      toast.success('已创建新会话')
    } else {
      toast.error(data.message || '创建失败')
    }
  } catch {
    toast.error('创建会话失败')
  }
}

async function handleDeleteConv(item: ConversationItem) {
  try {
    await ElMessageBox.confirm(`确定删除此会话？共 ${item.msg_count} 条消息将被清除。`)
    const { data } = await deleteConversation(item.id)
    if (data.code === 0) {
      conversationList.value = conversationList.value.filter((c) => c.id !== item.id)
      if (conversationId.value === item.id) {
        if (conversationList.value.length > 0) {
          selectConversation(conversationList.value[0]!)
        } else {
          sessionId.value = null
          conversationId.value = null
          await newSession()
        }
      }
      toast.success('已删除')
    } else {
      toast.error(data.message || '删除失败')
    }
  } catch (e) {
    if (e !== 'cancel') toast.error('删除失败')
  }
}

/** ChatPanel 发送成功后刷新会话列表（更新 last_preview、msg_count） */
function onChatSuccess() {
  loadConversations()
}

onMounted(loadNpcs)
</script>

<template>
  <div class="chat-view max-w-4xl mx-auto">
    <div class="mb-4">
      <p class="text-sm text-gray-500 mb-2">选择要对话的角色</p>
      <el-skeleton v-if="loading" :rows="2" animated />
      <div v-else class="flex flex-wrap gap-2">
        <el-button
          v-for="npc in npcList"
          :key="npc.id"
          :type="selectedNpc?.id === npc.id ? 'primary' : 'default'"
          size="default"
          @click="selectNpc(npc)"
        >
          <el-avatar v-if="npc.avatar" :src="resolveAvatarUrl(npc.avatar)" :size="20" class="mr-1" />
          <el-avatar v-else :size="20" class="mr-1">{{ npc.name?.charAt(0) }}</el-avatar>
          {{ npc.name }}
        </el-button>
      </div>
    </div>

    <div v-if="selectedNpc" class="mt-4">
      <h3 class="text-base font-medium mb-2 flex items-center gap-2">
        <el-avatar v-if="selectedNpc.avatar" :src="resolveAvatarUrl(selectedNpc.avatar)" :size="24" />
        <el-avatar v-else :size="24">{{ selectedNpc.name?.charAt(0) }}</el-avatar>
        与 {{ selectedNpc.name }} 对话
      </h3>
      <div class="flex gap-4">
        <!-- 会话列表侧栏 -->
        <div class="w-48 flex-shrink-0">
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm text-gray-500">会话</span>
            <el-button size="small" type="primary" @click="newSession">新建</el-button>
          </div>
          <el-scrollbar v-if="convLoading" height="200"><div class="py-4 text-center text-gray-500 text-sm">加载中...</div></el-scrollbar>
          <el-scrollbar v-else height="200" class="conversation-list">
            <div
              v-for="c in conversationList"
              :key="c.id"
              :class="['conversation-item', conversationId === c.id && 'active']"
              @click="selectConversation(c)"
            >
              <div class="truncate text-sm">{{ c.last_preview || '新会话' }}</div>
              <div class="flex items-center justify-between mt-1">
                <span class="text-xs text-gray-500">{{ c.msg_count }} 条</span>
                <el-button size="small" type="danger" text @click.stop="handleDeleteConv(c)">删</el-button>
              </div>
            </div>
            <el-empty v-if="!convLoading && conversationList.length === 0" description="暂无会话" :image-size="48" />
          </el-scrollbar>
        </div>
        <div class="flex-1 min-w-0">
          <ChatPanel
            :npc-id="selectedNpc.id"
            :npc-name="selectedNpc.name"
            :npc-avatar="selectedNpc.avatar"
            :session-id="sessionId"
            @success="onChatSuccess"
          />
        </div>
      </div>
    </div>

    <el-empty
      v-else
      description="请先选择一个角色开始对话"
      class="mt-12"
    />
  </div>
</template>

<style scoped>
.conversation-item {
  @apply p-2 rounded mb-2 cursor-pointer border border-transparent transition-colors;
}
.conversation-item:hover {
  @apply bg-gray-800/50;
}
.conversation-item.active {
  @apply bg-gray-700/50 border-gray-600;
}
</style>
