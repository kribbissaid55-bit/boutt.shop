/**
 * BotTestService — in-dashboard simulator.
 *
 * Reuses the matcher logic but does NOT touch the database. State lives
 * in-memory keyed by sessionId. Every step walked emits rich VirtualEvents
 * (text/audio/image/video/document/options/typing) carrying mediaId so the
 * client can stream the actual files from /api/media/:id/raw and render them
 * just like a real WhatsApp conversation.
 */
import { randomUUID } from 'node:crypto';
import { StepMatcherService, type StepWithChildren } from './StepMatcherService.js';
import type { VirtualEvent } from '../adapters/whatsapp/BotProvider.js';
import { matchOption } from '../engine/matchOption.js';
import { normalizeText, extractOptionNumber } from '../lib/jid.js';
import { substitute } from '../engine/variables.js';
import { prisma } from '../lib/prisma.js';
import { ORDER_QUESTIONS_AR, ORDER_FIELDS, type OrderField, type OrderState } from './OrderService.js';

export type TranscriptItem =
  | { id: string; ts: number; direction: 'in'; text: string }
  | { id: string; ts: number; direction: 'out'; events: VirtualEvent[]; matched?: string; suggestions?: { number: string; label: string }[] };

interface Session {
  botId: string;
  syntheticContactName: string;
  currentStepId?: string;
  failedAttempts: number;
  order?: OrderState;
  hadOut: boolean;
  transcript: TranscriptItem[];
  lastActiveAt: number;
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 30 * 60_000;   // 30 min idle → evict
const TRANSCRIPT_CAP = 200;            // soft cap to bound memory per session

// Periodically GC stale + over-long sessions so the in-memory map can't grow
// unbounded across long server uptimes.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActiveAt > SESSION_TTL_MS) {
      sessions.delete(id);
      continue;
    }
    if (s.transcript.length > TRANSCRIPT_CAP) {
      s.transcript = s.transcript.slice(-TRANSCRIPT_CAP);
    }
  }
}, 5 * 60_000).unref?.();

export const BotTestService = {
  async start(botId: string): Promise<string> {
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      botId, syntheticContactName: 'Test User',
      failedAttempts: 0, hadOut: false, transcript: [],
      lastActiveAt: Date.now(),
    });
    return sessionId;
  },

  reset(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.currentStepId = undefined;
    s.failedAttempts = 0;
    s.order = undefined;
    s.hadOut = false;
    s.transcript = [];
  },

  end(sessionId: string) { sessions.delete(sessionId); },

  getTranscript(sessionId: string): TranscriptItem[] {
    return sessions.get(sessionId)?.transcript ?? [];
  },

  async receive(sessionId: string, text: string): Promise<TranscriptItem[]> {
    const s = sessions.get(sessionId);
    if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
    s.lastActiveAt = Date.now();

    const inItem: TranscriptItem = {
      id: 'in_' + randomUUID(), ts: Date.now(), direction: 'in', text,
    };
    s.transcript.push(inItem);

    const events: VirtualEvent[] = [];
    const emit = (e: VirtualEvent) => events.push(e);

    let matched = '';
    const settingsRow = await prisma.botSettings.findUnique({ where: { botId: s.botId } });
    const handoverKws: string[] = settingsRow?.humanHandoverKeywords ? safeJson(settingsRow.humanHandoverKeywords) ?? [] : [];

    const norm = normalizeText(text);

    // 1) handover keywords always win
    if (handoverKws.some((kw) => norm.includes(normalizeText(kw)))) {
      matched = 'handover';
      const ho = await StepMatcherService.getHandoverStep(s.botId);
      if (ho) {
        const full = await StepMatcherService.getStep(ho.id);
        if (full) await walkSandbox(s, full, emit);
      }
    }
    // 2) order-collection state
    else if (s.order) {
      matched = 'order';
      handleOrderInputSandbox(s, emit, text);
    }
    // 3) normal flow
    else {
      let target: { id: string } | null = null;
      if (!s.hadOut) {
        target = await StepMatcherService.getWelcomeStep(s.botId);
        if (target) matched = 'welcome';
      }
      if (!target) {
        const current = s.currentStepId ? await StepMatcherService.getStep(s.currentStepId) : null;
        if (current?.options?.length) {
          const opt = matchOption(current.options, text);
          if (opt?.targetStepId) target = await prisma.botStep.findUnique({ where: { id: opt.targetStepId } });
          if (target) matched = `option:${opt!.number}`;
        }
        // Also match against the welcome menu so "1/2/3" works from any leaf step.
        if (!target) {
          const welcome = await StepMatcherService.getWelcomeStep(s.botId);
          if (welcome && welcome.id !== current?.id) {
            const fullWelcome = await StepMatcherService.getStep(welcome.id);
            if (fullWelcome?.options?.length) {
              const opt = matchOption(fullWelcome.options, text);
              if (opt?.targetStepId) {
                target = await prisma.botStep.findUnique({ where: { id: opt.targetStepId } });
                if (target) matched = `welcome-option:${opt.number}`;
              }
            }
          }
        }
        if (!target) {
          target = await StepMatcherService.match(s.botId, current, text);
          if (target) {
            const t = await prisma.botStep.findUnique({ where: { id: target.id }, select: { type: true } });
            matched = t?.type ?? 'matched';
          }
        }
      }

      if (target) {
        const isFb = (await prisma.botStep.findUnique({ where: { id: target.id }, select: { type: true } }))?.type === 'fallback';
        if (isFb) { s.failedAttempts++; }
        else { s.failedAttempts = 0; }
        const max = settingsRow?.maxFailedAttempts ?? 3;
        if (isFb && s.failedAttempts >= max) {
          const ho = await StepMatcherService.getHandoverStep(s.botId);
          if (ho) {
            matched = 'auto-handover'; s.failedAttempts = 0;
            const fullHo = await StepMatcherService.getStep(ho.id);
            if (fullHo) await walkSandbox(s, fullHo, emit);
          } else {
            const full = await StepMatcherService.getStep(target.id);
            if (full) await walkSandbox(s, full, emit);
          }
        } else {
          const full = await StepMatcherService.getStep(target.id);
          if (full) await walkSandbox(s, full, emit);
        }
      } else if (settingsRow?.defaultFallbackMessage) {
        matched = 'fallback-default';
        emit({ kind: 'text', text: settingsRow.defaultFallbackMessage });
      }
    }

    if (events.length) s.hadOut = true;

    // Quick-tap suggestions: options of the current step (after walking).
    let suggestions: { number: string; label: string }[] | undefined;
    if (s.currentStepId) {
      const cur = await StepMatcherService.getStep(s.currentStepId);
      if (cur?.options?.length) {
        suggestions = cur.options.filter((o) => o.enabled).map((o) => ({ number: o.number, label: o.label }));
      }
    }
    if (s.order && !s.order.awaitingConfirmation && s.order.currentField) {
      // No tap suggestions during free-text collection.
      suggestions = undefined;
    }
    if (s.order?.awaitingConfirmation) {
      suggestions = [
        { number: '1', label: 'نعم أكد الطلب' },
        { number: '2', label: 'لا بغيت نعدل' },
      ];
    }

    const outItem: TranscriptItem = {
      id: 'out_' + randomUUID(), ts: Date.now(), direction: 'out',
      events, matched, suggestions,
    };
    s.transcript.push(outItem);
    return [inItem, outItem];
  },
};

async function walkSandbox(s: Session, step: StepWithChildren, emit: (e: VirtualEvent) => void) {
  const bot = await prisma.bot.findUnique({ where: { id: s.botId } });
  const ctx = {
    contact: { name: s.syntheticContactName, jid: '212600000000@s.whatsapp.net' },
    bot: { name: bot?.name ?? '' },
    account: { name: 'Test' },
  };

  let optionsEmitted = false;
  const stepSettings: any = (() => {
    try { return step.settings ? JSON.parse(step.settings) : {}; } catch { return {}; }
  })();

  for (const b of step.blocks) {
    if (!b.enabled) continue;

    switch (b.type) {
      case 'text': {
        const txt = substitute(b.content ?? '', ctx);
        if (txt.trim()) emit({ kind: 'text', text: txt });
        break;
      }
      case 'image':
      case 'video':
      case 'audio':
      case 'document': {
        if (!b.media) {
          // Visible nudge in test mode — production silently skips, but here we
          // tell the operator their block is missing a file so they don't
          // think the bot is broken.
          emit({ kind: 'text', text: `⚠ كتلة ${b.type} بدون ملف مرفق — ارفع الملف من المحرر` });
          break;
        }
        const caption = b.caption ? substitute(b.caption, ctx) : undefined;
        emit({
          kind: b.type,
          mediaId: b.media.id,
          mimeType: b.media.mimeType,
          fileName: b.media.name,
          caption,
        });
        break;
      }
      case 'delay': {
        const ms = Math.min(60000, Math.max(0, (b.delaySeconds ?? 0) * 1000));
        if (ms > 0) emit({ kind: 'typing', ms });
        break;
      }
      case 'options': {
        if (!step.options.length) break;
        const meta = b.metadata ? safeJson(b.metadata) : null;
        const mode = (meta?.displayMode ?? 'numbered') as any;
        const rendered = step.options.filter((o) => o.enabled).map((o) => ({
          number: o.number, label: substitute(o.label, ctx),
        }));
        const header = substitute(b.content ?? '', ctx);
        emit({ kind: 'options', header, options: rendered, mode });
        optionsEmitted = true;
        break;
      }
      case 'action': {
        if (b.actionType === 'start_order_collection') {
          s.order = { fields: {}, currentField: 'fullName' };
          emit({ kind: 'text', text: ORDER_QUESTIONS_AR.fullName });
        }
        // mark_needs_human / pause_bot / resume_bot / set_status / end_conversation:
        // visible only as sandbox-internal flags — no message emitted.
        break;
      }
    }
  }

  // Auto-emit options menu at the end if step has options and none was emitted yet.
  const enabledOptions = step.options.filter((o) => o.enabled);
  if (
    !optionsEmitted &&
    enabledOptions.length > 0 &&
    stepSettings.autoMenu !== false
  ) {
    const firstText = step.blocks.find(
      (b) => b.enabled && b.type === 'text' && (b.content ?? '').trim()
    );
    const header = substitute(
      stepSettings.menuHeader ?? firstText?.content ?? 'اختار من القائمة:',
      ctx
    );
    const rendered = enabledOptions.map((o) => ({
      number: o.number, label: substitute(o.label, ctx),
    }));
    emit({ kind: 'options', header, options: rendered, mode: 'numbered' });
  }

  s.currentStepId = step.id;
}

function handleOrderInputSandbox(s: Session, emit: (e: VirtualEvent) => void, text: string) {
  if (!s.order) return;
  if (s.order.awaitingConfirmation) {
    const num = extractOptionNumber(text);
    if (num === '1') {
      emit({ kind: 'text', text: 'تم تأكيد الطلب، شكرا لك. سنتواصل معك قريبا.' });
      s.order = undefined;
      return;
    }
    if (num === '2') {
      emit({ kind: 'text', text: 'تم الإلغاء.' });
      s.order = undefined;
      return;
    }
    emit({ kind: 'text', text: 'عافاك جاوب بـ 1 للتأكيد أو 2 للإلغاء.' });
    return;
  }
  const cur = s.order.currentField as OrderField | undefined;
  if (!cur) return;
  s.order.fields[cur] = text.trim();
  const idx = ORDER_FIELDS.indexOf(cur);
  const nxt = ORDER_FIELDS[idx + 1];
  if (nxt) {
    s.order.currentField = nxt;
    emit({ kind: 'text', text: ORDER_QUESTIONS_AR[nxt] });
    return;
  }
  s.order.currentField = undefined;
  s.order.awaitingConfirmation = true;
  const f = s.order.fields;
  const summary = [
    'هذا هو الطلب ديالك:',
    `الاسم: ${f.fullName ?? '-'}`,
    `الهاتف: ${f.phone ?? '-'}`,
    `المدينة: ${f.city ?? '-'}`,
    `العنوان: ${f.address ?? '-'}`,
    `الكمية: ${f.quantity ?? '-'}`,
    `ملاحظات: ${f.notes ?? '-'}`,
    '',
    'واش نأكد الطلب؟',
    '1 - نعم أكد الطلب',
    '2 - لا بغيت نعدل المعلومات',
  ].join('\n');
  emit({ kind: 'text', text: summary });
}

function safeJson(s: string): any { try { return JSON.parse(s); } catch { return null; } }
