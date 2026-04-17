<script setup lang="ts">
/**
 * AINPC 主应用 - AI 配置 + 角色 NPC
 */
import { ref } from 'vue'
import ConfigList from './components/ConfigList.vue'
import NpcList from './components/NpcList.vue'

const activeTab = ref('config')
</script>

<template>
  <div class="max-w-[1200px] mx-auto">
    <header class="text-center mb-8">
      <h1 class="text-2xl font-bold tracking-tight mb-2">
        <span class="text-2xl mr-2 align-middle">⚡</span>
        <span class="bg-gradient-to-r from-gray-100 to-[var(--el-color-primary)] bg-clip-text text-transparent">
          AINPC 管理
        </span>
      </h1>
      <p class="text-gray-500 text-[0.95rem]">AI 配置与角色 NPC 管理</p>
    </header>
    <el-tabs v-model="activeTab" class="main-tabs">
      <el-tab-pane label="AI 配置" name="config">
        <ConfigList />
      </el-tab-pane>
      <el-tab-pane label="角色 NPC" name="npc">
        <NpcList />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.main-tabs :deep(.el-tabs__header) {
  margin-bottom: 1.5rem;
}
</style>
