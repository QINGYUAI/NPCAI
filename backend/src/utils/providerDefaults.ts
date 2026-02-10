/**
 * 各 AI 提供商默认 API 地址（OpenAI 兼容格式）
 * 用于连接测试时未配置 base_url 的情况
 */
export const PROVIDER_BASE_URLS: Record<string, string> = {
  OpenAI: 'https://api.openai.com/v1',
  Claude: 'https://api.anthropic.com/v1',
  'Google Gemini': 'https://generativelanguage.googleapis.com/v1beta',
  Mistral: 'https://api.mistral.ai/v1',
  Groq: 'https://api.groq.com/openai/v1',
  Cohere: 'https://api.cohere.ai/v1',
  通义千问: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  文心一言: 'https://aip.baidubce.com',
  智谱: 'https://open.bigmodel.cn/api/paas/v4',
  DeepSeek: 'https://api.deepseek.com',
  月之暗面: 'https://api.moonshot.cn/v1',
  百川智能: 'https://api.baichuan-ai.com/v1',
  零一万物: 'https://api.lingyiwanwu.com/v1',
  讯飞星火: 'https://spark-api.xf-yun.com/v1',
  字节豆包: 'https://ark.cn-beijing.volces.com/api/v3',
  MiniMax: 'https://api.minimax.chat/v1',
}
