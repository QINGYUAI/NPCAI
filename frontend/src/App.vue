<script setup lang="ts">
/**
 * AINPC 主应用 — 顶层壳：Tab（AI 配置 / 角色 NPC / 场景 / 沙盒）
 */
import { ref, provide, defineAsyncComponent } from 'vue'
import ConfigList from './components/ConfigList.vue'
import NpcList from './components/NpcList.vue'
import SceneList from './components/SceneList.vue'

/** Phaser 体积较大，懒加载减少首屏 JS */
const Sandbox = defineAsyncComponent(() => import('./components/Sandbox.vue'))

const activeTab = ref('config')

/** 从 NPC 表单跳转到「场景」Tab 并打开指定场景编辑（M2） */
const sceneOpenId = ref<number | null>(null)
function jumpToScene(id: number) {
  activeTab.value = 'scene'
  sceneOpenId.value = id
}
provide('jumpToScene', jumpToScene)
provide('sceneOpenId', sceneOpenId)
</script>

<template>
  <div class="app-shell">
    <header class="mb-8 pb-6 border-b border-[var(--ainpc-border)]">
      <p class="text-xs uppercase tracking-[0.2em] text-[var(--ainpc-muted)] mb-2 text-center">
        Console
      </p>
      <h1 class="text-center text-[1.65rem] sm:text-2xl font-semibold tracking-tight text-[#f0f6fc]">
        <span class="inline-block mr-2 align-middle opacity-90" aria-hidden="true">⚡</span>
        AINPC 管理
      </h1>
      <p class="text-center text-[var(--ainpc-muted)] text-sm mt-2 max-w-[28rem] mx-auto leading-relaxed">
        管理大模型连接、角色档案与场景编排；下方切换各模块。
      </p>
    </header>

    <!-- 主内容：Tab 采用卡片式导航条，与内容区视觉分离 -->
    <el-tabs v-model="activeTab" class="main-tabs">
      <el-tab-pane label="AI 配置" name="config">
        <ConfigList />
      </el-tab-pane>
      <el-tab-pane label="角色 NPC" name="npc">
        <NpcList />
      </el-tab-pane>
      <el-tab-pane label="场景" name="scene">
        <SceneList />
      </el-tab-pane>
      <el-tab-pane label="沙盒" name="sandbox" lazy>
        <Sandbox />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.main-tabs :deep(.el-tabs__header) {
  margin-bottom: 0;
  border: 1px solid var(--ainpc-border);
  border-radius: 10px 10px 0 0;
  background: var(--ainpc-surface);
  backdrop-filter: blur(8px);
  padding: 0 0.5rem;
}

.main-tabs :deep(.el-tabs__nav-wrap::after) {
  display: none;
}

.main-tabs :deep(.el-tabs__item) {
  font-weight: 500;
  letter-spacing: 0.02em;
  height: 44px;
}

.main-tabs :deep(.el-tabs__item.is-active) {
  color: var(--el-color-primary);
}

.main-tabs :deep(.el-tabs__active-bar) {
  height: 2px;
  border-radius: 1px;
}

.main-tabs :deep(.el-tabs__content) {
  border: 1px solid var(--ainpc-border);
  border-top: none;
  border-radius: 0 0 12px 12px;
  background: rgba(13, 17, 23, 0.55);
  padding: 1.5rem 1.25rem 1.75rem;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

@media (min-width: 640px) {
  .main-tabs :deep(.el-tabs__content) {
    padding: 1.75rem 1.75rem 2rem;
  }
}
</style>
