/**
 * 地图场景 Composable
 * 管理场景状态、启停、轮询、WebSocket
 */
import { ref, computed, type Ref } from 'vue'
import {
  getSceneState,
  startMap,
  pauseMap,
  initScene,
  type NpcState,
  type SceneState,
} from '../api/map'
import { connectMapScene } from '../api/ws'
import type { MapBinding } from '../types/map'

const POLL_FAST = 3000
const POLL_SLOW = 10000

export function useMapScene(mapId: Ref<number | null>, bindings: Ref<MapBinding[]>) {
  const sceneState = ref<SceneState>({ npcs: [] })
  const initLoading = ref(false)
  const startPauseLoading = ref(false)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let disconnectWs: (() => void) | null = null

  /** 用于显示的 NPC 列表：优先 Redis 状态，否则用 binding 初始位置 */
  const displayNpcs = computed<NpcState[]>(() => {
    const bindingMap = new Map(bindings.value.map((b) => [b.npc_id, b]))
    const mergeAvatar = (n: NpcState & { avatar?: string }) => ({
      ...n,
      avatar: n.avatar || bindingMap.get(n.npc_id)?.avatar,
    })
    if (sceneState.value.npcs?.length) return sceneState.value.npcs.map(mergeAvatar)
    return bindings.value.map((b) =>
      mergeAvatar({
        npc_id: b.npc_id,
        x: b.init_x,
        y: b.init_y,
        state: 'idle',
        groupId: '',
        avatar: b.avatar,
      })
    )
  })

  async function fetchSceneState() {
    if (!mapId.value) return
    try {
      const res = await getSceneState(mapId.value)
      if (res.data?.data) sceneState.value = res.data.data
    } catch {
      sceneState.value = { npcs: [] }
    }
  }

  function startPolling(useWs = false) {
    stopPolling()
    stopWs()
    if (useWs && mapId.value) {
      disconnectWs = connectMapScene(mapId.value, (state) => {
        sceneState.value = state
      })
    }
    pollTimer = setInterval(() => {
      fetchSceneState()
    }, useWs ? POLL_SLOW : POLL_FAST)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function stopWs() {
    if (disconnectWs) {
      disconnectWs()
      disconnectWs = null
    }
  }

  async function doInitScene() {
    if (!mapId.value) return
    try {
      initLoading.value = true
      await initScene(mapId.value)
      await fetchSceneState()
      return true
    } catch {
      return false
    } finally {
      initLoading.value = false
    }
  }

  async function doStartMap() {
    if (!mapId.value) return
    try {
      startPauseLoading.value = true
      await startMap(mapId.value)
      await fetchSceneState()
      startPolling(true)
      return true
    } catch {
      return false
    } finally {
      startPauseLoading.value = false
    }
  }

  async function doPauseMap() {
    if (!mapId.value) return
    try {
      startPauseLoading.value = true
      await pauseMap(mapId.value)
      await fetchSceneState()
      startPolling(false)
      return true
    } catch {
      return false
    } finally {
      startPauseLoading.value = false
    }
  }

  return {
    sceneState,
    displayNpcs,
    initLoading,
    startPauseLoading,
    fetchSceneState,
    startPolling,
    stopPolling,
    stopWs,
    doInitScene,
    doStartMap,
    doPauseMap,
  }
}
