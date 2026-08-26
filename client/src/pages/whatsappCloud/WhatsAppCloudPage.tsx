/**
 * WhatsAppCloudPage — "واتساب الرسمي": configure the OFFICIAL Meta WhatsApp
 * Cloud API (token, app secret, WABA), copy the webhook credentials, activate
 * phone numbers as regular accounts, and send a test message. Includes the
 * full click-by-click Meta setup guide.
 */
import { useEffect, useState } from 'react';
import {
  BadgeCheck, RefreshCw, Copy, ChevronDown, ChevronUp, Send, PlugZap,
  ShieldCheck, Phone, BookOpen,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input, Field } from '../../components/ui/Input';

type Config = {
  hasToken: boolean; tokenMasked: string; hasAppSecret: boolean;
  verifyToken: string; wabaId: string; apiVersion: string; webhookPath: string;
};
type PhoneRow = {
  phoneNumberId: string; displayPhone: string; verifiedName: string;
  qualityRating?: string; platform?: string; accountId: string | null;
};

export function WhatsAppCloudPage() {
  const { t } = useI18n();
  const s = t.waCloud;

  const [config, setConfig] = useState<Config | null>(null);
  const [accessToken, setAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [phones, setPhones] = useState<PhoneRow[] | null>(null);
  const [busy, setBusy] = useState('');
  const [guideOpen, setGuideOpen] = useState(true);
  const [testTo, setTestTo] = useState('');
  const [testText, setTestText] = useState('👋 رسالة تجريبية من bot said 22');
  const [testPid, setTestPid] = useState('');

  const reload = () => {
    api.get<Config>('/wa-cloud/config').then((c) => { setConfig(c); setWabaId(c.wabaId); }).catch(() => {});
  };
  useEffect(reload, []);

  const webhookUrl = `${location.origin}/api/whatsapp/webhook`;
  const copy = async (v: string) => { try { await navigator.clipboard.writeText(v); toast.success(s.copied); } catch {} };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e: any) { toast.error(String(e?.message ?? e).slice(0, 160)); }
    finally { setBusy(''); }
  };

  const save = () => run('save', async () => {
    await api.put('/wa-cloud/config', {
      ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
      ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
      wabaId: wabaId.trim(),
    });
    setAccessToken(''); setAppSecret('');
    toast.success(s.saved);
    reload();
  });

  const test = () => run('test', async () => {
    const r = await api.post<{ ok: boolean; name?: string }>('/wa-cloud/test');
    toast.success(`${s.testOk} ${r.name ?? ''}`);
  });

  const subscribe = () => run('subscribe', async () => {
    await api.post('/wa-cloud/subscribe');
    toast.success(s.subscribeOk);
  });

  const loadPhones = () => run('phones', async () => {
    const list = await api.get<PhoneRow[]>('/wa-cloud/phones');
    setPhones(list);
    if (list.length && !testPid) setTestPid(list[0].phoneNumberId);
  });

  const activate = (p: PhoneRow) => run(`act:${p.phoneNumberId}`, async () => {
    await api.post('/wa-cloud/phones/activate', {
      phoneNumberId: p.phoneNumberId, displayPhone: p.displayPhone, verifiedName: p.verifiedName,
    });
    toast.success(s.active);
    loadPhones();
  });

  const testSend = () => run('send', async () => {
    if (!testPid || !testTo.trim() || !testText.trim()) return;
    await api.post('/wa-cloud/test-send', { phoneNumberId: testPid, to: testTo.trim(), text: testText.trim() });
    toast.success(s.testSendOk);
  });

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
          <BadgeCheck size={22} />
        </div>
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            {s.title}
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">{s.officialBadge}</span>
          </h1>
          <p className="text-sm text-gray-500">{s.subtitle}</p>
        </div>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{s.windowNote}</div>

      {/* ── Setup guide ─────────────────────────────────────────────── */}
      <Card>
        <button className="w-full text-start" onClick={() => setGuideOpen(!guideOpen)}>
          <CardHeader actions={guideOpen ? <ChevronUp size={17} /> : <ChevronDown size={17} />}>
            <span className="flex items-center gap-2"><BookOpen size={17} /> {s.guideTitle}</span>
          </CardHeader>
        </button>
        {guideOpen && (
          <CardBody className="space-y-2 text-sm leading-6">
            <ol className="list-decimal space-y-2 ps-5">
              {s.guideSteps.map((step, i) => <li key={i}>{step}</li>)}
            </ol>
            <div className="rounded-lg bg-blue-50 p-3 text-blue-800">{s.metaApprovalNote}</div>
            <div className="rounded-lg bg-gray-50 p-3 text-gray-600">{s.accounts}</div>
          </CardBody>
        )}
      </Card>

      {/* ── Config ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader><span className="flex items-center gap-2"><ShieldCheck size={17} /> {s.configTitle}</span></CardHeader>
        <CardBody className="space-y-3">
          <Field label={s.accessToken} hint={config?.hasToken ? `${s.tokenSet} ${config.tokenMasked}` : s.accessTokenHint}>
            <Input type="password" dir="ltr" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="EAAG..." />
          </Field>
          <Field label={s.appSecret} hint={config?.hasAppSecret ? s.secretSet : s.appSecretHint}>
            <Input type="password" dir="ltr" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} />
          </Field>
          <Field label={s.wabaId} hint={s.wabaIdHint}>
            <Input dir="ltr" value={wabaId} onChange={(e) => setWabaId(e.target.value)} placeholder="1234567890" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} loading={busy === 'save'}>{s.save}</Button>
            <Button variant="secondary" onClick={test} loading={busy === 'test'}>{s.testBtn}</Button>
            <Button variant="secondary" onClick={subscribe} loading={busy === 'subscribe'}>
              <PlugZap size={15} className="me-1" /> {s.subscribeBtn}
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* ── Webhook credentials ─────────────────────────────────────── */}
      <Card>
        <CardHeader>{s.webhookTitle}</CardHeader>
        <CardBody className="space-y-2 text-sm">
          {[
            { label: s.webhookUrl, value: webhookUrl },
            { label: s.verifyToken, value: config?.verifyToken ?? '' },
          ].map((row) => (
            <div key={row.label} className="flex items-center gap-2">
              <span className="w-32 shrink-0 text-gray-500">{row.label}</span>
              <code dir="ltr" className="flex-1 overflow-x-auto rounded bg-gray-50 px-2 py-1 text-xs">{row.value}</code>
              <Button variant="ghost" size="sm" onClick={() => copy(row.value)}><Copy size={14} /></Button>
            </div>
          ))}
          <div className="text-xs text-gray-400">Graph API: {config?.apiVersion}</div>
        </CardBody>
      </Card>

      {/* ── Phones ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader actions={
          <Button variant="secondary" size="sm" onClick={loadPhones} loading={busy === 'phones'}>
            <RefreshCw size={14} /> {s.refreshPhones}
          </Button>
        }>
          <span className="flex items-center gap-2"><Phone size={17} /> {s.phonesTitle}</span>
        </CardHeader>
        <CardBody className="space-y-2">
          {phones === null && <div className="text-sm text-gray-400">—</div>}
          {phones?.length === 0 && <div className="text-sm text-gray-500">{s.noPhones}</div>}
          {phones?.map((p) => (
            <div key={p.phoneNumberId} className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-100 p-3">
              <div className="flex-1">
                <div className="font-medium" dir="ltr">{p.displayPhone}</div>
                <div className="text-xs text-gray-500">{p.verifiedName} · {s.quality}: {p.qualityRating ?? '—'}</div>
                <div className="text-[11px] text-gray-400" dir="ltr">id: {p.phoneNumberId}</div>
              </div>
              {p.accountId
                ? <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">{s.active}</span>
                : <Button size="sm" onClick={() => activate(p)} loading={busy === `act:${p.phoneNumberId}`}>{s.activate}</Button>}
            </div>
          ))}
        </CardBody>
      </Card>

      {/* ── Test send ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader><span className="flex items-center gap-2"><Send size={17} /> {s.testSendTitle}</span></CardHeader>
        <CardBody className="space-y-3">
          {phones && phones.length > 1 && (
            <select
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              value={testPid} onChange={(e) => setTestPid(e.target.value)} dir="ltr"
            >
              {phones.map((p) => <option key={p.phoneNumberId} value={p.phoneNumberId}>{p.displayPhone}</option>)}
            </select>
          )}
          <Field label={s.testSendTo}>
            <Input dir="ltr" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="2126XXXXXXXX" />
          </Field>
          <Field label={s.testSendText}>
            <Input value={testText} onChange={(e) => setTestText(e.target.value)} />
          </Field>
          <Button onClick={testSend} loading={busy === 'send'} disabled={!testPid}>{s.testSendBtn}</Button>
        </CardBody>
      </Card>

      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500">{s.honestNote}</div>
    </div>
  );
}
