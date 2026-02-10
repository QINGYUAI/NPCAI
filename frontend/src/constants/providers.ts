/**
 * AI 提供商及模型配置
 * 主流 AI 供应商列表，支持 OpenAI 兼容 API 或原生接口
 */
export const PROVIDER_MODELS: Record<string, string[]> = {
  // 国际主流
  OpenAI: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo', 'o1', 'o1-mini'],
  Claude: ['claude-3-5-sonnet', 'claude-3-5-haiku', 'claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'],
  'Google Gemini': ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.0-pro'],
  Mistral: ['mistral-large', 'mistral-medium', 'mistral-small', 'codestral', 'mistral-7b-instruct'],
  Groq: ['llama-3.3-70b', 'llama-3.1-70b', 'mixtral-8x7b', 'gemma2-9b'],
  Cohere: ['command-r-plus', 'command-r', 'command', 'embed-english-v3'],

  // 国内主流
  通义千问: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long', 'qwen-vl-max'],
  文心一言: ['ernie-4.5', 'ernie-4.0', 'ernie-3.5', 'ernie-speed', 'ernie-tiny'],
  智谱: ['glm-4-plus', 'glm-4-flash', 'glm-4', 'glm-3-turbo'],
  DeepSeek: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'],
  月之暗面: ['moonshot-v1', 'moonshot-v1-128k', 'moonshot-v1-32k'],
  百川智能: ['Baichuan2-Turbo', 'Baichuan2-53B', 'Baichuan2-13B'],
  零一万物: ['yi-large', 'yi-medium', 'yi-vision', 'yi-spark'],
  讯飞星火: ['spark-v3.5', 'spark-v3.0', 'spark-lite'],
  字节豆包: ['doubao-pro', 'doubao-lite', 'doubao-pro-32k'],
  MiniMax: ['abab6.5s', 'abab6.5', 'abab5.5-chat'],

  其他: ['custom'],
}

/** 获取所有提供商名称（用于筛选、表单下拉） */
export const PROVIDER_OPTIONS = Object.keys(PROVIDER_MODELS)
