/**
 * SocialPage — "التواصل الاجتماعي": connect Facebook pages (+ linked
 * Instagram), configure the AI social agent per account (auto-replies,
 * WhatsApp funnel, sales skills, linked bot brain), watch the activity log,
 * and dry-run the comment brain.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Share2, Facebook, Instagram, MessageCircle, Plus, RefreshCw, Trash2,
  ChevronDown, ChevronUp, Copy, ExternalLink, FlaskConical, Bot as BotIcon, Sparkles,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input, Field } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Empty } from '../../components/ui/Empty';

type Config = {
  appId: string; hasSecret: boolean; secretMask: string | null;
  verifyToken: string; webhookUrl: string; redirectUri: string;
};
type PageRow = {
  pageId: string; name: string; avatarUrl: string | null;
  igUserId: string | null; igUsername: string | null; alreadyConnected: boolean;
};
type Account = {
  id: string; platform: string; pageId: string; igUserId: string | null; igUsername: string | null;
  name: string; avatarUrl: string | null; enabled: boolean;
  commentAutoReply: boolean; dmAutoReply: boolean; privateReplyOnComment: boolean;
  ctaMode: 'whatsapp' | 'messenger' | 'none'; whatsappNumber: string | null;
  skills: string | null; botId: string | null;
};
type EventRow = {
  id: string; platform: string; kind: string; senderName: string | null;
  inText: string; replyText: string | null; privateReplyText: string | null;
  status: string; error: string | null; createdAt: string;
};
type SkillRow = { key: string; label: string };

const copyText = async (s: string) => { try { await navigator.clipboard.writeText(s); toast.success('✓'); } catch {} };

export function SocialPage() {
  const { t } = useI18n();
  const s = t.social;
  const [params, setParams] = useSearchParams();
  const [config, setConfig] = useState<Config | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [guideOpen, setGuideOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pages, setPages] = useState<PageRow[] | null>(null);

  const reload = () => {
    api.get<Config>('/social/config').then((c) => { setConfig(c); setAppId(c.appId); }).catch(() => {});
    api.get<Account[]>('/social/accounts').then(setAccounts).catch(() => {});
    api.get<SkillRow[]>('/social/skills').then(setSkills).catch(() => {});
    api.get<{ id: string; name: string }[]>('/bots').then(setBots).catch(() => {});
  };
  useEffect(reload, []);

  // Returning from the Facebook OAuth dialog.
  useEffect(() => {
    const connected = params.get('connected');
    if (connected === '1') {
      toast.success(s.connectedOk);
      setParams({}, { replace: true });
      openPicker();
    } else if (connected === '0') {
      toast.error(`${s.connectedFail}: ${params.get('reason') ?? ''}`);
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveConfig = async () => {
    if (!appId.trim()) { toast.error(s.appIdRequired); return; }
    await api.post('/social/config', { appId: appId.trim(), ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}) });
    setAppSecret('');
    toast.success('✓');
    reload();
  };

  const startConnect = async () => {
    if (!config?.appId || !config?.hasSecret) { setConfigOpen(true); toast.error(s.configFirst); return; }
    const r = await api.get<{ url: string }>('/social/oauth/start');
    window.location.href = r.url;
  };

  const openPicker = async () => {
    setPickerOpen(true);
    setPages(null);
    try { setPages(await api.get<PageRow[]>('/social/pages')); }
    catch { setPages([]); toast.error(s.pagesLoadFail); }
  };

  const connectPage = async (pageId: string) => {
    await api.post('/social/accounts', { pageId });
    toast.success(s.pageConnected);
    setPages((prev) => prev?.map((p) => (p.pageId === pageId ? { ...p, alreadyConnected: true } : p)) ?? null);
    reload();
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 via-fuchsia-500 to-orange-400 text-white shadow"><Share2 size={18} /></span>
            {s.title}
          </h1>
          <p className="text-sm text-gray-500">{s.subtitle}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setConfigOpen(true)}>{s.metaSettings}</Button>
          <Button onClick={startConnect}><Plus size={15} /> {s.connectFb}</Button>
        </div>
      </div>

      {/* Setup guide */}
      <Card>
        <button type="button" className="flex w-full items-center justify-between p-4 text-start" onClick={() => setGuideOpen((v) => !v)}>
          <span className="text-sm font-semibold">📘 {s.guideTitle}</span>
          {guideOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {guideOpen && config && (
          <CardBody className="space-y-2 border-t border-gray-100 text-sm leading-relaxed text-gray-700">
            <p>1️⃣ {s.guide1} <a className="inline-flex items-center gap-1 text-blue-600 hover:underline" href="https://developers.facebook.com/apps/create/" target="_blank" rel="noreferrer">developers.facebook.com <ExternalLink size={12} /></a> — {s.guide1b}</p>
            <p>2️⃣ {s.guide2}</p>
            <p>3️⃣ {s.guide3}</p>
            <div className="rounded-lg bg-gray-50 p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate"><b>Callback URL:</b> {config.webhookUrl}</span>
                <button onClick={() => copyText(config.webhookUrl)} className="rounded p-1 hover:bg-gray-200"><Copy size={13} /></button>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="truncate"><b>Verify Token:</b> {config.verifyToken}</span>
                <button onClick={() => copyText(config.verifyToken)} className="rounded p-1 hover:bg-gray-200"><Copy size={13} /></button>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="truncate"><b>OAuth Redirect URI:</b> {config.redirectUri}</span>
                <button onClick={() => copyText(config.redirectUri)} className="rounded p-1 hover:bg-gray-200"><Copy size={13} /></button>
              </div>
            </div>
            <p>4️⃣ {s.guide4}</p>
            <p>5️⃣ {s.guide5}</p>
            <p className="text-xs text-gray-500">💡 {s.guideDevMode}</p>
          </CardBody>
        )}
      </Card>

      {/* Accounts */}
      {accounts.length === 0 ? (
        <Card><CardBody><Empty title={s.emptyTitle} hint={s.emptyHint} /></CardBody></Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {accounts.map((a) => (
            <AccountCard key={a.id} account={a} skills={skills} bots={bots} onChanged={reload} />
          ))}
        </div>
      )}

      {/* TikTok roadmap */}
      <Card>
        <CardBody className="flex items-center gap-3 text-sm text-gray-500">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-black text-white">🎵</span>
          <div>
            <div className="font-semibold text-gray-700">{s.tiktokTitle}</div>
            <div className="text-xs">{s.tiktokHint}</div>
          </div>
        </CardBody>
      </Card>

      {/* Meta app settings modal */}
      <Modal open={configOpen} onClose={() => setConfigOpen(false)} title={s.metaSettings}>
        <div className="space-y-3">
          <Field label="App ID"><Input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="123456789012345" dir="ltr" /></Field>
          <Field label={`App Secret ${config?.hasSecret ? `(${s.saved}: ${config.secretMask})` : ''}`}>
            <Input value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={config?.hasSecret ? '••••••••' : 'abcd1234...'} dir="ltr" type="password" />
          </Field>
          <Button onClick={saveConfig} className="w-full">{s.save}</Button>
        </div>
      </Modal>

      {/* Page picker modal */}
      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title={s.pickPages}>
        {!pages ? (
          <div className="flex items-center justify-center gap-2 p-6 text-sm text-gray-500"><RefreshCw size={15} className="animate-spin" /> ...</div>
        ) : pages.length === 0 ? (
          <Empty title={s.noPages} hint={s.noPagesHint} />
        ) : (
          <div className="space-y-2">
            {pages.map((p) => (
              <div key={p.pageId} className="flex items-center gap-3 rounded-xl border border-gray-100 p-2">
                {p.avatarUrl ? <img src={p.avatarUrl} alt="" className="h-10 w-10 rounded-full" /> : <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-600"><Facebook size={16} /></span>}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{p.name}</div>
                  {p.igUsername && <div className="flex items-center gap-1 text-xs text-fuchsia-600"><Instagram size={11} /> @{p.igUsername}</div>}
                </div>
                {p.alreadyConnected
                  ? <span className="text-xs font-medium text-emerald-600">✓ {s.connected}</span>
                  : <Button size="sm" onClick={() => connectPage(p.pageId)}>{s.connect}</Button>}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

// ─── Per-account card ───────────────────────────────────────────────────────
function AccountCard({ account, skills, bots, onChanged }: {
  account: Account; skills: SkillRow[]; bots: { id: string; name: string }[]; onChanged: () => void;
}) {
  const { t } = useI18n();
  const s = t.social;
  const [busy, setBusy] = useState(false);
  const [waNumber, setWaNumber] = useState(account.whatsappNumber ?? '');
  const [logOpen, setLogOpen] = useState(false);
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [sample, setSample] = useState('');
  const [testOut, setTestOut] = useState<{ publicReply: string; privateMessage: string } | null>(null);
  const enabledSkills = useMemo<string[]>(() => {
    try { const v = JSON.parse(account.skills ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  }, [account.skills]);

  const patch = async (p: Record<string, unknown>) => {
    setBusy(true);
    try { await api.patch(`/social/accounts/${account.id}`, p); onChanged(); }
    finally { setBusy(false); }
  };

  const toggleSkill = (key: string) => {
    const next = enabledSkills.includes(key) ? enabledSkills.filter((k) => k !== key) : [...enabledSkills, key];
    void patch({ skills: next });
  };

  const loadEvents = async () => {
    setLogOpen((v) => !v);
    if (!events) {
      try { setEvents(await api.get<EventRow[]>(`/social/events?accountId=${account.id}&limit=30`)); }
      catch { setEvents([]); }
    }
  };

  const runTest = async () => {
    if (!sample.trim()) return;
    setBusy(true); setTestOut(null);
    try { setTestOut(await api.post(`/social/test-reply`, { accountId: account.id, sampleComment: sample })); }
    catch (e: any) { toast.error(String(e?.message ?? 'error').slice(0, 120)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm(s.disconnectConfirm)) return;
    await api.delete(`/social/accounts/${account.id}`);
    toast.success('✓');
    onChanged();
  };

  const Toggle = ({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) => (
    <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-gray-100 px-3 py-2 text-sm">
      <span>{label}</span>
      <button type="button" disabled={busy} onClick={() => onChange(!value)}
        className={`h-5 w-9 rounded-full p-0.5 transition ${value ? 'bg-emerald-500' : 'bg-gray-300'}`}>
        <span className={`block h-4 w-4 rounded-full bg-white shadow transition ${value ? 'ltr:translate-x-4 rtl:-translate-x-4' : ''}`} />
      </button>
    </label>
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex w-full items-center gap-3">
          {account.avatarUrl
            ? <img src={account.avatarUrl} alt="" className="h-10 w-10 rounded-full" />
            : <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-600"><Facebook size={16} /></span>}
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{account.name}</div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700"><Facebook size={10} /> Page + Messenger</span>
              {account.igUsername && <span className="inline-flex items-center gap-1 rounded-full bg-fuchsia-50 px-2 py-0.5 text-fuchsia-700"><Instagram size={10} /> @{account.igUsername}</span>}
            </div>
          </div>
          <button onClick={remove} title={s.disconnect} className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"><Trash2 size={16} /></button>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle value={account.enabled} onChange={(v) => void patch({ enabled: v })} label={s.enabled} />
          <Toggle value={account.commentAutoReply} onChange={(v) => void patch({ commentAutoReply: v })} label={s.commentAutoReply} />
          <Toggle value={account.dmAutoReply} onChange={(v) => void patch({ dmAutoReply: v })} label={s.dmAutoReply} />
          <Toggle value={account.privateReplyOnComment} onChange={(v) => void patch({ privateReplyOnComment: v })} label={s.privateReply} />
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={s.ctaMode}>
            <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={account.ctaMode}
              onChange={(e) => void patch({ ctaMode: e.target.value })}>
              <option value="whatsapp">{s.ctaWhatsapp}</option>
              <option value="messenger">{s.ctaMessenger}</option>
              <option value="none">{s.ctaNone}</option>
            </select>
          </Field>
          <Field label={s.waNumber}>
            <div className="flex gap-1">
              <Input dir="ltr" placeholder="2126XXXXXXXX" value={waNumber} onChange={(e) => setWaNumber(e.target.value)} />
              <Button size="sm" variant="secondary" onClick={() => void patch({ whatsappNumber: waNumber || null })}>{s.save}</Button>
            </div>
          </Field>
        </div>

        <Field label={s.linkedBot} hint={s.linkedBotHint}>
          <div className="flex items-center gap-2">
            <BotIcon size={15} className="shrink-0 text-violet-500" />
            <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={account.botId ?? ''}
              onChange={(e) => void patch({ botId: e.target.value || null })}>
              <option value="">{s.noBot}</option>
              {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </Field>

        <div>
          <div className="mb-1 flex items-center gap-1 text-sm font-medium"><Sparkles size={13} className="text-violet-500" /> {s.skillsTitle}</div>
          <div className="flex flex-wrap gap-1.5">
            {skills.map((sk) => (
              <button key={sk.key} type="button" disabled={busy} onClick={() => toggleSkill(sk.key)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  enabledSkills.includes(sk.key)
                    ? 'border-violet-300 bg-violet-50 text-violet-700'
                    : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                }`}>
                {enabledSkills.includes(sk.key) ? '✓ ' : ''}{sk.label}
              </button>
            ))}
          </div>
        </div>

        {/* Dry-run tester */}
        <div className="rounded-xl border border-dashed border-violet-200 bg-violet-50/40 p-2">
          <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-violet-700"><FlaskConical size={12} /> {s.testTitle}</div>
          <div className="flex gap-1">
            <Input placeholder={s.testPlaceholder} value={sample} onChange={(e) => setSample(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runTest()} />
            <Button size="sm" onClick={runTest} loading={busy}>{s.testRun}</Button>
          </div>
          {testOut && (
            <div className="mt-2 space-y-1 text-xs">
              <div className="rounded-lg bg-white p-2"><b>💬 {s.testPublic}:</b> {testOut.publicReply || '—'}</div>
              <div className="rounded-lg bg-white p-2"><b>📩 {s.testPrivate}:</b> {testOut.privateMessage || '—'}</div>
            </div>
          )}
        </div>

        {/* Activity log */}
        <button type="button" onClick={loadEvents} className="flex w-full items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm font-medium hover:bg-gray-100">
          <span className="inline-flex items-center gap-1"><MessageCircle size={14} /> {s.logTitle}</span>
          {logOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
        {logOpen && (
          <div className="max-h-64 space-y-2 overflow-y-auto scrollbar-thin">
            {!events ? <div className="p-2 text-center text-xs text-gray-400">...</div>
              : events.length === 0 ? <div className="p-2 text-center text-xs text-gray-400">{s.logEmpty}</div>
              : events.map((ev) => (
                <div key={ev.id} className="rounded-lg border border-gray-100 p-2 text-xs">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-gray-400">
                    <span className={`rounded-full px-1.5 py-0.5 font-medium ${
                      ev.status === 'replied' ? 'bg-emerald-50 text-emerald-600'
                      : ev.status === 'error' ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-500'
                    }`}>{ev.status}</span>
                    <span>{ev.platform} · {ev.kind === 'comment' ? s.kindComment : s.kindDm}</span>
                    {ev.senderName && <span>· {ev.senderName}</span>}
                    <span className="ms-auto">{new Date(ev.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="text-gray-700">🗨️ {ev.inText.slice(0, 160)}</div>
                  {ev.replyText && <div className="mt-0.5 text-emerald-700">↩️ {ev.replyText.slice(0, 160)}</div>}
                  {ev.privateReplyText && <div className="mt-0.5 text-violet-700">📩 {ev.privateReplyText.slice(0, 160)}</div>}
                  {ev.error && <div className="mt-0.5 text-red-500">⚠ {ev.error.slice(0, 120)}</div>}
                </div>
              ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
