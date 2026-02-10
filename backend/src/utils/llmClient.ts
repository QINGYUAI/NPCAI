/**
 * 通用 LLM 调用工具（OpenAI 兼容 Chat Completions API）
 * 用于连接测试、角色生成等场景
 */
import { PROVIDER_BASE_URLS } from './providerDefaults.js';

export interface LlmConfig {
  api_key: string
  base_url?: string | null
  provider: string
  model?: string
  max_tokens?: number
}

/**
 * 调用 LLM 生成文本
 * @param config AI 配置信息
 * @param messages 消息列表
 * @param options 超时等选项
 */
export async function chatCompletion(
  config: LlmConfig,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  options?: { timeout?: number; max_tokens?: number }
): Promise<string> {
  const { api_key, base_url, provider, model } = config
  if (!api_key?.trim()) {
    throw new Error('该配置未设置 API Key')
  }

  const base = (base_url && base_url.trim()) || PROVIDER_BASE_URLS[provider] || 'https://api.openai.com/v1'
  const url = base.replace(/\/$/, '') + '/chat/completions'

  const body = {
    model: model || 'gpt-3.5-turbo',
    messages,
    max_tokens: options?.max_tokens ?? config.max_tokens ?? 2000,
  }

  const timeout = options?.timeout ?? 30000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${api_key}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })

  clearTimeout(timer)

  if (!resp.ok) {
    const errText = await resp.text()
    let errMsg = `HTTP ${resp.status}`
    try {
      const errJson = JSON.parse(errText)
      errMsg = errJson.error?.message || errJson.message || errText.slice(0, 300) || errMsg
    } catch {
      errMsg = errText.slice(0, 300) || errMsg
    }
    throw new Error(errMsg)
  }

  const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = json.choices?.[0]?.message?.content?.trim() || ''
  if (!content) {
    throw new Error('模型返回为空')
  }
  return content
}

/**
 * 流式调用 LLM，逐块返回生成内容
 * @returns AsyncGenerator  yielding 内容片段
 */
export async function* chatCompletionStream(
  config: LlmConfig,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  options?: { timeout?: number; max_tokens?: number }
): AsyncGenerator<string, void, void> {
  const { api_key, base_url, provider, model } = config
  if (!api_key?.trim()) {
    throw new Error('该配置未设置 API Key')
  }

  const base = (base_url && base_url.trim()) || PROVIDER_BASE_URLS[provider] || 'https://api.openai.com/v1'
  const url = base.replace(/\/$/, '') + '/chat/completions'

  const body = {
    model: model || 'gpt-3.5-turbo',
    messages,
    stream: true,
    max_tokens: options?.max_tokens ?? config.max_tokens ?? 2000,
  }

  const timeout = options?.timeout ?? 45000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${api_key}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })

  clearTimeout(timer)
  if (!resp.ok) {
    const errText = await resp.text()
    let errMsg = `HTTP ${resp.status}`
    try {
      const errJson = JSON.parse(errText)
      errMsg = errJson.error?.message || errJson.message || errText.slice(0, 300) || errMsg
    } catch {
      errMsg = errText.slice(0, 300) || errMsg
    }
    throw new Error(errMsg)
  }

  const reader = resp.body?.getReader()
  if (!reader) throw new Error('无法读取流')
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
      if (!s || s === 'data: [DONE]') continue
      if (s.startsWith('data: ')) {
        try {
          const json = JSON.parse(s.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> }
          const content = json.choices?.[0]?.delta?.content
          if (content) yield content
        } catch {
          // 忽略解析失败行
        }
      }
    }
  }
}

/**
 * 文本向量化（OpenAI Embeddings 兼容接口）
 * 用于记忆的语义检索
 */
export async function embedText(
  config: { api_key: string; base_url?: string | null; provider: string },
  text: string,
  options?: { timeout?: number }
): Promise<number[]> {
  const { api_key, base_url, provider } = config
  if (!api_key?.trim()) throw new Error('未设置 API Key')

  const base = (base_url && base_url.trim()) || PROVIDER_BASE_URLS[provider] || 'https://api.openai.com/v1'
  const url = base.replace(/\/$/, '') + '/embeddings'

  const body = {
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000), // 限制长度
  }

  const timeout = options?.timeout ?? 10000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
  clearTimeout(timer)

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(errText.slice(0, 200) || `HTTP ${resp.status}`)
  }

  const json = (await resp.json()) as { data?: Array<{ embedding?: number[] }> }
  const embedding = json.data?.[0]?.embedding
  if (!Array.isArray(embedding)) throw new Error('Embedding 返回格式异常')
  return embedding
}

/** 余弦相似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
