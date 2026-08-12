import { EventEmitter } from 'node:events';

export type AppEvents =
  | { type: 'qr'; accountId: string; dataUrl: string }
  | { type: 'account.status'; accountId: string; status: string; phoneNumber?: string | null; lastError?: string | null }
  | { type: 'message.in'; accountId: string; contactId: string; messageId: string }
  | { type: 'message.out'; accountId: string; contactId: string; messageId: string }
  | { type: 'log'; level: string; message: string }
  | { type: 'settings.update' };

class TypedBus extends EventEmitter {
  emitEvent(e: AppEvents) {
    this.emit('event', e);
  }
  onEvent(fn: (e: AppEvents) => void) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new TypedBus();
bus.setMaxListeners(100);
