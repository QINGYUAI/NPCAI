/**
 * [M4.3.1.b] 对话回声保护（intake 侧，纯函数）
 *
 * 动机
 *   - consumed_set 只能防同一 event 被多次消费；A↔B 持续互答每轮都是**新 event**
 *     （id/parent/turn 均不同），consumed 拦不住链式回声。
 *   - 若无硬上限：两个 NPC 会无限互回，烧 token + 污染记忆。
 *
 * 算法（E1=a：conv_turn + parent 链 actor 交替 + 内存判定）
 *   1) 只对 type==='dialogue' 的 candidate 判定；其它类型恒放行。
 *   2) 用场景快照构 parent map（id → row）。
 *   3) 从 candidate 沿 parent_event_id 回溯最多 N+1 层，提取 actor 序列。
 *   4) 拦截条件全部成立才拦：
 *      · conv_turn 存在且 ≥ echoMaxTurn + 1
 *      · actor 序列能拿到连续 N+1 个非 null 值
 *      · 该 N+1 段严格 (A,B,A,B,…) 交替（A ≠ B 且只含两个 actor）
 *   5) 其它情况（链断 / 链出快照 / 3 人及以上参与 / 首句 parent=null / conv_turn 缺失）
 *      → 一律**放行**（§5.4 降级：宁可多放一条，不误伤）。
 *
 * 边界（E4=a）
 *   - echoMaxTurn ≤ 0 视为**禁用回声保护**，调用方可直接跳过（本模块再兜一次，双保险）。
 *
 * 隐式窗口（E3=a）
 *   - 不显式算 tick 差；`allEvents` 由 scheduler 通过 EVENT_LOOKBACK_SECONDS 做时间窗截断；
 *     conv_turn 单调递增，一旦链断会从 1 重新开始 —— 天然实现"窗口滚动后释放"。
 *
 * 非职责
 *   - 不写 DB / 不查 DB；所有输入来自 intake 侧的 sceneEvents 快照
 *   - 不决定"丢弃后是否 warn"：由 intake.ts 调用方决定（此处只返回布尔）
 */
import type { SceneEventRow } from '../event/types.js';

/** 仅保留回声判定需要的最小字段；兼容 SceneEventRow 与裁剪快照 */
export interface EchoChainNode {
  id: number;
  type: string;
  actor: string | null;
  parent_event_id?: number | null;
  conv_turn?: number | null;
}

export interface EchoGuardParams {
  /** 候选待注入的事件（单条；一般是 dialogue） */
  candidate: EchoChainNode;
  /** 场景快照 id → row；用于 parent 链 lookup */
  byId: Map<number, EchoChainNode>;
  /** 同 DialogueConfig.echoMaxTurn；≤0 视为禁用 */
  echoMaxTurn: number;
}

/**
 * 从场景快照构建 id → row 映射。
 * - 调用方（scheduler / intake）只需构一次，scene 级复用。
 */
export function buildParentMap(
  events: ReadonlyArray<EchoChainNode | SceneEventRow>,
): Map<number, EchoChainNode> {
  const m = new Map<number, EchoChainNode>();
  for (const e of events) {
    if (!e || typeof e.id !== 'number') continue;
    m.set(e.id, {
      id: e.id,
      type: e.type,
      actor: e.actor ?? null,
      parent_event_id: e.parent_event_id ?? null,
      conv_turn: e.conv_turn ?? null,
    });
  }
  return m;
}

/**
 * 沿 parent_event_id 回溯，返回 actor 序列（从 start 自身开始，长度 ≤ maxDepth）。
 * - 链出快照（parent 在 map 里找不到）或达到 depth 上限即停
 * - 环保护：已访问过的 id 直接中断
 */
export function walkChain(
  start: EchoChainNode,
  byId: Map<number, EchoChainNode>,
  maxDepth: number,
): Array<string | null> {
  const out: Array<string | null> = [];
  if (maxDepth <= 0) return out;

  const seen = new Set<number>();
  let cur: EchoChainNode | undefined = start;
  while (cur && out.length < maxDepth) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    out.push(cur.actor ?? null);
    const pid = cur.parent_event_id;
    if (pid == null) break;
    cur = byId.get(pid);
  }
  return out;
}

/**
 * 判定一个 dialogue candidate 是否构成回声循环、应当被拦。
 * - 语义上游 config: echoMaxTurn=3 意为「pair 最多互相回应 3 个回合」
 *   · 链上有 N+1 连续交替 actor 即触发（conv_turn 至少 = N+1 = 4）
 * - 返回 true  = 拦（intake 侧 dropped++ + warn）
 * - 返回 false = 放行
 */
export function isEchoBlocked(p: EchoGuardParams): boolean {
  const { candidate, byId, echoMaxTurn } = p;

  if (echoMaxTurn <= 0) return false;
  if (candidate.type !== 'dialogue') return false;
  if (candidate.actor == null) return false;

  /** conv_turn 缺失（历史数据 / 手插事件） → 无法断言回声，放行 */
  const turn = candidate.conv_turn;
  if (typeof turn !== 'number' || turn < echoMaxTurn + 1) return false;

  /** 回溯 N+1 层 actor 序列（含自身） */
  const needLen = echoMaxTurn + 1;
  const chain = walkChain(candidate, byId, needLen);
  if (chain.length < needLen) return false;

  /** 全非 null + 仅含 2 个 actor + 严格交替 */
  const a = chain[0];
  const b = chain[1] ?? null;
  if (a == null || b == null || a === b) return false;

  for (let i = 0; i < chain.length; i += 1) {
    const expected = i % 2 === 0 ? a : b;
    if (chain[i] !== expected) return false;
  }
  return true;
}
