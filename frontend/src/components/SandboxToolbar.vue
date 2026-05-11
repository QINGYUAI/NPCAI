<script setup lang="ts">
/**
 * [M4.6.0·批次C] 沙盒顶栏：场景 / 气泡与吸附 / 引擎 / 事件预设 / 画布缩放与布局保存
 *
 * 纯展示 + v-model 双向绑定与事件上抛；不含 API / WS 逻辑（留在 Sandbox.vue）。
 */
import type { MetaWarn, EngineStatus, WsConnectionState } from '../types/engine'
import type { Scene, SceneDetail } from '../types/scene'

defineProps<{
  scenes: Scene[]
  loading: boolean
  engineRunning: boolean
  engineStatus: EngineStatus | null
  engineLoading: boolean
  /** engineStatus.meta_warns 派生的最新一条（父组件 computed） */
  latestMetaWarn: MetaWarn | null
  wsState: WsConnectionState
  sessionTokens: number
  sessionCostUsd: number | null
  reflectionCount: number
  eventCount: number
  eventSubmitting: Set<string>
  detail: SceneDetail | null
  dirty: boolean
  saving: boolean
  zoomLevel: number
}>()

const activeSceneId = defineModel<number | null>('activeSceneId')
const bubbleEnabled = defineModel<boolean>('bubbleEnabled')
const bubbleIntervalMs = defineModel<number>('bubbleIntervalMs')
const snapEnabled = defineModel<boolean>('snapEnabled')
const snapStep = defineModel<number>('snapStep')
const engineDryRun = defineModel<boolean>('engineDryRun')
const engineInterval = defineModel<number>('engineInterval')

const emit = defineEmits<{
  loadScenes: []
  engineStart: []
  engineStep: []
  engineStop: [force: boolean]
  timelinePillClick: []
  reflectionPillClick: []
  eventPillClick: []
  eventPreset: [key: 'rain' | 'earthquake']
  eventCustomClick: []
  zoomIn: []
  zoomOut: []
  zoomFit: []
  autoArrange: []
  resetLayout: []
  saveLayout: []
}>()

function fmtSessionCost(v: number | null): string {
  if (v == null) return '$?'
  if (v === 0) return '$0.0000'
  if (v < 0.0001) return `$${v.toExponential(2)}`
  return `$${v.toFixed(4)}`
}
function fmtTokensShort(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
</script>

<template>
  <section class="flex flex-wrap items-center gap-3 mb-4">
    <div class="flex items-center gap-2">
      <span class="text-sm text-[var(--ainpc-muted)]">场景</span>
      <el-select
        v-model="activeSceneId"
        placeholder="选择场景"
        filterable
        class="w-60"
        :disabled="loading"
      >
        <el-option v-for="s in scenes" :key="s.id" :label="s.name" :value="s.id" />
      </el-select>
      <el-button :disabled="loading" @click="emit('loadScenes')">刷新场景</el-button>
    </div>
    <div class="flex items-center gap-2">
      <el-tooltip content="从 NPC.simulation_meta 读取 latest_say / latest_action 显示气泡" placement="top">
        <el-switch v-model="bubbleEnabled" active-text="状态气泡" inline-prompt />
      </el-tooltip>
      <el-select v-if="bubbleEnabled" v-model="bubbleIntervalMs" size="small" class="w-28">
        <el-option label="2 秒" :value="2000" />
        <el-option label="5 秒" :value="5000" />
        <el-option label="10 秒" :value="10000" />
        <el-option label="30 秒" :value="30000" />
      </el-select>
    </div>
    <div class="flex items-center gap-2">
      <el-tooltip content="开启后拖拽始终吸附到网格；关闭时按住 Shift 临时吸附" placement="top">
        <el-switch v-model="snapEnabled" active-text="网格吸附" inline-prompt />
      </el-tooltip>
      <el-select v-model="snapStep" size="small" class="w-24">
        <el-option label="10 px" :value="10" />
        <el-option label="20 px" :value="20" />
        <el-option label="40 px" :value="40" />
        <el-option label="80 px" :value="80" />
      </el-select>
    </div>
    <!-- M4.1 引擎控制条 -->
    <div class="flex items-center gap-2 px-2 py-1 rounded border border-[var(--ainpc-border)] bg-[rgba(13,17,23,0.45)]">
      <span class="text-xs text-[var(--ainpc-muted)]">引擎</span>
      <el-tag v-if="engineRunning" type="success" size="small" effect="dark">
        运行 #{{ engineStatus?.tick ?? 0 }}
      </el-tag>
      <el-tag v-else type="info" size="small">停止</el-tag>
      <el-tooltip content="dry_run：跳过 LLM 仅跑确定性伪输出，用于验证链路" placement="top">
        <el-switch v-model="engineDryRun" active-text="dry_run" inline-prompt :disabled="engineRunning" />
      </el-tooltip>
      <el-select v-model="engineInterval" size="small" class="w-24" :disabled="engineRunning">
        <el-option label="2 秒" :value="2000" />
        <el-option label="5 秒" :value="5000" />
        <el-option label="10 秒" :value="10000" />
        <el-option label="30 秒" :value="30000" />
        <el-option label="60 秒" :value="60000" />
      </el-select>
      <el-button-group>
        <el-tooltip content="启动 tick 循环" placement="top">
          <el-button
            size="small"
            type="primary"
            :disabled="!activeSceneId || engineRunning"
            :loading="engineLoading && !engineRunning"
            @click="emit('engineStart')"
          >▶</el-button>
        </el-tooltip>
        <el-tooltip content="执行单次 tick（未启动时临时跑一次）" placement="top">
          <el-button size="small" :disabled="!activeSceneId || engineLoading" @click="emit('engineStep')">⏭</el-button>
        </el-tooltip>
        <el-tooltip content="软停（等当前 tick 完）" placement="top">
          <el-button
            size="small"
            :disabled="!engineRunning"
            :loading="engineLoading && engineRunning"
            @click="emit('engineStop', false)"
          >⏸</el-button>
        </el-tooltip>
      </el-button-group>
      <el-tooltip
        v-if="latestMetaWarn"
        placement="bottom"
        :content="`NPC#${latestMetaWarn.npc_id} tick#${latestMetaWarn.tick} simulation_meta=${(latestMetaWarn.bytes / 1024).toFixed(1)}KB 超软阈值 ${(latestMetaWarn.soft_limit / 1024).toFixed(0)}KB，建议精简`"
      >
        <el-tag type="warning" size="small" effect="dark" class="meta-warn-pill">
          ⚠ meta {{ (latestMetaWarn.bytes / 1024).toFixed(1) }}KB
        </el-tag>
      </el-tooltip>
      <el-tooltip
        v-if="engineRunning && engineStatus?.ws_endpoint"
        placement="bottom"
        :content="wsState === 'open' ? 'WebSocket 实时推送中' :
          wsState === 'connecting' ? '正在连接 WebSocket…' :
          wsState === 'degraded' ? 'WebSocket 连续失败，已降级为 3s 轮询' :
          'WebSocket 已断开，重连中…'"
      >
        <el-tag
          size="small"
          :type="wsState === 'open' ? 'success' : wsState === 'degraded' ? 'warning' : 'info'"
          effect="plain"
        >
          {{ wsState === 'open' ? '● WS' : wsState === 'degraded' ? '○ 轮询' : '◐ WS…' }}
        </el-tag>
      </el-tooltip>
      <el-tooltip
        v-if="engineStatus?.memory_degraded"
        placement="bottom"
        content="记忆子系统降级：近 5 分钟内 Qdrant 不可用或 embedding 失败，NPC 仍可对话但回忆降级为 MySQL importance 排序"
      >
        <el-tag type="warning" size="small" effect="dark" class="memory-warn-pill">
          🧠 记忆降级
        </el-tag>
      </el-tooltip>
      <el-tooltip placement="bottom" content="本会话累计 tokens / cost（切场景或刷新归零）；点击展开时间线">
        <el-tag size="small" type="success" effect="plain" class="session-sum-pill" @click="emit('timelinePillClick')">
          Σ {{ fmtSessionCost(sessionCostUsd) }} · {{ fmtTokensShort(sessionTokens) }}tok
        </el-tag>
      </el-tooltip>
      <el-tooltip
        placement="bottom"
        content="本会话反思条数（每次触发 3 条主题，同组合并为 1）。tick 为 REFLECT_EVERY_N_TICK 倍数时自动触发；也可在右键菜单手动触发"
      >
        <el-tag size="small" type="warning" effect="plain" class="reflection-pill" @click="emit('reflectionPillClick')">
          🧘 {{ reflectionCount }}
        </el-tag>
      </el-tooltip>
      <el-tooltip
        placement="bottom"
        content="本会话收到的场景事件条数（含首屏补发）。事件会被引擎下一 tick 相应 NPC 的 plan prompt 消费"
      >
        <el-tag size="small" type="info" effect="plain" class="event-pill" @click="emit('eventPillClick')">
          📢 {{ eventCount }}
        </el-tag>
      </el-tooltip>
    </div>
    <div class="flex items-center gap-2 px-2 py-1 rounded border border-[var(--ainpc-border)] bg-[rgba(13,17,23,0.45)]">
      <span class="text-xs text-[var(--ainpc-muted)]">事件</span>
      <el-tooltip content="注入「下雨」天气事件（全场景可见）" placement="top">
        <el-button
          size="small"
          :disabled="!activeSceneId"
          :loading="eventSubmitting.has('rain')"
          @click="emit('eventPreset', 'rain')"
        >🌧️ 下雨</el-button>
      </el-tooltip>
      <el-tooltip content="注入「地震」剧情事件（全场景可见）" placement="top">
        <el-button
          size="small"
          :disabled="!activeSceneId"
          :loading="eventSubmitting.has('earthquake')"
          @click="emit('eventPreset', 'earthquake')"
        >🌋 地震</el-button>
      </el-tooltip>
      <el-tooltip content="打开自定义事件对话框（可选 4 类型、可定向投递）" placement="top">
        <el-button size="small" type="primary" :disabled="!activeSceneId" @click="emit('eventCustomClick')">
          💬 自定义事件
        </el-button>
      </el-tooltip>
    </div>
    <div class="flex-1" />
    <div class="flex items-center gap-2">
      <el-button-group>
        <el-tooltip content="缩小" placement="top">
          <el-button :disabled="!detail || loading" @click="emit('zoomOut')">−</el-button>
        </el-tooltip>
        <el-tooltip content="适配" placement="top">
          <el-button :disabled="!detail || loading" @click="emit('zoomFit')">
            {{ Math.round(zoomLevel * 100) }}%
          </el-button>
        </el-tooltip>
        <el-tooltip content="放大" placement="top">
          <el-button :disabled="!detail || loading" @click="emit('zoomIn')">+</el-button>
        </el-tooltip>
      </el-button-group>
      <el-tag v-if="dirty" type="warning" size="small">未保存</el-tag>
      <el-button :disabled="!detail || loading" @click="emit('autoArrange')">网格排布</el-button>
      <el-button :disabled="!detail || !dirty || loading" @click="emit('resetLayout')">撤销</el-button>
      <el-button type="primary" :loading="saving" :disabled="!detail || !dirty" @click="emit('saveLayout')">
        保存布局
      </el-button>
    </div>
  </section>
</template>

<style scoped>
.meta-warn-pill {
  margin-left: 2px;
  animation: meta-warn-flash 1.6s ease-in-out 0s 2 alternate;
}
.memory-warn-pill {
  margin-left: 2px;
  animation: meta-warn-flash 2.4s ease-in-out infinite alternate;
}
.session-sum-pill {
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.session-sum-pill:hover {
  filter: brightness(1.15);
}
.reflection-pill {
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  user-select: none;
  margin-left: 2px;
}
.reflection-pill:hover {
  filter: brightness(1.15);
}
.event-pill {
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  user-select: none;
  margin-left: 2px;
}
.event-pill:hover {
  filter: brightness(1.15);
}
@keyframes meta-warn-flash {
  from {
    opacity: 0.6;
  }
  to {
    opacity: 1;
  }
}
</style>
