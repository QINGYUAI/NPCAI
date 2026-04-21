/**
 * 进程内 SceneScheduler 单例注册表
 */
import { SceneScheduler } from './scheduler.js';
import type { EngineConfig } from './types.js';

const schedulers = new Map<number, SceneScheduler>();

export function getScheduler(scene_id: number): SceneScheduler | undefined {
  return schedulers.get(scene_id);
}

export function createScheduler(scene_id: number, cfg: EngineConfig): SceneScheduler {
  const s = new SceneScheduler(scene_id, cfg);
  schedulers.set(scene_id, s);
  return s;
}

/**
 * 直接把一个已有实例塞进注册表
 * - 主要给单元测试用：在 controller 层之外创建 scheduler 后希望 REST 能查到
 * - 业务代码请优先使用 createScheduler
 */
export function setScheduler(scene_id: number, scheduler: SceneScheduler): void {
  schedulers.set(scene_id, scheduler);
}

export function removeScheduler(scene_id: number): void {
  schedulers.delete(scene_id);
}

/** 进程退出时停掉所有 scheduler */
export async function shutdownAll(): Promise<void> {
  await Promise.all(
    Array.from(schedulers.values()).map((s) => s.stop('user', true).catch(() => void 0)),
  );
  schedulers.clear();
}
