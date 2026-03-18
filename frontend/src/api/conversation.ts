/**
 * 对话 API - 用户与 NPC 聊天
 */
import { conversationApi } from './client.js'
import type { ApiResponse } from './client.js'
import type { MemoryItem } from '../types/memory.js'
import type { MessageRecord, ConversationItem } from '../types/conversation.js'

export type { ApiResponse, MemoryItem, MessageRecord, ConversationItem }

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
  return conversationApi.post<ApiResponse<ChatResult>>('/conversation/chat', params)
}

/** 流式对话：逐字返回（使用 fetch 支持 SSE），onChunk 接收内容片段，onDone 接收完整结果 */
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

/** 获取会话历史消息 */
export function getMessages(sessionId: string) {
  return conversationApi.get<ApiResponse<MessageRecord[]>>('/conversation/messages', {
    params: { session_id: sessionId },
  })
}

/** 获取某 NPC 的会话列表 */
export function getConversations(npcId: number) {
  return conversationApi.get<ApiResponse<ConversationItem[]>>('/conversation/conversations', {
    params: { npc_id: npcId },
  })
}

/** 创建新会话 */
export function createConversation(npcId: number) {
  return conversationApi.post<ApiResponse<{ id: number; session_id: string }>>('/conversation/conversations', {
    npc_id: npcId,
  })
}

/** 删除会话 */
export function deleteConversation(id: number) {
  return conversationApi.delete<ApiResponse<void>>(`/conversation/conversations/${id}`)
}

