/**
 * 对话 API - 用户与 NPC 聊天
 */
import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:3000/api',
  timeout: 60000, // 对话接口 LLM 调用较慢
})

export interface ApiResponse<T> {
  code: number
  data?: T
  message?: string
}

/** 对话请求参数 */
export interface ChatParams {
  npc_id: number
  session_id?: string
  user_input: string
}

/** 对话响应 */
export interface ChatResult {
  content: string
  message_id: number
  session_id: string
  conversation_id: number
}

/** 发送消息与 NPC 对话 */
export function chat(params: ChatParams) {
  return api.post<ApiResponse<ChatResult>>('/conversation/chat', params)
}

/** 流式对话：逐字返回，onChunk 接收内容片段，onDone 接收完整结果 */
export async function chatStream(
  params: ChatParams,
  callbacks: {
    onChunk: (content: string) => void
    onDone: (result: { message_id: number; session_id: string; conversation_id: number }) => void
    onError?: (message: string) => void
  }
) {
  const baseURL = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  const res = await fetch(`${baseURL}/conversation/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: controller.signal,
  })
  clearTimeout(timer)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    callbacks.onError?.(err?.message || '请求失败')
    return
  }
  const reader = res.body?.getReader()
  if (!reader) {
    callbacks.onError?.('无法读取流')
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data: ')) continue
      try {
        const data = JSON.parse(s.slice(6)) as { content?: string; done?: boolean; error?: string; message_id?: number; session_id?: string; conversation_id?: number }
        if (data.error) {
          callbacks.onError?.(data.error)
          return
        }
        if (data.content) callbacks.onChunk(data.content)
        if (data.done && data.message_id && data.session_id != null && data.conversation_id != null) {
          callbacks.onDone({
            message_id: data.message_id,
            session_id: data.session_id,
            conversation_id: data.conversation_id,
          })
        }
      } catch {
        /* 忽略解析失败 */
      }
    }
  }
}

/** 消息记录 */
export interface MessageRecord {
  id: number
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

/** 获取会话历史消息 */
export function getMessages(sessionId: string) {
  return api.get<ApiResponse<MessageRecord[]>>('/conversation/messages', {
    params: { session_id: sessionId },
  })
}

/** 会话摘要 */
export interface ConversationItem {
  id: number
  session_id: string
  created_at: string
  msg_count: number
  last_preview: string | null
}

/** 获取某 NPC 的会话列表 */
export function getConversations(npcId: number) {
  return api.get<ApiResponse<ConversationItem[]>>('/conversation/conversations', {
    params: { npc_id: npcId },
  })
}

/** 创建新会话 */
export function createConversation(npcId: number) {
  return api.post<ApiResponse<{ id: number; session_id: string }>>('/conversation/conversations', {
    npc_id: npcId,
  })
}

/** 删除会话 */
export function deleteConversation(id: number) {
  return api.delete<ApiResponse<void>>(`/conversation/conversations/${id}`)
}

/** 记忆项 */
export interface MemoryItem {
  id: number
  npc_id: number
  conversation_id: number | null
  type: string
  description: string
  importance: number
  created_at: string
}
