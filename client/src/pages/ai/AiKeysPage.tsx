/**
 * AiKeysPage — vault for AI provider API keys. Keys are encrypted at rest
 * (AES-256-GCM) and never returned to the client — only the masked tail is
 * shown so the operator can recognise which key is which.
 */
import { useEffect, useState } from 'react';
import { Plus, Star, Trash2, KeyRound, FlaskConical, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { PageHeader } from '../../components/ui/PageHeader';
import { Card, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Input, Field } from '../../components/ui/Input';

type Provider = 'openai' | 'deepseek' | 'gemini' | 'anthropic' | 'elevenlabs';

interface Cred {
  id: string;
  provider: Provider;
  label: string;
  masked: string;
  isDefault: boolean;
  createdAt: string;
}

const PROVIDER_LABEL: Record<Provider, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  gemini: 'Google Gemini',
  anthropic: 'Anthropic',
  elevenlabs: 'ElevenLabs',
};

export function AiKeysPage() {
  const { t } = useI18n();
  const [creds, setCreds] = useState<Cred[]>([]);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<Provider>('openai');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isDefault, setIsDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  // Providers at least one active bot needs (chat / voice-chat / TTS).
  // Used to spot mismatches like "your bot uses DeepSeek but no DeepSeek
  // key exists" — the source of the "AI never replies" bug.
  const [neededProviders, setNeededProviders] = useState<Provider[]>([]);

  const load = () => api.get<Cred[]>('/ai/credentials').then(setCreds);
  const loadNeeded = () =>
    api.get<{ providers: Provider[] }>('/ai/providers-needed')
      .then((r) => setNeededProviders(r.providers ?? []))
      .catch(() => {});
  useEffect(() => { load(); loadNeeded(); }, []);

  // Providers that bots use but have no credential yet — the "danger zone".
  const missingProviders = neededProviders.filter(
    (p) => !creds.some((c) => c.provider === p),
  );

  // When the operator opens the "Add key" modal, pre-select a missing
  // provider so muscle-memory ("hit save with the default openai") doesn't
  // save the key under the wrong provider again.
  const openAddModal = () => {
    setProvider(missingProviders[0] ?? 'openai');
    setAdding(true);
  };

  // Test results by credential id — sticky in-page badges so the operator
  // can see at a glance which keys are healthy.
  type TestResult = { ok: boolean; latencyMs: number; sampleReply?: string; status?: number; error?: string };
  const [testResults, setTestResults] = useState<Record<string, TestResult | 'pending'>>({});

  const testKey = async (id: string): Promise<TestResult | undefined> => {
    setTestResults((s) => ({ ...s, [id]: 'pending' }));
    try {
      const r = await api.post<TestResult>(`/ai/credentials/${id}/test`, {});
      setTestResults((s) => ({ ...s, [id]: r }));
      if (r.ok) toast.success(`✓ المفتاح صالح (${r.latencyMs}ms)`);
      else toast.error(`✗ فشل: ${r.status ? `HTTP ${r.status} — ` : ''}${(r.error ?? '').slice(0, 100)}`);
      return r;
    } catch (e: any) {
      const r: TestResult = { ok: false, latencyMs: 0, error: e?.message ?? String(e) };
      setTestResults((s) => ({ ...s, [id]: r }));
      toast.error(`✗ ${r.error}`);
      return r;
    }
  };

  const submit = async () => {
    if (!label.trim() || !apiKey.trim()) return;
    setBusy(true);
    try {
      const created = await api.post<{ id: string }>('/ai/credentials', {
        provider, label: label.trim(), apiKey: apiKey.trim(), isDefault,
      });
      setAdding(false);
      setLabel(''); setApiKey(''); setIsDefault(true);
      await load();
      loadNeeded();
      // Auto-test the freshly-saved key so the operator learns immediately
      // whether they pasted a valid key or (as happened before) a key from
      // a different provider. Removes the "I saved it, is it working?"
      // uncertainty.
      const test = created?.id ? await testKey(created.id) : undefined;
      if (test?.ok) toast.success(t.app.saved);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally { setBusy(false); }
  };

  const setDefault = async (id: string) => {
    await api.patch(`/ai/credentials/${id}`, { isDefault: true });
    load();
  };
  const remove = async (id: string) => {
    if (!confirm(t.app.delete + '?')) return;
    await api.delete(`/ai/credentials/${id}`);
    load();
  };

  return (
    <>
      <PageHeader
        title={t.aiKeys.title}
        subtitle={t.aiKeys.subtitle}
        actions={<Button onClick={openAddModal}><Plus size={14} /> {t.aiKeys.add}</Button>}
      />

      {missingProviders.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" dir="rtl">
          <div className="font-semibold mb-1">⚠️ مفاتيح ناقصة</div>
          <div className="text-xs leading-relaxed">
            بوت أو أكثر مضبوط على استعمال هذه المزوّدات لكن لا يوجد مفتاح API لها.
            بدون مفاتيح لن يستطيع البوت الرد على العملاء:
            <div className="mt-1 flex flex-wrap gap-1">
              {missingProviders.map((p) => (
                <span key={p} className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium">
                  {PROVIDER_LABEL[p]}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {creds.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center gap-2 p-10 text-center text-sm text-gray-500">
            <KeyRound size={28} className="text-gray-300" />
            <div>{t.aiKeys.emptyTitle}</div>
            <div className="text-xs text-gray-400">{t.aiKeys.emptyHint}</div>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-2">
          {creds.map((c) => (
            <Card key={c.id}>
              <CardBody>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                    <KeyRound size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900">{c.label}</span>
                      {c.isDefault && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                          <Star size={9} className="fill-current" /> {t.aiKeys.defaultLabel}
                        </span>
                      )}
                      {testResults[c.id] === 'pending' && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                          <Loader2 size={9} className="animate-spin" /> جاري الفحص…
                        </span>
                      )}
                      {typeof testResults[c.id] === 'object' && (testResults[c.id] as TestResult).ok && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                          <CheckCircle2 size={9} /> صالح · {(testResults[c.id] as TestResult).latencyMs}ms
                        </span>
                      )}
                      {typeof testResults[c.id] === 'object' && !(testResults[c.id] as TestResult).ok && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700" title={(testResults[c.id] as TestResult).error}>
                          <XCircle size={9} /> فاشل{(testResults[c.id] as TestResult).status ? ` · HTTP ${(testResults[c.id] as TestResult).status}` : ''}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">
                      {PROVIDER_LABEL[c.provider]} · <span className="font-mono">{c.masked}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => testKey(c.id)} title="اختبر المفتاح">
                      <FlaskConical size={13} />
                    </Button>
                    {!c.isDefault && (
                      <Button size="sm" variant="ghost" onClick={() => setDefault(c.id)}><Star size={13} /> {t.aiKeys.setDefault}</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => remove(c.id)}><Trash2 size={13} className="text-red-500" /></Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title={t.aiKeys.add}
        footer={<>
          <Button variant="secondary" onClick={() => setAdding(false)}>{t.app.cancel}</Button>
          <Button onClick={submit} loading={busy} disabled={!label.trim() || !apiKey.trim()}>{t.app.save}</Button>
        </>}>
        <div className="space-y-3">
          <Field label={t.aiKeys.provider} required>
            <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
              {(Object.keys(PROVIDER_LABEL) as Provider[]).map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
            </select>
          </Field>
          <Field label={t.aiKeys.label} required hint={t.aiKeys.labelHint}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="مفتاحي الرئيسي" />
          </Field>
          <Field label={t.aiKeys.apiKey} required>
            <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." dir="ltr" type="password" />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            {t.aiKeys.useAsDefault}
          </label>
        </div>
      </Modal>
    </>
  );
}
