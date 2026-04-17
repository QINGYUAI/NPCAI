<script setup lang="ts">
/**
 * 角色 NPC 表单组件（新增/编辑）
 */
import { ref, watch, onMounted, computed } from 'vue'
import { toast } from 'vue3-toastify'
import type { Npc, CreateNpcForm } from '../types/npc'
import { getNpcById, createNpc, updateNpc, generateNpcContent, uploadAvatar } from '../api/npc'
import { getConfigList } from '../api/config'
import type { AiConfig } from '../types/config'
import { NPC_CATEGORIES, NPC_PROMPT_TYPES, NPC_GENDERS } from '../constants/npc'
import { resolveAvatarUrl } from '../utils/avatar'

const props = defineProps<{
  id: number | null
}>()

const emit = defineEmits<{
  close: []
  success: []
}>()

const loading = ref(false)
const generateLoading = ref(false)
const avatarUploading = ref(false)
const generateHint = ref('')
const aiConfigList = ref<AiConfig[]>([])
const form = ref<CreateNpcForm>({
  name: '',
  description: '',
  background: '',
  personality: '',
  gender: '',
  age: '',
  occupation: '',
  voice_tone: '',
  avatar: '',
  ai_config_id: 0,
  system_prompt: '',
  category: 'custom',
  prompt_type: 'high',
  status: 1,
  sort: 0,
})

async function loadAiConfigs() {
  try {
    const { data } = await getConfigList({ status: 1 })
    if (data.code === 0 && data.data) {
      aiConfigList.value = data.data
      if (aiConfigList.value.length > 0 && !form.value.ai_config_id) {
        form.value.ai_config_id = aiConfigList.value[0]!.id
      }
    }
  } catch (e) {
    console.error(e)
  }
}

async function loadDetail() {
  if (!props.id) return
  try {
    const { data } = await getNpcById(props.id)
    if (data.code === 0 && data.data) {
      const d = data.data as Npc
      form.value = {
        name: d.name,
        description: d.description || '',
        background: d.background || '',
        personality: d.personality || '',
        gender: d.gender || '',
        age: d.age || '',
        occupation: d.occupation || '',
        voice_tone: d.voice_tone || '',
        avatar: d.avatar || '',
        ai_config_id: d.ai_config_id,
        system_prompt: d.system_prompt || '',
        category: d.category || 'custom',
        prompt_type: d.prompt_type || 'high',
        status: d.status,
        sort: d.sort,
      }
    }
  } catch (e) {
    console.error(e)
  }
}

watch(
  () => props.id,
  (id) => {
    if (id) loadDetail()
    else resetForm()
  },
  { immediate: true }
)

function resetForm() {
  form.value = {
    name: '',
    description: '',
    background: '',
    personality: '',
    gender: '',
    age: '',
    occupation: '',
    voice_tone: '',
    avatar: '',
    ai_config_id: aiConfigList.value[0]?.id ?? 0,
    system_prompt: '',
    category: 'custom',
    prompt_type: 'high',
    status: 1,
    sort: 0,
  }
  generateHint.value = ''
}

/** AI 自动生成角色内容（简介、背景、性格、系统提示词） */
async function handleAiGenerate() {
  const name = form.value.name.trim()
  const hint = generateHint.value.trim()
  if (!name && !hint) {
    toast.warning('请先输入角色名称或补充描述')
    return
  }
  if (!form.value.ai_config_id) {
    toast.warning('请先选择 AI 配置')
    return
  }
  generateLoading.value = true
  try {
    const { data } = await generateNpcContent({
      ai_config_id: form.value.ai_config_id,
      name: name || undefined,
      hint: hint || undefined,
    })
    if (data.code === 0 && data.data) {
      form.value.description = data.data.description
      form.value.background = data.data.background
      form.value.personality = data.data.personality
      form.value.gender = data.data.gender || ''
      form.value.age = data.data.age || ''
      form.value.occupation = data.data.occupation || ''
      form.value.voice_tone = data.data.voice_tone || ''
      form.value.system_prompt = data.data.system_prompt
      toast.success('AI 生成完成')
    } else {
      toast.error(data.message || '生成失败')
    }
  } catch (e: unknown) {
    const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
    toast.error(msg || '生成失败，请检查网络与 AI 配置')
  } finally {
    generateLoading.value = false
  }
}

async function submit() {
  if (!form.value.name.trim()) {
    toast.warning('请输入角色名称')
    return
  }
  if (!form.value.ai_config_id) {
    toast.warning('请选择 AI 配置')
    return
  }

  loading.value = true
  try {
    const payload = { ...form.value }

    if (props.id) {
      const { data } = await updateNpc(props.id, payload)
      if (data.code === 0) {
        emit('success')
      } else {
        toast.error(data.message || '更新失败')
      }
    } else {
      const { data } = await createNpc(payload as CreateNpcForm)
      if (data.code === 0) {
        emit('success')
      } else {
        toast.error(data.message || '创建失败')
      }
    }
  } catch (e) {
    toast.error('请求失败，请检查后端服务是否启动')
  } finally {
    loading.value = false
  }
}

function close() {
  resetForm()
  emit('close')
}

/** 头像展示 URL */
const avatarDisplayUrl = computed(() => resolveAvatarUrl(form.value.avatar))

async function handleAvatarUpload(file: File) {
  if (file.size > 2 * 1024 * 1024) {
    toast.error('图片不超过 2MB')
    return false
  }
  avatarUploading.value = true
  try {
    const url = await uploadAvatar(file)
    form.value.avatar = url
    toast.success('上传成功')
  } catch (e) {
    toast.error((e as Error).message || '上传失败')
  } finally {
    avatarUploading.value = false
  }
  return false
}

onMounted(loadAiConfigs)
</script>

<template>
  <el-dialog :model-value="true" :title="id ? '编辑角色' : '新增角色'" class="npc-form-dialog" width="640px"
    :close-on-click-modal="false" destroy-on-close align-center @close="close">
    <el-form label-position="top" class="ainpc-form-sections npc-form-body" @submit.prevent="submit">
      <el-divider content-position="left">基础信息</el-divider>
      <el-row :gutter="16">
        <el-col :span="12">
          <el-form-item label="角色名称" required>
            <el-input v-model="form.name" placeholder="如：小明" clearable />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="补充描述（选填）">
            <el-input v-model="generateHint" placeholder="如：古代书生、游戏村长" clearable />
          </el-form-item>
        </el-col>
      </el-row>
      <el-form-item label="角色简介">
        <el-input v-model="form.description" type="textarea" :rows="2" placeholder="简短概括，用于列表展示" />
      </el-form-item>

      <el-divider content-position="left">角色设定</el-divider>
      <el-form-item label="角色背景">
        <el-input v-model="form.background" type="textarea" :rows="4" placeholder="详细背景故事、出身、经历、与其它角色的关系等" />
      </el-form-item>
      <el-form-item label="角色性格">
        <el-input v-model="form.personality" placeholder="如：开朗/冷淡、谨慎/冲动、待人接物风格等" clearable />
      </el-form-item>
      <el-row :gutter="16">
        <el-col :span="12">
          <el-form-item label="性别">
            <el-select v-model="form.gender" class="w-full" placeholder="选填" clearable>
              <el-option v-for="g in NPC_GENDERS" :key="g.value" :label="g.label" :value="g.value" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="年龄">
            <el-input v-model="form.age" placeholder="如：25、青年、中年" clearable />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="16">
        <el-col :span="12">
          <el-form-item label="职业">
            <el-input v-model="form.occupation" placeholder="如：剑士、村长、商人" clearable />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="说话风格">
            <el-input v-model="form.voice_tone" placeholder="如：温和、爽朗、沉稳" clearable />
          </el-form-item>
        </el-col>
      </el-row>

      <el-divider content-position="left">头像</el-divider>
      <el-form-item label="头像">
        <div class="flex flex-wrap items-center gap-3">
          <el-upload :show-file-list="false" :disabled="avatarUploading"
            accept="image/jpeg,image/png,image/gif,image/webp" :before-upload="(raw: File) => handleAvatarUpload(raw)">
            <template #trigger>
              <el-button size="small" :loading="avatarUploading">本地上传</el-button>
            </template>
          </el-upload>
          <el-input v-model="form.avatar" placeholder="或粘贴图片 URL" clearable
            class="flex-1 min-w-0 font-mono-nums text-sm" />
        </div>
        <p class="text-xs text-[var(--ainpc-muted)] mt-1.5">
          支持 JPG、PNG、GIF、WebP，本地上传不超过 2MB
        </p>
        <div v-if="form.avatar" class="mt-3">
          <el-avatar :src="avatarDisplayUrl" :size="64" class="rounded border border-[var(--ainpc-border)]" />
        </div>
      </el-form-item>

      <el-divider content-position="left">AI 与提示词</el-divider>
      <el-form-item label="绑定 AI 配置" required>
        <el-select v-model="form.ai_config_id" class="w-full" placeholder="选择 AI 配置">
          <el-option v-for="c in aiConfigList" :key="c.id" :label="`${c.name} (${c.provider})`" :value="c.id" />
        </el-select>
        <p v-if="aiConfigList.length === 0" class="text-xs text-[#d29922] mt-1.5">
          请先在「AI 配置」中创建并启用配置
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <el-button type="primary" plain :loading="generateLoading" @click="handleAiGenerate">
            {{ generateLoading ? '生成中…' : 'AI 自动生成' }}
          </el-button>
          <span class="text-xs text-[var(--ainpc-muted)] leading-snug max-w-full">
            根据名称与补充描述生成简介、背景、性格与系统提示词
          </span>
        </div>
      </el-form-item>
      <el-form-item label="系统提示词">
        <el-input v-model="form.system_prompt" type="textarea" :rows="5"
          placeholder="角色人设、口吻、行为约束。可基于背景与性格自动组装，或完全自定义" />
      </el-form-item>

      <el-divider content-position="left">分类与发布</el-divider>
      <el-row :gutter="16">
        <el-col :span="12">
          <el-form-item label="分类">
            <el-select v-model="form.category" class="w-full">
              <el-option v-for="c in NPC_CATEGORIES" :key="c.value" :label="c.label" :value="c.value" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="约束类型">
            <el-select v-model="form.prompt_type" class="w-full">
              <el-option v-for="p in NPC_PROMPT_TYPES" :key="p.value" :label="p.label" :value="p.value" />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="16">
        <el-col :span="12">
          <el-form-item label="状态">
            <el-select v-model="form.status" class="w-full">
              <el-option label="启用" :value="1" />
              <el-option label="禁用" :value="0" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="排序">
            <el-input-number v-model="form.sort" :min="0" class="w-full" />
          </el-form-item>
        </el-col>
      </el-row>
    </el-form>
    <template #footer>
      <div class="flex justify-end gap-2">
        <el-button @click="close">取消</el-button>
        <el-button type="primary" :loading="loading" @click="submit">
          {{ loading ? '提交中…' : '保存' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 长表单：限制弹窗内滚动区域高度，避免小屏溢出 */
.npc-form-body {
  max-height: min(70vh, 560px);
  overflow-y: auto;
  padding-right: 4px;
}
</style>
