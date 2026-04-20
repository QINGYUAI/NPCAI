import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  build: {
    /** 提高单 chunk 告警阈值，避免 Phaser 触发噪声；真正的切分见 manualChunks */
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        /** 手动分包：Phaser 仅沙盒页用，单独拆；UI 库/Vue 运行时/vendor 各自独立 */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (id.includes('phaser')) return 'phaser'
          if (id.includes('element-plus') || id.includes('@element-plus')) return 'element-plus'
          if (id.includes('vue3-toastify')) return 'toastify'
          if (
            id.includes('/vue/') ||
            id.includes('/@vue/') ||
            id.includes('\\vue\\') ||
            id.includes('\\@vue\\')
          ) {
            return 'vue'
          }
          return 'vendor'
        },
      },
    },
  },
})
