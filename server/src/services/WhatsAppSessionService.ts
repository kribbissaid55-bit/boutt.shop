/**
 * WhatsAppSessionService — owns lifecycle of accounts in DB and starts the
 * adapter for them. Wires adapter events to the EventBus and to ingest.
 */
import path from 'node:path';
import fs from 'node:fs';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { whatsapp } from '../adapters/whatsapp/BaileysAdapter.js';
import type {
  AccountStatus,
  IncomingMessage,
} from '../adapters/whatsapp/types.js';
import type { IncomingCall } from '../engine/handleIncomingCall.js';
import { bus } from './EventBus.js';
import { MessageQueueService } from './MessageQueueService.js';

let wired = false;
const lastQrPerAccount = new Map<string, string>();

export const WhatsAppSessionService = {
  /** Wire adapter events once. Idempotent. */
  init(
    onMessage: (m: IncomingMessage) => void,
    onCall?: (c: IncomingCall) => void,
  ) {
    if (wired) return;
    wired = true;

    if (onCall) {
      whatsapp.on('call', (c: IncomingCall) => {
        try { onCall(c); } catch (e) { logger.error({ err: e }, 'onCall handler failed'); }
      });
    }

    whatsapp.on('qr', (accountId: string, dataUrl: string) => {
      lastQrPerAccount.set(accountId, dataUrl);
      bus.emitEvent({ type: 'qr', accountId, dataUrl });
    });

    whatsapp.on(
      'status',
      async (
        accountId: string,
        status: AccountStatus,
        info: { phoneNumber?: string | null; lastError?: string | null }
      ) => {
        try {
          await prisma.whatsAppAccount.update({
            where: { id: accountId },
            data: {
              status,
              phoneNumber: info.phoneNumber ?? undefined,
              lastError: info.lastError ?? null,
            },
          });
        } catch (e) {
          logger.warn({ err: e, accountId }, 'failed to persist status');
        }
        if (status === 'connected') lastQrPerAccount.delete(accountId);
        bus.emitEvent({
          type: 'account.status',
          accountId,
          status,
          phoneNumber: info.phoneNumber,
          lastError: info.lastError,
        });
      }
    );

    whatsapp.on('message', (m: IncomingMessage) => {
      try { onMessage(m); } catch (e) { logger.error({ err: e }, 'onMessage handler failed'); }
    });
  },

  async list() {
    return prisma.whatsAppAccount.findMany({ orderBy: { createdAt: 'asc' } });
  },

  async get(id: string) {
    return prisma.whatsAppAccount.findUnique({ where: { id } });
  },

  async create(name: string) {
    const account = await prisma.whatsAppAccount.create({
      data: { name, sessionPath: '' },
    });
    const sessionPath = path.join(env.SESSIONS_DIR, account.id);
    return prisma.whatsAppAccount.update({
      where: { id: account.id },
      data: { sessionPath },
    });
  },

  async rename(id: string, name: string) {
    return prisma.whatsAppAccount.update({ where: { id }, data: { name } });
  },

  async patch(id: string, data: Partial<{ name: string; ignoreGroups: boolean; dailySendCap: number; proxyUrl: string | null }>) {
    return prisma.whatsAppAccount.update({ where: { id }, data });
  },

  async connect(id: string) {
    const acc = await prisma.whatsAppAccount.findUnique({ where: { id } });
    if (!acc) throw Object.assign(new Error('account not found'), { status: 404 });
    await whatsapp.start(id);
  },

  async disconnect(id: string) {
    await whatsapp.disconnect(id);
  },

  async logoutAndWipe(id: string) {
    await whatsapp.logout(id);
  },

  async remove(id: string) {
    await whatsapp.logout(id);
    try {
      const dir = path.join(env.SESSIONS_DIR, id);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    await prisma.whatsAppAccount.delete({ where: { id } });
    // Free the in-process send queue + state for this account so the Map
    // doesn't accumulate entries for every account that ever existed.
    MessageQueueService.removeAccount(id);
  },

  /** Re-attach previously-connected accounts on boot. */
  async resumeAll() {
    const accounts = await prisma.whatsAppAccount.findMany({
      where: { status: { in: ['connected', 'connecting', 'qr_required'] } },
    });
    for (const a of accounts) {
      try {
        await whatsapp.start(a.id);
      } catch (e) {
        logger.error({ err: e, accountId: a.id }, 'resume start failed');
      }
    }
  },

  getLastQr(id: string): string | undefined {
    return lastQrPerAccount.get(id);
  },
};
