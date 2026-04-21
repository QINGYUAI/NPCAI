/**
 * AI 接口调用日志
 * 记录 chatCompletion、chatCompletionStream、embedText 等调用的请求与响应情况
 */
import { pool } from '../db/connection.js';

/** 单条内容最大存储长度，避免日志过大 */
const MAX_CONTENT_LEN = 4000;

export interface AiLogParams {
  ai_config_id?: number;
  api_type: 'chat' | 'chat_stream' | 'embed';
  provider: string;
  model?: string | null;
  request_info?: Record<string, unknown>;
  response_info?: Record<string, unknown>;
  request_content?: string | null;
  response_content?: string | null;
  duration_ms?: number;
  status: 'success' | 'error';
  error_message?: string | null;
  source?: string | null;
  context?: Record<string, unknown> | null;
  /** [M4.2.1.a] 来自 provider usage 或本地 tiktoken 估算；null 表示未知 */
  prompt_tokens?: number | null;
  /** [M4.2.1.a] 输出 tokens */
  completion_tokens?: number | null;
  /** [M4.2.1.a] 总 tokens；为空时自动取 prompt+completion */
  total_tokens?: number | null;
  /** [M4.2.1.a] 本次调用费用（美元）；未匹配模型为 null */
  cost_usd?: number | null;
}

function truncate(s: string, max = MAX_CONTENT_LEN): string {
  return s.length <= max ? s : s.slice(0, max) + '...[截断]';
}

/**
 * 异步记录 AI 调用日志，不阻塞主流程
 */
export function logAiCall(params: AiLogParams): void {
  /** [M4.2.1.a] total_tokens 未提供则用 prompt+completion 自动补齐；两者皆缺为 null */
  const pt = params.prompt_tokens ?? null;
  const ct = params.completion_tokens ?? null;
  const tt =
    params.total_tokens != null
      ? params.total_tokens
      : pt != null || ct != null
        ? (pt ?? 0) + (ct ?? 0)
        : null;

  pool
    .execute(
      `INSERT INTO ai_call_log (ai_config_id, api_type, provider, model, request_info, response_info, request_content, response_content, duration_ms, status, error_message, source, context, prompt_tokens, completion_tokens, total_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.ai_config_id ?? null,
        params.api_type,
        params.provider,
        params.model ?? null,
        params.request_info ? JSON.stringify(params.request_info) : null,
        params.response_info ? JSON.stringify(params.response_info) : null,
        params.request_content ? truncate(params.request_content) : null,
        params.response_content ? truncate(params.response_content) : null,
        params.duration_ms ?? null,
        params.status,
        params.error_message ?? null,
        params.source ?? null,
        params.context ? JSON.stringify(params.context) : null,
        pt,
        ct,
        tt,
        params.cost_usd ?? null,
      ]
    )
    .catch((e) => console.warn('[aiLogger] 写入失败:', e));
}
