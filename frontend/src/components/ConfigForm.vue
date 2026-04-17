<script setup lang="ts">
/**
 * AI 配置表单组件（新增/编辑）- 使用 Element Plus 组件
 */
import { ref, watch } from 'vue'
import { toast } from 'vue3-toastify'
import type { AiConfig, CreateConfigForm } from '../types/config'
import { getConfigById, createConfig, updateConfig } from '../api/config'
import { PROVIDER_MODELS } from '../constants/providers'

const props = defineProps<{
  id: number | null
}>()

const emit = defineEmits<{
  close: []
  success: []
}>()

const loading = ref(false)
const form = ref<CreateConfigForm>({
  name: '',
  provider: 'OpenAI',
  api_key: '',
  base_url: '',
  model: 'gpt-3.5-turbo',
  temperature: 0.7,
  max_tokens: 2000,
  is_default: 0,
  status: 1,
  remark: '',
})

const modelOptions = ref<string[]>([])

watch(
  () => form.value.provider,
  (p) => {
    modelOptions.value = PROVIDER_MODELS[p] ?? PROVIDER_MODELS['其他'] ?? ['custom']
    if (!modelOptions.value.includes(form.value.model)) {
      form.value.model = modelOptions.value[0] || 'gpt-3.5-turbo'
    }
  },
  { immediate: true }
)

async function loadDetail() {
  if (!props.id) return
  try {
    const { data } = await getConfigById(props.id)
    if (data.code === 0 && data.data) {
      const d = data.data as AiConfig
      form.value = {
        name: d.name,
        provider: d.provider,
        api_key: '',
        base_url: d.base_url || '',
        model: d.model,
        temperature: d.temperature,
        max_tokens: d.max_tokens,
        is_default: d.is_default,
        status: d.status,
        remark: d.remark || '',
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
    provider: 'OpenAI',
    api_key: '',
    base_url: '',
    model: 'gpt-3.5-turbo',
    temperature: 0.7,
    max_tokens: 2000,
    is_default: 0,
    status: 1,
    remark: '',
  }
}

async function submit() {
  if (!form.value.name.trim()) {
    toast.warning('请输入配置名称')
    return
  }
  if (!props.id && !form.value.api_key.trim()) {
    toast.warning('新增时请填写 API Key')
    return
  }

  loading.value = true
  try {
    const payload = { ...form.value }
    if (!payload.api_key) delete (payload as Record<string, unknown>).api_key

    if (props.id) {
      const { data } = await updateConfig(props.id, payload)
      if (data.code === 0) {
        emit('success')
      } else {
        toast.error(data.message || '更新失败')
      }
    } else {
      const { data } = await createConfig(payload as CreateConfigForm)
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
</script>

<template>
  <el-dialog :model-value="true" :title="id ? '编辑 AI 配置' : '新增 AI 配置'" class="config-form-dialog" width="560px"
    :close-on-click-modal="false" destroy-on-close align-center @close="close">
    <!-- 分组表单：降低长表单的认知负担 -->
    <el-form label-position="top" class="ainpc-form-sections" @submit.prevent="submit">
      <el-divider content-position="left">基础信息</el-divider>
      <el-form-item label="配置名称" required>
        <el-input v-model="form.name" placeholder="如：生产环境 GPT-4" clearable />
      </el-form-item>
      <el-form-item label="提供商">
        <el-select v-model="form.provider" class="w-full" placeholder="选择提供商">
          <el-option v-for="p in Object.keys(PROVIDER_MODELS)" :key="p" :label="p" :value="p" />
        </el-select>
      </el-form-item>

      <el-divider content-position="left">连接与密钥</el-divider>
      <el-form-item :label="id ? 'API Key（留空不修改）' : 'API Key *'">
        <el-input v-model="form.api_key" type="password" placeholder="sk-xxx..." show-password clearable
          autocomplete="new-password" class="font-mono-nums" />
      </el-form-item>
      <el-form-item label="Base URL">
        <el-input v-model="form.base_url" placeholder="可选，如 https://api.openai.com/v1" clearable
          class="font-mono-nums text-sm" />
      </el-form-item>

      <el-divider content-position="left">模型与参数</el-divider>
      <el-form-item label="模型">
        <el-select v-model="form.model" class="w-full" placeholder="选择模型">
          <el-option v-for="m in modelOptions" :key="m" :label="m" :value="m" />
        </el-select>
      </el-form-item>
      <el-row :gutter="16">
        <el-col :span="12">
          <el-form-item label="温度（0–2）">
            <el-input-number v-model="form.temperature" :min="0" :max="2" :step="0.1" :precision="1" class="w-full" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="最大 Token">
            <el-input-number v-model="form.max_tokens" :min="1" :max="128000" class="w-full" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-divider content-position="left">状态与其他</el-divider>
      <el-form-item label="状态">
        <el-select v-model="form.status" class="w-full">
          <el-option label="启用" :value="1" />
          <el-option label="禁用" :value="0" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-checkbox v-model="form.is_default" :true-value="1" :false-value="0">
          设为默认配置
        </el-checkbox>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="可选，如用途说明" />
      </el-form-item>
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
