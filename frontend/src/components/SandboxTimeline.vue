<script setup lang="ts">
/**
 * [M4.2.1.c] tick 时间线浮窗（P1 右侧独立列）
 * - 数据来源：父组件 Sandbox.vue 订阅 WS 事件后聚合的 `TimelineTickRow[]`（最多 20 条）
 * - 每行可点击展开，显示该 tick 内每个 NPC 的耗时 / prompt→completion / latest_say
 * - 浏览器宽度 < 1280px 时，父组件会把 `mode` 传为 'drawer'，改为抽屉呈现
 */
import { computed, ref } from 'vue'
import type { TimelineTickRow } from '../types/timeline'

const props = defineProps<{
  entries: TimelineTickRow[]
  /** 会话累计（含未显示在 ring buffer 中的早期 tick） */
  totalTokens: number
  totalCost: number | null
  /** 'panel' = 右侧浮窗；'drawer' = 小屏抽屉，由父组件按视口宽度切换 */
  mode?: 'panel' | 'drawer'
  /** drawer 模式下的抽屉可见性（v-model:visible） */
  visible?: boolean
  /** panel 模式下的折叠状态（v-model:collapsed），默认展开 */
  collapsed?: boolean
}>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'update:collapsed', v: boolean): void
}>()

const panelCollapsed = computed({
  get: () => props.collapsed ?? false,
  set: (v) => emit('update:collapsed', v),
})

const isDrawer = computed(() => props.mode === 'drawer')
const drawerVisible = computed({
  get: () => props.visible ?? false,
  set: (v) => emit('update:visible', v),
})

/** 展开状态：以 tick 号为 key；默认最新一条展开 */
const openedTicks = ref<Set<number>>(new Set())
function toggleRow(tick: number) {
  const next = new Set(openedTicks.value)
  if (next.has(tick)) next.delete(tick)
  else next.add(tick)
  openedTicks.value = next
}

/** 展示：cost → $0.000123 / 未知价 → "$?"；tokens → 1234 / 1.2k */
function fmtCost(v: number | null | undefined): string {
  if (v == null) return '$?'
  if (v < 0.0001) return `$${v.toExponential(2)}`
  return `$${v.toFixed(4)}`
}
function fmtTokens(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
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
function statusIcon(s: 'success' | 'error' | 'skipped'): string {
  return s === 'success' ? '✓' : s === 'skipped' ? '⧗' : '✕'
}
function statusColor(s: 'success' | 'error' | 'skipped'): string {
  return s === 'success' ? '#3fb950' : s === 'skipped' ? '#d29922' : '#f85149'
}

/** 按最新在上排列（父组件 push 到末尾，这里倒序渲染） */
const ordered = computed<TimelineTickRow[]>(() => [...props.entries].reverse())
</script>

<template>
  <!-- ================= Panel 模式（≥1280px） ================= -->
  <aside v-if="!isDrawer" class="timeline-panel" :class="{ collapsed: panelCollapsed }">
    <header class="timeline-head">
      <span class="timeline-title">
        时间线
        <span class="timeline-count">[{{ entries.length }}/20]</span>
      </span>
      <span class="timeline-sum">
        Σ {{ fmtCost(totalCost) }} · {{ fmtTokens(totalTokens) }}tok
      </span>
      <button class="timeline-toggle" @click="panelCollapsed = !panelCollapsed">
        {{ panelCollapsed ? '展开' : '收起' }}
      </button>
    </header>
    <div v-show="!panelCollapsed" class="timeline-body">
      <el-empty v-if="entries.length === 0" :image-size="60" description="尚无 tick；启动引擎后实时显示" />
      <ul v-else class="timeline-list">
        <li v-for="row in ordered" :key="row.tick" class="timeline-row">
          <button class="timeline-row-head" @click="toggleRow(row.tick)">
            <span class="tick-no">t={{ row.tick }}</span>
            <span class="tick-time">{{ fmtTime(row.ended_at || row.started_at) }}</span>
            <span class="tick-cost">Σ {{ fmtCost(row.cost_usd) }}</span>
            <span class="tick-tok">· {{ fmtTokens(row.tokens_total) }}tok</span>
            <span v-if="row.duration_ms != null" class="tick-dur">· {{ row.duration_ms }}ms</span>
            <span class="tick-arrow">{{ openedTicks.has(row.tick) ? '▾' : '▸' }}</span>
          </button>
          <ul v-show="openedTicks.has(row.tick)" class="timeline-npcs">
            <li v-for="(n, i) in row.npcs" :key="`${row.tick}-${n.npc_id}-${i}`" class="npc-row">
              <span class="npc-status" :style="{ color: statusColor(n.status) }">{{ statusIcon(n.status) }}</span>
              <span class="npc-name">{{ n.npc_name || `NPC#${n.npc_id}` }}</span>
              <span v-if="n.duration_ms != null" class="npc-dur">{{ n.duration_ms }}ms</span>
              <span v-if="n.prompt_tokens != null || n.completion_tokens != null" class="npc-tokens">
                {{ n.prompt_tokens ?? '?' }}→{{ n.completion_tokens ?? '?' }}
              </span>
              <span v-if="n.cost_usd != null" class="npc-cost">{{ fmtCost(n.cost_usd) }}</span>
              <div v-if="n.latest_say" class="npc-say">“{{ n.latest_say }}”</div>
              <div v-else-if="n.latest_action" class="npc-say">[动作] {{ n.latest_action }}</div>
              <div v-else-if="n.note" class="npc-note">{{ n.note }}</div>
            </li>
          </ul>
        </li>
      </ul>
    </div>
  </aside>

  <!-- ================= Drawer 模式（<1280px） ================= -->
  <el-drawer v-else v-model="drawerVisible" title="tick 时间线" direction="rtl" size="380px"
    :with-header="true" append-to-body>
    <template #header>
      <div class="flex items-center gap-3">
        <span class="timeline-title">时间线 <span class="timeline-count">[{{ entries.length }}/20]</span></span>
        <span class="timeline-sum">Σ {{ fmtCost(totalCost) }} · {{ fmtTokens(totalTokens) }}tok</span>
      </div>
    </template>
    <el-empty v-if="entries.length === 0" :image-size="60" description="尚无 tick；启动引擎后实时显示" />
    <ul v-else class="timeline-list">
      <li v-for="row in ordered" :key="row.tick" class="timeline-row">
        <button class="timeline-row-head" @click="toggleRow(row.tick)">
          <span class="tick-no">t={{ row.tick }}</span>
          <span class="tick-time">{{ fmtTime(row.ended_at || row.started_at) }}</span>
          <span class="tick-cost">Σ {{ fmtCost(row.cost_usd) }}</span>
          <span class="tick-tok">· {{ fmtTokens(row.tokens_total) }}tok</span>
          <span v-if="row.duration_ms != null" class="tick-dur">· {{ row.duration_ms }}ms</span>
          <span class="tick-arrow">{{ openedTicks.has(row.tick) ? '▾' : '▸' }}</span>
        </button>
        <ul v-show="openedTicks.has(row.tick)" class="timeline-npcs">
          <li v-for="(n, i) in row.npcs" :key="`${row.tick}-${n.npc_id}-${i}`" class="npc-row">
            <span class="npc-status" :style="{ color: statusColor(n.status) }">{{ statusIcon(n.status) }}</span>
            <span class="npc-name">{{ n.npc_name || `NPC#${n.npc_id}` }}</span>
            <span v-if="n.duration_ms != null" class="npc-dur">{{ n.duration_ms }}ms</span>
            <span v-if="n.prompt_tokens != null || n.completion_tokens != null" class="npc-tokens">
              {{ n.prompt_tokens ?? '?' }}→{{ n.completion_tokens ?? '?' }}
            </span>
            <span v-if="n.cost_usd != null" class="npc-cost">{{ fmtCost(n.cost_usd) }}</span>
            <div v-if="n.latest_say" class="npc-say">“{{ n.latest_say }}”</div>
            <div v-else-if="n.latest_action" class="npc-say">[动作] {{ n.latest_action }}</div>
            <div v-else-if="n.note" class="npc-note">{{ n.note }}</div>
          </li>
        </ul>
      </li>
    </ul>
  </el-drawer>
</template>

<style scoped>
.timeline-panel {
  position: sticky;
  top: 16px;
  width: 360px;
  max-height: calc(100vh - 120px);
  border: 1px solid var(--ainpc-border);
  border-radius: 8px;
  background: rgba(13, 17, 23, 0.7);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}
.timeline-panel.collapsed .timeline-body { display: none; }

.timeline-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ainpc-border);
  background: rgba(22, 27, 34, 0.8);
  font-size: 12px;
}
.timeline-title { font-weight: 600; color: #f0f6fc; }
.timeline-count { color: var(--ainpc-muted); font-weight: 400; margin-left: 4px; }
.timeline-sum {
  margin-left: auto;
  color: #7ee787;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}
.timeline-toggle {
  background: transparent;
  color: var(--ainpc-muted);
  border: 1px solid var(--ainpc-border);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
}
.timeline-toggle:hover { color: #f0f6fc; border-color: #58a6ff; }

.timeline-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 4px;
}

.timeline-list { list-style: none; margin: 0; padding: 0; }
.timeline-row {
  border-bottom: 1px dashed rgba(139, 148, 158, 0.2);
  padding: 4px 8px;
}
.timeline-row-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  width: 100%;
  background: transparent;
  border: none;
  color: #f0f6fc;
  text-align: left;
  cursor: pointer;
  padding: 4px 2px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.timeline-row-head:hover { background: rgba(88, 166, 255, 0.08); }
.tick-no { color: #79c0ff; font-weight: 600; min-width: 42px; }
.tick-time { color: var(--ainpc-muted); }
.tick-cost { color: #7ee787; }
.tick-tok { color: var(--ainpc-muted); }
.tick-dur { color: var(--ainpc-muted); }
.tick-arrow { margin-left: auto; color: var(--ainpc-muted); }

.timeline-npcs { list-style: none; margin: 4px 0 6px 14px; padding: 0; }
.npc-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  font-size: 11px;
  color: #d7dde3;
  font-variant-numeric: tabular-nums;
}
.npc-status { font-weight: 700; min-width: 14px; display: inline-block; }
.npc-name { color: #f0f6fc; font-weight: 500; }
.npc-dur, .npc-tokens, .npc-cost { color: var(--ainpc-muted); }
.npc-say {
  flex-basis: 100%;
  margin-left: 20px;
  color: #c9d1d9;
  font-style: italic;
  padding: 2px 0;
  line-height: 1.4;
  word-break: break-all;
}
.npc-note {
  flex-basis: 100%;
  margin-left: 20px;
  color: #d29922;
  padding: 2px 0;
  font-size: 11px;
}
</style>
