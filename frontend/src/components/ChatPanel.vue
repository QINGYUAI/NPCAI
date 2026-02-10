<script setup lang="ts">
/**
 * 对话面板 - 使用 Element-Plus-X 的 BubbleList + Sender 组件
 * 文档: https://element-plus-x.com/zh/
 */
import { ref, watch, nextTick, computed } from 'vue'
import { BubbleList, Sender } from 'vue-element-plus-x'
import { chatStream, getMessages } from '../api/conversation'
import type { MessageRecord } from '../api/conversation'
import { resolveAvatarUrl } from '../utils/avatar'
import { toast } from 'vue3-toastify'

const props = defineProps<{
  npcId: number
  npcName: string
  npcAvatar?: string | null
  sessionId: string | null
}>()
const emit = defineEmits<{ success: [] }>()

const messages = ref<MessageRecord[]>([])
const loading = ref(false)
const senderValue = ref('')
const bubbleListRef = ref<{ scrollToBottom: () => void } | null>(null)

/** 将 MessageRecord 转为 BubbleList 所需格式 */
type BubbleItem = {
  key: number
  role: 'user' | 'ai'
  placement: 'start' | 'end'
  content: string
  loading: boolean
  shape: 'corner'
  variant: 'filled' | 'outlined'
  avatar: string
  avatarSize: string
  typing?: boolean
}

const bubbleList = computed<BubbleItem[]>(() => {
  const defaultUserAvatar = 'https://api.dicebear.com/7.x/avataaars/svg?seed=user'
  // 使用角色配置的头像，无则回退为按名称生成的默认头像
  const npcAvatarUrl = resolveAvatarUrl(props.npcAvatar) || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(props.npcName)}`

  return messages.value.map((m, idx) => ({
    key: m.id,
    role: m.role === 'user' ? 'user' : 'ai',
    placement: m.role === 'user' ? 'end' : 'start',
    content: m.content,
    loading: loading.value && m.role === 'assistant' && idx === messages.value.length - 1 && !m.content,
    shape: 'corner' as const,
    variant: (m.role === 'user' ? 'outlined' : 'filled') as 'outlined' | 'filled',
    avatar: m.role === 'user' ? defaultUserAvatar : npcAvatarUrl,
    avatarSize: '32px',
    typing: m.role === 'assistant' && idx === messages.value.length - 1 && !loading.value,
  }))
})

/** 加载中占位项（流式时最后一则是 assistant，不再额外加 loading 气泡） */
const displayList = computed<BubbleItem[]>(() => {
  const list = [...bubbleList.value]
  const lastIsAssistant = list.length > 0 && list[list.length - 1]?.role === 'ai'
  if (loading.value && !lastIsAssistant) {
    list.push({
      key: -Date.now(),
      role: 'ai',
      placement: 'start',
      content: '',
      loading: true,
      shape: 'corner',
      variant: 'filled',
      avatar: resolveAvatarUrl(props.npcAvatar) || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(props.npcName)}`,
      avatarSize: '32px',
    })
  }
  return list
})

/** 加载历史消息 */
async function loadHistory() {
  if (!props.sessionId) {
    messages.value = []
    return
  }
  try {
    const { data } = await getMessages(props.sessionId)
    if (data.code === 0 && data.data) {
      messages.value = data.data
    } else {
      messages.value = []
    }
  } catch {
    messages.value = []
  }
}

/** 滚动到底部 */
function scrollToBottom() {
  nextTick(() => {
    bubbleListRef.value?.scrollToBottom()
  })
}

watch(
  () => [props.sessionId, props.npcId],
  () => {
    loadHistory()
    nextTick(scrollToBottom)
  },
  { immediate: true }
)

watch(displayList, () => nextTick(scrollToBottom), { deep: true })

async function handleSubmit(value: string) {
  const text = (value || senderValue.value || '').trim()
  if (!text) return
  if (loading.value) return
  if (!props.npcId) {
    toast.warning('请先选择角色')
    return
  }

  loading.value = true

  const userMsg: MessageRecord = {
    id: Date.now(),
    role: 'user',
    content: text,
    created_at: new Date().toISOString(),
  }
  messages.value.push(userMsg)
  // 占位：流式回复将实时更新 content
  const streamMsg: MessageRecord = {
    id: -Date.now(),
    role: 'assistant',
    content: '',
    created_at: new Date().toISOString(),
  }
  messages.value.push(streamMsg)
  scrollToBottom()

  try {
    await chatStream(
      {
        npc_id: props.npcId,
        session_id: props.sessionId || undefined,
        user_input: text,
      },
      {
        onChunk: (chunk) => {
          streamMsg.content += chunk
          scrollToBottom()
        },
        onDone: (result) => {
          streamMsg.id = result.message_id
          emit('success')
        },
        onError: (msg) => {
          toast.error(msg || '发送失败')
          messages.value.pop()
        },
      }
    )
  } catch (e: unknown) {
    const msg = (e as { message?: string })?.message
    toast.error(msg || '发送失败，请检查网络与 AI 配置')
    messages.value.pop()
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="chat-panel flex flex-col h-[520px] border border-gray-700 rounded-lg overflow-hidden bg-gray-900/30">
    <!-- BubbleList 消息列表 -->
    <div class="flex-1 min-h-0">
      <BubbleList
        ref="bubbleListRef"
        :list="displayList"
        max-height="100%"
        :btn-color="'var(--el-color-primary)'"
        :always-show-scrollbar="false"
      >
        <template #footer="{ item: msg }">
          <span
            v-if="msg.content && !msg.loading"
            class="text-xs text-gray-500"
          >
            {{ new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}
          </span>
        </template>
        <template #loading>
          <div class="flex items-center gap-2 px-3 py-2 text-gray-400 text-sm">
            <span class="animate-pulse">{{ npcName }} 正在思考</span>
            <span class="animate-bounce">...</span>
          </div>
        </template>
      </BubbleList>
    </div>

    <!-- 空状态 -->
    <div
      v-if="messages.length === 0 && !loading"
      class="absolute inset-0 flex items-center justify-center pointer-events-none"
    >
      <div class="text-center text-gray-500">
        <p class="text-sm">暂无消息，输入内容开始与 {{ npcName }} 对话</p>
        <p class="text-xs mt-1 opacity-70">支持多轮对话，上下文将自动保留</p>
      </div>
    </div>

    <!-- Sender 输入框 -->
    <div class="flex-shrink-0 p-3 border-t border-gray-700 bg-gray-800/50">
      <Sender
        v-model="senderValue"
        placeholder="输入消息，按 Enter 发送..."
        :loading="loading"
        clearable
        :disabled="!npcId"
        @submit="handleSubmit"
      />
    </div>
  </div>
</template>

<style scoped>
.chat-panel {
  position: relative;
}

/* 适配深色主题：气泡与输入框文字样式 */
.chat-panel :deep(.el-bubble-content) {
  background-color: rgba(48, 54, 61, 0.9) !important;
  color: #e6edf3 !important;
  border-color: rgba(56, 63, 70, 0.8);
}

.chat-panel :deep(.el-bubble-content-filled) {
  background-color: rgba(48, 54, 61, 0.9) !important;
  color: #e6edf3 !important;
}

.chat-panel :deep(.el-bubble-content-outlined) {
  background-color: rgba(22, 27, 34, 0.6) !important;
  border-color: rgba(56, 63, 70, 0.9) !important;
  color: #e6edf3 !important;
}

.chat-panel :deep(.el-bubble-header),
.chat-panel :deep(.el-bubble-footer) {
  color: #8b949e !important;
}

.chat-panel :deep(.typer-content),
.chat-panel :deep(.el-typewriter) {
  color: #e6edf3 !important;
}

/* Sender 输入框深色适配 */
.chat-panel :deep(.el-textarea__inner),
.chat-panel :deep(.el-textarea textarea),
.chat-panel :deep(.el-input__wrapper) {
  background-color: rgba(22, 27, 34, 0.8) !important;
  color: #e6edf3 !important;
  box-shadow: 0 0 0 1px rgba(56, 63, 70, 0.8);
}

.chat-panel :deep(.el-textarea__inner)::placeholder {
  color: #8b949e;
}
</style>
