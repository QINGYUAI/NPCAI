import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

/**
 * 允许 IP / 域名访问（方案 D）：
 *   - server.host = true → 监听 0.0.0.0，手机 / 局域网 / Tailscale 都可 `http://<ip>:<port>` 打开
 *   - server.allowedHosts = true → 关闭 Host header 校验（域名访问不被 Vite 拦）
 *   - server.proxy → 把 `/api` `/ws` `/uploads` 就地转给后端，保持同源避免 CORS
 *   - preview.host = true → 预览产物时同样对外开放
 *
 * 反向代理目标：BACKEND_ORIGIN（默认 http://localhost:3000）；跑在非本机后端时设：
 *   BACKEND_ORIGIN=http://10.0.0.2:3000 npm run dev
 */
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || 'http://localhost:3000'
const BACKEND_WS = BACKEND_ORIGIN.replace(/^http/, 'ws')

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    proxy: {
      '/api': { target: BACKEND_ORIGIN, changeOrigin: true },
      '/uploads': { target: BACKEND_ORIGIN, changeOrigin: true },
      '/ws': { target: BACKEND_WS, ws: true, changeOrigin: true },
    },
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: false,
    allowedHosts: true,
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
