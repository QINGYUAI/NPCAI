/**
 * 引擎事件总线：进程内 EventEmitter
 * 后续可在 ws.ts 中订阅推送给前端
 */
import { EventEmitter } from 'node:events';
import type { TickEvent } from './types.js';

class TypedBus extends EventEmitter {
  emitEvent(ev: TickEvent): void {
    this.emit('tick', ev);
    this.emit(ev.type, ev);
  }

  onTick(listener: (ev: TickEvent) => void): () => void {
    this.on('tick', listener);
    return () => this.off('tick', listener);
  }
}

export const bus = new TypedBus();
bus.setMaxListeners(100);
/**
 * [M4.2.0] Node EventEmitter 对名为 'error' 的事件有特殊处理：
 * 无监听器时会抛 uncaught。我们的 TickEvent.type === 'error' 只是业务语义上的错误，
 * 不应让进程崩溃，故注册一个 noop 监听器做底座。
 */
bus.on('error', () => { /* noop: 业务 error 事件不应导致进程崩溃 */ });
