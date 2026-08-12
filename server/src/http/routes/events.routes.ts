/**
 * SSE endpoint for live updates: QR codes, account status, incoming/outgoing
 * messages, settings changes. Auth via cookie inherits from middleware.
 */
import { Router } from 'express';
import { bus } from '../../services/EventBus.js';

export const eventsRouter = Router();

eventsRouter.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (e: unknown) => {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  };

  send({ type: 'hello', t: Date.now() });
  const off = bus.onEvent(send);

  // heartbeat to keep proxies happy
  const hb = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(hb);
    off();
  });
});
