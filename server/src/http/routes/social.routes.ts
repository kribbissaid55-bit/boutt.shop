/**
 * social.routes — authenticated management API for the social module.
 *
 *   GET    /social/config                → app credentials status + webhook url
 *   POST   /social/config                → save App ID / App Secret / verify token
 *   GET    /social/oauth/start           → { url } Facebook Login dialog
 *   GET    /social/oauth/callback        → exchange code, store user token, redirect
 *   GET    /social/pages                 → pages the connected user manages
 *   POST   /social/accounts              → connect a page (stores encrypted token, subscribes webhooks)
 *   GET    /social/accounts              → connected accounts
 *   PATCH  /social/accounts/:id          → toggles / CTA / skills / bot link
 *   DELETE /social/accounts/:id          → disconnect
 *   GET    /social/events                → activity log
 *   POST   /social/test-reply            → dry-run the comment brain (no posting)
 *   GET    /social/skills                → available sales skills
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { encryptApiKey, decryptApiKey, maskKey } from '../../lib/ai-crypto.js';
import { SocialGraphService } from '../../services/SocialGraphService.js';
import { socialEngine, SOCIAL_SKILLS } from '../../engine/socialEngine.js';

export const socialRouter = Router();

const OAUTH_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_engagement',
  'pages_manage_metadata',
  'pages_messaging',
  'instagram_basic',
  'instagram_manage_comments',
  'instagram_manage_messages',
  'business_management',
].join(',');

const setSetting = async (key: string, value: string) =>
  prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
const getSetting = async (key: string) =>
  (await prisma.setting.findUnique({ where: { key } }))?.value ?? '';

function baseUrl(req: any): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'https').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
  return `${proto}://${host}`;
}

// ── App credentials ───────────────────────────────────────────────────────
socialRouter.get('/social/config', async (req, res, next) => {
  try {
    const appId = await getSetting('social_app_id');
    const secretEnc = await getSetting('social_app_secret_enc');
    let verifyToken = await getSetting('social_verify_token');
    if (!verifyToken) {
      verifyToken = crypto.randomBytes(12).toString('hex');
      await setSetting('social_verify_token', verifyToken);
    }
    res.json({
      appId,
      hasSecret: !!secretEnc,
      secretMask: secretEnc ? maskKey(decryptApiKey(secretEnc)) : null,
      verifyToken,
      webhookUrl: `${baseUrl(req)}/api/social/webhook`,
      redirectUri: `${baseUrl(req)}/api/social/oauth/callback`,
    });
  } catch (e) { next(e); }
});

socialRouter.post('/social/config', async (req, res, next) => {
  try {
    const { appId, appSecret } = z.object({
      appId: z.string().min(3).max(64),
      appSecret: z.string().min(8).max(128).optional(),
    }).parse(req.body);
    await setSetting('social_app_id', appId.trim());
    if (appSecret) await setSetting('social_app_secret_enc', encryptApiKey(appSecret.trim()));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── OAuth: connect Facebook ───────────────────────────────────────────────
socialRouter.get('/social/oauth/start', async (req, res, next) => {
  try {
    const appId = await getSetting('social_app_id');
    if (!appId) return res.status(400).json({ error: 'social_config_missing' });
    const state = crypto.randomBytes(16).toString('hex');
    await setSetting('social_oauth_state', state);
    const redirectUri = `${baseUrl(req)}/api/social/oauth/callback`;
    const url = new URL('https://www.facebook.com/v21.0/dialog/oauth');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', OAUTH_SCOPES);
    url.searchParams.set('response_type', 'code');
    res.json({ url: url.toString() });
  } catch (e) { next(e); }
});

socialRouter.get('/social/oauth/callback', async (req, res) => {
  try {
    const code = String(req.query.code ?? '');
    const state = String(req.query.state ?? '');
    const expected = await getSetting('social_oauth_state');
    if (!code || !state || state !== expected) return res.redirect('/social?connected=0&reason=state');
    const appId = await getSetting('social_app_id');
    const appSecret = decryptApiKey(await getSetting('social_app_secret_enc'));
    const redirectUri = `${baseUrl(req)}/api/social/oauth/callback`;
    const shortToken = await SocialGraphService.exchangeCode(appId, appSecret, redirectUri, code);
    const longToken = await SocialGraphService.longLivedUserToken(appId, appSecret, shortToken);
    await setSetting('social_user_token_enc', encryptApiKey(longToken));
    res.redirect('/social?connected=1');
  } catch (e: any) {
    res.redirect('/social?connected=0&reason=' + encodeURIComponent(String(e?.message ?? 'oauth').slice(0, 80)));
  }
});

// ── Pages of the connected user ───────────────────────────────────────────
socialRouter.get('/social/pages', async (_req, res, next) => {
  try {
    const tokenEnc = await getSetting('social_user_token_enc');
    if (!tokenEnc) return res.status(400).json({ error: 'not_connected' });
    const pages = await SocialGraphService.listPages(decryptApiKey(tokenEnc));
    const connected = new Set((await prisma.socialAccount.findMany({ select: { pageId: true } })).map((a) => a.pageId));
    res.json(pages.map((p) => ({
      pageId: p.id,
      name: p.name,
      avatarUrl: p.picture?.data?.url ?? null,
      igUserId: p.instagram_business_account?.id ?? null,
      igUsername: p.instagram_business_account?.username ?? null,
      alreadyConnected: connected.has(p.id),
    })));
  } catch (e) { next(e); }
});

// ── Connect / manage accounts ─────────────────────────────────────────────
socialRouter.post('/social/accounts', async (req, res, next) => {
  try {
    const { pageId } = z.object({ pageId: z.string().min(3).max(64) }).parse(req.body);
    const tokenEnc = await getSetting('social_user_token_enc');
    if (!tokenEnc) return res.status(400).json({ error: 'not_connected' });
    const pages = await SocialGraphService.listPages(decryptApiKey(tokenEnc));
    const page = pages.find((p) => p.id === pageId);
    if (!page) return res.status(404).json({ error: 'page_not_found' });

    // Subscribe the page to feed + messages webhooks (idempotent).
    try { await SocialGraphService.subscribePage(page.id, page.access_token); }
    catch (e) { SocialGraphService.safeLog('subscribePage', e); }

    const account = await prisma.socialAccount.upsert({
      where: { platform_pageId: { platform: 'facebook', pageId: page.id } },
      update: {
        name: page.name,
        avatarUrl: page.picture?.data?.url ?? null,
        igUserId: page.instagram_business_account?.id ?? null,
        igUsername: page.instagram_business_account?.username ?? null,
        accessToken: encryptApiKey(page.access_token),
      },
      create: {
        platform: 'facebook',
        pageId: page.id,
        name: page.name,
        avatarUrl: page.picture?.data?.url ?? null,
        igUserId: page.instagram_business_account?.id ?? null,
        igUsername: page.instagram_business_account?.username ?? null,
        accessToken: encryptApiKey(page.access_token),
        skills: JSON.stringify(['comment_hook', 'whatsapp_funnel', 'objection_handling', 'lead_qualify']),
      },
    });
    res.status(201).json({ ...account, accessToken: undefined });
  } catch (e) { next(e); }
});

socialRouter.get('/social/accounts', async (_req, res, next) => {
  try {
    const rows = await prisma.socialAccount.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(rows.map((r) => ({ ...r, accessToken: undefined })));
  } catch (e) { next(e); }
});

socialRouter.patch('/social/accounts/:id', async (req, res, next) => {
  try {
    const patch = z.object({
      enabled: z.boolean().optional(),
      commentAutoReply: z.boolean().optional(),
      dmAutoReply: z.boolean().optional(),
      privateReplyOnComment: z.boolean().optional(),
      ctaMode: z.enum(['whatsapp', 'messenger', 'none']).optional(),
      whatsappNumber: z.string().max(30).nullable().optional(),
      skills: z.array(z.string().max(40)).max(12).optional(),
      botId: z.string().max(64).nullable().optional(),
    }).parse(req.body);
    const data: any = { ...patch };
    if (patch.skills) data.skills = JSON.stringify(patch.skills.filter((k) => k in SOCIAL_SKILLS));
    const row = await prisma.socialAccount.update({ where: { id: req.params.id }, data });
    res.json({ ...row, accessToken: undefined });
  } catch (e) { next(e); }
});

socialRouter.delete('/social/accounts/:id', async (req, res, next) => {
  try {
    await prisma.socialAccount.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Activity log ──────────────────────────────────────────────────────────
socialRouter.get('/social/events', async (req, res, next) => {
  try {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
    const rows = await prisma.socialEvent.findMany({
      where: accountId ? { accountId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(req.query.limit ?? 50) || 50, 200),
    });
    res.json(rows);
  } catch (e) { next(e); }
});

// ── Dry-run tester (no posting to Meta) ───────────────────────────────────
socialRouter.post('/social/test-reply', async (req, res) => {
  try {
    const { accountId, sampleComment } = z.object({
      accountId: z.string().min(3),
      sampleComment: z.string().min(1).max(1500),
    }).parse(req.body);
    const account = await prisma.socialAccount.findUnique({ where: { id: accountId } });
    if (!account) return res.status(404).json({ error: 'account_not_found' });
    const out = await socialEngine.commentReply(account, {
      commentText: sampleComment, senderName: 'زبون تجريبي', platform: 'facebook',
    });
    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? 'test_failed').slice(0, 200) });
  }
});

// ── Skills catalog ────────────────────────────────────────────────────────
socialRouter.get('/social/skills', (_req, res) => {
  res.json(Object.entries(SOCIAL_SKILLS).map(([key, v]) => ({ key, label: v.ar })));
});
