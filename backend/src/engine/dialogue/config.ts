/**
 * [M4.3.1.a] dialogue 子系统配置与 env 解析
 *
 * 职责
 *   - 集中解析 DIALOGUE_* 环境变量：
 *       · DIALOGUE_AUTO_EVENT_ENABLED  总开关；false = emitDialogueFromSay 全短路（回退 M4.2 行为）
 *       · DIALOGUE_CONTENT_MAX_LEN    入事件 content 的截断长度
 *       · DIALOGUE_ECHO_WINDOW_TICK   回声保护窗口 tick 数（本节点仅存储，M4.3.1.b 消费）
 *       · DIALOGUE_ECHO_MAX_TURN      回声保护最大轮数（本节点仅存储，M4.3.1.b 消费）
 *   - 启动期对正整数字段做硬校验，错 env 即抛
 *   - 提供 resetDialogueConfig() 供单测清缓存
 *
 * 非职责
 *   - 不写库，不注入 prompt；和 event.config / memory.config 语义正交
 */

const DEFAULTS = {
  DIALOGUE_AUTO_EVENT_ENABLED: 'true',
  DIALOGUE_CONTENT_MAX_LEN: '200',
  DIALOGUE_ECHO_WINDOW_TICK: '10',
  DIALOGUE_ECHO_MAX_TURN: '3',
} as const;

function readStr(key: keyof typeof DEFAULTS): string {
  const v = process.env[key];
  return (v && v.trim()) || DEFAULTS[key];
}

function readBool(key: keyof typeof DEFAULTS): boolean {
  return readStr(key).toLowerCase() === 'true';
}

function readPositiveInt(key: keyof typeof DEFAULTS): number {
  const raw = readStr(key);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`[dialogue.config] env ${key} 必须是正整数，当前=${raw}`);
  }
  return n;
}

export interface DialogueConfig {
  /** false = emitDialogueFromSay 整体短路；回退到 M4.2 行为（不写 scene_event） */
  enabled: boolean;
  /** content 截断长度，超出加 …；与 speakSchema.latest_say 200 上限一致 */
  contentMaxLen: number;
  /** [M4.3.1.b 消费] 回声保护窗口 tick 数 */
  echoWindowTick: number;
  /** [M4.3.1.b 消费] 同 pair 在窗口内最多互相回应轮数 */
  echoMaxTurn: number;
}

let cached: DialogueConfig | null = null;

export function getDialogueConfig(): DialogueConfig {
  if (cached) return cached;
  cached = {
    enabled: readBool('DIALOGUE_AUTO_EVENT_ENABLED'),
    contentMaxLen: readPositiveInt('DIALOGUE_CONTENT_MAX_LEN'),
    echoWindowTick: readPositiveInt('DIALOGUE_ECHO_WINDOW_TICK'),
    echoMaxTurn: readPositiveInt('DIALOGUE_ECHO_MAX_TURN'),
  };
  return cached;
}

export function resetDialogueConfig(): void {
  cached = null;
}
