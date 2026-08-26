/**
 * CloudApiService — the ONLY place that talks to Meta's WhatsApp Cloud API
 * (graph.facebook.com). Single-tenant: one access token + one WABA for the
 * whole install, stored encrypted (AES-256-GCM vault) in the Setting table:
 *
 *   wa_cloud_token_enc       — System User permanent access token (encrypted)
 *   wa_cloud_app_secret_enc  — Meta App Secret, for webhook HMAC (encrypted)
 *   wa_cloud_verify_token    — webhook verify token (random, auto-generated)
 *   wa_cloud_waba_id         — WhatsApp Business Account id
 *
 * Graph version comes from env.META_GRAPH_API_VERSION (default v23.0).
 * SECURITY: tokens never leave this module in plaintext; API responses to the
 * dashboard are masked. Nothing here is reachable without the admin cookie
 * except the webhook (which has its own HMAC check).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { encryptApiKey, decryptApiKey, maskKey } from '../lib/ai-crypto.js';

const GRAPH = () => `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;

// ── Settings access ─────────────────────────────────────────────────────────

const getSetting = async (key: string): Promise<string> =>
  (await prisma.setting.findUnique({ where: { key } }))?.value ?? '';

const putSetting = (key: string, value: string) =>
  prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });

export interface CloudConfigPublic {
  hasToken: boolean;
  tokenMasked: string;
  hasAppSecret: boolean;
  verifyToken: string;
  wabaId: string;
  apiVersion: string;
  webhookPath: string; // relative — the UI prefixes the site origin
}

export class CloudApiError extends Error {
  constructor(
    message: string,
    public code?: number,
    public subcode?: number,
    public details?: string,
  ) { super(message); }
}

async function graphFetch<T = any>(pathname: string, init: RequestInit = {}, token?: string): Promise<T> {
  const tk = token ?? await CloudApiService.getToken();
  if (!tk) throw new CloudApiError('cloud_api_not_configured — access token missing');
  const res = await fetch(`${GRAPH()}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${tk}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON (media download handled separately) */ }
  if (!res.ok) {
    const e = data?.error ?? {};
    // NEVER log the token; log only Meta's structured error.
    logger.warn({ path: pathname, status: res.status, code: e.code, subcode: e.error_subcode, msg: e.message }, '[cloud] graph error');
    throw new CloudApiError(e.message ?? `HTTP ${res.status}`, e.code, e.error_subcode, e.error_data?.details);
  }
  return data as T;
}

/** '2126...@s.whatsapp.net' | '2126...@lid' | bare digits → bare E.164 digits. */
export function jidToWaNumber(jid: string): string {
  return String(jid).split('@')[0].split(':')[0].replace(/[^\d]/g, '');
}

// ── Service ────────────────────────────────────────────────────────────────

export const CloudApiService = {

  async getToken(): Promise<string | null> {
    const enc = await getSetting('wa_cloud_token_enc');
    if (!enc) return null;
    try { return decryptApiKey(enc); } catch { return null; }
  },

  async getAppSecret(): Promise<string | null> {
    const enc = await getSetting('wa_cloud_app_secret_enc');
    if (!enc) return null;
    try { return decryptApiKey(enc); } catch { return null; }
  },

  async getConfig(): Promise<CloudConfigPublic> {
    const [tokenEnc, secretEnc, waba] = await Promise.all([
      getSetting('wa_cloud_token_enc'),
      getSetting('wa_cloud_app_secret_enc'),
      getSetting('wa_cloud_waba_id'),
    ]);
    let verify = await getSetting('wa_cloud_verify_token');
    if (!verify) {
      verify = crypto.randomBytes(24).toString('hex');
      await putSetting('wa_cloud_verify_token', verify);
    }
    let tokenMasked = '';
    if (tokenEnc) { try { tokenMasked = maskKey(decryptApiKey(tokenEnc)); } catch { tokenMasked = '****'; } }
    return {
      hasToken: !!tokenEnc,
      tokenMasked,
      hasAppSecret: !!secretEnc,
      verifyToken: verify,
      wabaId: waba,
      apiVersion: env.META_GRAPH_API_VERSION,
      webhookPath: '/api/whatsapp/webhook',
    };
  },

  async saveConfig(p: { accessToken?: string; appSecret?: string; wabaId?: string }): Promise<void> {
    if (p.accessToken?.trim()) await putSetting('wa_cloud_token_enc', encryptApiKey(p.accessToken.trim()));
    if (p.appSecret?.trim())   await putSetting('wa_cloud_app_secret_enc', encryptApiKey(p.appSecret.trim()));
    if (p.wabaId !== undefined) await putSetting('wa_cloud_waba_id', p.wabaId.trim());
  },

  // ── Discovery / setup ────────────────────────────────────────────────────

  /** Verify the token + WABA id by reading the WABA node. */
  async testConnection(): Promise<{ wabaId: string; name?: string; currency?: string; timezone?: string }> {
    const wabaId = await getSetting('wa_cloud_waba_id');
    if (!wabaId) throw new CloudApiError('waba_id_missing');
    const d = await graphFetch<any>(`/${wabaId}?fields=id,name,currency,timezone_id`);
    return { wabaId: d.id, name: d.name, currency: d.currency, timezone: d.timezone_id };
  },

  /** List phone numbers registered under the WABA. */
  async fetchPhones(): Promise<Array<{
    phoneNumberId: string; displayPhone: string; verifiedName: string;
    qualityRating?: string; platform?: string;
  }>> {
    const wabaId = await getSetting('wa_cloud_waba_id');
    if (!wabaId) throw new CloudApiError('waba_id_missing');
    const d = await graphFetch<any>(
      `/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,platform_type`,
    );
    return (d.data ?? []).map((p: any) => ({
      phoneNumberId: String(p.id),
      displayPhone: p.display_phone_number ?? '',
      verifiedName: p.verified_name ?? '',
      qualityRating: p.quality_rating,
      platform: p.platform_type,
    }));
  },

  /**
   * Subscribe OUR app to the WABA's webhooks. Required once — without it Meta
   * never delivers messages. (The webhook URL itself is configured on the App
   * dashboard; this call binds the WABA to the app.)
   */
  async subscribeApp(): Promise<boolean> {
    const wabaId = await getSetting('wa_cloud_waba_id');
    if (!wabaId) throw new CloudApiError('waba_id_missing');
    const d = await graphFetch<any>(`/${wabaId}/subscribed_apps`, { method: 'POST' });
    return !!d.success;
  },

  /** List message templates on the WABA (name, status, language, category). */
  async listTemplates(): Promise<Array<{ name: string; status: string; language: string; category: string }>> {
    const wabaId = await getSetting('wa_cloud_waba_id');
    if (!wabaId) throw new CloudApiError('waba_id_missing');
    const d = await graphFetch<any>(`/${wabaId}/message_templates?fields=name,status,language,category&limit=100`);
    return (d.data ?? []).map((t: any) => ({
      name: t.name, status: t.status, language: t.language, category: t.category,
    }));
  },

  // ── Messaging ────────────────────────────────────────────────────────────

  async sendText(phoneNumberId: string, to: string, text: string): Promise<string | undefined> {
    const d = await graphFetch<any>(`/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual',
        to, type: 'text', text: { preview_url: true, body: text.slice(0, 4096) },
      }),
    });
    return d?.messages?.[0]?.id;
  },

  /** Upload local media then send it. Cloud API: audio/ogg (opus) is the
   *  voice-note format — our uploads are already normalized to that. */
  async sendMedia(
    phoneNumberId: string, to: string,
    m: { type: 'audio' | 'image' | 'video' | 'document'; filePath: string; mimeType: string; fileName?: string; caption?: string },
  ): Promise<string | undefined> {
    const mediaId = await this.uploadMedia(phoneNumberId, m.filePath, m.mimeType);
    const payload: any = {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: m.type,
    };
    const obj: any = { id: mediaId };
    if (m.caption && (m.type === 'image' || m.type === 'video' || m.type === 'document')) obj.caption = m.caption.slice(0, 1024);
    if (m.type === 'document' && m.fileName) obj.filename = m.fileName;
    payload[m.type] = obj;
    const d = await graphFetch<any>(`/${phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    return d?.messages?.[0]?.id;
  },

  async uploadMedia(phoneNumberId: string, filePath: string, mimeType: string): Promise<string> {
    const buf = await fs.promises.readFile(filePath);
    // Cloud API rejects the ';codecs=opus' suffix — bare type only.
    const bareMime = mimeType.split(';')[0].trim();
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', bareMime);
    fd.append('file', new Blob([new Uint8Array(buf)], { type: bareMime }), path.basename(filePath) || 'file');
    const d = await graphFetch<any>(`/${phoneNumberId}/media`, { method: 'POST', body: fd as any });
    if (!d?.id) throw new CloudApiError('media_upload_failed');
    return String(d.id);
  },

  /** Download an INCOMING media object: GET /{media-id} → signed url → bytes.
   *  The signed url requires the same Bearer token. */
  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const meta = await graphFetch<any>(`/${mediaId}`);
    const url: string = meta?.url;
    if (!url) throw new CloudApiError('media_url_missing');
    const tk = await this.getToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tk}` } });
    if (!res.ok) throw new CloudApiError(`media_download_http_${res.status}`);
    const ab = await res.arrayBuffer();
    return { buffer: Buffer.from(ab), mimeType: meta?.mime_type ?? res.headers.get('content-type') ?? 'application/octet-stream' };
  },

  /** Interactive reply buttons (max 3, 20-char titles). */
  async sendButtons(
    phoneNumberId: string, to: string, header: string,
    options: Array<{ number: string; label: string }>,
  ): Promise<string | undefined> {
    const d = await graphFetch<any>(`/${phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: (header || '...').slice(0, 1024) },
          action: {
            buttons: options.slice(0, 3).map((o) => ({
              type: 'reply', reply: { id: o.number, title: o.label.slice(0, 20) },
            })),
          },
        },
      }),
    });
    return d?.messages?.[0]?.id;
  },

  /** Interactive list (max 10 rows, 24-char titles). */
  async sendList(
    phoneNumberId: string, to: string, header: string,
    options: Array<{ number: string; label: string }>, buttonLabel = 'اختر',
  ): Promise<string | undefined> {
    const d = await graphFetch<any>(`/${phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: (header || '...').slice(0, 4096) },
          action: {
            button: buttonLabel.slice(0, 20),
            sections: [{
              rows: options.slice(0, 10).map((o) => ({
                id: o.number, title: o.label.slice(0, 24),
                description: o.label.length > 24 ? o.label.slice(24, 96) : undefined,
              })),
            }],
          },
        },
      }),
    });
    return d?.messages?.[0]?.id;
  },

  /** Business-initiated template send (required outside the 24h window). */
  async sendTemplate(
    phoneNumberId: string, to: string, name: string, language: string,
    bodyParams: string[] = [],
  ): Promise<string | undefined> {
    const components = bodyParams.length
      ? [{ type: 'body', parameters: bodyParams.map((p) => ({ type: 'text', text: p })) }]
      : undefined;
    const d = await graphFetch<any>(`/${phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
        template: { name, language: { code: language }, ...(components ? { components } : {}) },
      }),
    });
    return d?.messages?.[0]?.id;
  },

  /** Blue-tick an incoming message (and show a typing indicator while the
   *  bot composes — supported by Cloud API on the same call). */
  async markRead(phoneNumberId: string, waMessageId: string, typing = false): Promise<void> {
    await graphFetch<any>(`/${phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', status: 'read', message_id: waMessageId,
        ...(typing ? { typing_indicator: { type: 'text' } } : {}),
      }),
    }).catch((e) => logger.debug({ err: (e as Error).message }, '[cloud] markRead failed (non-fatal)'));
  },
};
