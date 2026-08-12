import { prisma } from '../lib/prisma.js';
import { bus } from './EventBus.js';

export type AppSettings = {
  default_fallback_text: string;
  welcome_enabled: boolean;
  bot_globally_enabled: boolean;
  media_text_delay_ms: number;
  ignore_groups_default: boolean;
  per_contact_rate_per_min: number;
  per_contact_rate_per_hour: number;
  emergency_stop: boolean;
  typing_simulation: boolean;
  read_receipts: boolean;
  min_send_delay_ms: number;
  max_send_delay_ms: number;
  cold_start_ignore_seconds: number;
  handover_keywords: string[];
  handover_message: string;
  working_hours: { enabled: boolean; start: string; end: string; tz: string };
  burst_threshold_count: number;
  burst_window_minutes: number;
  burst_cooldown_seconds: number;
  auto_pause_on_manual_reply: boolean;
  auto_resume_after_hours: number;   // 0 = never auto-resume
  never_auto_resume_if_ordered_or_rejected: boolean;
  // Auto-reject incoming voice/video calls + (optionally) send a follow-up.
  // When auto_reject_calls is off, all four call_* keys are inert.
  auto_reject_calls: boolean;
  call_rejection_message_type: 'none' | 'text' | 'audio' | 'image' | 'video';
  call_rejection_message_text: string;
  call_rejection_media_id: string | null;
};

const DEFAULTS: AppSettings = {
  // Empty by default — bot stays silent on unmatched messages. The owner can
  // set a string from the Settings UI to re-enable the auto-reply.
  default_fallback_text: '',
  welcome_enabled: true,
  bot_globally_enabled: true,
  media_text_delay_ms: 800,
  ignore_groups_default: true,
  per_contact_rate_per_min: 6,
  per_contact_rate_per_hour: 60,
  emergency_stop: false,
  typing_simulation: true,
  // Default OFF so customer messages stay unread on the owner's phone WhatsApp,
  // making it easy to scroll the chat list and see what's new.
  // Trade-off: customers don't see ✓✓ blue ticks. Toggle on if you want them.
  read_receipts: false,
  min_send_delay_ms: 1200,
  max_send_delay_ms: 3500,
  cold_start_ignore_seconds: 60,
  handover_keywords: [],
  handover_message: '',
  working_hours: { enabled: false, start: '09:00', end: '20:00', tz: 'Africa/Casablanca' },
  burst_threshold_count: 50,
  burst_window_minutes: 30,
  burst_cooldown_seconds: 15,
  auto_pause_on_manual_reply: true,
  auto_resume_after_hours: 0,
  never_auto_resume_if_ordered_or_rejected: true,
  auto_reject_calls: false,
  call_rejection_message_type: 'none',
  call_rejection_message_text: '',
  call_rejection_media_id: null,
};

let cache: AppSettings | null = null;
let cachedAt = 0;
// Settings rarely change yet load() is hit on every handleIncoming + every
// queue dispatch. A 30-second floor on the cache cuts DB reads dramatically
// under multi-account pressure while still picking up legitimate edits within
// a half-minute. update() invalidates synchronously, so the only path that
// uses a stale cache is direct DB writes bypassing the service (rare).
const CACHE_TTL_MS = 30_000;

export const SettingsService = {
  async load(): Promise<AppSettings> {
    if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
    const rows = await prisma.setting.findMany();
    const out: any = { ...DEFAULTS };
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        // ignore malformed
      }
    }
    cache = out as AppSettings;
    cachedAt = Date.now();
    return cache;
  },

  invalidate() {
    cache = null;
    cachedAt = 0;
  },

  async getAll() {
    return this.load();
  },

  async update(patch: Partial<AppSettings>) {
    for (const [k, v] of Object.entries(patch)) {
      await prisma.setting.upsert({
        where: { key: k },
        update: { value: JSON.stringify(v) },
        create: { key: k, value: JSON.stringify(v) },
      });
    }
    this.invalidate();
    bus.emitEvent({ type: 'settings.update' });
    return this.load();
  },
};
