/**
 * SocialGraphService — thin typed client over the Meta Graph API used by the
 * social module (Facebook Pages, Messenger, Instagram Business).
 *
 * Every method takes explicit tokens; nothing global. Errors throw with the
 * Graph error message trimmed so routes/engine can log or surface them.
 */
import { logger } from '../config/logger.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph<T = any>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'DELETE'; token?: string; params?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<T> {
  const url = new URL(`${GRAPH}${path}`);
  if (opts.token) url.searchParams.set('access_token', opts.token);
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j?.error) {
    const msg = j?.error?.message ?? `graph_${res.status}`;
    throw Object.assign(new Error(String(msg).slice(0, 300)), { status: res.status, graphCode: j?.error?.code });
  }
  return j as T;
}

export type FbPage = {
  id: string;
  name: string;
  access_token: string;
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string };
};

export const SocialGraphService = {
  /** OAuth: authorization code → short-lived user token. */
  async exchangeCode(appId: string, appSecret: string, redirectUri: string, code: string): Promise<string> {
    const j = await graph<{ access_token: string }>('/oauth/access_token', {
      params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
    });
    return j.access_token;
  },

  /** Short-lived user token → long-lived (~60 days). */
  async longLivedUserToken(appId: string, appSecret: string, token: string): Promise<string> {
    const j = await graph<{ access_token: string }>('/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: token,
      },
    });
    return j.access_token;
  },

  /** Pages the user manages (page tokens included — page tokens derived from
   *  a long-lived user token do not expire). */
  async listPages(userToken: string): Promise<FbPage[]> {
    const j = await graph<{ data: FbPage[] }>('/me/accounts', {
      token: userToken,
      params: {
        fields: 'id,name,access_token,picture{url},instagram_business_account{id,username}',
        limit: '100',
      },
    });
    return j.data ?? [];
  },

  /** Subscribe the app to the page's webhook events (feed + messages). */
  async subscribePage(pageId: string, pageToken: string): Promise<void> {
    await graph(`/${pageId}/subscribed_apps`, {
      method: 'POST',
      token: pageToken,
      params: { subscribed_fields: 'feed,messages' },
    });
  },

  /** Public reply under a Facebook comment. */
  async replyToFbComment(commentId: string, pageToken: string, message: string): Promise<void> {
    await graph(`/${commentId}/comments`, { method: 'POST', token: pageToken, body: { message } });
  },

  /** Public reply under an Instagram comment. */
  async replyToIgComment(igCommentId: string, pageToken: string, message: string): Promise<void> {
    await graph(`/${igCommentId}/replies`, { method: 'POST', token: pageToken, body: { message } });
  },

  /**
   * Private reply: one DM to the author of a comment (FB & IG). Allowed by
   * Meta within 7 days of the comment, once per comment.
   */
  async privateReplyToComment(commentId: string, pageToken: string, text: string): Promise<void> {
    await graph('/me/messages', {
      method: 'POST',
      token: pageToken,
      body: { recipient: { comment_id: commentId }, message: { text } },
    });
  },

  /** Messenger / Instagram DM reply to a user id (PSID / IGSID). */
  async sendDm(psid: string, pageToken: string, text: string): Promise<void> {
    await graph('/me/messages', {
      method: 'POST',
      token: pageToken,
      body: { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } },
    });
  },

  /** Best-effort helper for logs. */
  safeLog(scope: string, err: unknown) {
    logger.warn({ err: (err as any)?.message ?? String(err) }, `[social] ${scope} failed`);
  },
};
