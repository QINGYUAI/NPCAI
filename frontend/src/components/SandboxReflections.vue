<script setup lang="ts">
/**
 * [M4.2.3.c] 反思抽屉：展示本 session 收到的 WS `reflection.created` 事件
 *
 * 数据契约
 * - entries：父组件 Sandbox.vue 维护的 ring buffer（按 received_at 从旧到新；渲染倒序）
 * - 切场景/组件卸载时父组件会清空
 *
 * 交互
 * - 按 (npc × tick) 分组，每组一张卡片，3 行 goal/emotion/relation（theme 固定顺序）
 * - 每张卡片可展开「本次参考的 #memory_id 列表」供调试溯源
 * - 右上角 ✕ 或点空白处关闭（走 el-drawer 标准行为）
 */
import { computed, ref } from 'vue'
import type { ReflectionRingEntry } from '../types/reflection'
import { REFLECTION_THEMES, THEME_LABELS } from '../types/reflection'

const props = defineProps<{
  entries: ReflectionRingEntry[]
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

/** 最新在上 */
const ordered = computed<ReflectionRingEntry[]>(() => [...props.entries].reverse())

/** 溯源展开状态：以 key 为 id */
const openedKeys = ref<Set<number>>(new Set())
function toggleSource(key: number) {
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

/** 找到给定主题对应的 item；theme 缺失时返回 '-' 占位 */
function contentOf(entry: ReflectionRingEntry, theme: string): string {
  const it = entry.items.find((i) => i.theme === theme)
  return it?.content ?? '—'
}
</script>

<template>
  <el-drawer v-model="drawerVisible" title="反思" direction="rtl" size="440px" :with-header="true" append-to-body>
    <template #header>
      <div class="flex items-center gap-3">
        <span class="refl-title">🧘 反思 <span class="refl-count">[{{ entries.length }}]</span></span>
        <button v-if="entries.length > 0" class="refl-clear" @click="emit('clear')">清空</button>
      </div>
    </template>
    <el-empty
      v-if="entries.length === 0"
      :image-size="60"
      description="暂无反思。引擎运行至 tick=5 的倍数时自动触发，或使用底部「手动反思」按钮。"
    />
    <ul v-else class="refl-list">
      <li v-for="entry in ordered" :key="entry.key" class="refl-card">
        <header class="refl-card-head">
          <span class="refl-npc">{{ entry.npc_name || `NPC#${entry.npc_id}` }}</span>
          <span class="refl-tick">t={{ entry.tick }}</span>
          <span class="refl-time">{{ fmtTime(entry.received_at) }}</span>
          <button class="refl-source-btn" @click="toggleSource(entry.key)">
            {{ openedKeys.has(entry.key) ? '收起溯源' : `溯源 #${entry.source_memory_ids.length}` }}
          </button>
        </header>
        <ul class="refl-items">
          <li v-for="theme in REFLECTION_THEMES" :key="`${entry.key}-${theme}`" class="refl-item">
            <span
              class="refl-theme"
              :style="{ color: THEME_LABELS[theme].color }"
            >{{ THEME_LABELS[theme].emoji }} {{ THEME_LABELS[theme].label }}</span>
            <span class="refl-content">{{ contentOf(entry, theme) }}</span>
          </li>
        </ul>
        <div v-if="openedKeys.has(entry.key)" class="refl-source">
          <span class="refl-source-title">参考 memory：</span>
          <span
            v-for="(mid, i) in entry.source_memory_ids"
            :key="mid"
            class="refl-source-chip"
          >#{{ mid }}{{ i < entry.source_memory_ids.length - 1 ? ' ·' : '' }}</span>
          <span class="refl-source-ids">（反思 id：{{ entry.reflection_ids.join('/') }}）</span>
        </div>
      </li>
    </ul>
  </el-drawer>
</template>

<style scoped>
.refl-title {
  font-weight: 600;
  color: #f0f6fc;
  font-size: 14px;
}
.refl-count {
  color: var(--ainpc-muted);
  font-weight: 400;
  margin-left: 4px;
  font-variant-numeric: tabular-nums;
}
.refl-clear {
  background: transparent;
  color: var(--ainpc-muted);
  border: 1px solid var(--ainpc-border);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
}
.refl-clear:hover { color: #f85149; border-color: #f85149; }

.refl-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.refl-card {
  border: 1px solid var(--ainpc-border);
  border-radius: 8px;
  background: rgba(13, 17, 23, 0.7);
  padding: 10px 12px;
  margin-bottom: 10px;
}
.refl-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px dashed rgba(139, 148, 158, 0.25);
  font-variant-numeric: tabular-nums;
}
.refl-npc {
  color: #f0f6fc;
  font-weight: 600;
}
.refl-tick { color: #79c0ff; }
.refl-time { color: var(--ainpc-muted); }
.refl-source-btn {
  margin-left: auto;
  background: transparent;
  color: var(--ainpc-muted);
  border: 1px solid var(--ainpc-border);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
}
.refl-source-btn:hover { color: #f0f6fc; border-color: #58a6ff; }

.refl-items {
  list-style: none;
  margin: 0;
  padding: 0;
}
.refl-item {
  display: flex;
  gap: 10px;
  padding: 4px 2px;
  font-size: 12px;
  line-height: 1.55;
  color: #d7dde3;
}
.refl-theme {
  flex-shrink: 0;
  font-weight: 600;
  min-width: 56px;
  font-size: 11px;
}
.refl-content {
  flex: 1;
  color: #c9d1d9;
  word-break: break-all;
  white-space: pre-wrap;
}
.refl-source {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(139, 148, 158, 0.25);
  font-size: 11px;
  color: var(--ainpc-muted);
  font-variant-numeric: tabular-nums;
  line-height: 1.6;
}
.refl-source-title { color: #f0f6fc; margin-right: 4px; }
.refl-source-chip {
  color: #a5d6ff;
  margin-right: 2px;
}
.refl-source-ids {
  display: inline-block;
  margin-left: 6px;
  color: #8b949e;
}
</style>
