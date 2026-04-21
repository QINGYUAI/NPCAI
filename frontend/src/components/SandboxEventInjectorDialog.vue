<script setup lang="ts">
/**
 * [M4.2.4.c] 场景事件注入对话框（💬 自定义事件）
 *
 * 数据契约
 * - 父组件 Sandbox.vue 通过 v-model:visible 控制显隐
 * - npcOptions：下拉多选源（来自 detail.npcs）；空=禁用定向投递开关
 * - 点「发送」→ emit('submit', body) 给父组件真正调用 POST；成功 / 失败由父组件 toast
 *
 * 表单约束（与后端 createSceneEventSchema 严格对齐）
 *   type          : 4 枚举必填
 *   content       : 1~500 字
 *   actor         : 0~64 字；空 → null（后端会 trim）
 *   visible_npcs  : undefined = 全场景可见；数组 = 定向（最多 100）
 *   payload       : JSON 文本（顶层 object 或空）；<=2KB 序列化后
 */
import { computed, ref, watch } from 'vue'
import { EVENT_TYPES, EVENT_TYPE_LABELS } from '../types/event'
import type { CreateSceneEventBody, EventType } from '../types/event'

const props = defineProps<{
  visible: boolean
  sceneId: number | null
  /** 场景已关联的 NPC 列表（供 visible_npcs 多选） */
  npcOptions: Array<{ npc_id: number; npc_name?: string }>
  /** 父组件可以传递一个「预设 body」直接打开填好的表单（2 个快捷按钮复用此组件时可以用）；当前版本未启用 */
  initial?: Partial<CreateSceneEventBody>
}>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'submit', body: CreateSceneEventBody): void
}>()

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
})

/** 表单状态 */
const formType = ref<EventType>('system')
const formContent = ref('')
const formActor = ref('')
const formPayload = ref('')
const targetAll = ref(true)
const formVisibleNpcs = ref<number[]>([])
const submitting = ref(false)

/** 前端轻校验 errors 的 key 映射 */
const contentErr = computed(() => {
  const s = formContent.value.trim()
  if (s.length === 0) return '必填'
  if (s.length > 500) return `最多 500 字（当前 ${s.length}）`
  return ''
})
const actorErr = computed(() => {
  if (formActor.value.length > 64) return `最多 64 字（当前 ${formActor.value.length}）`
  return ''
})
const payloadErr = computed(() => {
  const raw = formPayload.value.trim()
  if (raw.length === 0) return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'payload 必须是 JSON 对象（顶层 {...}）'
    }
    const bytes = new Blob([raw]).size
    if (bytes > 2048) return `payload 序列化后 ${bytes} 字节，超过 2KB 上限`
    return ''
  } catch {
    return 'JSON 解析失败'
  }
})
const visibleErr = computed(() => {
  if (targetAll.value) return ''
  if (formVisibleNpcs.value.length === 0) return '定向投递需至少选择 1 个 NPC'
  if (formVisibleNpcs.value.length > 100) return '最多选择 100 个 NPC'
  return ''
})
const canSubmit = computed(
  () =>
    !submitting.value &&
    props.sceneId != null &&
    !contentErr.value &&
    !actorErr.value &&
    !payloadErr.value &&
    !visibleErr.value,
)

/** 每次打开重置表单（或应用父组件的 initial） */
watch(
  () => props.visible,
  (v) => {
    if (v) {
      const i = props.initial || {}
      formType.value = (i.type as EventType) || 'system'
      formContent.value = i.content || ''
      formActor.value = i.actor ?? ''
      formPayload.value = i.payload ? JSON.stringify(i.payload, null, 2) : ''
      targetAll.value = i.visible_npcs == null
      formVisibleNpcs.value = Array.isArray(i.visible_npcs) ? [...i.visible_npcs] : []
      submitting.value = false
    }
  },
)

function close() {
  dialogVisible.value = false
}

function onSubmit() {
  if (!canSubmit.value) return
  submitting.value = true
  const actorTrim = formActor.value.trim()
  let payloadObj: Record<string, unknown> | null = null
  const payloadRaw = formPayload.value.trim()
  if (payloadRaw.length > 0) {
    try {
      payloadObj = JSON.parse(payloadRaw) as Record<string, unknown>
    } catch {
      submitting.value = false
      return
    }
  }
  const body: CreateSceneEventBody = {
    type: formType.value,
    content: formContent.value.trim(),
    actor: actorTrim ? actorTrim : null,
    payload: payloadObj,
    visible_npcs: targetAll.value ? null : [...formVisibleNpcs.value],
  }
  emit('submit', body)
  /** 父组件 POST 成功/失败后会关闭 visible；submitting 随 watch 重置 */
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    title="注入场景事件"
    width="520px"
    :close-on-click-modal="false"
    append-to-body
    destroy-on-close
  >
    <div class="evt-form">
      <div class="evt-row">
        <label class="evt-label">类型</label>
        <el-select v-model="formType" class="w-full" size="default">
          <el-option
            v-for="t in EVENT_TYPES"
            :key="t"
            :value="t"
            :label="`${EVENT_TYPE_LABELS[t].emoji} ${EVENT_TYPE_LABELS[t].label}（${t}）`"
          />
        </el-select>
      </div>

      <div class="evt-row">
        <label class="evt-label">内容 <span class="evt-req">*</span></label>
        <el-input
          v-model="formContent"
          type="textarea"
          :rows="3"
          maxlength="500"
          show-word-limit
          placeholder="例如：远处传来急促的钟声，似乎有意外发生。"
        />
        <p v-if="contentErr" class="evt-err">{{ contentErr }}</p>
      </div>

      <div class="evt-row">
        <label class="evt-label">发起者 actor</label>
        <el-input
          v-model="formActor"
          maxlength="64"
          placeholder="可选；留空等同于 system"
        />
        <p v-if="actorErr" class="evt-err">{{ actorErr }}</p>
      </div>

      <div class="evt-row">
        <label class="evt-label">可见范围</label>
        <div class="evt-inline">
          <el-switch v-model="targetAll" active-text="全场景可见" inactive-text="定向投递" inline-prompt />
          <el-select
            v-if="!targetAll"
            v-model="formVisibleNpcs"
            multiple
            collapse-tags
            collapse-tags-tooltip
            placeholder="选择可见 NPC（最多 100）"
            :disabled="npcOptions.length === 0"
            class="flex-1"
          >
            <el-option
              v-for="n in npcOptions"
              :key="n.npc_id"
              :value="n.npc_id"
              :label="`${n.npc_name || `NPC#${n.npc_id}`} (#${n.npc_id})`"
            />
          </el-select>
        </div>
        <p v-if="visibleErr" class="evt-err">{{ visibleErr }}</p>
      </div>

      <div class="evt-row">
        <label class="evt-label">附加 payload（JSON 对象，可选）</label>
        <el-input
          v-model="formPayload"
          type="textarea"
          :rows="4"
          placeholder='{"weather":"rain","intensity":"heavy"}'
          class="evt-code"
        />
        <p v-if="payloadErr" class="evt-err">{{ payloadErr }}</p>
        <p v-else class="evt-hint">
          仅顶层对象；序列化后必须 ≤ 2KB。可用于携带结构化字段（天气状态 / 剧情标签等）
        </p>
      </div>
    </div>

    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" :loading="submitting" @click="onSubmit">
        发送
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.evt-form { display: flex; flex-direction: column; gap: 14px; }
.evt-row { display: flex; flex-direction: column; gap: 4px; }
.evt-label { font-size: 12px; color: var(--ainpc-muted); font-weight: 500; }
.evt-req { color: #f85149; margin-left: 2px; }
.evt-inline { display: flex; align-items: center; gap: 10px; }
.evt-err { font-size: 11px; color: #f85149; margin: 2px 0 0; line-height: 1.5; }
.evt-hint { font-size: 11px; color: var(--ainpc-muted); margin: 2px 0 0; line-height: 1.5; }
.evt-code :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
</style>
