/**
 * M4.1.d 真 LLM smoke 脚本
 * ---------------------------------------------------------------
 * 用途：
 *   - 对已运行的后端（npm run dev）发起真实 LLM 引擎跑测
 *   - 仅读取后端 REST，不直接访问 MySQL，便于随时跨环境复用
 *   - 自动汇总 tick_log 与 ai_call_log，给出人类可读结论
 *
 * 用法（在 backend/ 目录下）：
 *   npm run smoke:engine -- --scene=1 --ticks=3 --interval=5000 --concurrency=2
 *
 * 可选参数（均有默认值）：
 *   --scene=<id>         场景 ID（必填）
 *   --ticks=<N>          最大 tick 数，默认 3
 *   --interval=<ms>      tick 间隔，默认 5000
 *   --concurrency=<N>    同 tick 内并发 NPC 数，默认 2
 *   --base=<url>         后端 Base URL，默认 http://localhost:3001
 *   --dry-run            只做 dry_run（不打 LLM）
 *   --timeout=<s>        全局超时（含启动轮询），默认 300 秒
 */

const DEFAULT_BASE = 'http://localhost:3000';
const DEFAULT_TICKS = 3;
const DEFAULT_INTERVAL = 5000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_S = 300;

interface CliArgs {
  scene: number;
  ticks: number;
  interval: number;
  concurrency: number;
  base: string;
  dryRun: boolean;
  timeoutMs: number;
}

/** 简易 CLI 解析：--key=value / --flag */
function parseArgs(argv: string[]): CliArgs {
  const map: Record<string, string | boolean> = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const kv = raw.slice(2);
    const eq = kv.indexOf('=');
    if (eq >= 0) map[kv.slice(0, eq)] = kv.slice(eq + 1);
    else map[kv] = true;
  }
  const scene = Number(map.scene);
  if (!Number.isFinite(scene) || scene <= 0) {
    console.error('❌ 必须提供 --scene=<场景ID>');
    process.exit(2);
  }
  return {
    scene,
    ticks: Number(map.ticks) || DEFAULT_TICKS,
    interval: Number(map.interval) || DEFAULT_INTERVAL,
    concurrency: Number(map.concurrency) || DEFAULT_CONCURRENCY,
    base: (map.base as string) || DEFAULT_BASE,
    dryRun: map['dry-run'] === true,
    timeoutMs: (Number(map.timeout) || DEFAULT_TIMEOUT_S) * 1000,
  };
}

/** 标准 {code, data, message} 响应封装 */
interface ApiResp<T> {
  code: number;
  data?: T;
  message?: string;
  error?: string;
}

async function apiGet<T>(base: string, path: string): Promise<T> {
  const resp = await fetch(`${base}${path}`);
  const json = (await resp.json()) as ApiResp<T>;
  if (!resp.ok || json.code !== 0) {
    throw new Error(`GET ${path} 失败：HTTP ${resp.status} ${json.message || json.error || ''}`);
  }
  return json.data as T;
}

async function apiPost<T>(base: string, path: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await resp.json()) as ApiResp<T>;
  if (!resp.ok || json.code !== 0) {
    throw new Error(`POST ${path} 失败：HTTP ${resp.status} ${json.message || json.error || ''}`);
  }
  return json.data as T;
}

interface SceneDetail {
  id: number;
  name: string;
  npcs: Array<{ npc_id: number; npc_name: string }>;
}

interface NpcDetail {
  id: number;
  name: string;
  ai_config_id: number | null;
}

interface EngineStatus {
  scene_id: number;
  running: boolean;
  tick: number;
  started_at: string | null;
  last_tick_at: string | null;
  last_duration_ms: number | null;
  npc_count: number;
  errors_recent: number;
  cost_usd_total: number;
  config: { dry_run?: boolean; interval_ms?: number } | null;
}

interface TickRow {
  id: number;
  scene_id: number;
  npc_id: number;
  tick: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  input_summary: string | null;
  output_meta: Record<string, unknown> | null;
  duration_ms: number | null;
  error_message: string | null;
}

interface AiLogRow {
  id: number;
  ai_config_id: number | null;
  api_type: string;
  provider: string | null;
  model: string | null;
  status: string;
  source: string | null;
  context: Record<string, unknown> | null;
  duration_ms: number | null;
  created_at: string;
}

/** 时间格式辅助：ms → "1.23s" / "567ms" */
function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}

function log(title: string): void {
  console.log(`\n====== ${title} ======`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log('🚀 AINPC Engine Smoke — 真 LLM 验收脚本');
  console.log(`   base=${args.base}  scene=${args.scene}  ticks=${args.ticks}  interval=${args.interval}ms  concurrency=${args.concurrency}  dry_run=${args.dryRun}`);

  log('1/5 Preflight：健康检查 + 场景与 NPC 校验');
  const health = await fetch(`${args.base}/api/health`).then((r) => r.ok).catch(() => false);
  if (!health) {
    throw new Error(
      `后端 ${args.base}/api/health 不可达。请确认：① 后端已 \`npm run dev\` 启动；② 端口是否一致（后端默认 3000，可用 --base=http://localhost:<port> 覆盖）`,
    );
  }
  console.log('   ✅ /api/health OK');

  const scene = await apiGet<SceneDetail>(args.base, `/api/scene/${args.scene}`);
  console.log(`   ✅ 场景：#${scene.id} ${scene.name}（关联 NPC=${scene.npcs.length}）`);
  if (scene.npcs.length === 0) {
    throw new Error('场景下无 NPC，请先去前端绑定至少 2 个 NPC（推荐 2 个以验证并发）');
  }
  if (scene.npcs.length < 2) {
    console.log('   ⚠️  建议至少 2 个 NPC 以验证并发池，当前仅 1 个，继续');
  }

  for (const link of scene.npcs) {
    const npc = await apiGet<NpcDetail>(args.base, `/api/npc/${link.npc_id}`);
    const marker = npc.ai_config_id ? `✅ ai_config_id=${npc.ai_config_id}` : '❌ 未绑定 ai_config';
    console.log(`   · #${npc.id} ${npc.name}  ${marker}`);
    if (!npc.ai_config_id && !args.dryRun) {
      throw new Error(`NPC #${npc.id} ${npc.name} 未绑定 ai_config_id，真 LLM 模式下必需（或改用 --dry-run）`);
    }
  }

  log('2/5 记录引擎启动前的 tick_log / ai_call_log 基线');
  const baseTicks = await apiGet<TickRow[]>(
    args.base,
    `/api/engine/ticks?scene_id=${args.scene}&limit=1&order=desc`,
  );
  const baselineMaxTickId = baseTicks[0]?.id ?? 0;
  const baselineMaxTick = baseTicks[0]?.tick ?? 0;
  /** ai_call_log 用 id 基线隔离（避免把前一轮 smoke 的条目算进本轮） */
  const baseAi = await apiGet<{ list: AiLogRow[]; total: number }>(
    args.base,
    `/api/ai-logs?pageSize=1&page=1`,
  );
  const baselineMaxAiId = baseAi.list[0]?.id ?? 0;
  console.log(
    `   · 基线：tick_log 最大 id=${baselineMaxTickId}（tick=${baselineMaxTick}）；ai_call_log 最大 id=${baselineMaxAiId}`,
  );

  log('3/5 启动引擎');
  const startRes = await apiPost<EngineStatus>(args.base, `/api/engine/start`, {
    scene_id: args.scene,
    interval_ms: args.interval,
    max_ticks: args.ticks,
    concurrency: args.concurrency,
    dry_run: args.dryRun,
  });
  console.log(
    `   ✅ 已启动：running=${startRes.running}（npc_count 会在首个 tick 完成后更新，此刻为 ${startRes.npc_count}）`,
  );

  log('4/5 轮询状态直至 stopping（或超时）');
  const deadline = Date.now() + args.timeoutMs;
  let lastPrintedTick = -1;
  let finalStatus: EngineStatus = startRes;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      finalStatus = await apiGet<EngineStatus>(
        args.base,
        `/api/engine/status?scene_id=${args.scene}`,
      );
    } catch (e) {
      throw new Error(
        `轮询 /api/engine/status 失败（后端可能已中断）：${(e as Error).message}。请检查后端日志（常见：数据库列缺失需补跑 \`npm run db:migrate-scene\` / \`db:migrate-engine\`）`,
      );
    }
    if (finalStatus.tick !== lastPrintedTick) {
      console.log(
        `   · tick=${finalStatus.tick}/${args.ticks}  running=${finalStatus.running}  ` +
        `npc_count=${finalStatus.npc_count}  last_dur=${fmtMs(finalStatus.last_duration_ms)}  errors=${finalStatus.errors_recent}`,
      );
      lastPrintedTick = finalStatus.tick;
    }
    if (!finalStatus.running) break;
  }
  if (finalStatus.running) {
    console.log('   ⚠️ 超时仍在运行，强制停止');
    await apiPost<EngineStatus>(args.base, `/api/engine/stop`, {
      scene_id: args.scene,
      force: true,
      reason: 'smoke-timeout',
    });
  }

  log('5/5 汇总 tick_log 与 ai_call_log');
  /**
   * 每次 start 都会新建 scheduler，tickNo 从 1 重新数，所以不能用 tick 号做基线过滤。
   * 改用 id（BIGINT auto_increment，全局单调）过滤本次 smoke 新增。
   */
  const fresh = await apiGet<TickRow[]>(
    args.base,
    `/api/engine/ticks?scene_id=${args.scene}&limit=200&order=desc`,
  );
  const newRows = fresh
    .filter((r) => r.id > baselineMaxTickId)
    .sort((a, b) => a.tick - b.tick || a.id - b.id);

  const byTick = new Map<number, TickRow[]>();
  for (const r of newRows) {
    const arr = byTick.get(r.tick) ?? [];
    arr.push(r);
    byTick.set(r.tick, arr);
  }
  const tickKeys = [...byTick.keys()].sort((a, b) => a - b);

  let successCnt = 0;
  let errorCnt = 0;
  let sayCnt = 0;
  let actCnt = 0;

  console.log('\n  id   │ Tick │ NPC │ Status  │ Duration │ latest_say / error');
  console.log('  ─────┼──────┼─────┼─────────┼──────────┼────────────────────────────');
  /** 清洗 LLM 回文中常见的 \r \n \t，避免终端渲染错位 */
  const oneLine = (s: string): string => s.replace(/[\r\n\t]+/g, ' ').trim();
  for (const t of tickKeys) {
    const rows = byTick.get(t)!;
    for (const r of rows) {
      const isOk = r.status === 'success';
      isOk ? successCnt++ : errorCnt++;
      const meta = r.output_meta || {};
      const say = (meta as Record<string, unknown>).latest_say;
      const act = (meta as Record<string, unknown>).latest_action;
      if (typeof say === 'string' && say.trim()) sayCnt++;
      if (typeof act === 'string' && act.trim()) actCnt++;
      const previewRaw = isOk
        ? (typeof say === 'string' ? say : typeof act === 'string' ? `(${act})` : '(空)')
        : r.error_message ?? '';
      const preview = oneLine(String(previewRaw)).slice(0, 50);
      console.log(
        `  ${String(r.id).padEnd(4)} │ ${String(r.tick).padEnd(4)} │ ${String(r.npc_id).padEnd(3)} │ ${String(r.status).padEnd(7)} │ ${fmtMs(r.duration_ms).padEnd(8)} │ ${preview}`,
      );
    }
  }

  /** ai_call_log 取最新 200 条按 source 过滤本 scene 本轮区间 */
  const aiLogs: AiLogRow[] = [];
  for (const source of ['engine.plan', 'engine.speak', 'engine.memory']) {
    const page = await apiGet<{ list: AiLogRow[]; total: number }>(
      args.base,
      `/api/ai-logs?source=${encodeURIComponent(source)}&pageSize=100&page=1`,
    );
    aiLogs.push(...page.list);
  }
  /** 用 id 基线 + scene_id 双重过滤，确保只统计本次 smoke 的调用 */
  const freshAi = aiLogs.filter((row) => {
    if (row.id <= baselineMaxAiId) return false;
    const ctx = row.context || {};
    return Number((ctx as { scene_id?: unknown }).scene_id) === args.scene;
  });
  const aiOk = freshAi.filter((r) => r.status === 'success').length;
  const aiErr = freshAi.filter((r) => r.status === 'error').length;
  const aiDurAvg =
    freshAi.length === 0
      ? 0
      : Math.round(freshAi.reduce((s, r) => s + (r.duration_ms || 0), 0) / freshAi.length);
  const aiByNode = freshAi.reduce<Record<string, number>>((m, r) => {
    const key = r.source || '?';
    m[key] = (m[key] || 0) + 1;
    return m;
  }, {});

  console.log('\n───────── 汇总 ─────────');
  console.log(`  tick_log 新增:       ${newRows.length} 行（${tickKeys.length} 个 tick，预期 ${args.ticks * scene.npcs.length}）`);
  console.log(`  success / error:     ${successCnt} / ${errorCnt}`);
  console.log(`  latest_say 非空:     ${sayCnt} / ${successCnt}`);
  console.log(`  latest_action 非空:  ${actCnt} / ${successCnt}`);
  console.log(`  ai_call_log 命中:    ${freshAi.length}（success=${aiOk}, error=${aiErr}, 平均 ${fmtMs(aiDurAvg)}）`);
  console.log(`  ai_call_log 分节点:  ${Object.entries(aiByNode).map(([k, v]) => `${k}=${v}`).join(' / ') || '(无)'}`);

  const expectedRuns = args.ticks * scene.npcs.length;
  const okRatio = expectedRuns > 0 ? successCnt / expectedRuns : 0;

  let verdict: 'PASS' | 'WARN' | 'FAIL' = 'PASS';
  if (successCnt === 0) verdict = 'FAIL';
  else if (okRatio < 0.8 || (errorCnt > 0 && !args.dryRun)) verdict = 'WARN';

  const icon = verdict === 'PASS' ? '🟢' : verdict === 'WARN' ? '🟡' : '🔴';
  console.log(`\n${icon} Smoke 结论：${verdict}   (完成率 ${(okRatio * 100).toFixed(0)}%)`);

  if (verdict === 'FAIL') process.exit(1);
}

main().catch((e) => {
  console.error('\n❌ Smoke 失败：', (e as Error).message);
  process.exit(1);
});
