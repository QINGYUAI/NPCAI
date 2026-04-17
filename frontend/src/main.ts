import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
/** 深色 CSS 变量：需配合 index.html 的 <html class="dark"> */
import 'element-plus/theme-chalk/dark/css-vars.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import Vue3Toastify, { type ToastContainerOptions } from 'vue3-toastify'
import 'vue3-toastify/dist/index.css'
import './style.css'
import App from './App.vue'

const app = createApp(App)
app.use(ElementPlus)
app.use(Vue3Toastify, {
  autoClose: 3000,
  theme: 'dark',
  position: 'top-right',
} as ToastContainerOptions)

// 注册 Element Plus 图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.mount('#app')
