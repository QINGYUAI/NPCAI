/**
 * 对话相关共享类型
 */
export interface MessageRecord {
  id: number
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface ConversationItem {
  id: number
  session_id: string
  created_at: string
  msg_count: number
  last_preview: string | null
}
