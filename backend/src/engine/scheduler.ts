/**
 * 场景级 Tick 调度器
 *
 * - 每个场景一把运行时锁（见 registry.ts）
 * - 固定 interval 背压：前一次 tick 未完成则跳过
 * - 单 NPC 推理失败不影响同 tick 其它 NPC
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../db/connection.js';
import { bus } from './bus.js';
import { getEventConfig } from './event/config.js';
import {
  fetchConsumedSet,
  fetchRecentSceneEvents,
  writeConsumedBatch,
} from './event/fetchRecentEvents.js';
import { pickEventsForNpc } from './event/intake.js';
import { buildEventBlock } from './event/prompts.js';
import type { SceneEventRow } from './event/types.js';
import { buildParentMap, type EchoChainNode } from './dialogue/echo.js';
import { getDialogueConfig } from './dialogue/config.js';
import { runGraph } from './graph/build.js';
import { generateTraceId } from './trace.js';
import type {
  EngineConfig,
  EngineStatus,
  MetaWarn,
  NpcRow,
  SceneRow,
  SimulationMetaV1,
} from './types.js';

/** simulation_meta 大小阈值：软 64KB 仅警告，硬 256KB 拒绝写入 */
const META_SOFT_BYTES = 64 * 1024;
const META_HARD_BYTES = 256 * 1024;

/** [M4.2.0] meta_warns 最近 N 条滚动窗口；N 条以外自动丢弃 */
const META_WARN_RING_SIZE = 20;
/** [M4.2.0] "新鲜"告警阈值：此窗口内产生过任一 warn 则触发 X-Meta-Warn */
const META_WARN_FRESH_MS = 5 * 60 * 1000;

/** [M4.2.2.b] 记忆降级信号的"新鲜"窗口；与 meta.warn 对齐 */
const MEMORY_DEGRADED_FRESH_MS = 5 * 60 * 1000;

/** 默认每场景保留最近 N 条 tick_log；超出 async prune */
const LOG_RETENTION_DEFAULT = Number(process.env.ENGINE_LOG_RETENTION) || 2000;

export class SceneScheduler {
  readonly scene_id: number;
  private cfg: EngineConfig;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private ticking = false;
  private tickNo = 0;
  private startedAt: string | null = null;
  private lastTickAt: string | null = null;
  private lastDurationMs: number | null = null;
  private npcCount = 0;
  private errorsRecent = 0;
  private costUsdTotal = 0;
  /** [M4.2.0] 最近 N 条 simulation_meta 软阈值越界告警（滚动窗口） */
  private metaWarns: MetaWarn[] = [];
  /**
   * [M4.2.2.b] 最近一次记忆 retrieve 降级时间戳（unix ms）
   * - runGraph 返回 memory_degraded=true 时刷新
   * - status().memory_degraded = (now - this <= MEMORY_DEGRADED_FRESH_MS)
   */
  private memoryDegradedAt: number | null = null;
  /**
   * [M4.2.0 → M4.2.1.a] 每个 NPC 上一 tick 的真实 token 总消耗（prompt+completion）
   * - 数据来源：runGraph().tokens（M4.2.1.a 起接 chatCompletion.onMetrics 真实值）
   * - 下一 tick 开始前与 ai_config.budget_tokens_per_tick 比较；超支即写 skipped
   */
  private lastTickTokensByNpc: Map<number, number> = new Map();
  /** 允许硬停时中断正在进行的推理 */
  private abortController: AbortController | null = null;

  constructor(scene_id: number, cfg: EngineConfig) {
    this.scene_id = scene_id;
    this.cfg = cfg;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.startedAt = new Date().toISOString();
    this.tickNo = 0;
    this.errorsRecent = 0;
    this.costUsdTotal = 0;

    /** 立即触发一次 tick，再挂定时器 */
    void this.safeTick();
    this.timer = setInterval(() => {
      void this.safeTick();
    }, this.cfg.interval_ms);
  }

  async stop(reason: 'user' | 'error' | 'max_ticks' = 'user', force = false): Promise<void> {
    if (!this.running && !this.ticking) return;
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (force && this.abortController) {
      this.abortController.abort();
    }
    /** 软停：若正在 tick，给它跑完再退 */
    while (this.ticking && !force) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.running = false;
    this.stopping = false;
    bus.emitEvent({
      type: 'tick.end',
      scene_id: this.scene_id,
      tick: this.tickNo,
      duration_ms: 0,
    });
    void reason;
  }

  status(): EngineStatus {
    const memoryDegraded =
      this.memoryDegradedAt != null &&
      Date.now() - this.memoryDegradedAt <= MEMORY_DEGRADED_FRESH_MS;
    return {
      scene_id: this.scene_id,
      running: this.running,
      tick: this.tickNo,
      started_at: this.startedAt,
      last_tick_at: this.lastTickAt,
      last_duration_ms: this.lastDurationMs,
      npc_count: this.npcCount,
      errors_recent: this.errorsRecent,
      cost_usd_total: this.costUsdTotal,
      config: this.cfg,
      meta_warns: this.metaWarns.slice(),
      memory_degraded: memoryDegraded,
    };
  }

  /** [M4.2.0] 最近 METAWARN_FRESH_MS 毫秒内是否有过 meta 越界告警（供 controller 打 X-Meta-Warn 响应头） */
  hasFreshMetaWarn(): boolean {
    if (this.metaWarns.length === 0) return false;
    const now = Date.now();
    for (let i = this.metaWarns.length - 1; i >= 0; i -= 1) {
      const w = this.metaWarns[i];
      if (!w) continue;
      if (now - new Date(w.at).getTime() <= META_WARN_FRESH_MS) return true;
    }
    return false;
  }

  private pushMetaWarn(warn: MetaWarn, traceId: string | null): void {
    this.metaWarns.push(warn);
    if (this.metaWarns.length > META_WARN_RING_SIZE) {
      this.metaWarns.splice(0, this.metaWarns.length - META_WARN_RING_SIZE);
    }
    /** [M4.2.1.b] 同步通过 bus 广播给 WebSocket 订阅者，前端即时闪徽章；不等 3s 轮询 */
    bus.emitEvent({
      type: 'meta.warn',
      scene_id: warn.scene_id,
      tick: warn.tick,
      npc_id: warn.npc_id,
      npc_name: warn.npc_name,
      bytes: warn.bytes,
      soft_limit: warn.soft_limit,
      at: warn.at,
      trace_id: traceId,
    });
  }

  /** 外部调用：跑一次 tick（供「单步」按钮 / 测试使用） */
  async stepOnce(): Promise<void> {
    if (this.ticking) return;
    await this.safeTick();
  }

  /** 背压：若上一次 tick 还没跑完，跳过本次 */
  private async safeTick(): Promise<void> {
    if (this.stopping) return;
    if (this.ticking) {
      /** 跳过：记一条 skipped，只记一次（首个 NPC 足矣） */
      console.warn(`[engine] scene=${this.scene_id} tick=${this.tickNo + 1} 被跳过（上一轮仍在进行）`);
      return;
    }
    this.ticking = true;
    try {
      await this.tick();
    } finally {
      this.ticking = false;
    }
  }

  private async tick(): Promise<void> {
    this.tickNo += 1;
    const tickNo = this.tickNo;
    const t0 = Date.now();
    const startedAt = new Date();
    /**
     * [M4.3.0] tick 粒度 trace_id：本 tick 内所有 DB 写入（5 张表）+ WS 事件 + 日志都串同一 id
     * - TRACE_ID_ENABLED=false 时返回 null，所有字段写 NULL（一键回滚到 M4.2 行为）
     * - 通过函数参数显式贯穿，不用全局 AsyncLocalStorage，更易单测 & 排错
     */
    const traceId = generateTraceId();
    bus.emitEvent({
      type: 'tick.start',
      scene_id: this.scene_id,
      tick: tickNo,
      at: startedAt.toISOString(),
      trace_id: traceId,
    });

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let scene: SceneRow;
    let npcs: NpcRow[];
    try {
      [scene, npcs] = await loadSceneAndNpcs(this.scene_id);
    } catch (e) {
      this.errorsRecent += 1;
      bus.emitEvent({
        type: 'error',
        scene_id: this.scene_id,
        tick: tickNo,
        message: `load: ${(e as Error).message}`,
        trace_id: traceId,
      });
      return;
    }

    this.npcCount = npcs.length;
    if (npcs.length === 0) {
      return;
    }

    const neighbors = npcs.map((n) => ({ id: n.id, name: n.name }));

    /**
     * [M4.2.0] 批量加载本 tick 相关 ai_config 的 budget_tokens_per_tick
     * - 0 或 null = 不限
     * - 预算检查放在每个 NPC runGraph 之前；超支则跳过并记 'skipped'
     */
    const budgetMap = await loadBudgetsByAiConfigIds(
      Array.from(new Set(npcs.map((n) => n.ai_config_id))),
    );

    /**
     * [M4.2.4.b] event-intake 预取：scene 级一次查询 + consumed 预读
     * - 拉票 Q2b：tick 内 1 次查事件 + 1 次查 consumed（vs per-NPC N² 查询）
     * - 拉票 Q8a：查询失败降级为「无事件」，不阻塞整 tick；scheduler 打 warn 后继续跑 plan/speak
     * - eventConfig.enabled=false 时彻底短路（查询跳过，每 NPC eventBlock 为空）
     */
    const eventCfg = getEventConfig();
    let sceneEvents: SceneEventRow[] = [];
    let consumedSet: Set<string> = new Set();
    if (eventCfg.enabled) {
      try {
        sceneEvents = await fetchRecentSceneEvents({
          scene_id: this.scene_id,
          lookbackSeconds: eventCfg.lookbackSeconds,
          /** [M4.4.0 Q2a] 混合窗口：条数窗与时间窗取并集，解 budget skip 拉断对话链（L-1） */
          lookbackCount: eventCfg.lookbackCount,
          /** hardLimit 估算：max per-NPC × NPC 数 × 2 buffer；避免大量定向事件被误丢 */
          hardLimit: Math.max(
            eventCfg.lookbackCount,
            eventCfg.maxPerTick * npcs.length * 2,
            eventCfg.maxPerTick,
          ),
        });
        if (sceneEvents.length > 0) {
          consumedSet = await fetchConsumedSet({
            event_ids: sceneEvents.map((e) => e.id),
            npc_ids: npcs.map((n) => n.id),
          });
        }
      } catch (e) {
        console.warn(
          `[engine.event] scene=${this.scene_id} tick=${tickNo} event-intake 预取失败降级为空：`,
          (e as Error).message,
        );
        sceneEvents = [];
        consumedSet = new Set();
      }
    }

    /**
     * [M4.3.1.b] 回声保护：scene 级预构 parent map，多 NPC 复用
     *   - 仅在 sceneEvents 非空 + dialogue 启用时构建；失败降级放行
     *   - echoMaxTurn ≤0 时视为禁用（intake 侧双保险）
     */
    const dialogueCfg = getDialogueConfig();
    const echoMaxTurn = dialogueCfg.enabled ? dialogueCfg.echoMaxTurn : 0;
    let echoParentMap: Map<number, EchoChainNode> | undefined;
    if (echoMaxTurn > 0 && sceneEvents.length > 0) {
      try {
        echoParentMap = buildParentMap(sceneEvents);
      } catch (e) {
        console.warn(
          `[engine.echo] scene=${this.scene_id} tick=${tickNo} parent map 构建失败降级放行：`,
          (e as Error).message,
        );
        echoParentMap = undefined;
      }
    }

    /** 并发池：Promise.all + 分片 */
    await runWithPool(npcs, this.cfg.concurrency, async (npc) => {
      if (signal.aborted) return;
      const npcStart = Date.now();

      /** [M4.2.0] 预算检查：上一 tick 消耗 > budget 则本 tick 直接 skip */
      const budget = budgetMap.get(npc.ai_config_id) ?? 0;
      const lastTokens = this.lastTickTokensByNpc.get(npc.id) ?? 0;
      if (budget > 0 && lastTokens > budget) {
        const msg = `budget exceeded: last=${lastTokens} > budget=${budget}`;
        await persistNpcTick({
          scene_id: this.scene_id,
          npc_id: npc.id,
          tick: tickNo,
          started_at: new Date(npcStart),
          finished_at: new Date(),
          status: 'skipped',
          input_summary: `tick=${tickNo} npc=${npc.name}`,
          output_meta: null,
          duration_ms: Date.now() - npcStart,
          error_message: msg,
          trace_id: traceId,
        }).catch((e) => console.warn('[engine] 记录 skipped 日志失败:', e));
        bus.emitEvent({
          type: 'error',
          scene_id: this.scene_id,
          tick: tickNo,
          npc_id: npc.id,
          message: msg,
          trace_id: traceId,
        });
        /** 预算 skip 不消耗本 tick tokens，清零使下一 tick 继续尝试 */
        this.lastTickTokensByNpc.set(npc.id, 0);
        return;
      }
      /**
       * [M4.2.4.b] per-NPC event-intake（纯函数）：
       * - 基于 tick 顶部预取的 sceneEvents + consumedSet 做 3 步过滤（visible_npcs / consumed / maxPerTick）
       * - enabled=false 时 sceneEvents 本身为空，pickEventsForNpc 直接返回 empty，eventBlock=''，完全不影响 prompt
       * - dry_run 模式下仍调用 pickEventsForNpc 但 eventBlock 不会被 dry 路径使用（对齐 memory 子系统风格）
       */
      const intake = pickEventsForNpc({
        allEvents: sceneEvents,
        npc_id: npc.id,
        consumedSet,
        maxPerTick: eventCfg.maxPerTick,
        /** [M4.3.1.a V2=b] 自播 dialogue 过滤：A 不消费自己 t-1 的 dialogue event，避免自言自语循环 */
        self_actor_name: npc.name,
        /** [M4.3.1.b] 回声保护：0 等价禁用；parentMap scene 级复用 */
        echoMaxTurn,
        parentMap: echoParentMap,
        /** [M4.4.0 L-4 修复] 带 tick 号 + 窗口给 echo，超窗口的 candidate 不再拦 */
        currentTick: tickNo,
        echoWindowTick: dialogueCfg.enabled ? dialogueCfg.echoWindowTick : null,
      });
      const eventBlock = buildEventBlock(intake.items);

      try {
        const result = await runGraph({
          scene,
          npc,
          neighbors: neighbors.filter((n) => n.id !== npc.id),
          tick: tickNo,
          dryRun: this.cfg.dry_run,
          signal,
          eventBlock,
          /** [M4.3.1.a] 同源结构化 items，graph 内 emitDialogueFromSay 用于就地筛 parent */
          eventItems: intake.items,
          traceId,
        });
        this.costUsdTotal += result.cost_usd || 0;
        /** [M4.2.1.a] 记录真实 tokens 供下一 tick budget 判定；dry_run 仍为 0 */
        const npcTotalTokens = Number(result.tokens ?? 0);
        this.lastTickTokensByNpc.set(npc.id, npcTotalTokens);

        /** [M4.2.2.b] 聚合 memory 降级标记：任一 NPC 降级即刷新时间戳 */
        if (result.memory_degraded) {
          this.memoryDegradedAt = Date.now();
        }

        /**
         * [M4.2.3.b] reflection 生成事件：仅 status='generated' 时广播
         * - UI 据此在时间线/徽章实时显示（不等轮询）
         * - skipped/failed 不广播，避免噪音
         */
        if (result.reflection && result.reflection.status === 'generated') {
          bus.emitEvent({
            type: 'reflection.created',
            scene_id: this.scene_id,
            tick: tickNo,
            npc_id: npc.id,
            npc_name: npc.name,
            items: result.reflection.items,
            reflection_ids: result.reflection.reflection_ids,
            source_memory_ids: result.reflection.source_memory_ids,
            at: new Date().toISOString(),
            trace_id: traceId,
          });
        }

        const metaStr = serializeMeta(result.nextMeta);
        if (metaStr.byteLength > META_HARD_BYTES) {
          throw new Error(`simulation_meta 超过硬阈值 ${META_HARD_BYTES} 字节`);
        }

        const npcDuration = Date.now() - npcStart;
        await persistNpcTick({
          scene_id: this.scene_id,
          npc_id: npc.id,
          tick: tickNo,
          started_at: new Date(npcStart),
          finished_at: new Date(),
          status: 'success',
          input_summary: result.inputSummary,
          output_meta: metaStr.str,
          duration_ms: npcDuration,
          trace_id: traceId,
        });

        /**
         * [M4.2.4.b] 事件消费写回（拉票 Q1a：success 后立即写，不等 tick 尾）
         * - runGraph 成功才写，失败 / 异常路径不写 → 下 tick 可重新看到事件
         * - INSERT IGNORE 保证幂等：即使重复跑（stepOnce 误触发）也不报错
         * - 写失败不阻塞主流程，仅记 warn
         */
        if (intake.consumed_ids.length > 0) {
          try {
            await writeConsumedBatch({
              pairs: intake.consumed_ids.map((eid) => ({ event_id: eid, npc_id: npc.id })),
              tick: tickNo,
            });
          } catch (e) {
            console.warn(
              `[engine.event] scene=${this.scene_id} npc=${npc.id} tick=${tickNo} writeConsumed 失败：`,
              (e as Error).message,
            );
          }
        }

        /** [M4.2.1.b] tick.npc.updated 携带 status / duration / tokens / cost，WS 直推时间线 */
        bus.emitEvent({
          type: 'tick.npc.updated',
          scene_id: this.scene_id,
          tick: tickNo,
          npc_id: npc.id,
          npc_name: npc.name,
          meta: result.nextMeta,
          status: 'success',
          duration_ms: npcDuration,
          tokens: {
            prompt: 0,
            completion: 0,
            total: npcTotalTokens,
          },
          cost_usd: result.cost_usd ?? null,
          trace_id: traceId,
        });

        if (metaStr.byteLength > META_SOFT_BYTES) {
          const warn: MetaWarn = {
            scene_id: this.scene_id,
            npc_id: npc.id,
            npc_name: npc.name,
            tick: tickNo,
            bytes: metaStr.byteLength,
            soft_limit: META_SOFT_BYTES,
            at: new Date().toISOString(),
          };
          this.pushMetaWarn(warn, traceId);
          console.warn(
            `[engine] scene=${this.scene_id} npc=${npc.id} meta 超软阈值 ${META_SOFT_BYTES}B（实际 ${metaStr.byteLength}B）`,
          );
        }
      } catch (err) {
        this.errorsRecent += 1;
        const msg = err instanceof Error ? err.message : String(err);
        await persistNpcTick({
          scene_id: this.scene_id,
          npc_id: npc.id,
          tick: tickNo,
          started_at: new Date(npcStart),
          finished_at: new Date(),
          status: 'error',
          input_summary: `tick=${tickNo} npc=${npc.name}`,
          output_meta: null,
          duration_ms: Date.now() - npcStart,
          error_message: msg,
          trace_id: traceId,
        }).catch((e) => console.warn('[engine] 记录错误日志失败:', e));
        bus.emitEvent({
          type: 'error',
          scene_id: this.scene_id,
          tick: tickNo,
          npc_id: npc.id,
          message: msg,
          trace_id: traceId,
        });
      }
    });

    const duration = Date.now() - t0;
    this.lastDurationMs = duration;
    this.lastTickAt = new Date().toISOString();
    /** [M4.2.1.b] tick.end 带上 cost_usd_total，前端顶栏可即时累计 */
    bus.emitEvent({
      type: 'tick.end',
      scene_id: this.scene_id,
      tick: tickNo,
      duration_ms: duration,
      cost_usd_total: this.costUsdTotal,
      trace_id: traceId,
    });

    /** 异步裁剪日志 */
    void pruneTickLog(this.scene_id, LOG_RETENTION_DEFAULT);

    if (this.cfg.max_ticks && tickNo >= this.cfg.max_ticks) {
      void this.stop('max_ticks');
    }
  }
}

/** simulation_meta 序列化 + 字节数 */
function serializeMeta(meta: SimulationMetaV1): { str: string; byteLength: number } {
  const str = JSON.stringify(meta);
  return { str, byteLength: Buffer.byteLength(str, 'utf8') };
}

/** 并发池：同时运行至多 `concurrency` 个任务 */
async function runWithPool<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const pool = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const workers = Array.from({ length: pool }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      const it = items[i];
      if (it === undefined) break;
      await task(it);
    }
  });
  await Promise.all(workers);
}

/**
 * [M4.2.0] 批量加载 ai_config 的 budget_tokens_per_tick
 * - null / 非正数统一视为 0（不限）
 * - 表结构未迁移时，返回的行里读不到这一列，兜底为 0，不阻塞 tick
 */
async function loadBudgetsByAiConfigIds(ids: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (ids.length === 0) return map;
  try {
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, budget_tokens_per_tick FROM ai_config WHERE id IN (${placeholders})`,
      ids,
    );
    for (const r of rows as { id: number; budget_tokens_per_tick: number | null }[]) {
      const b = Number(r.budget_tokens_per_tick ?? 0);
      map.set(r.id, Number.isFinite(b) && b > 0 ? b : 0);
    }
  } catch (e) {
    /** 列不存在（未跑迁移）或查询异常：全部视为不限，记 warn 即可 */
    console.warn('[engine] loadBudgetsByAiConfigIds 查询失败，全部视为不限：', (e as Error).message);
  }
  return map;
}

/** 加载场景基本信息与其下的 NPC */
async function loadSceneAndNpcs(scene_id: number): Promise<[SceneRow, NpcRow[]]> {
  const [scenes] = await pool.query<RowDataPacket[]>(
    'SELECT id, name, description, width, height FROM scene WHERE id = ?',
    [scene_id],
  );
  if (scenes.length === 0) {
    throw new Error(`场景不存在: id=${scene_id}`);
  }
  const scene = scenes[0] as unknown as SceneRow;

  const [npcs] = await pool.query<RowDataPacket[]>(
    `SELECT n.id, n.name, n.personality, n.system_prompt, n.simulation_meta, n.ai_config_id
     FROM scene_npc sn
     INNER JOIN npc n ON n.id = sn.npc_id
     WHERE sn.scene_id = ?
     ORDER BY n.id ASC`,
    [scene_id],
  );

  return [scene, npcs as unknown as NpcRow[]];
}

/** 写 npc_tick_log + 更新 npc.simulation_meta（事务） */
async function persistNpcTick(row: {
  scene_id: number;
  npc_id: number;
  tick: number;
  started_at: Date;
  finished_at: Date;
  status: 'success' | 'error' | 'skipped';
  input_summary: string | null;
  output_meta: string | null;
  duration_ms: number;
  error_message?: string;
  /** [M4.3.0] 本 tick 全局 trace_id；TRACE_ID_ENABLED=false 传 null，列写 NULL */
  trace_id?: string | null;
}): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO npc_tick_log
         (scene_id, npc_id, tick, started_at, finished_at, status, input_summary, output_meta, duration_ms, error_message, trace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.scene_id,
        row.npc_id,
        row.tick,
        row.started_at,
        row.finished_at,
        row.status,
        row.input_summary,
        row.output_meta,
        row.duration_ms,
        row.error_message ?? null,
        row.trace_id ?? null,
      ],
    );
    if (row.status === 'success' && row.output_meta) {
      await conn.execute('UPDATE npc SET simulation_meta = ? WHERE id = ?', [
        row.output_meta,
        row.npc_id,
      ]);
    }
    await conn.commit();
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    conn.release();
  }
}

/** 保留最近 N 条：按场景裁剪，防表膨胀 */
async function pruneTickLog(scene_id: number, retention: number): Promise<void> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM npc_tick_log WHERE scene_id = ?',
      [scene_id],
    );
    const total = Number((rows as { c: number }[])[0]?.c ?? 0);
    if (total <= retention) return;
    await pool.execute<ResultSetHeader>(
      `DELETE FROM npc_tick_log
       WHERE scene_id = ?
       ORDER BY tick ASC, id ASC
       LIMIT ?`,
      [scene_id, total - retention],
    );
  } catch (e) {
    console.warn('[engine] pruneTickLog 失败:', e);
  }
}
