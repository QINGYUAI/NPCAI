/**
 * [M4.2.1.a] 本地 token 计数 + 硬编码单价表
 *
 * 设计要点
 * - tokenizer 锁定 `tiktoken` (wasm)（评审 §10.1 = B）：精度与 OpenAI 官方一致
 * - encoding 选择：`gpt-4o` / `gpt-4o-mini` 用 o200k_base；其余 OpenAI 兼容模型退回 cl100k_base
 *   未知模型/加载失败：走字符数 /4 粗略兜底，避免阻塞主流程
 * - 单价表硬编码在本文件末尾（评审 §10.4 = S1），单位：美元 / 1K tokens；截至 2026-04
 * - 通过环境变量 COST_ACCOUNTING_ENABLED=false 可整体关闭计费（默认开启）
 */
import { createRequire } from 'node:module';
import type { Tiktoken, TiktokenEncoding } from 'tiktoken';

const FALLBACK_CHARS_PER_TOKEN = 4;

/** ESM 下借助 createRequire 同步加载 tiktoken cjs + wasm 二进制 */
const nodeRequire = createRequire(import.meta.url);

let loadedTiktoken: typeof import('tiktoken') | null = null;
let tiktokenLoadFailed = false;

/** 懒加载 tiktoken（失败会走字符数 /4 兜底） */
function getTiktoken(): typeof import('tiktoken') | null {
  if (loadedTiktoken || tiktokenLoadFailed) return loadedTiktoken;
  try {
    loadedTiktoken = nodeRequire('tiktoken') as typeof import('tiktoken');
    return loadedTiktoken;
  } catch (e) {
    tiktokenLoadFailed = true;
    console.warn('[tokenCounter] tiktoken 加载失败，走字符数兜底:', (e as Error)?.message);
    return null;
  }
}

/**
 * [M4.2.1.a] 按模型映射到 tiktoken encoding 名；未知模型 → cl100k_base
 * o200k_base 覆盖 gpt-4o 系列（含 gpt-4o-mini），其余统一用 cl100k_base
 */
function pickEncodingName(model: string | null | undefined): TiktokenEncoding {
  if (!model) return 'cl100k_base';
  const m = model.toLowerCase();
  if (m.startsWith('gpt-4o') || m.startsWith('o1') || m.startsWith('o3')) return 'o200k_base';
  return 'cl100k_base';
}

const encCache = new Map<TiktokenEncoding, Tiktoken>();

function getEncoder(model: string | null | undefined): Tiktoken | null {
  const lib = getTiktoken();
  if (!lib) return null;
  const encName = pickEncodingName(model);
  let enc = encCache.get(encName);
  if (!enc) {
    try {
      enc = lib.get_encoding(encName);
      encCache.set(encName, enc);
    } catch (e) {
      console.warn('[tokenCounter] get_encoding 失败，走字符数兜底:', (e as Error)?.message);
      return null;
    }
  }
  return enc;
}

/**
 * [M4.2.1.a] 本地估算给定文本在给定模型下的 token 数
 * - 计费开关关时直接返回 0
 * - tiktoken 不可用时退回字符数 /4 粗略估算
 */
export function countTokens(model: string | null | undefined, text: string): number {
  if (!isCostAccountingEnabled()) return 0;
  if (!text) return 0;
  const enc = getEncoder(model);
  if (!enc) return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
  try {
    return enc.encode(text).length;
  } catch (e) {
    console.warn('[tokenCounter] encode 失败，走字符数兜底:', (e as Error)?.message);
    return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
  }
}

/**
 * [M4.2.1.a] 硬编码单价表（美元 / 1K tokens），截至 2026-04
 * - 未匹配的模型返回 null，calcCostUsd 对应返回 null（cost_usd 列保持 NULL）
 * - 后续升级到 S2（配置表）时只需替换本函数实现
 */
export function priceFor(
  model: string | null | undefined,
): { in_per_1k: number; out_per_1k: number } | null {
  if (!model) return null;
  const m = model.toLowerCase();
  const PRICES: Record<string, { in_per_1k: number; out_per_1k: number }> = {
    'gpt-4o-mini': { in_per_1k: 0.00015, out_per_1k: 0.00060 },
    'gpt-4o': { in_per_1k: 0.00250, out_per_1k: 0.01000 },
    'gpt-3.5-turbo': { in_per_1k: 0.00050, out_per_1k: 0.00150 },
    'deepseek-chat': { in_per_1k: 0.00014, out_per_1k: 0.00028 },
    'deepseek-reasoner': { in_per_1k: 0.00055, out_per_1k: 0.00219 },
    'glm-4-flash': { in_per_1k: 0.0, out_per_1k: 0.0 },
    'glm-4': { in_per_1k: 0.00070, out_per_1k: 0.00070 },
    'qwen-turbo': { in_per_1k: 0.00030, out_per_1k: 0.00060 },
    'qwen-plus': { in_per_1k: 0.00120, out_per_1k: 0.00350 },
    'moonshot-v1-8k': { in_per_1k: 0.00170, out_per_1k: 0.00170 },
  };
  if (PRICES[m]) return PRICES[m]!;
  for (const key of Object.keys(PRICES)) {
    if (m.startsWith(key)) return PRICES[key]!;
  }
  return null;
}

/**
 * [M4.2.1.a] 计算一次调用的费用（美元）
 * - 未知模型 → 返回 null；调用方写入 ai_call_log 时传 null 保留 DB NULL
 * - 免费模型（glm-4-flash）→ 返回 0
 */
export function calcCostUsd(
  model: string | null | undefined,
  promptTokens: number,
  completionTokens: number,
): number | null {
  if (!isCostAccountingEnabled()) return null;
  const price = priceFor(model);
  if (!price) return null;
  const cost = (promptTokens / 1000) * price.in_per_1k + (completionTokens / 1000) * price.out_per_1k;
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * [M4.2.1.a] 计费开关：COST_ACCOUNTING_ENABLED=false 时关闭
 * - 关闭时 countTokens 返回 0、calcCostUsd 返回 null；其余流程不变
 */
export function isCostAccountingEnabled(): boolean {
  const v = (process.env.COST_ACCOUNTING_ENABLED ?? 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no' && v !== 'off';
}
