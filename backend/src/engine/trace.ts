/**
 * [M4.3.0] tick 粒度 trace_id 工具
 *
 * 目标
 *   - 每个 tick 在 runTick 顶部生成一次 uuid v4，贯穿本 tick 写入 5 张表
 *     （npc_tick_log / ai_call_log / scene_event / npc_memory / npc_reflection）
 *   - 与 WS payload、bus event 同步透传
 *   - 通过 TRACE_ID_ENABLED=false 可一键回退到 M4.2 行为（全部字段写 NULL）
 *
 * 粒度决策（拉票 Q6a 锁定）
 *   - tick 级：scheduler.runTick 开头生成一次，整个 tick 内所有子系统复用同一 id
 *   - 不用 scene 级（跨 tick 无法区分）、不用 NPC 级（一次 tick 要串 N 条 trace）
 *   - 不用全局 AsyncLocalStorage：显式参数贯穿更好排错、更适合单测
 *
 * 失败策略
 *   - crypto.randomUUID 是 Node 19+ 内置，不会运行时失败
 *   - env=false 时返回 null，所有下游字段写 NULL，不影响 M4.2 行为
 */

import { randomUUID } from 'node:crypto';

/** TRACE_ID_ENABLED 开关；默认 true；'false'/'0'/'no'/'off' 为关闭 */
export function isTraceEnabled(): boolean {
  const v = (process.env.TRACE_ID_ENABLED ?? 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no' && v !== 'off';
}

/**
 * 生成 tick 级 trace_id
 *   - 启用：返回 uuid v4（如 "9f8c1b3a-7e5d-4f2a-8c4b-d3a5b6c7e8f0"，36 字节）
 *   - 禁用：返回 null，写入层会落 NULL，保留 legacy 行为
 */
export function generateTraceId(): string | null {
  if (!isTraceEnabled()) return null;
  return randomUUID();
}

/**
 * 日志用短 trace
 *   - TRACE_ID_LOG_FORMAT=short（默认）取首 8 字节缩写打印
 *   - TRACE_ID_LOG_FORMAT=full 打完整 uuid（仅排障场景）
 *   - trace 为 null 时返回空字符串，日志行不渲染多余符号
 */
export function shortTrace(trace: string | null | undefined): string {
  if (!trace) return '';
  const format = (process.env.TRACE_ID_LOG_FORMAT ?? 'short').toLowerCase();
  if (format === 'full') return trace;
  return trace.slice(0, 8);
}

/** 给 `/api/engine/trace/:id` 做格式校验：uuid v4 的宽松 36 字符匹配 */
const TRACE_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function isValidTraceId(s: unknown): s is string {
  return typeof s === 'string' && TRACE_ID_RE.test(s);
}
