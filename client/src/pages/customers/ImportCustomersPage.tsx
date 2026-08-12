import { useEffect, useRef, useState } from 'react';
import { Upload, ArrowRight, ArrowLeft, CheckCircle2, AlertCircle, FileSpreadsheet } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { PageHeader } from '../../components/ui/PageHeader';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input, Field } from '../../components/ui/Input';

interface UploadResult {
  uploadId: string;
  fileName: string;
  headers: string[];
  rowCount: number;
  preview: Record<string, string>[];
  autoMapping: Record<string, string>;
}

interface PreviewResult {
  valid: number;
  newCount: number;
  updateCount: number;
  errors: { row: number; reason: string }[];
}

interface Account { id: string; name: string }

const FIELD_KEYS = ['phone', 'name', 'city', 'address', 'status', 'tags', 'notes', 'source', 'campaign'] as const;

export function ImportCustomersPage() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [importTag, setImportTag] = useState('');
  const [behavior, setBehavior] = useState<'skip_existing' | 'update_existing' | 'merge_tags'>('skip_existing');
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<Account[]>('/accounts').then((a) => {
      setAccounts(a);
      if (a[0]) setAccountId(a[0].id);
    });
  }, []);

  const Back = lang === 'ar' ? ArrowRight : ArrowLeft;

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/customers/import/upload', { method: 'POST', credentials: 'include', body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as UploadResult;
      setUpload(data);
      setMapping(data.autoMapping);
      setStep(2);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const runPreview = async () => {
    if (!upload || !mapping.phone) {
      toast.error(t.imports.phoneRequired);
      return;
    }
    setBusy(true);
    try {
      const data = await api.post<PreviewResult>('/customers/import/preview', {
        uploadId: upload.uploadId,
        mapping,
        defaultAccountId: accountId,
      });
      setPreview(data);
      setStep(4);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!upload) return;
    setBusy(true);
    try {
      const data = await api.post('/customers/import/confirm', {
        uploadId: upload.uploadId,
        mapping,
        accountId,
        behavior,
        importTag: importTag.trim() || undefined,
        source: upload.fileName.endsWith('.csv') ? 'csv' : 'excel',
      });
      setResult(data);
      setStep(5);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally { setBusy(false); }
  };

  return (
    <>
      <button onClick={() => nav('/customers')} className="mb-3 flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <Back size={14} /> {t.app.back}
      </button>
      <PageHeader title={t.imports.title} subtitle={t.imports.subtitle} />

      <div className="mb-6 flex items-center gap-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <div key={n} className="flex flex-1 items-center gap-2">
            <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
              step >= n ? 'bg-brand-500 text-white' : 'bg-gray-200 text-gray-500'
            }`}>{n}</div>
            {n < 5 && <div className={`h-0.5 flex-1 ${step > n ? 'bg-brand-500' : 'bg-gray-200'}`} />}
          </div>
        ))}
      </div>

      {step === 1 && (
        <Card>
          <CardHeader>{t.imports.step1Title}</CardHeader>
          <CardBody className="space-y-3">
            <Field label={t.imports.targetAccount} required>
              <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <input ref={fileRef} type="file" className="hidden" onChange={onFile} accept=".xlsx,.xls,.csv" />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy || !accountId}
              className="flex h-32 w-full items-center justify-center gap-3 rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 text-gray-500 hover:border-brand-500 hover:bg-brand-50 disabled:opacity-50"
            >
              <Upload size={28} />
              <span>{busy ? t.app.loading : t.imports.dropHere}</span>
            </button>
            <p className="text-xs text-gray-500">{t.imports.fileFormats}</p>
          </CardBody>
        </Card>
      )}

      {step === 2 && upload && (
        <Card>
          <CardHeader actions={
            <Button onClick={() => setStep(3)} disabled={!mapping.phone}>{t.imports.next} <ArrowRight size={14} /></Button>
          }>
            {t.imports.step2Title} — {upload.fileName} · {upload.rowCount} {t.imports.rowsLabel}
          </CardHeader>
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  {upload.headers.map((h) => <th key={h} className="border-b border-gray-100 p-2 text-start">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {upload.preview.slice(0, 10).map((row, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    {upload.headers.map((h) => (
                      <td key={h} className="p-2 text-gray-700">{row[h]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {step === 3 && upload && (
        <Card>
          <CardHeader actions={
            <Button onClick={runPreview} loading={busy} disabled={!mapping.phone}>{t.imports.validateBtn}</Button>
          }>
            {t.imports.step3Title}
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-xs text-gray-500">{t.imports.mappingHint}</p>
            <div className="grid gap-2 md:grid-cols-2">
              {FIELD_KEYS.map((key) => (
                <Field key={key} label={`${key}${key === 'phone' ? ' *' : ''}`}>
                  <select
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    value={mapping[key] ?? ''}
                    onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}
                  >
                    <option value="">— {t.imports.notMapped} —</option>
                    {upload.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </Field>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {step === 4 && preview && (
        <Card>
          <CardHeader actions={
            <Button onClick={confirm} loading={busy}>{t.imports.confirmBtn}</Button>
          }>
            {t.imports.step4Title}
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <Stat label={t.imports.validRows} value={preview.valid} cls="bg-blue-50 text-blue-700" />
              <Stat label={t.imports.newCount} value={preview.newCount} cls="bg-emerald-50 text-emerald-700" />
              <Stat label={t.imports.updateCount} value={preview.updateCount} cls="bg-amber-50 text-amber-700" />
            </div>
            {preview.errors.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs">
                <div className="mb-1 flex items-center gap-1 font-bold text-red-700">
                  <AlertCircle size={12} /> {preview.errors.length} {t.imports.errorsFound}
                </div>
                <ul className="max-h-48 overflow-y-auto text-red-700">
                  {preview.errors.slice(0, 30).map((e, i) => (
                    <li key={i}>Row {e.row}: {e.reason}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t.imports.behaviorTitle}>
                <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={behavior} onChange={(e) => setBehavior(e.target.value as any)}>
                  <option value="skip_existing">{t.imports.behavior_skip}</option>
                  <option value="update_existing">{t.imports.behavior_update}</option>
                  <option value="merge_tags">{t.imports.behavior_merge}</option>
                </select>
              </Field>
              <Field label={t.imports.importTagOptional}>
                <Input value={importTag} onChange={(e) => setImportTag(e.target.value)} placeholder="lead2025" />
              </Field>
            </div>
          </CardBody>
        </Card>
      )}

      {step === 5 && result && (
        <Card>
          <CardBody className="space-y-3 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50">
              <CheckCircle2 size={36} className="text-emerald-500" />
            </div>
            <div className="text-lg font-semibold">{t.imports.successTitle}</div>
            <div className="grid gap-2 text-sm md:grid-cols-4">
              <Stat label={t.imports.newCount} value={result.importedRows} cls="bg-emerald-50 text-emerald-700" />
              <Stat label={t.imports.updateCount} value={result.updatedRows} cls="bg-amber-50 text-amber-700" />
              <Stat label={t.imports.skipped} value={result.skippedRows} cls="bg-gray-100 text-gray-600" />
              <Stat label={t.imports.failed} value={result.failedRows} cls="bg-red-50 text-red-600" />
            </div>
            <div className="flex justify-center gap-2 pt-3">
              <Button variant="secondary" onClick={() => { setStep(1); setUpload(null); setPreview(null); setResult(null); }}>
                {t.imports.importAnother}
              </Button>
              <Button onClick={() => nav('/customers')}><FileSpreadsheet size={14} /> {t.customers.title}</Button>
            </div>
          </CardBody>
        </Card>
      )}
    </>
  );
}

function Stat({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={`rounded-lg p-3 text-center ${cls}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}
