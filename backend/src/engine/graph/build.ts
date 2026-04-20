/**
 * 推理子图：loadContext → plan → speak → persist
 *
 * M4.1.a：仅实现 dry_run 路径（不调用 LLM）；真 LLM 路径占位 throw，由 M4.1.b 接入 LangGraph.js
 */
import type { NpcRow, SceneRow, SimulationMetaV1 } from '../types.js';

export interface GraphInput {
  scene: SceneRow;
  npc: NpcRow;
  neighbors: Array<{ id: number; name: string }>;
  tick: number;
  /** 跳过 LLM，使用确定性伪输出 */
  dryRun: boolean;
  /** AbortController 信号，用于硬停 */
  signal?: AbortSignal;
}

export interface GraphOutput {
  nextMeta: SimulationMetaV1;
  inputSummary: string;
  cost_usd?: number;
}

/** 简易 dry_run 输出：根据 tick 循环几种动作 / 台词 */
const DRY_ACTIONS = ['walking', 'thinking', 'looking_around', 'resting'];
const DRY_SAYS = [
  '今天天气不错',
  '我得去看看老王',
  '这附近真热闹',
  '有点饿了',
  '先整理下思路',
];
const DRY_EMOTIONS = ['neutral', 'curious', 'happy'];

export async function runGraph(input: GraphInput): Promise<GraphOutput> {
  const { npc, neighbors, tick, dryRun, signal } = input;

  if (signal?.aborted) {
    throw new Error('aborted');
  }

  const inputSummary = [
    `npc=${npc.name}`,
    `tick=${tick}`,
    `neighbors=[${neighbors.map((n) => n.name).join(',')}]`,
    dryRun ? 'mode=dry_run' : 'mode=live',
  ].join(' | ');

  if (!dryRun) {
    throw new Error('ENGINE_LIVE_MODE_NOT_IMPLEMENTED: live LLM graph 将在 M4.1.b 接入 LangGraph.js');
  }

  /** dry_run：纯确定性伪输出，方便自测与不花钱冒烟 */
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

/** 从 DB 读出的 simulation_meta 尝试反序列化为 v1 对象 */
function parseMeta(raw: unknown): SimulationMetaV1 | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as SimulationMetaV1;
  if (typeof raw === 'string') {
    try {
      const obj = JSON.parse(raw);
      return obj as SimulationMetaV1;
    } catch {
      return null;
    }
  }
  return null;
}
