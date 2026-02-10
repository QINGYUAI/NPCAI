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
