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
import { getDialogueConfig } from '../dialogue/config.js';
import { emitDialogueFromSay } from '../dialogue/emit.js';
import type { EventBlockItem } from '../event/types.js';
import { retrieveMemories } from '../memory/retrieve.js';
import { storeMemory } from '../memory/store.js';
import { reflectIfTriggered } from '../reflection/reflect.js';
import type { ReflectionResult } from '../reflection/types.js';
import type { NpcRow, SceneRow, SimulationMetaV1 } from '../types.js';
import {
  buildMemoryBlock,
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
  /**
   * [M4.2.4.b] event-intake 节点的 prompt 段；空字符串 / undefined = 不注入
   * - 由 scheduler 在 tick 顶部预取场景事件 + per-NPC pick 后产出
   * - 最终注入到 buildPlanPrompt 的 user 消息最前（event > scene > neighbor > memory > tick）
   */
  eventBlock?: string;
  /**
   * [M4.3.1.a] 与 eventBlock 同源的结构化 items；dialogue 自动化需要从中筛 parent
   *   - 由 scheduler 把 pickEventsForNpc().items 原样透传
   *   - undefined/空数组 → emitDialogueFromSay 视为首条 dialogue（parent=null, conv_turn=1）
   */
  eventItems?: EventBlockItem[];
  /**
   * [M4.3.0] tick 级 trace_id（uuid v4）
   *   - scheduler 在 tick 顶部生成一次，贯穿本函数所有子调用（retrieve / store / reflect / callWithRetry）
   *   - 最终落到 5 张表（ai_call_log / npc_tick_log / scene_event / npc_memory / npc_reflection）
   *   - TRACE_ID_ENABLED=false 时为 null，全链路写 NULL，保持 M4.2 行为
   */
  traceId?: string | null;
  /**
   * [M4.4.1.a] 当前 NPC 在当前 hour 的日程条目（由 scheduler 预解析注入）
   *   - 本 .a 批次仅透传到 persist 层 / simulation_meta，不改 plan prompt
   *   - M4.4.1.b 将按 Q4=a 在 plan 节点做"无事件→日程驱动"前置分支消费
   *   - null / undefined = 该小时无日程模板 or SCHEDULE_ENABLED=false
   */
  scheduledActivity?: {
    activity: string;
    location: string | null;
    priority: number;
  } | null;
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
  /**
   * [M4.2.2.b] 记忆子系统是否走了降级路径（Qdrant 不可达 / embed 失败）
   * - true 时 scheduler 会冒泡 memory_degraded 标记到 status；不影响本 tick 产出
   * - store 失败不影响此标记（store 失败也降级写 MySQL，不算"retrieve 不可用"）
   */
  memory_degraded?: boolean;
  /**
   * [M4.2.3.b] 本 tick 反思节点的结果（仅在周期命中 & live 模式时可能为 'generated'）
   * - scheduler 根据 status === 'generated' emit reflection.created 事件
   * - status === 'skipped' / 'failed' 时调度器不广播
   */
  reflection?: ReflectionResult;
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
  /** [M4.3.0] 统一取 traceId，null 代表 TRACE_ID_ENABLED=false 或非 scheduler 入口 */
  const traceId = input.traceId ?? null;
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

  /**
   * [M4.2.2.b] memory-retrieve：plan 之前跑一次，产出「相关记忆」供 plan/speak 共享
   * - 内部已有三级降级（Qdrant→MySQL→空）；外层只关心 degraded 标记冒泡到 scheduler
   */
  const prevSummary = prevMeta?.memory_summary ?? '';
  const retrieveResult = await retrieveMemories({
    scene: input.scene,
    npc,
    neighbors,
    prevSummary,
    tick,
    aiCfg: {
      id: aiCfg.id,
      api_key: aiCfg.api_key,
      base_url: aiCfg.base_url,
      provider: aiCfg.provider,
    },
    signal,
    onMetrics,
    traceId,
  });
  const memoryBlock = buildMemoryBlock(retrieveResult.entries);

  /**
   * plan 节点；[M4.2.4.b] 注入 eventBlock（若有）
   * [M4.4.1.b Q4=a] 日程前置分支：仅当"本 tick 无事件 + scheduledActivity 非空"时传入日程
   *   - 有事件 → 事件驱动 prompt，忽略日程（避免 hint 干扰）
   *   - 无事件 + 无日程 → 退化为 M4.4.0 行为
   *   - 无事件 + 有日程 → 新增【当前时段计划】system 行
   */
  const hasEvents = Array.isArray(input.eventItems) && input.eventItems.length > 0;
  const planScheduledActivity =
    !hasEvents && input.scheduledActivity ? input.scheduledActivity : null;
  const planPrompt = buildPlanPrompt({
    scene: input.scene,
    npc,
    neighbors,
    prevSummary,
    tick,
    memoryBlock,
    eventBlock: input.eventBlock,
    scheduledActivity: planScheduledActivity,
  });
  const planResult = await callWithRetry(
    aiCfg,
    planPrompt.system,
    planPrompt.user,
    planSchema,
    {
      source: 'engine.plan',
      ai_config_id: npc.ai_config_id,
      context: { scene_id: input.scene.id, npc_id: npc.id, tick, node: 'plan' },
      trace_id: traceId,
    },
    signal,
    onMetrics,
  );

  /** speak 节点：plan 失败则用兜底计划 */
  const plan = planResult?.plan ?? (prevMeta?.plan?.length ? prevMeta.plan : [`观察 ${input.scene.name}`]);
  const speakPrompt = buildSpeakPrompt({ scene: input.scene, npc, plan, tick, memoryBlock });
  const speakResult = await callWithRetry(
    aiCfg,
    speakPrompt.system,
    speakPrompt.user,
    speakSchema,
    {
      source: 'engine.speak',
      ai_config_id: npc.ai_config_id,
      context: { scene_id: input.scene.id, npc_id: npc.id, tick, node: 'speak' },
      trace_id: traceId,
    },
    signal,
    onMetrics,
  );

  if (!speakResult) {
    /** speak 硬失败：调度器会把整 tick 记 error；但仍返回保留上一轮 meta，避免前端气泡闪没 */
    throw new Error('speak 节点解析失败且重试无果');
  }

  /**
   * [M4.2.2.b] memory-store：say/action 各一条（Q2 a 方案锁定）
   * - 完全 fire-and-forget 的语义上由 storeMemory 内部吞错保证；这里 await 只为拿到状态
   * - store 失败不冒泡 degraded（degraded 语义仅代表 retrieve 能力受损）
   */
  if (speakResult.latest_action) {
    await storeMemory({
      scene: input.scene,
      npc,
      tick,
      type: 'observation',
      content: `[${speakResult.emotion ?? 'neutral'}] ${speakResult.latest_action}`,
      aiCfg: { id: aiCfg.id, api_key: aiCfg.api_key, base_url: aiCfg.base_url, provider: aiCfg.provider },
      signal,
      onMetrics,
      traceId,
    });
  }
  if (speakResult.latest_say) {
    await storeMemory({
      scene: input.scene,
      npc,
      tick,
      type: 'dialogue',
      content: speakResult.latest_say,
      aiCfg: { id: aiCfg.id, api_key: aiCfg.api_key, base_url: aiCfg.base_url, provider: aiCfg.provider },
      signal,
      onMetrics,
      traceId,
    });

    /**
     * [M4.3.1.a] speak.latest_say → scene_event{type:'dialogue'} 自动注入（V3=a：memory / event 并存）
     *   - 串在 storeMemory 之后：memory 是私有记忆，event 是场景公共广播，两条职责正交
     *   - 失败只 warn，不 throw；storeMemory 和 memory-summary / reflect 不受影响
     *   - DIALOGUE_AUTO_EVENT_ENABLED=false 时 emitDialogueFromSay 内部短路返回 null，完全回退 M4.2
     *   - parent / conv_turn 由 eventItems 就地筛（见 dialogue/emit.ts::pickDialogueParent）
     */
    if (getDialogueConfig().enabled) {
      await emitDialogueFromSay({
        scene_id: input.scene.id,
        actor: npc.name,
        content: speakResult.latest_say,
        eventItems: input.eventItems ?? null,
        trace_id: traceId,
        /** [M4.4.0] 把 tick 号带下去，新行会填 scene_event.created_tick，供下一 tick echo 精判 */
        current_tick: tick,
      });
    }
  }

  /** memory 摘要节点（保留）：失败不影响整体 */
  let memorySummary = prevSummary;
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
      {
        source: 'engine.memory',
        ai_config_id: npc.ai_config_id,
        context: { scene_id: input.scene.id, npc_id: npc.id, tick, node: 'memory' },
        trace_id: traceId,
      },
      signal,
      onMetrics,
    );
    if (memResult) memorySummary = memResult.memory_summary;
  } catch {
    /* memory 失败保留旧值 */
  }

  /**
   * [M4.2.3.b] reflect 节点：周期命中才做一次；失败/跳过都不阻塞主流程
   * - 放在 memory-summary 之后：可以拿到本 tick 最新 say/action 已落的 npc_memory
   * - dryRun=false 由本文件进入 live 分支即天然保证
   */
  const reflection = await reflectIfTriggered({
    scene: input.scene,
    npc,
    tick,
    prevSummary: memorySummary,
    aiCfg,
    dryRun: false,
    signal,
    onMetrics,
    traceId,
  });

  const nextMeta: SimulationMetaV1 = {
    version: '1.0',
    last_tick_at: new Date().toISOString(),
    latest_say: speakResult.latest_say,
    latest_action: speakResult.latest_action,
    emotion: speakResult.emotion,
    plan: plan.slice(0, 3),
    memory_summary: memorySummary,
    /**
     * [M4.4.1.b] 始终写入 scheduled_activity（即便走事件分支也留档），
     * 前端气泡按 say>action>schedule 优先级自行决定是否展示
     */
    scheduled_activity: input.scheduledActivity ?? null,
    debug: {
      live: true,
      tick,
      node_retry: { plan: planResult ? 0 : 1 },
      memory: { retrieved: retrieveResult.entries.length, degraded: retrieveResult.degraded },
      reflection: {
        status: reflection.status,
        ids: reflection.reflection_ids,
        source_ids: reflection.source_memory_ids,
      },
    },
  };

  return {
    nextMeta,
    inputSummary,
    tokens: tickMetrics.tokens,
    cost_usd: tickMetrics.costKnown ? tickMetrics.cost : 0,
    memory_degraded: retrieveResult.degraded,
    reflection,
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
    /** [M4.4.1.b] dry_run 也透传日程，方便 SIM_CLOCK_HOUR 演示前端气泡 */
    scheduled_activity: input.scheduledActivity ?? null,
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
  logCtx: {
    source: string;
    ai_config_id?: number;
    context?: Record<string, unknown>;
    /** [M4.3.0] tick 级 trace_id；由 runGraph 透传，写入 ai_call_log.trace_id */
    trace_id?: string | null;
  },
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
            trace_id: logCtx.trace_id ?? null,
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
