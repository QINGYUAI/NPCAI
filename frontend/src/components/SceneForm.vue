<script setup lang="ts">
/**
 * 场景表单：元数据 + 覆盖式 NPC 关联
 */
import { ref, watch, onMounted } from 'vue'
import { toast } from 'vue3-toastify'
import type { Npc } from '../types/npc'
import { getNpcList } from '../api/npc'
import {
  createScene,
  updateScene,
  getSceneById,
  replaceSceneNpcs,
} from '../api/scene'
import { NPC_CATEGORIES } from '../constants/npc'
import { uploadImage } from '../api/upload'

const props = defineProps<{
  id: number | null
}>()

const emit = defineEmits<{
  close: []
  success: []
}>()

const loading = ref(false)
const bgUploading = ref(false)
const npcOptions = ref<Npc[]>([])

const name = ref('')
const description = ref('')
const category = ref('custom')
const tagList = ref<string[]>([])
const backgroundImage = ref('')
const width = ref(800)
const height = ref(600)
const status = ref(1)
const sort = ref(0)

/** 关联行：npc_id 为 0 表示未选择 */
const rows = ref<Array<{ npc_id: number; role_note: string }>>([])

/** 底图上传：走通用 /api/upload/image（8MB 上限） */
async function handleBackgroundUpload(file: File) {
  if (file.size > 8 * 1024 * 1024) {
    toast.error('图片不超过 8MB')
    return false
  }
  bgUploading.value = true
  try {
    const url = await uploadImage(file)
    backgroundImage.value = url
    toast.success('上传成功')
  } catch (e) {
    toast.error((e as Error).message || '上传失败')
  } finally {
    bgUploading.value = false
  }
  return false
}

async function loadNpcs() {
  try {
    const { data } = await getNpcList({ status: 1 })
    if (data.code === 0 && data.data) {
      npcOptions.value = data.data
    }
  } catch (e) {
    console.error(e)
  }
}

async function loadDetail() {
  if (!props.id) return
  try {
    const { data } = await getSceneById(props.id)
    if (data.code === 0 && data.data) {
      const d = data.data
      name.value = d.name
      description.value = d.description || ''
      category.value = d.category || 'custom'
      backgroundImage.value = d.background_image || ''
      width.value = typeof d.width === 'number' ? d.width : 800
      height.value = typeof d.height === 'number' ? d.height : 600
      status.value = d.status
      sort.value = d.sort
      if (Array.isArray(d.tags)) {
        tagList.value = d.tags.map((x) => String(x))
      } else if (d.tags != null) {
        tagList.value = []
      } else {
        tagList.value = []
      }
      rows.value =
        d.npcs?.map((n) => ({
          npc_id: n.npc_id,
          role_note: n.role_note || '',
        })) ?? []
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
  { immediate: true },
)

function resetForm() {
  name.value = ''
  description.value = ''
  category.value = 'custom'
  tagList.value = []
  backgroundImage.value = ''
  width.value = 800
  height.value = 600
  status.value = 1
  sort.value = 0
  rows.value = []
}

function addRow() {
  rows.value.push({ npc_id: 0, role_note: '' })
}

function removeRow(i: number) {
  rows.value.splice(i, 1)
}

async function submit() {
  const n = name.value.trim()
  if (!n) {
    toast.warning('请输入场景名称')
    return
  }
  const links = rows.value
    .filter((r) => r.npc_id > 0)
    .map((r) => ({
      npc_id: r.npc_id,
      role_note: r.role_note.trim() || null,
    }))

  const dup = new Set<number>()
  for (const l of links) {
    if (dup.has(l.npc_id)) {
      toast.warning('同一角色不能重复添加')
      return
    }
    dup.add(l.npc_id)
  }

  loading.value = true
  try {
    const payload = {
      name: n,
      description: description.value.trim() || undefined,
      category: category.value,
      tags: tagList.value.length ? tagList.value : undefined,
      background_image: backgroundImage.value.trim() || null,
      width: width.value,
      height: height.value,
      status: status.value,
      sort: sort.value,
    }

    if (props.id) {
      const { data: u } = await updateScene(props.id, payload)
      if (u.code !== 0) {
        toast.error(u.message || '更新失败')
        return
      }
      const { data: p } = await replaceSceneNpcs(props.id, links)
      if (p.code !== 0) {
        toast.error(p.message || '关联保存失败')
        return
      }
      emit('success')
    } else {
      const { data: c } = await createScene(payload)
      if (c.code !== 0 || !c.data?.id) {
        toast.error(c.message || '创建失败')
        return
      }
      const newId = c.data.id
      const { data: p } = await replaceSceneNpcs(newId, links)
      if (p.code !== 0) {
        toast.error(p.message || '关联保存失败')
        return
      }
      emit('success')
    }
  } catch (e) {
    console.error(e)
    toast.error('请求失败，请检查后端与数据库迁移')
  } finally {
    loading.value = false
  }
}

function close() {
  resetForm()
  emit('close')
}

onMounted(loadNpcs)
</script>

<template>
  <el-dialog :model-value="true" :title="id ? '编辑场景' : '新增场景'" class="scene-form-dialog" width="720px"
    :close-on-click-modal="false" destroy-on-close align-center @close="close">
    <el-form label-position="top" class="scene-form-body" @submit.prevent="submit">
      <el-divider content-position="left">基础信息</el-divider>
      <el-row :gutter="16">
        <el-col :span="14">
          <el-form-item label="场景名称" required>
            <el-input v-model="name" placeholder="如：中央广场、咖啡馆夜话" clearable />
          </el-form-item>
        </el-col>
        <el-col :span="10">
          <el-form-item label="分类">
            <el-select v-model="category" class="w-full">
              <el-option v-for="c in NPC_CATEGORIES" :key="c.value" :label="c.label" :value="c.value" />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>
      <el-form-item label="简介">
        <el-input v-model="description" type="textarea" :rows="3" placeholder="地点、活动或剧情提要" />
      </el-form-item>
      <el-form-item label="标签（JSON 数组，可输入后回车添加）">
        <el-select v-model="tagList" multiple filterable allow-create default-first-option class="w-full"
          placeholder="输入标签后回车" />
      </el-form-item>
      <el-form-item label="沙盒底图（可选，用于 2D 可视化）">
        <div class="flex flex-wrap items-center gap-3">
          <el-upload :show-file-list="false" :disabled="bgUploading"
            accept="image/jpeg,image/png,image/gif,image/webp"
            :before-upload="(raw: File) => handleBackgroundUpload(raw)">
            <template #trigger>
              <el-button size="small" :loading="bgUploading">本地上传</el-button>
            </template>
          </el-upload>
          <el-input v-model="backgroundImage" placeholder="或粘贴图片 URL" clearable
            class="flex-1 min-w-0 font-mono-nums text-sm" />
        </div>
        <div v-if="backgroundImage" class="mt-2">
          <img :src="backgroundImage" alt="预览" class="max-w-[200px] max-h-[120px] rounded border border-[var(--ainpc-border)]"
            onerror="this.style.display='none'" />
        </div>
        <p class="text-xs text-[var(--ainpc-muted)] mt-1.5">
          支持 JPG、PNG、GIF、WebP，本地上传不超过 8MB
        </p>
      </el-form-item>
      <el-row :gutter="16">
        <el-col :span="12">
          <el-form-item label="沙盒宽度（像素，200~8000）">
            <el-input-number v-model="width" :min="200" :max="8000" :step="50" class="w-full" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="沙盒高度（像素，200~8000）">
            <el-input-number v-model="height" :min="200" :max="8000" :step="50" class="w-full" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="16">
        <el-col :span="12">
          <el-form-item label="状态">
            <el-select v-model="status" class="w-full">
              <el-option label="启用" :value="1" />
              <el-option label="禁用" :value="0" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="排序">
            <el-input-number v-model="sort" :min="0" class="w-full" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-divider content-position="left">关联角色（覆盖式保存）</el-divider>
      <p class="text-xs text-[var(--ainpc-muted)] mb-3">
        保存时将<strong>用下列列表完全替换</strong>本场景下原有角色关联；留空表示不与任何角色关联。
      </p>
      <el-table :data="rows" border size="small" class="mb-3">
        <el-table-column label="角色" min-width="200">
          <template #default="{ row }">
            <el-select v-model="row.npc_id" placeholder="选择 NPC" clearable filterable class="w-full">
              <el-option v-for="n in npcOptions" :key="n.id" :label="`${n.name} (#${n.id})`" :value="n.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="场景中备注（可选）" min-width="160">
          <template #default="{ row }">
            <el-input v-model="row.role_note" placeholder="如：店主" clearable />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="72" align="center">
          <template #default="{ $index }">
            <el-button type="danger" link size="small" @click="removeRow($index)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-button size="small" @click="addRow">添加一行</el-button>
    </el-form>
    <template #footer>
      <div class="flex justify-end gap-2">
        <el-button @click="close">取消</el-button>
        <el-button type="primary" :loading="loading" @click="submit">
          {{ loading ? '保存中…' : '保存' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.scene-form-body {
  max-height: min(72vh, 620px);
  overflow-y: auto;
  padding-right: 4px;
}
</style>
