/**
 * 引擎模块入口：注册退出钩子
 */
import { shutdownAll } from './registry.js';

export function isEngineEnabled(): boolean {
  const v = process.env.ENGINE_ENABLED;
  if (v === undefined || v === '') return true;
  return v !== 'false' && v !== '0';
}

let hooked = false;
export function initEngine(): void {
  if (hooked) return;
  hooked = true;
  const handler = () => {
    void shutdownAll();
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  process.once('beforeExit', handler);
}
