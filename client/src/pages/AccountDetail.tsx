import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowRight, ArrowLeft, Power, RotateCw, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client';
import { events } from '../api/sse';
import { useI18n } from '../i18n';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input, Field } from '../components/ui/Input';
import { StatusPill } from '../components/domain/StatusPill';
import { QRConnectModal } from '../components/domain/QRConnectModal';

type Account = {
  id: string; name: string; phoneNumber: string | null; status: string;
  ignoreGroups: boolean; dailySendCap: number; lastError: string | null;
  proxyUrl: string | null; browserIdentity: string | null;
  cooldownUntil: string | null; dailySent: number; lastSendAt: string | null;
  lastQr?: string;
};

export function AccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const [acc, setAcc] = useState<Account | null>(null);
  const [name, setName] = useState('');
  const [ignoreGroups, setIgnoreGroups] = useState(true);
  const [cap, setCap] = useState(800);
  const [proxyUrl, setProxyUrl] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!id) return;
    const a = await api.get<Account>(`/accounts/${id}`);
    setAcc(a); setName(a.name); setIgnoreGroups(a.ignoreGroups); setCap(a.dailySendCap);
    setProxyUrl(a.proxyUrl ?? '');
  };

  useEffect(() => {
    load();
    return events.on((e) => {
      if (e.type === 'account.status' && e.accountId === id) load();
    });
  }, [id]);

  if (!acc) return <div className="text-gray-400">...</div>;

  const Back = lang === 'ar' ? ArrowRight : ArrowLeft;

  const connect = () => { setShowQr(true); };
  const disconnect = async () => {
    try {
      await api.post(`/accounts/${id}/disconnect`);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.patch(`/accounts/${id}`, {
        name, ignoreGroups, dailySendCap: cap,
        proxyUrl: proxyUrl.trim() === '' ? null : proxyUrl.trim(),
      });
      toast.success(t.app.saved);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally { setSaving(false); }
  };

  const browserChip = (() => {
    if (!acc?.browserIdentity) return null;
    try {
      const arr = JSON.parse(acc.browserIdentity);
      return Array.isArray(arr) ? `${arr[0]} · ${arr[1]} · ${arr[2]}` : null;
    } catch { return null; }
  })();
  const inCooldown = acc?.cooldownUntil ? new Date(acc.cooldownUntil).getTime() > Date.now() : false;

  return (
    <>
      <button onClick={() => nav('/accounts')} className="mb-4 flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <Back size={16} /> {t.app.back}
      </button>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{acc.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-gray-500">
            <StatusPill status={acc.status} />
            <span>{acc.phoneNumber ?? ''}</span>
          </div>
        </div>
        <div className="flex gap-2">
          {acc.status !== 'connected' ? (
            <Button onClick={connect}><Power size={16} />{t.accounts.connect}</Button>
          ) : (
            <Button variant="secondary" onClick={disconnect}><RotateCw size={16} />{t.accounts.disconnect}</Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>{t.accounts.qrTitle}</CardHeader>
          <CardBody>
            {acc.status === 'connected' ? (
              <p className="py-12 text-center text-sm text-green-600">✓ {t.accounts.statuses.connected}</p>
            ) : (
              <button
                onClick={connect}
                className="flex w-full flex-col items-center gap-3 rounded-lg border-2 border-dashed border-gray-300 p-8 text-gray-500 transition hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700"
              >
                <Power size={32} />
                <span className="text-base font-semibold">{t.accounts.connect}</span>
                <span className="text-center text-xs text-gray-400">{t.accounts.qrInstructions}</span>
              </button>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>{t.app.edit}</CardHeader>
          <CardBody className="space-y-4">
            <Field label={t.app.name}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ignoreGroups} onChange={(e) => setIgnoreGroups(e.target.checked)} />
              {t.accounts.ignoreGroups}
            </label>
            <Field label={t.accounts.dailySendCap}>
              <Input type="number" value={cap} onChange={(e) => setCap(+e.target.value)} min={1} max={10000} />
            </Field>
            <Button onClick={save} loading={saving}><Save size={16} />{t.app.save}</Button>

            {/* Anti-ban / advanced visibility */}
            <div className="space-y-2 rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs">
              {browserChip && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-gray-500">{t.accounts.browserIdentity}</span>
                  <span className="rounded bg-white px-2 py-0.5 font-mono">{browserChip}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-gray-500">{t.accounts.dailySent}</span>
                <span className="font-semibold">{acc.dailySent ?? 0} / {acc.dailySendCap}</span>
              </div>
              {acc.lastSendAt && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-gray-500">{t.accounts.lastSendAt}</span>
                  <span>{new Date(acc.lastSendAt).toLocaleString()}</span>
                </div>
              )}
              {inCooldown && (
                <div className="flex items-center justify-between gap-2 rounded bg-red-50 px-2 py-1 text-red-700">
                  <span>⚠ {t.accounts.cooldownActive}</span>
                  <span>{t.accounts.cooldownUntil} {new Date(acc.cooldownUntil!).toLocaleTimeString()}</span>
                </div>
              )}
            </div>

            {/* Advanced (proxy URL) */}
            <button onClick={() => setShowAdvanced(!showAdvanced)} className="text-xs text-brand-600 hover:underline">
              {showAdvanced ? '▾' : '▸'} {t.accounts.advanced}
            </button>
            {showAdvanced && (
              <Field label={t.accounts.proxyUrl} hint={t.accounts.proxyHelp}>
                <Input value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder="http://user:pass@host:port" />
              </Field>
            )}

            <div className="pt-2 text-xs text-gray-500">
              <Link to="/bots" className="text-brand-600 hover:underline">{t.bots.title} →</Link>
            </div>
          </CardBody>
        </Card>
      </div>

      <QRConnectModal
        open={showQr}
        accountId={id ?? null}
        accountName={acc.name}
        onClose={() => { setShowQr(false); load(); }}
      />
    </>
  );
}
