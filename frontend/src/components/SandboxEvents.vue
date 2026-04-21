<script setup lang="ts">
/**
 * [M4.2.4.c] 场景事件抽屉：展示本 session 通过 WS / REST 收到的事件
 *
 * 数据契约
 * - entries：父组件 Sandbox.vue 维护的 ring buffer（按 received_at 升序；渲染倒序，最新在上）
 * - 切场景 / 组件卸载时父组件会清空
 *
 * 交互
 * - 每条事件为一张卡片：类型徽章色 + actor + content 摘要
 * - 可展开查看完整 payload（折叠 JSON）+ visible_npcs 列表
 * - 顶部「清空」仅清空本地 ring buffer（不删服务端）
 * - 未来可接入 delete API；当前版本不暴露，避免误删其他客户端视角需要的事件
 */
import { computed, ref } from 'vue'
import { EVENT_TYPE_LABELS } from '../types/event'
import type { EventRingEntry } from '../types/event'

const props = defineProps<{
  entries: EventRingEntry[]
  visible: boolean
}>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'clear'): void
}>()

const drawerVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
})

/** 最新在上（ring buffer 本身按 received_at 升序推入） */
const ordered = computed<EventRingEntry[]>(() => [...props.entries].reverse())

/** 卡片展开 payload/visible_npcs 的状态（按 event_id） */
const openedKeys = ref<Set<number>>(new Set())
function toggleOpen(key: number) {
  const next = new Set(openedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openedKeys.value = next
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  } catch {
    return iso
  }
}

function hasDetail(entry: EventRingEntry): boolean {
  const hasPayload = entry.payload && Object.keys(entry.payload).length > 0
  const hasVisible = Array.isArray(entry.visible_npcs) && entry.visible_npcs.length > 0
  return !!(hasPayload || hasVisible)
}

function fmtPayload(p: Record<string, unknown> | null): string {
  if (!p) return ''
  try {
    return JSON.stringify(p, null, 2)
  } catch {
    return String(p)
  }
}
</script>

<template>
  <el-drawer v-model="drawerVisible" title="事件" direction="rtl" size="440px" :with-header="true" append-to-body>
    <template #header>
      <div class="flex items-center gap-3">
        <span class="evt-title">📢 事件 <span class="evt-count">[{{ entries.length }}]</span></span>
        <button v-if="entries.length > 0" class="evt-clear" @click="emit('clear')">清空</button>
      </div>
    </template>
    <el-empty
      v-if="entries.length === 0"
      :image-size="60"
      description="暂无事件。可通过顶栏「🌧️ 下雨」「🌋 地震」快捷按钮，或「💬 自定义事件」注入任意事件。"
    />
    <ul v-else class="evt-list">
      <li
        v-for="entry in ordered"
        :key="entry.key"
        class="evt-card"
        :style="{ borderLeftColor: EVENT_TYPE_LABELS[entry.type].color }"
      >
        <header class="evt-card-head">
          <span
            class="evt-type-chip"
            :style="{ background: EVENT_TYPE_LABELS[entry.type].color }"
          >{{ EVENT_TYPE_LABELS[entry.type].emoji }} {{ EVENT_TYPE_LABELS[entry.type].label }}</span>
          <span class="evt-actor">{{ entry.actor || 'system' }}</span>
          <span class="evt-time">{{ fmtTime(entry.received_at) }}</span>
          <span class="evt-id">#{{ entry.key }}</span>
        </header>
        <div class="evt-content">{{ entry.content }}</div>
        <div class="evt-meta-row">
          <span v-if="entry.visible_npcs == null" class="evt-badge evt-badge-all">全场景可见</span>
          <span v-else-if="entry.visible_npcs.length === 0" class="evt-badge evt-badge-none">仅留档（无人可见）</span>
          <span v-else class="evt-badge evt-badge-some">定向 {{ entry.visible_npcs.length }} 人</span>
          <span v-if="entry.consumed_tick != null" class="evt-badge evt-badge-consumed">
            已消费 @ t={{ entry.consumed_tick }}
          </span>
          <button
            v-if="hasDetail(entry)"
            class="evt-detail-btn"
            @click="toggleOpen(entry.key)"
          >{{ openedKeys.has(entry.key) ? '收起详情' : '详情' }}</button>
        </div>
        <div v-if="openedKeys.has(entry.key) && hasDetail(entry)" class="evt-detail">
          <div v-if="entry.visible_npcs && entry.visible_npcs.length > 0" class="evt-detail-block">
            <span class="evt-detail-title">visible_npcs：</span>
            <span class="evt-npc-list">{{ entry.visible_npcs.map((n) => `#${n}`).join(' · ') }}</span>
          </div>
          <div v-if="entry.payload && Object.keys(entry.payload).length > 0" class="evt-detail-block">
            <span class="evt-detail-title">payload：</span>
            <pre class="evt-payload">{{ fmtPayload(entry.payload) }}</pre>
          </div>
        </div>
      </li>
    </ul>
  </el-drawer>
</template>

<style scoped>
.evt-title {
  font-weight: 600;
  color: #f0f6fc;
  font-size: 14px;
}
.evt-count {
  color: var(--ainpc-muted);
  font-weight: 400;
  margin-left: 4px;
  font-variant-numeric: tabular-nums;
}
.evt-clear {
  background: transparent;
  color: var(--ainpc-muted);
  border: 1px solid var(--ainpc-border);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
}
.evt-clear:hover { color: #f85149; border-color: #f85149; }

.evt-list { list-style: none; margin: 0; padding: 0; }
.evt-card {
  border: 1px solid var(--ainpc-border);
  border-left: 3px solid var(--ainpc-border);
  border-radius: 8px;
  background: rgba(13, 17, 23, 0.7);
  padding: 10px 12px;
  margin-bottom: 10px;
}
.evt-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  margin-bottom: 6px;
  padding-bottom: 6px;
  border-bottom: 1px dashed rgba(139, 148, 158, 0.25);
  font-variant-numeric: tabular-nums;
  flex-wrap: wrap;
}
.evt-type-chip {
  color: #0d1117;
  font-weight: 700;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
}
.evt-actor { color: #f0f6fc; font-weight: 600; font-size: 12px; }
.evt-time { color: var(--ainpc-muted); }
.evt-id { color: var(--ainpc-muted); margin-left: auto; }

.evt-content {
  color: #c9d1d9;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
  margin-bottom: 8px;
}

.evt-meta-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.evt-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid transparent;
  font-weight: 500;
}
.evt-badge-all { color: #7ee787; border-color: rgba(126, 231, 135, 0.4); background: rgba(126, 231, 135, 0.08); }
.evt-badge-some { color: #a5d6ff; border-color: rgba(165, 214, 255, 0.4); background: rgba(165, 214, 255, 0.08); }
.evt-badge-none { color: var(--ainpc-muted); border-color: var(--ainpc-border); }
.evt-badge-consumed { color: #f59e0b; border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.08); }

.evt-detail-btn {
  margin-left: auto;
  background: transparent;
  color: var(--ainpc-muted);
  border: 1px solid var(--ainpc-border);
  border-radius: 4px;
  padding: 1px 8px;
  cursor: pointer;
  font-size: 11px;
}
.evt-detail-btn:hover { color: #f0f6fc; border-color: #58a6ff; }

.evt-detail {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed rgba(139, 148, 158, 0.25);
  font-size: 11px;
}
.evt-detail-block { margin-bottom: 6px; }
.evt-detail-block:last-child { margin-bottom: 0; }
.evt-detail-title { color: #f0f6fc; margin-right: 4px; }
.evt-npc-list { color: #a5d6ff; font-variant-numeric: tabular-nums; word-break: break-all; }
.evt-payload {
  margin: 4px 0 0;
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--ainpc-border);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #c9d1d9;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow: auto;
}
</style>
