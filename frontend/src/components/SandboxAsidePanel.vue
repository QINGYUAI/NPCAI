<script setup lang="ts">
/**
 * [M4.6.0·批次C] 沙盒右侧说明区：当前场景信息 + 关联 NPC 列表（坐标来自 detail，非画布实时拖拽）
 */
import type { Scene, SceneDetail } from '../types/scene'
import { NPC_CATEGORIES } from '../constants/npc'
import { categoryCss } from '../utils/sandbox'

defineProps<{
  activeScene: Scene | null
  detail: SceneDetail | null
}>()

function categoryLabel(v: string | null | undefined) {
  return NPC_CATEGORIES.find((c) => c.value === v)?.label || v || '—'
}
</script>

<template>
  <aside class="sandbox-aside flex-1 min-w-0">
    <h3 class="text-sm font-semibold text-[#f0f6fc] mb-2">
      {{ activeScene?.name || '—' }}
      <el-tag v-if="activeScene" size="small" type="info" class="ml-1">
        {{ categoryLabel(activeScene.category) }}
      </el-tag>
    </h3>
    <p v-if="activeScene?.description" class="text-xs text-[var(--ainpc-muted)] mb-3 leading-relaxed">
      {{ activeScene.description }}
    </p>
    <p v-if="activeScene?.background_image" class="text-xs text-[var(--ainpc-muted)] mb-3 truncate">
      底图：<span class="text-[#79c0ff]">{{ activeScene.background_image }}</span>
    </p>
    <p v-else class="text-xs text-[var(--ainpc-muted)] mb-3">
      未设置底图（使用网格），可在「场景」Tab 的表单里配置
    </p>

    <el-divider content-position="left">关联角色（{{ detail?.npcs.length ?? 0 }}）</el-divider>
    <el-empty
      v-if="!detail || detail.npcs.length === 0"
      :image-size="50"
      description="请先在「场景」Tab 为该场景添加角色"
    />
    <ul v-else class="space-y-1 text-xs max-h-[320px] overflow-auto pr-1">
      <li
        v-for="n in detail.npcs"
        :key="n.npc_id"
        class="flex items-center gap-2 py-1 border-b border-[var(--ainpc-border)] last:border-none"
      >
        <span class="sandbox-dot" :style="{ background: categoryCss(n.npc_category) }" />
        <span class="font-medium text-[#f0f6fc]">{{ n.npc_name }}</span>
        <span v-if="n.role_note" class="text-[var(--ainpc-muted)] truncate">（{{ n.role_note }}）</span>
        <span class="ml-auto text-[var(--ainpc-muted)] font-mono-nums">
          {{ n.pos_x != null ? Math.round(Number(n.pos_x)) : '—' }},
          {{ n.pos_y != null ? Math.round(Number(n.pos_y)) : '—' }}
        </span>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.sandbox-aside {
  border: 1px solid var(--ainpc-border);
  border-radius: 8px;
  padding: 1rem;
  background: rgba(13, 17, 23, 0.55);
}

.sandbox-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.font-mono-nums {
  font-variant-numeric: tabular-nums;
}
</style>
