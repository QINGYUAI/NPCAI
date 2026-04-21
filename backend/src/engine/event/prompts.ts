/**
 * [M4.2.4.a] 事件总线 Prompt 基建 + API 输入 zod 校验
 *
 * 提供两类能力：
 * 1) 入库侧：`createSceneEventSchema` 严格校验 `POST /api/scene/:id/events` 的 body
 * 2) 读取侧：`hasEvents` / `buildEventBlock` 把 event-intake 节点返回的 items 格式化成
 *    可直接拼进 plan prompt user 消息头部的中文文本段（拉票 Q5a）
 *
 * 设计取舍
 * - content 截断 160 字：tick 内通常 1~10 条事件，预留 plan 原本的 prompt 余量；长事件 LLM 也抓不住重点
 * - 不做 Markdown：plan prompt 约定纯文本以节省 token
 * - 空数组返回空字符串：调用方 `eventBlock || ''` 拼接，不会多余换行
 */
import { z } from 'zod';
import { EVENT_TYPES, type EventBlockItem } from './types.js';

/** 单条 content 最长 500（入库列是 TEXT，但 prompt 值过长无益） */
const CONTENT_MAX = 500;

/** 单条 content 进入 prompt 时的截断上限（入库值不变，仅 prompt 侧裁剪） */
const PROMPT_CONTENT_MAX = 160;

/** actor 列长 VARCHAR(64)；prompt 拼接时保留原值 */
const ACTOR_MAX = 64;

/** payload JSON 序列化后最大 2KB，防止恶意大 payload 吃爆 DB 行 */
const PAYLOAD_MAX_BYTES = 2048;

/** visible_npcs 数组最多 100 个 NPC id，避免超大 JSON */
const VISIBLE_NPCS_MAX = 100;

/**
 * POST /api/scene/:id/events 的 body schema
 * - type 必须是 4 枚举之一
 * - content 去空白后 1~500 字
 * - actor 去空白后 0~64 字；空字符串会被 transform 为 null
 * - payload 可选，序列化后必须 <=2KB
 * - visible_npcs：undefined/null/空数组 区分明确：
 *   · 缺省或 null = 全场景可见
 *   · 数组 = 指定 NPC 列表（空数组会入库，但意味着「无人可见」，用于审计记录）
 */
export const createSceneEventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  content: z
    .string()
    .trim()
    .min(1, 'content 不可为空')
    .max(CONTENT_MAX, `content 长度不可超过 ${CONTENT_MAX}`),
  actor: z
    .string()
    .trim()
    .max(ACTOR_MAX, `actor 长度不可超过 ${ACTOR_MAX}`)
    .nullable()
    .optional()
    .transform((v) => {
      const s = typeof v === 'string' ? v.trim() : v;
      return s ? s : null;
    }),
  payload: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .refine(
      (v) => {
        if (v == null) return true;
        try {
          return Buffer.byteLength(JSON.stringify(v), 'utf8') <= PAYLOAD_MAX_BYTES;
        } catch {
          return false;
        }
      },
      { message: `payload 序列化后不可超过 ${PAYLOAD_MAX_BYTES} 字节` },
    ),
  visible_npcs: z
    .array(z.number().int().positive())
    .max(VISIBLE_NPCS_MAX, `visible_npcs 最多 ${VISIBLE_NPCS_MAX} 项`)
    .nullable()
    .optional(),
});

export type CreateSceneEventBody = z.infer<typeof createSceneEventSchema>;

/** 有事件 → true；空数组 / null / undefined → false */
export function hasEvents(items: EventBlockItem[] | null | undefined): boolean {
  return Array.isArray(items) && items.length > 0;
}

/**
 * 将本 NPC 本 tick 的事件列表格式化为 prompt 段（拉票 Q5a：塞 plan.user 头部）
 *
 * 输出示例（非空）：
 * ```
 * 【最近发生的事件】（请据此调整计划）
 * - [weather] 天色忽然阴沉，有雨点开始落下
 * - [dialogue 来自 小明] 你好，我在找一家好点的茶馆
 * - [plot] 街角传来一阵喧闹声
 * ```
 *
 * 设计点：
 * - 中括号前缀 `[type]` 帮助 LLM 快速分类；actor 非空时补 ` 来自 {actor}`
 * - 单条截断 160 字；省略号 `…` 提示 LLM 知道是截断
 * - 尾部带换行：调用方直接拼接，不需要再补
 */
export function buildEventBlock(items: EventBlockItem[] | null | undefined): string {
  if (!hasEvents(items)) return '';
  const lines = items!.map((ev) => {
    const raw = (ev.content ?? '').replace(/\s+/g, ' ').trim();
    const truncated = raw.length > PROMPT_CONTENT_MAX ? raw.slice(0, PROMPT_CONTENT_MAX) + '…' : raw;
    const actorPart = ev.actor ? ` 来自 ${ev.actor}` : '';
    return `- [${ev.type}${actorPart}] ${truncated}`;
  });
  return `【最近发生的事件】（请据此调整计划）\n${lines.join('\n')}\n`;
}
