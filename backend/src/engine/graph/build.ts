/**
 * M4.1.b 推理子图：loadContext → plan → speak → memory → persist
 *
 * 设计要点
 * - dry_run 路径：确定性伪输出，不调用 LLM，不读 ai_config（用于冒烟 / 测试）
 * - live 路径：读取 NPC.ai_config_id 对应配置，调用 chatCompletion 逐节点生成
 * - zod 严格校验；每个节点单独重试 1 次，仍失败则按「保留上一轮」策略降级，
 *   并由调度器把本 tick 记为 error
 * - memory 节点非必需：失败则保留旧 summary，不影响 speak / plan 输出
 */
import type { RowDataPacket } from 'mysql2';
import { z } from 'zod';
import { pool } from '../../db/connection.js';
import { chatCompletion } from '../../utils/llmClient.js';
import type { NpcRow, SceneRow, SimulationMetaV1 } from '../types.js';
import {
  buildMemoryPrompt,
  buildPlanPrompt,
  buildSpeakPrompt,
} from './prompts.js';

export interface GraphInput {
  scene: SceneRow;
  npc: NpcRow;
  neighbors: Array<{ id: number; name: string }>;
  tick: number;
  /** 跳过 LLM 调用，使用确定性伪输出 */
  dryRun: boolean;
  /** AbortController 信号，用于硬停 */
  signal?: AbortSignal;
}

export interface GraphOutput {
  nextMeta: SimulationMetaV1;
  inputSummary: string;
  cost_usd?: number;
  /**
   * [M4.2.1.a] 本 tick 对该 NPC 的总 token 消耗（plan+speak+memory 三节点聚合）
   * - dry_run 仍为 0；live 路径从 chatCompletion.onMetrics 回调累加得到
   * - scheduler 据此 + ai_config.budget_tokens_per_tick 在下一 tick 执行 budget 判定
   */
  tokens?: number;
}

const planSchema = z
  .object({
    plan: z.array(z.string().min(1).max(200)).min(1).max(6),
  })
  .strict();

const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'curious', 'scared'] as const;
const speakSchema = z
  .object({
    latest_say: z.string().min(1).max(200),
    latest_action: z.string().min(1).max(100),
    emotion: z.enum(EMOTIONS),
  })
  .strict();

const memorySchema = z
  .object({
    memory_summary: z.string().min(1).max(800),
  })
  .strict();

/** dry_run 伪输出池 */
const DRY_ACTIONS = ['walking', 'thinking', 'looking_around', 'resting'];
const DRY_SAYS = [
  '今天天气不错',
  '我得去看看老王',
  '这附近真热闹',
  '有点饿了',
  '先整理下思路',
];
const DRY_EMOTIONS: Array<(typeof EMOTIONS)[number]> = ['neutral', 'curious', 'happy'];

export async function runGraph(input: GraphInput): Promise<GraphOutput> {
  const { npc, neighbors, tick, dryRun, signal } = input;
  if (signal?.aborted) throw new Error('aborted');

  const inputSummary = [
    `npc=${npc.name}`,
    `tick=${tick}`,
    `neighbors=[${neighbors.map((n) => n.name).join(',')}]`,
    dryRun ? 'mode=dry_run' : 'mode=live',
  ].join(' | ');

  if (dryRun) {
    return runDryRun(input, inputSummary);
  }

  /** live 模式：先加载 ai_config */
  const aiCfg = await loadAiConfig(npc.ai_config_id);
  const prevMeta = parseMeta(npc.simulation_meta);

  /**
   * [M4.2.1.a] tick 粒度的 metrics 累加器
   * - 被 callWithRetry -> chatCompletion.onMetrics 回调追加
   * - 成功与失败（HTTP 200 但 JSON 校验失败重试）均会累加，保证预算硬度
   */
  const tickMetrics = { tokens: 0, cost: 0, costKnown: false };
  const onMetrics = (m: { total_tokens: number; cost_usd: number | null }) => {
    tickMetrics.tokens += m.total_tokens;
    if (m.cost_usd != null) {
      tickMetrics.cost += m.cost_usd;
      tickMetrics.costKnown = true;
    }
  };

  /** plan 节点 */
  const planPrompt = buildPlanPrompt({
    scene: input.scene,
    npc,
    neighbors,
    prevSummary: prevMeta?.memory_summary ?? '',
    tick,
  });
  const planResult = await callWithRetry(
    aiCfg,
    planPrompt.system,
    planPrompt.user,
    planSchema,
    { source: 'engine.plan', ai_config_id: npc.ai_config_id, context: { scene_id: input.scene.id, npc_id: npc.id, tick, node: 'plan' } },
    signal,
    onMetrics,
  );

  /** speak 节点：plan 失败则用兜底计划 */
  const plan = planResult?.plan ?? (prevMeta?.plan?.length ? prevMeta.plan : [`观察 ${input.scene.name}`]);
  const speakPrompt = buildSpeakPrompt({ scene: input.scene, npc, plan, tick });
  const speakResult = await callWithRetry(
    aiCfg,
    speakPrompt.system,
    speakPrompt.user,
    speakSchema,
    { source: 'engine.speak', ai_config_id: npc.ai_config_id, context: { scene_id: input.scene.id, npc_id: npc.id, tick, node: 'speak' } },
    signal,
    onMetrics,
  );

  if (!speakResult) {
    /** speak 硬失败：调度器会把整 tick 记 error；但仍返回保留上一轮 meta，避免前端气泡闪没 */
    throw new Error('speak 节点解析失败且重试无果');
  }

  /** memory 节点（可选）：失败不影响整体 */
  let memorySummary = prevMeta?.memory_summary ?? '';
  try {
    const memPrompt = buildMemoryPrompt({
      npc,
      prevSummary: memorySummary,
      latestSay: speakResult.latest_say,
      latestAction: speakResult.latest_action,
    });
    const memResult = await callWithRetry(
      aiCfg,
      memPrompt.system,
      memPrompt.user,
      memorySchema,
      { source: 'engine.memory', ai_config_id: npc.ai_config_id, context: { scene_id: input.scene.id, npc_id: npc.id, tick, node: 'memory' } },
      signal,
      onMetrics,
    );
    if (memResult) memorySummary = memResult.memory_summary;
  } catch {
    /* memory 失败保留旧值 */
  }

  const nextMeta: SimulationMetaV1 = {
    version: '1.0',
    last_tick_at: new Date().toISOString(),
    latest_say: speakResult.latest_say,
    latest_action: speakResult.latest_action,
    emotion: speakResult.emotion,
    plan: plan.slice(0, 3),
    memory_summary: memorySummary,
    debug: { live: true, tick, node_retry: { plan: planResult ? 0 : 1 } },
  };

  return {
    nextMeta,
    inputSummary,
    tokens: tickMetrics.tokens,
    cost_usd: tickMetrics.costKnown ? tickMetrics.cost : 0,
  };
}

/** dry_run 路径：保持与 M4.1.a 一致的确定性伪输出 */
function runDryRun(input: GraphInput, inputSummary: string): GraphOutput {
  const { npc, tick } = input;
  const prevMeta = parseMeta(npc.simulation_meta);
  const say = DRY_SAYS[(tick + npc.id) % DRY_SAYS.length];
  const action = DRY_ACTIONS[(tick + npc.id) % DRY_ACTIONS.length];
  const emotion = DRY_EMOTIONS[(tick + npc.id) % DRY_EMOTIONS.length];

  const nextMeta: SimulationMetaV1 = {
    version: '1.0',
    last_tick_at: new Date().toISOString(),
    latest_say: say ?? null,
    latest_action: action ?? null,
    emotion: emotion ?? null,
    plan: prevMeta?.plan && prevMeta.plan.length ? prevMeta.plan.slice(0, 3) : [`继续 tick ${tick}`],
    memory_summary: prevMeta?.memory_summary ?? `dry_run ${npc.name} 初始记忆`,
    debug: { dry_run: true, tick, cost_usd: 0 },
  };
  return { nextMeta, inputSummary, cost_usd: 0 };
}

/** LLM 调用 + JSON 解析 + zod 校验；失败重试一次，仍失败返回 null（降级） */
async function callWithRetry<T>(
  aiCfg: AiConfigRow,
  system: string,
  user: string,
  schema: z.ZodSchema<T>,
  logCtx: { source: string; ai_config_id?: number; context?: Record<string, unknown> },
  signal?: AbortSignal,
  /** [M4.2.1.a] 无论 JSON 校验是否成功，只要 provider 真实返回 200 就累加 tokens/cost */
  onMetrics?: (m: { total_tokens: number; cost_usd: number | null }) => void,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      const content = await chatCompletion(
        {
          api_key: aiCfg.api_key,
          base_url: aiCfg.base_url,
          provider: aiCfg.provider,
          model: aiCfg.model,
          max_tokens: Math.min(aiCfg.max_tokens || 600, 800),
        },
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        {
          timeout: 30_000,
          logContext: {
            source: logCtx.source,
            ai_config_id: logCtx.ai_config_id,
            context: { ...(logCtx.context || {}), attempt },
          },
          onMetrics,
        },
      );
      const parsed = parseJsonRobust(content);
      if (!parsed) continue;
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
    } catch (e) {
      if (signal?.aborted) throw e;
      /* 交给下一轮重试 */
    }
  }
  return null;
}

/** 兼容 LLM 常见反应：去 Markdown 代码块、首尾杂字符、偶尔多行 */
function parseJsonRobust(text: string): unknown {
  const trimmed = text.trim();
  const fromBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fromBlock ? fromBlock[1] : trimmed).trim();
  try {
    return JSON.parse(raw);
  } catch {
    /** 退而尝试截取第一个 { ... } 平衡块 */
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

interface AiConfigRow {
  id: number;
  provider: string;
  api_key: string;
  base_url: string | null;
  model: string;
  max_tokens: number;
}

async function loadAiConfig(id: number): Promise<AiConfigRow> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, provider, api_key, base_url, model, max_tokens FROM ai_config WHERE id = ? AND status = 1',
    [id],
  );
  const list = rows as unknown as AiConfigRow[];
  if (list.length === 0 || !list[0]?.api_key) {
    throw new Error(`ENGINE_LIVE_AI_CONFIG_INVALID: ai_config_id=${id} 不可用（未启用或未设 API Key）`);
  }
  return list[0];
}

function parseMeta(raw: unknown): SimulationMetaV1 | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as SimulationMetaV1;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as SimulationMetaV1;
    } catch {
      return null;
    }
  }
  return null;
}
