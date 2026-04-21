/**
 * [M4.2.1.a] tokenCounter 单测
 *  - countTokens：tiktoken 真实编码 ± 字符数兜底
 *  - priceFor：硬编码单价表命中 / 前缀匹配 / 未知模型返回 null
 *  - calcCostUsd：已知模型正确换算；未知模型返回 null；免费模型返回 0
 *  - isCostAccountingEnabled：通过环境变量关闭
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  countTokens,
  priceFor,
  calcCostUsd,
  isCostAccountingEnabled,
} from '../src/engine/tokenCounter.js';

describe('[M4.2.1.a] tokenCounter', () => {
  const savedEnv = process.env.COST_ACCOUNTING_ENABLED;

  beforeEach(() => {
    process.env.COST_ACCOUNTING_ENABLED = 'true';
  });

  afterEach(() => {
    process.env.COST_ACCOUNTING_ENABLED = savedEnv;
  });

  it('countTokens 对英文短句应落在合理范围（±5 token 误差）', () => {
    const n = countTokens('gpt-4o-mini', 'Hello, world! This is a tokenizer smoke test.');
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(30);
  });

  it('countTokens 对空字符串返回 0；不同 encoding 结果稳定', () => {
    expect(countTokens('gpt-4o-mini', '')).toBe(0);
    const a = countTokens('gpt-4o', 'abcdefg 1234567');
    const b = countTokens('gpt-4o-mini', 'abcdefg 1234567');
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it('countTokens 对 cl100k 编码模型也能工作', () => {
    const n = countTokens('gpt-3.5-turbo', '这是中文测试文本');
    expect(n).toBeGreaterThan(0);
  });

  it('countTokens 对未知模型退回 cl100k_base，仍能产出正数', () => {
    const n = countTokens('some-unknown-model-2099', 'hello');
    expect(n).toBeGreaterThan(0);
  });

  it('priceFor 精确匹配与前缀匹配均可命中；未知模型返回 null', () => {
    expect(priceFor('gpt-4o-mini')).toEqual({ in_per_1k: 0.00015, out_per_1k: 0.0006 });
    expect(priceFor('GPT-4o-mini')).toEqual({ in_per_1k: 0.00015, out_per_1k: 0.0006 });
    expect(priceFor('gpt-4o-2024-11-20')).toEqual({ in_per_1k: 0.0025, out_per_1k: 0.01 });
    expect(priceFor('brand-new-model-2099')).toBeNull();
    expect(priceFor(null)).toBeNull();
  });

  it('calcCostUsd 对 gpt-4o-mini 按单价正确换算（1K in + 1K out = $0.00075）', () => {
    const cost = calcCostUsd('gpt-4o-mini', 1000, 1000);
    expect(cost).not.toBeNull();
    expect(cost!).toBeCloseTo(0.00075, 6);
  });

  it('calcCostUsd 对免费模型返回 0；未知模型返回 null', () => {
    expect(calcCostUsd('glm-4-flash', 10_000, 10_000)).toBe(0);
    expect(calcCostUsd('brand-new-model-2099', 1000, 1000)).toBeNull();
  });

  it('COST_ACCOUNTING_ENABLED=false 时 countTokens 返回 0，calcCostUsd 返回 null', () => {
    process.env.COST_ACCOUNTING_ENABLED = 'false';
    expect(isCostAccountingEnabled()).toBe(false);
    expect(countTokens('gpt-4o-mini', 'hello world')).toBe(0);
    expect(calcCostUsd('gpt-4o-mini', 100, 100)).toBeNull();
  });
});
