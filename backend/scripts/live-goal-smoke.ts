/**
 * [M4.5.observe / C-new-3] Live goal 真机冒烟脚本（可重放）
 * ---------------------------------------------------------------
 * 目标
 *   在运行中的后端上，验证 `plan_path='goal'` 能否被实际观察到——
 *   即：下一条 goal 后，NPC 的下一 tick `output_meta.plan_path='goal'`，
 *        随后 PATCH status=done 后 `plan_path` 回到 schedule/idle/event。
 *
 * 设计取舍
 *   - 纯 REST + 直查 `npc_tick_log` 最新行，确保拿到的是刚跑完的一条
 *     （对照 M4.5.1.b smoke 调试经验：/engine/ticks 的 tick 号非全局单调）
 *   - 【关键前置】观察到 `plan_path='goal'` 需要 event 不抢占：
 *       - 在 M4.5.1.b 的设计里 event 优先级 > goal（computePlanPath）
 *       - 对话场景下 dialogue event 会持续涌入，goal 路径永远被抢占
 *       - 脚本**不主动**清 scene_event / 改 env，避免污染用户数据；
 *         若观察超时，打印建议：临时设 `EVENT_BUS_ENABLED=false` 重启 backend 再跑
 *   - 可重放：每次运行自动清理 engine stop + 删除脚本创建的测试 goal
 *
 * 用法（在 backend/ 目录下）
 *   # 最简：场景 1、NPC 1、priority 9
 *   npm run smoke:live-goal -- --scene=1 --npc=1
 *
 *   # 自定义参数
 *   npm run smoke:live-goal -- --scene=1 --npc=1 --priority=9 \
 *     --title='去图书馆找小美' --ticks=15 --interval=3000 --timeout=120
 *
 * 可选参数
 *   --scene=<id>       场景 ID（必填）
 *   --npc=<id>         目标 NPC ID（必填）
 *   --priority=<1..10> goal priority，默认 9
 *   --title=<text>     goal title，默认 "去图书馆找小美"
 *   --ticks=<N>        引擎 max_ticks，默认 15
 *   --interval=<ms>    tick 间隔，默认 3000（最小 2000）
 *   --timeout=<s>      等待 plan_path 的全局超时秒，默认 90
 *   --base=<url>       后端 Base URL，默认 http://localhost:3000
 *   --keep-engine      观察结束后不停止引擎（默认 stop）
 *
 * 退出码
 *   0  观察到完整闭环：goal 激活 → 撤销 goal 后路径回落
 *   1  超时：未观察到 plan_path='goal'（多数是 event 抢占，看 hint）
 *   2  后端不可达 / 参数非法 / 前置条件不满足
 */
import 'dotenv/config';
import { pool } from '../src/db/connection.js';
import type { RowDataPacket } from 'mysql2';

// -------- CLI 解析 --------
interface Args {
  scene: number;
  npc: number;
  priority: number;
  title: string;
  ticks: number;
  interval: number;
  timeoutSec: number;
  base: string;
  keepEngine: boolean;
}
function parseArgs(): Args {
  const out: Partial<Args> = {
    priority: 9,
    title: '去图书馆找小美',
    ticks: 15,
    interval: 3000,
    timeoutSec: 90,
    base: 'http://localhost:3000',
    keepEngine: false,
  };
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'keep-engine') out.keepEngine = true;
    else if (k === 'scene') out.scene = Number(v);
    else if (k === 'npc') out.npc = Number(v);
    else if (k === 'priority') out.priority = Number(v);
    else if (k === 'title') out.title = String(v);
    else if (k === 'ticks') out.ticks = Number(v);
    else if (k === 'interval') out.interval = Number(v);
    else if (k === 'timeout') out.timeoutSec = Number(v);
    else if (k === 'base') out.base = String(v);
  }
  if (!Number.isInteger(out.scene) || (out.scene as number) <= 0) {
    console.error('缺少 --scene=<正整数>');
    process.exit(2);
  }
  if (!Number.isInteger(out.npc) || (out.npc as number) <= 0) {
    console.error('缺少 --npc=<正整数>');
    process.exit(2);
  }
  if ((out.priority as number) < 1 || (out.priority as number) > 10) {
    console.error('--priority 必须在 1..10');
    process.exit(2);
  }
  if ((out.interval as number) < 2000) {
    console.warn('--interval 最小 2000，已拉齐为 2000');
    out.interval = 2000;
  }
  return out as Args;
}

// -------- 通用工具 --------
async function api<T = unknown>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body: json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TickMeta {
  id: number;
  npc_id: number;
  plan_path: string | null;
  goal_title: string | null;
  activity: string | null;
  finished_at: Date | null;
}

/** 直查 npc_tick_log 最新一条（id DESC），避开 API 的 tick 排序歧义 */
async function fetchLatestTickMeta(npc_id: number, afterId: number): Promise<TickMeta | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, npc_id, output_meta, finished_at
       FROM npc_tick_log
      WHERE npc_id=? AND id > ? AND status='success'
      ORDER BY id DESC LIMIT 1`,
    [npc_id, afterId],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  let meta: Record<string, unknown> = {};
  const raw = r['output_meta'];
  if (raw && typeof raw === 'object') meta = raw as Record<string, unknown>;
  else if (typeof raw === 'string') {
    try {
      meta = JSON.parse(raw);
    } catch {
      meta = {};
    }
  }
  const activeGoal = meta['active_goal'] as { title?: string } | null | undefined;
  const schedAct = meta['scheduled_activity'] as { activity?: string } | null | undefined;
  return {
    id: Number(r['id']),
    npc_id: Number(r['npc_id']),
    plan_path: (meta['plan_path'] as string | null) ?? null,
    goal_title: activeGoal?.title ?? null,
    activity: schedAct?.activity ?? null,
    finished_at: r['finished_at'] instanceof Date ? r['finished_at'] : null,
  };
}

async function fetchBaselineTickId(npc_id: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT MAX(id) AS maxId FROM npc_tick_log WHERE npc_id=?`,
    [npc_id],
  );
  return Number(rows[0]?.['maxId'] ?? 0);
}

function fmt(meta: TickMeta | null): string {
  if (!meta) return '(no tick yet)';
  return `tick#${meta.id} path=${meta.plan_path ?? '-'} goal=${meta.goal_title ?? '-'} act=${meta.activity ?? '-'}`;
}

// -------- 主流程 --------
async function main() {
  const args = parseArgs();
  console.log('================ live-goal-smoke ================');
  console.log('参数:', {
    scene: args.scene,
    npc: args.npc,
    priority: args.priority,
    title: args.title,
    ticks: args.ticks,
    interval: args.interval,
    timeoutSec: args.timeoutSec,
    base: args.base,
  });

  /** 前置 1：后端存活（顺便拿到 scene 的 engine 状态） */
  let initialRunning = false;
  try {
    const h = await api<{ data?: { running?: boolean } }>(
      args.base,
      'GET',
      `/api/engine/status?scene_id=${args.scene}`,
    );
    if (h.status >= 500) throw new Error(`status=${h.status}`);
    if (h.status === 400) throw new Error(`scene=${args.scene} 不存在或参数非法`);
    initialRunning = (h.body as { data?: { running?: boolean } }).data?.running ?? false;
  } catch (e) {
    console.error(`✗ 后端不可达或 scene 非法：${args.base}（${(e as Error).message}）`);
    process.exit(2);
  }

  /** 前置 2：env 提示 */
  const eventBusEnabled = (process.env['EVENT_BUS_ENABLED'] ?? 'true').toLowerCase() !== 'false';
  const goalEnabled = (process.env['GOAL_ENABLED'] ?? 'true').toLowerCase() !== 'false';
  if (!goalEnabled) {
    console.error('✗ backend 当前 GOAL_ENABLED=false，goal 写入会 503；请先置 true 重启后端');
    process.exit(2);
  }
  if (eventBusEnabled) {
    console.log('ⓘ EVENT_BUS_ENABLED=true：dialogue event 可能持续抢占 goal 路径');
    console.log('   若观察超时，临时设置 EVENT_BUS_ENABLED=false 重启后端再跑，可得纯净 goal 路径');
  }

  const baselineId = await fetchBaselineTickId(args.npc);
  console.log(`baseline npc_tick_log.id = ${baselineId}`);

  /** 1) 确保 engine 启动（复用前置里拿到的 initialRunning） */
  if (!initialRunning) {
    console.log('启动 engine...');
    const startRes = await api(args.base, 'POST', '/api/engine/start', {
      scene_id: args.scene,
      interval_ms: args.interval,
      max_ticks: args.ticks,
    });
    if (startRes.status !== 200) {
      console.error('✗ 启动 engine 失败:', startRes.status, startRes.body);
      process.exit(2);
    }
  } else {
    console.log('engine 已在运行，直接复用');
  }

  /** 2) 下 goal */
  console.log(`下 goal npc=${args.npc} title="${args.title}" priority=${args.priority}...`);
  const goalRes = await api<{ code: number; data?: { id: number }; error?: string; message?: string }>(
    args.base,
    'POST',
    '/api/engine/goals',
    {
      npc_id: args.npc,
      title: args.title,
      kind: 'player',
      priority: args.priority,
      expires_in_seconds: 300,
    },
  );
  if (goalRes.status !== 200 || !goalRes.body.data?.id) {
    console.error('✗ 创建 goal 失败:', goalRes.status, goalRes.body);
    await cleanup(args, null);
    process.exit(2);
  }
  const goalId = goalRes.body.data.id;
  console.log(`✓ goal#${goalId} 已创建`);

  /** 3) 等待 plan_path='goal' */
  console.log(`等待 plan_path='goal' (最多 ${args.timeoutSec}s)...`);
  const deadline1 = Date.now() + args.timeoutSec * 1000;
  let hitGoalMeta: TickMeta | null = null;
  let latestSeen: TickMeta | null = null;
  while (Date.now() < deadline1) {
    const meta = await fetchLatestTickMeta(args.npc, baselineId);
    if (meta && (!latestSeen || meta.id > latestSeen.id)) {
      latestSeen = meta;
      console.log(`  · ${fmt(meta)}`);
    }
    if (meta?.plan_path === 'goal') {
      hitGoalMeta = meta;
      break;
    }
    await sleep(2000);
  }
  if (!hitGoalMeta) {
    console.error(`✗ 超时未观察到 plan_path='goal'；最近一条 = ${fmt(latestSeen)}`);
    console.error('hint:');
    console.error(
      '   1. dialogue event 可能在抢占 —— 设置 EVENT_BUS_ENABLED=false 重启 backend 再跑',
    );
    console.error(
      '   2. 该 NPC 可能没有 schedule 也没触发调度；检查 npc_schedule 表和当前模拟时钟',
    );
    console.error(
      '   3. priority 若低于日程优先级，也会落 schedule —— 把 --priority=10 试试',
    );
    await cleanup(args, goalId);
    process.exit(1);
  }
  console.log(`✓ 命中 goal 路径：${fmt(hitGoalMeta)}`);

  /** 4) 撤销 goal */
  console.log(`PATCH goal#${goalId} status=done 撤销...`);
  const patchRes = await api(args.base, 'PATCH', `/api/engine/goals/${goalId}`, { status: 'done' });
  if (patchRes.status !== 200) {
    console.warn('PATCH 失败（继续观察后续）:', patchRes.status, patchRes.body);
  }

  /** 5) 等待 plan_path 回落（非 goal） */
  console.log(`等待 plan_path 回落 (最多 ${args.timeoutSec}s)...`);
  const deadline2 = Date.now() + args.timeoutSec * 1000;
  let backMeta: TickMeta | null = null;
  let afterGoalBaseline = hitGoalMeta.id;
  while (Date.now() < deadline2) {
    const meta = await fetchLatestTickMeta(args.npc, afterGoalBaseline);
    if (meta) {
      console.log(`  · ${fmt(meta)}`);
      afterGoalBaseline = meta.id;
      if (meta.plan_path !== 'goal') {
        backMeta = meta;
        break;
      }
    }
    await sleep(2000);
  }
  if (!backMeta) {
    console.warn('⚠ 超时仍停在 goal 路径（可能是 goal 未生效撤销/或被新 goal 覆盖）');
    await cleanup(args, goalId);
    process.exit(1);
  }
  console.log(`✓ 路径已回落：${fmt(backMeta)}`);

  /** 6) 清理 */
  await cleanup(args, goalId);

  console.log('================ PASS ================');
  console.log(`闭环：tick#${hitGoalMeta.id}(goal) → PATCH done → tick#${backMeta.id}(${backMeta.plan_path})`);
  process.exit(0);
}

async function cleanup(args: Args, goalId: number | null) {
  try {
    if (goalId) {
      const r = await api(args.base, 'DELETE', `/api/engine/goals/${goalId}`);
      console.log(`cleanup: DELETE goal#${goalId} → ${r.status}`);
    }
    if (!args.keepEngine) {
      const r = await api(args.base, 'POST', '/api/engine/stop', { scene_id: args.scene });
      console.log(`cleanup: engine stop scene=${args.scene} → ${r.status}`);
    }
  } catch (e) {
    console.warn('cleanup 失败（忽略）:', (e as Error).message);
  } finally {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
  }
}

main().catch(async (e) => {
  console.error('未捕获异常:', e);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(2);
});
