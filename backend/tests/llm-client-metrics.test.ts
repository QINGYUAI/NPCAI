/**
 * [M4.2.1.a] llmClient.chatCompletion 计费路径单测
 *  - usage 路径：provider 返回 usage，直接使用
 *  - estimate 路径：provider 不返 usage，用 tiktoken 本地估算
 *  - onMetrics 回调：两条路径均被调用一次，返回值可用于上层累加
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** mock aiLogger：捕获 logAiCall 参数，避免真的写 DB */
const { logCalls } = vi.hoisted(() => ({
  logCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/utils/aiLogger.js', () => ({
  logAiCall: (p: Record<string, unknown>) => {
    logCalls.push(p);
  },
}));

import { chatCompletion, type LlmMetrics } from '../src/utils/llmClient.js';

describe('[M4.2.1.a] chatCompletion tokens/cost', () => {
  const originalFetch = globalThis.fetch;
  const savedAcc = process.env.COST_ACCOUNTING_ENABLED;

  beforeEach(() => {
    logCalls.length = 0;
    process.env.COST_ACCOUNTING_ENABLED = 'true';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.COST_ACCOUNTING_ENABLED = savedAcc;
  });

  it('provider 返回 usage 时直接使用，cost 按硬编码单价换算', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"plan":["observe"]}' } }],
          usage: { prompt_tokens: 400, completion_tokens: 100, total_tokens: 500 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const metrics: LlmMetrics[] = [];
    const out = await chatCompletion(
      { api_key: 'sk-x', provider: 'openai', model: 'gpt-4o-mini' },
      [{ role: 'user', content: 'hi' }],
      { onMetrics: (m) => metrics.push(m) },
    );

    expect(out).toBe('{"plan":["observe"]}');
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.tokens_source).toBe('usage');
    expect(metrics[0]!.prompt_tokens).toBe(400);
    expect(metrics[0]!.completion_tokens).toBe(100);
    expect(metrics[0]!.total_tokens).toBe(500);
    expect(metrics[0]!.cost_usd).toBeCloseTo(400 / 1000 * 0.00015 + 100 / 1000 * 0.0006, 6);

    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]!.prompt_tokens).toBe(400);
    expect(logCalls[0]!.completion_tokens).toBe(100);
    expect(logCalls[0]!.cost_usd).toBeCloseTo(400 / 1000 * 0.00015 + 100 / 1000 * 0.0006, 6);
  });

  it('provider 不返 usage 时走 tiktoken 本地估算，tokens_source = estimate', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"plan":["observe"]}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const metrics: LlmMetrics[] = [];
    await chatCompletion(
      { api_key: 'sk-x', provider: 'openai', model: 'gpt-4o-mini' },
      [{ role: 'user', content: 'hello world' }],
      { onMetrics: (m) => metrics.push(m) },
    );

    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.tokens_source).toBe('estimate');
    expect(metrics[0]!.prompt_tokens).toBeGreaterThan(0);
    expect(metrics[0]!.completion_tokens).toBeGreaterThan(0);
    expect(metrics[0]!.total_tokens).toBe(metrics[0]!.prompt_tokens + metrics[0]!.completion_tokens);
    expect(metrics[0]!.cost_usd).not.toBeNull();
    expect(metrics[0]!.cost_usd!).toBeGreaterThan(0);
  });

  it('未匹配模型时 cost_usd = null，但 tokens 仍按估算填写', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const metrics: LlmMetrics[] = [];
    await chatCompletion(
      { api_key: 'sk-x', provider: 'openai', model: 'brand-new-model-2099' },
      [{ role: 'user', content: 'hi' }],
      { onMetrics: (m) => metrics.push(m) },
    );

    expect(metrics[0]!.cost_usd).toBeNull();
    expect(metrics[0]!.total_tokens).toBeGreaterThan(0);
  });
});
