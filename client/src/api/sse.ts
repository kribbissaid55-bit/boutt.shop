/**
 * Tiny SSE client wrapper around EventSource. Auto-reconnects.
 */
export type AppEvent =
  | { type: 'hello'; t: number }
  | { type: 'qr'; accountId: string; dataUrl: string }
  | { type: 'account.status'; accountId: string; status: string; phoneNumber?: string | null; lastError?: string | null }
  | { type: 'message.in'; accountId: string; contactId: string; messageId: string }
  | { type: 'message.out'; accountId: string; contactId: string; messageId: string }
  | { type: 'settings.update' };

type Listener = (e: AppEvent) => void;

class EventStream {
  private es?: EventSource;
  private listeners = new Set<Listener>();

  start() {
    if (this.es) return;
    this.connect();
  }

  private connect() {
    const es = new EventSource('/api/events', { withCredentials: true });
    this.es = es;
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as AppEvent;
        this.listeners.forEach((l) => l(e));
      } catch {}
    };
    es.onerror = () => {
      es.close();
      this.es = undefined;
      setTimeout(() => this.connect(), 3000);
    };
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  stop() {
    this.es?.close();
    this.es = undefined;
  }
}

export const events = new EventStream();
