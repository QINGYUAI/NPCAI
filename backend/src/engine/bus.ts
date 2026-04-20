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
