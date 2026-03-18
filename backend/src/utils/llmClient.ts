/**
 * 通用 LLM 调用工具（OpenAI 兼容 Chat Completions API）
 * 用于连接测试、角色生成等场景，自动记录 AI 调用日志
 */
import { PROVIDER_BASE_URLS } from './providerDefaults.js';
import { logAiCall } from './aiLogger.js';

export interface LlmConfig {
  api_key: string
  base_url?: string | null
  provider: string
  model?: string
  max_tokens?: number
}

/** 日志上下文，可选传给 chatCompletion / chatCompletionStream / embedText */
export interface LogContext {
  source?: string
  ai_config_id?: number
  context?: Record<string, unknown>
}

/** 视觉 API 支持：content 可为 string 或多模态内容块 */
type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type MessageContent = string | ContentPart[];

/**
 * 调用 LLM 生成文本
 * @param config AI 配置信息
 * @param messages 消息列表
 * @param options 超时等选项，可含 logContext 用于日志
 */
export async function chatCompletion(
  config: LlmConfig,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: MessageContent }>,
  options?: { timeout?: number; max_tokens?: number; logContext?: LogContext }
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

  const start = Date.now()
  const logCtx = options?.logContext

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

  const duration = Date.now() - start

  if (!resp.ok) {
    const errText = await resp.text()
    let errMsg = `HTTP ${resp.status}`
    try {
      const errJson = JSON.parse(errText)
      errMsg = errJson.error?.message || errJson.message || errText.slice(0, 300) || errMsg
    } catch {
      errMsg = errText.slice(0, 300) || errMsg
    }
    const serializeContent = (c: MessageContent) =>
      typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
    const requestContent = messages.map((m) => `[${m.role}]: ${serializeContent(m.content)}`).join('\n---\n');
    logAiCall({
      api_type: 'chat',
      provider,
      model: model || undefined,
      request_info: { message_count: messages.length },
      request_content: requestContent,
      duration_ms: duration,
      status: 'error',
      error_message: errMsg,
      source: logCtx?.source,
      ai_config_id: logCtx?.ai_config_id,
      context: logCtx?.context,
    })
    throw new Error(errMsg)
  }

  const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = json.choices?.[0]?.message?.content?.trim() || ''
  if (!content) {
    const serializeContent = (c: MessageContent) =>
      typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
    const requestContent = messages.map((m) => `[${m.role}]: ${serializeContent(m.content)}`).join('\n---\n');
    logAiCall({
      api_type: 'chat',
      provider,
      model: model || undefined,
      request_info: { message_count: messages.length },
      request_content: requestContent,
      duration_ms: duration,
      status: 'error',
      error_message: '模型返回为空',
      source: logCtx?.source,
      ai_config_id: logCtx?.ai_config_id,
      context: logCtx?.context,
    })
    throw new Error('模型返回为空')
  }

  const serializeContent = (c: MessageContent) =>
    typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
  const requestContent = messages.map((m) => `[${m.role}]: ${serializeContent(m.content)}`).join('\n---\n');
  logAiCall({
    api_type: 'chat',
    provider,
    model: model || undefined,
    request_info: { message_count: messages.length },
    response_info: { output_length: content.length },
    request_content: requestContent,
    response_content: content,
    duration_ms: duration,
    status: 'success',
    source: logCtx?.source,
    ai_config_id: logCtx?.ai_config_id,
    context: logCtx?.context,
  })
  return content
}

/**
 * 流式调用 LLM，逐块返回生成内容
 * @returns AsyncGenerator  yielding 内容片段
 */
export async function* chatCompletionStream(
  config: LlmConfig,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  options?: { timeout?: number; max_tokens?: number; logContext?: LogContext }
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
    max_tokens: options?.max_tokens ?? config.max_tokens ?? 2000,
  }

  const start = Date.now()
  const logCtx = options?.logContext
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
  const duration = Date.now() - start

  if (!resp.ok) {
    const errText = await resp.text()
    let errMsg = `HTTP ${resp.status}`
    try {
      const errJson = JSON.parse(errText)
      errMsg = errJson.error?.message || errJson.message || errText.slice(0, 300) || errMsg
    } catch {
      errMsg = errText.slice(0, 300) || errMsg
    }
    const serializeContent = (c: MessageContent) =>
      typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
    const requestContent = messages.map((m) => `[${m.role}]: ${serializeContent(m.content)}`).join('\n---\n');
    logAiCall({
      api_type: 'chat_stream',
      provider,
      model: model || undefined,
      request_info: { message_count: messages.length },
      request_content: requestContent,
      duration_ms: duration,
      status: 'error',
      error_message: errMsg,
      source: logCtx?.source,
      ai_config_id: logCtx?.ai_config_id,
      context: logCtx?.context,
    })
    throw new Error(errMsg)
  }

  const requestContent = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n---\n');
  logAiCall({
    api_type: 'chat_stream',
    provider,
    model: model || undefined,
    request_info: { message_count: messages.length },
    response_info: { stream: true },
    request_content: requestContent,
    response_content: '[流式响应，内容未采集]',
    duration_ms: duration,
    status: 'success',
    source: logCtx?.source,
    ai_config_id: logCtx?.ai_config_id,
    context: logCtx?.context,
  })

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
  options?: { timeout?: number; logContext?: LogContext }
): Promise<number[]> {
  const { api_key, base_url, provider } = config
  if (!api_key?.trim()) throw new Error('未设置 API Key')

  const base = (base_url && base_url.trim()) || PROVIDER_BASE_URLS[provider] || 'https://api.openai.com/v1'
  const url = base.replace(/\/$/, '') + '/embeddings'

  const inputLen = Math.min(text.length, 8000)
  const body = {
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000),
  }

  const start = Date.now()
  const logCtx = options?.logContext
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
  const duration = Date.now() - start

  const inputText = text.slice(0, 8000);
  if (!resp.ok) {
    const errText = await resp.text()
    const errMsg = errText.slice(0, 300) || `HTTP ${resp.status}`
    logAiCall({
      api_type: 'embed',
      provider,
      model: 'text-embedding-3-small',
      request_info: { input_length: inputLen },
      request_content: inputText,
      duration_ms: duration,
      status: 'error',
      error_message: errMsg,
      source: logCtx?.source,
      ai_config_id: logCtx?.ai_config_id,
      context: logCtx?.context,
    })
    throw new Error(errMsg)
  }

  const json = (await resp.json()) as { data?: Array<{ embedding?: number[] }> }
  const embedding = json.data?.[0]?.embedding
  if (!Array.isArray(embedding)) {
    logAiCall({
      api_type: 'embed',
      provider,
      model: 'text-embedding-3-small',
      request_info: { input_length: inputLen },
      request_content: inputText,
      duration_ms: duration,
      status: 'error',
      error_message: 'Embedding 返回格式异常',
      source: logCtx?.source,
      ai_config_id: logCtx?.ai_config_id,
      context: logCtx?.context,
    })
    throw new Error('Embedding 返回格式异常')
  }

  logAiCall({
    api_type: 'embed',
    provider,
    model: 'text-embedding-3-small',
    request_info: { input_length: inputLen },
    response_info: { embedding_dim: embedding.length },
    request_content: inputText,
    response_content: `[向量维度: ${embedding.length}]`,
    duration_ms: duration,
    status: 'success',
    source: logCtx?.source,
    ai_config_id: logCtx?.ai_config_id,
    context: logCtx?.context,
  })
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
