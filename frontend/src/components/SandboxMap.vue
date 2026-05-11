<script setup lang="ts">
/**
 * [M4.6.0·批次B] Phaser 地图 + NPC 节点 + 气泡层 三位一体组件
 *
 * 从 Sandbox.vue 抽离的 Phaser 渲染层。为什么气泡层一起抽：
 *   - 气泡是 scene.add.text / scene.add.container 产出的 Phaser GameObjects，不是 Vue DOM
 *   - 气泡渲染强依赖 scene / NPC container，与地图共享生命周期
 *   - 独立成 SandboxBubble.vue 技术不可行（没有 template）
 *
 * 职责（零业务副作用）：
 *   1. 挂载时根据 detail 创建 Phaser.Game；detail 变化时重建；卸载时销毁
 *   2. 绘制背景 / 网格 / 边框 / NPC 节点（头像优先、首字母降级）
 *   3. 拖拽 / 吸附（snapEnabled 或 Shift） / 滚轮缩放 / 右键平移
 *   4. 右键点击节点 → emit 'npc-right-click'（父组件自行弹菜单）
 *   5. 拖拽节点 → emit 'position-changed'（父组件自行 dirty + 累积位置快照）
 *   6. 气泡：根据 bubbleEnabled + detail.npcs[].simulation_meta 渲染文本气泡
 *
 * 对父组件的命令式 API（defineExpose）：
 *   - getPositions(): 读取当前所有 NPC 的画布坐标（供 Save 布局按钮）
 *   - setZoom / zoomIn / zoomOut / zoomFit: 相机控制
 *   - refreshBubbles(): 手动刷新一次气泡（父组件 pollStatus 后调用）
 *   - resetLayout(): 回退到 detail 里的 pos_x/pos_y（撤销未保存拖动，等价于重建）
 *
 * 设计约束：
 *   - **不持有业务 state**：position / dirty / 右键菜单显隐均在父组件
 *   - **不调用 toast / ElMessageBox**：所有 UI 反馈交父组件处理
 *   - **findReplyToActor 通过 prop 注入**：避免耦合事件 ring buffer（在 Sandbox.vue 里）
 */
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import * as Phaser from 'phaser'
import type { SceneDetail, SceneNpcLink } from '../types/scene'
import { resolveAvatarUrl } from '../utils/avatar'
import {
  clamp,
  colorOfCategory,
  extractBubbleText,
  fallbackPosition,
  snapTo,
} from '../utils/sandbox'

interface Props {
  /** 场景详情；null 时不渲染 Phaser，仅保留空画布 */
  detail: SceneDetail | null
  /** 气泡开关；false → 清空所有气泡 */
  bubbleEnabled: boolean
  /** 拖拽吸附（按 snapStep 对齐）；用户按住 Shift 临时启用 */
  snapEnabled?: boolean
  /** 吸附步长，默认 20 */
  snapStep?: number
  /**
   * [M4.3.1.c] 气泡"💬 回应 <actor>"后缀查找；由父组件 eventEntries ring buffer 计算
   * - 返回 null 表示此 NPC 的最新 dialogue 非 reply，或 parent 已移出 ring buffer
   */
  findReplyToActor?: (npcName: string | null | undefined) => string | null
  /** 画布视口尺寸（Phaser Game 的 width/height，DOM 像素） */
  viewportWidth?: number
  viewportHeight?: number
  /** NPC 节点半径（世界坐标） */
  nodeRadius?: number
}

const props = withDefaults(defineProps<Props>(), {
  snapEnabled: false,
  snapStep: 20,
  findReplyToActor: () => () => null,
  viewportWidth: 800,
  viewportHeight: 600,
  nodeRadius: 26,
})

interface Emits {
  /** NPC 拖拽结束某一帧触发；父组件自行更新 dirty / 位置缓存 */
  (e: 'position-changed', npcId: number, pos: { x: number; y: number }): void
  /** 右键点击 NPC 节点；父组件自行弹上下文菜单；(x, y) 相对画布左上角（DOM 像素） */
  (e: 'npc-right-click', payload: { npc: SceneNpcLink; x: number; y: number }): void
  /** 相机缩放变化；父组件据此显示 zoom 数字 */
  (e: 'zoom-change', z: number): void
}
const emit = defineEmits<Emits>()

/** 缩放范围 */
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2.5

const containerEl = ref<HTMLDivElement | null>(null)
const gameRef = shallowRef<Phaser.Game | null>(null)
const sceneRef = shallowRef<Phaser.Scene | null>(null)

/** 每次 createGame 重建一次：npc_id → NodeHandle */
interface NodeHandle {
  container: Phaser.GameObjects.Container
  bubble: Phaser.GameObjects.Container | null
  /** avatar 图像的几何遮罩（需跟随容器移动） */
  maskShape: Phaser.GameObjects.Graphics | null
}
const nodeHandles = shallowRef<Map<number, NodeHandle>>(new Map())
const positionCache = shallowRef<Map<number, { x: number; y: number }>>(new Map())

/** 起始于 NPC 节点的右键按下 → 抑制画布 pan（避免拖不动场景错觉） */
let rightDownOnNode = false

/** 从场景详情读取 world 尺寸；缺省 800x600 */
function worldSize(d: SceneDetail | null): { w: number; h: number } {
  const w = typeof d?.width === 'number' && d.width >= 200 ? d.width : 800
  const h = typeof d?.height === 'number' && d.height >= 200 ? d.height : 600
  return { w, h }
}

function avatarKey(npcId: number) {
  return `avatar-${npcId}`
}

function destroyGame() {
  if (gameRef.value) {
    gameRef.value.destroy(true)
    gameRef.value = null
    sceneRef.value = null
  }
  positionCache.value = new Map()
  nodeHandles.value = new Map()
}

/**
 * 在指定节点上方渲染/更新气泡；空文本则移除气泡
 */
function renderBubble(scene: Phaser.Scene, handle: NodeHandle, text: string) {
  const NODE_R = props.nodeRadius
  if (!text) {
    if (handle.bubble) {
      handle.bubble.destroy(true)
      handle.bubble = null
    }
    return
  }
  if (handle.bubble) handle.bubble.destroy(true)

  const maxWidth = 180
  const label = scene.add.text(0, 0, text, {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '12px',
    color: '#0d1117',
    backgroundColor: '#e6edf3',
    padding: { x: 6, y: 4 },
    wordWrap: { width: maxWidth, useAdvancedWrap: true },
    align: 'center',
  })
  label.setOrigin(0.5, 1)
  label.setPosition(0, -NODE_R - 6)

  const bubble = scene.add.container(0, 0, [label])
  bubble.setDepth(20)
  handle.container.add(bubble)
  handle.bubble = bubble
}

/** 刷新所有节点气泡（基于最新 detail.npcs 的 simulation_meta） */
function refreshBubbles() {
  if (!props.detail || !sceneRef.value) return
  const scene = sceneRef.value
  const replyFn = props.findReplyToActor
  for (const n of props.detail.npcs) {
    const h = nodeHandles.value.get(n.npc_id)
    if (!h) continue
    const replyTo = props.bubbleEnabled && replyFn ? replyFn(n.npc_name) : null
    /** [M4.4.1.b] 闲时回退：无 say/action 时展示当前小时日程 */
    const sched =
      props.bubbleEnabled && n.simulation_meta
        ? (n.simulation_meta as Record<string, unknown>).scheduled_activity ?? null
        : null
    /** [M4.5.1.b] 动态目标回退（优先级高于 schedule） */
    const goal =
      props.bubbleEnabled && n.simulation_meta
        ? (n.simulation_meta as Record<string, unknown>).active_goal ?? null
        : null
    const text = props.bubbleEnabled
      ? extractBubbleText(
          n.simulation_meta,
          replyTo,
          sched as Parameters<typeof extractBubbleText>[2],
          goal as Parameters<typeof extractBubbleText>[3],
        )
      : ''
    renderBubble(scene, h, text)
  }
}

/** 为单个 NPC 生成可拖拽的节点：头像优先、失败回退首字母 */
function createNpcNode(
  scene: Phaser.Scene,
  npc: SceneNpcLink,
  x: number,
  y: number,
  W: number,
  H: number,
): NodeHandle {
  const NODE_R = props.nodeRadius
  const color = colorOfCategory(npc.npc_category)
  const key = avatarKey(npc.npc_id)
  const hasAvatar = !!npc.npc_avatar && scene.textures.exists(key)

  const container = scene.add.container(x, y)
  container.setDepth(10)

  /** 背景圆（分类色） */
  const bg = scene.add.circle(0, 0, NODE_R, color, 0.9)
  bg.setStrokeStyle(2, 0xffffff, 0.9)
  container.add(bg)

  /** 头像图像（圆形遮罩）或首字母降级 */
  let maskShape: Phaser.GameObjects.Graphics | null = null
  if (hasAvatar) {
    const img = scene.add.image(0, 0, key)
    /** cover 到节点内切圆（取图像短边等比缩放到直径） */
    const imgD = NODE_R * 2 - 4
    const ratio = Math.max(imgD / img.width, imgD / img.height)
    img.setScale(ratio)
    img.setOrigin(0.5)
    /** 用独立 Graphics 作几何遮罩；遮罩内容画在 (0,0)，通过自身 x/y 跟随容器 */
    maskShape = scene.make.graphics({}, false)
    maskShape.fillStyle(0xffffff, 1)
    maskShape.fillCircle(0, 0, NODE_R - 2)
    maskShape.x = x
    maskShape.y = y
    img.setMask(maskShape.createGeometryMask())
    container.add(img)
  } else {
    const initial = (npc.npc_name || '?').charAt(0).toUpperCase()
    const text = scene.add.text(0, 0, initial, {
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '18px',
      color: '#ffffff',
      fontStyle: 'bold',
    })
    text.setOrigin(0.5)
    container.add(text)
  }

  /** 姓名标签（容器下方） */
  const nameLabel = scene.add.text(0, NODE_R + 6, npc.npc_name || '未命名', {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '12px',
    color: '#f0f6fc',
    backgroundColor: 'rgba(13,17,23,0.7)',
    padding: { x: 4, y: 2 },
  })
  nameLabel.setOrigin(0.5, 0)
  container.add(nameLabel)

  /** 交互（圆形命中） */
  container.setSize(NODE_R * 2, NODE_R * 2)
  container.setInteractive(
    new Phaser.Geom.Circle(0, 0, NODE_R),
    Phaser.Geom.Circle.Contains,
  )
  scene.input.setDraggable(container)

  container.on('pointerover', () => bg.setStrokeStyle(3, 0xffffff, 1))
  container.on('pointerout', () => bg.setStrokeStyle(2, 0xffffff, 0.9))

  /** 右键点击：emit 给父组件弹出菜单（并抑制相机 pan） */
  container.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
    if (pointer.rightButtonDown()) {
      rightDownOnNode = true
      emit('npc-right-click', {
        npc,
        x: pointer.x,
        y: pointer.y,
      })
    }
  })

  container.on(
    'drag',
    (pointer: Phaser.Input.Pointer, dragX: number, dragY: number) => {
      /** 吸附：全局开关打开 或 按住 Shift 时启用；步长由 snapStep 控制 */
      const rawEvent = pointer?.event as unknown as { shiftKey?: boolean } | undefined
      const shift = !!rawEvent?.shiftKey
      const doSnap = props.snapEnabled || shift
      const sx = doSnap ? snapTo(dragX, props.snapStep) : dragX
      const sy = doSnap ? snapTo(dragY, props.snapStep) : dragY
      const nx = clamp(sx, NODE_R, W - NODE_R)
      const ny = clamp(sy, NODE_R, H - NODE_R)
      container.x = nx
      container.y = ny
      /** 同步遮罩位置（世界坐标），保证头像圆形裁剪跟随节点 */
      if (maskShape) {
        maskShape.x = nx
        maskShape.y = ny
      }
      const map = new Map(positionCache.value)
      map.set(npc.npc_id, { x: nx, y: ny })
      positionCache.value = map
      emit('position-changed', npc.npc_id, { x: nx, y: ny })
    },
  )

  return { container, bubble: null, maskShape }
}

/** 创建 Phaser Game 并加载当前 detail */
function createGame(d: SceneDetail) {
  if (!containerEl.value) return
  destroyGame()

  const ws = worldSize(d)
  const NODE_R = props.nodeRadius

  /** 使用闭包内的自定义 Scene：保持 Phaser 生命周期内访问 Vue 数据 */
  class SandboxScene extends Phaser.Scene {
    constructor() {
      super('sandbox')
    }

    preload() {
      /** 允许远程图片作为纹理（需服务端 CORS 支持；失败会进入 loaderror） */
      this.load.crossOrigin = 'anonymous'
      if (d.background_image) {
        this.load.image('bg', d.background_image)
      }
      for (const n of d.npcs ?? []) {
        if (n.npc_avatar) {
          const url = resolveAvatarUrl(n.npc_avatar)
          if (url) this.load.image(avatarKey(n.npc_id), url)
        }
      }
      this.load.on('loaderror', (file: Phaser.Loader.File) => {
        console.warn('[SandboxMap] 资源加载失败:', file.key, file.src)
      })
    }

    create() {
      sceneRef.value = this
      const W = ws.w
      const H = ws.h

      /** 背景层 */
      if (d.background_image && this.textures.exists('bg')) {
        const bg = this.add.image(W / 2, H / 2, 'bg')
        const scale = Math.max(W / bg.width, H / bg.height)
        bg.setScale(scale).setDepth(0)
      } else {
        const g = this.add.graphics()
        g.fillStyle(0x0d1117, 1)
        g.fillRect(0, 0, W, H)
        g.lineStyle(1, 0x30363d, 0.6)
        for (let x = 0; x <= W; x += 40) {
          g.beginPath()
          g.moveTo(x, 0)
          g.lineTo(x, H)
          g.strokePath()
        }
        for (let y = 0; y <= H; y += 40) {
          g.beginPath()
          g.moveTo(0, y)
          g.lineTo(W, y)
          g.strokePath()
        }
        g.setDepth(0)
      }

      /** 世界边界提示 */
      const border = this.add.graphics()
      border.lineStyle(1, 0x58a6ff, 0.6)
      border.strokeRect(0.5, 0.5, W - 1, H - 1)
      border.setDepth(100)

      /** 绘制 NPC 节点 */
      const npcs = d.npcs ?? []
      const cache = new Map<number, { x: number; y: number }>()
      const handles = new Map<number, NodeHandle>()
      npcs.forEach((n, idx) => {
        let x: number
        let y: number
        if (typeof n.pos_x === 'number' && typeof n.pos_y === 'number') {
          x = clamp(Number(n.pos_x), NODE_R, W - NODE_R)
          y = clamp(Number(n.pos_y), NODE_R, H - NODE_R)
        } else {
          const fb = fallbackPosition(idx, npcs.length, W, H)
          x = fb.x
          y = fb.y
        }
        cache.set(n.npc_id, { x, y })
        const h = createNpcNode(this, n, x, y, W, H)
        handles.set(n.npc_id, h)
      })
      positionCache.value = cache
      nodeHandles.value = handles

      /** 相机：world bounds + 初始 fit */
      const cam = this.cameras.main
      cam.setBounds(0, 0, W, H)
      const fitZoom = Math.min(props.viewportWidth / W, props.viewportHeight / H, 1)
      cam.setZoom(Math.max(MIN_ZOOM, fitZoom))
      emit('zoom-change', cam.zoom)
      cam.centerOn(W / 2, H / 2)

      /** 滚轮缩放（以鼠标位置为缩放中心） */
      this.input.on(
        'wheel',
        (
          _pointer: Phaser.Input.Pointer,
          _over: unknown,
          _dx: number,
          dy: number,
        ) => {
          const next = clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), MIN_ZOOM, MAX_ZOOM)
          cam.setZoom(next)
          emit('zoom-change', next)
        },
      )

      /** 右键/中键拖拽 pan：空白处拖拽平移；若起始于节点则抑制 */
      this.input.on(
        'pointermove',
        (pointer: Phaser.Input.Pointer) => {
          if (!pointer.isDown || rightDownOnNode) return
          const rightOrMiddle = pointer.rightButtonDown() || pointer.buttons === 4
          if (rightOrMiddle) {
            cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom
            cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom
          }
        },
      )
      this.input.on('pointerup', () => {
        rightDownOnNode = false
      })

      /** 场景重建后：若气泡开启，立刻渲染一次当前 meta */
      if (props.bubbleEnabled) refreshBubbles()
    }
  }

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: containerEl.value,
    width: props.viewportWidth,
    height: props.viewportHeight,
    backgroundColor: '#0d1117',
    scene: SandboxScene,
    audio: { noAudio: true },
    disableContextMenu: true,
  })
  gameRef.value = game
}

/** 缩放命令式 API */
function setZoom(z: number) {
  const cam = sceneRef.value?.cameras.main
  if (!cam) return
  const clamped = clamp(z, MIN_ZOOM, MAX_ZOOM)
  cam.setZoom(clamped)
  emit('zoom-change', clamped)
}
function zoomIn() {
  const cur = sceneRef.value?.cameras.main.zoom ?? 1
  setZoom(cur * 1.2)
}
function zoomOut() {
  const cur = sceneRef.value?.cameras.main.zoom ?? 1
  setZoom(cur / 1.2)
}
function zoomFit() {
  if (!props.detail) return
  const cam = sceneRef.value?.cameras.main
  if (!cam) return
  const ws = worldSize(props.detail)
  const z = Math.min(props.viewportWidth / ws.w, props.viewportHeight / ws.h, 1)
  setZoom(Math.max(MIN_ZOOM, z))
  cam.centerOn(ws.w / 2, ws.h / 2)
}

/** 读取当前所有 NPC 的画布坐标（供父组件 Save 布局调用） */
function getPositions(): Array<{ npc_id: number; pos_x: number; pos_y: number }> {
  return Array.from(positionCache.value.entries()).map(([npc_id, p]) => ({
    npc_id,
    pos_x: p.x,
    pos_y: p.y,
  }))
}

/** 重置为 detail 里保存的坐标（等价于重建场景） */
function resetLayout() {
  if (props.detail) createGame(props.detail)
}

/**
 * [M4.6.0·批次B-2] 仅当「画布拓扑」变化时重建 Phaser。
 *
 * 父组件 pollStatus 会替换整个 detail 引用且仅合并 simulation_meta；
 * 若 watch 裸监听 props.detail，则每隔几秒销毁重建 Game → 闪烁 / 丢相机。
 *
 * 指纹刻意排除 simulation_meta（气泡仍靠 refreshBubbles + expose）。
 */
function layoutRebuildKey(d: SceneDetail | null): string {
  if (!d) return ''
  return JSON.stringify({
    sid: d.id,
    bg: d.background_image ?? null,
    w: d.width ?? null,
    h: d.height ?? null,
    npcs: (d.npcs ?? []).map((n) => ({
      id: n.npc_id,
      nm: n.npc_name ?? '',
      px: n.pos_x ?? null,
      py: n.pos_y ?? null,
      cat: n.npc_category ?? null,
      av: n.npc_avatar ?? null,
      rn: n.role_note ?? null,
    })),
  })
}

watch(
  () => layoutRebuildKey(props.detail),
  (key, prevKey) => {
    if (key === prevKey) return
    if (!props.detail) {
      destroyGame()
      return
    }
    createGame(props.detail)
  },
  { flush: 'post' },
)

/** bubbleEnabled 切换：立刻刷新一次（true → 渲染，false → 清空） */
watch(
  () => props.bubbleEnabled,
  () => refreshBubbles(),
)

onBeforeUnmount(() => {
  destroyGame()
})

defineExpose({
  getPositions,
  setZoom,
  zoomIn,
  zoomOut,
  zoomFit,
  refreshBubbles,
  resetLayout,
})
</script>

<template>
  <div ref="containerEl" class="sandbox-map"></div>
</template>

<style scoped>
.sandbox-map {
  width: 100%;
  height: 100%;
  background-color: #0d1117;
  overflow: hidden;
}
</style>
