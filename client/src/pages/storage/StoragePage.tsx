/**
 * StoragePage — disk-usage dashboard with breakdown, threshold config, and
 * manual force-cleanup button. The server-side `StorageMonitorService` runs
 * silently every 30 minutes; this page exposes its state to the operator
 * and lets them tune thresholds without redeploying.
 */
import { useEffect, useState } from 'react';
import { HardDrive, AlertTriangle, Trash2, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { PageHeader } from '../../components/ui/PageHeader';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input, Field } from '../../components/ui/Input';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

interface Status {
  usage: { media: number; sessions: number; exports: number; database: number; total: number };
  config: { thresholdGb: number; warningGb: number; gracePeriodDays: number };
  state: {
    phase: 'ok' | 'warning' | 'critical_warned' | 'cleanup_required';
    firstWarnedAt?: string;
    lastCleanupAt?: string;
    lastFreedBytes?: number;
  };
}

function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

export function StoragePage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // local form state for the threshold fields
  const [warningGb, setWarningGb] = useState(50);
  const [thresholdGb, setThresholdGb] = useState(60);
  const [gracePeriodDays, setGracePeriodDays] = useState(3);

  const load = async () => {
    try {
      setLoadError(null);
      const s = await api.get<Status>('/storage/status');
      setStatus(s);
      setWarningGb(s.config.warningGb);
      setThresholdGb(s.config.thresholdGb);
      setGracePeriodDays(s.config.gracePeriodDays);
    } catch (e: any) {
      setLoadError(e?.message ?? 'load_failed');
    }
  };
  useEffect(() => { load(); }, []);

  if (loadError) {
    return (
      <div className="m-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <div className="mb-2">{t.app.error}</div>
        <Button size="sm" variant="secondary" onClick={load}>{t.storage.refresh}</Button>
      </div>
    );
  }
  if (!status) return <div className="p-8 text-gray-400">{t.app.loading}</div>;

  const usedGb = status.usage.total / GB;
  const pct = Math.min(100, (status.usage.total / (status.config.thresholdGb * GB)) * 100);
  const phaseLabels: Record<Status['state']['phase'], string> = {
    ok: t.storage.phaseOk,
    warning: t.storage.phaseWarning,
    critical_warned: t.storage.phaseCritical,
    cleanup_required: t.storage.phaseCleanup,
  };
  const phaseColor: Record<Status['state']['phase'], string> = {
    ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    warning: 'bg-amber-50 text-amber-800 border-amber-300',
    critical_warned: 'bg-red-50 text-red-800 border-red-300',
    cleanup_required: 'bg-blue-50 text-blue-800 border-blue-300',
  };

  const saveCfg = async () => {
    setBusy(true);
    try {
      await api.patch('/storage/config', { warningGb, thresholdGb, gracePeriodDays });
      await load();
      toast.success(t.app.saved);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally { setBusy(false); }
  };

  const forceCleanup = async () => {
    if (!confirm(t.storage.confirmForce)) return;
    setBusy(true);
    try {
      const r = await api.post<{ summary: string; freedBytes: number }>('/storage/cleanup-now', {});
      toast.success(`${t.storage.cleanupDone}: ${formatBytes(r.freedBytes)}`);
      load();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally { setBusy(false); }
  };

  const daysSinceWarning = status.state.firstWarnedAt
    ? Math.floor((Date.now() - new Date(status.state.firstWarnedAt).getTime()) / 86_400_000)
    : null;
  const daysUntilCleanup = daysSinceWarning !== null
    ? Math.max(0, status.config.gracePeriodDays - daysSinceWarning)
    : null;

  return (
    <>
      <PageHeader
        title={t.storage.title}
        subtitle={t.storage.subtitle}
        actions={
          <Button variant="secondary" onClick={load}><RefreshCw size={14} /> {t.storage.refresh}</Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        {/* LEFT — gauge + breakdown */}
        <Card>
          <CardHeader>
            <span className="inline-flex items-center gap-2">
              <HardDrive size={16} className="text-brand-600" />
              {t.storage.usage}
            </span>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="space-y-1">
              <div className="flex items-baseline justify-between">
                <span className="text-3xl font-bold text-gray-900">{usedGb.toFixed(2)} <span className="text-base text-gray-500">GB</span></span>
                <span className="text-xs text-gray-500">/ {status.config.thresholdGb} GB</span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100">
                <div
                  className={`h-full transition-all ${
                    pct >= 100 ? 'bg-red-500'
                    : pct >= (status.config.warningGb / status.config.thresholdGb) * 100 ? 'bg-amber-500'
                    : 'bg-emerald-500'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>

            <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${phaseColor[status.state.phase]}`}>
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">{phaseLabels[status.state.phase]}</div>
                {status.state.phase === 'warning' && (
                  <div className="text-xs">{t.storage.warningHint}</div>
                )}
                {status.state.phase === 'critical_warned' && daysUntilCleanup !== null && (
                  <div className="text-xs">
                    {t.storage.cleanupIn} <strong>{daysUntilCleanup}</strong> {t.storage.days}
                  </div>
                )}
                {status.state.lastCleanupAt && (
                  <div className="mt-1 text-[11px] text-gray-600">
                    {t.storage.lastCleanup}: {new Date(status.state.lastCleanupAt).toLocaleString()}
                    {status.state.lastFreedBytes != null && ` (${formatBytes(status.state.lastFreedBytes)})`}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase text-gray-500">{t.storage.breakdown}</h4>
              <BreakdownRow label={t.storage.media}    bytes={status.usage.media} />
              <BreakdownRow label={t.storage.sessions} bytes={status.usage.sessions} />
              <BreakdownRow label={t.storage.exports}  bytes={status.usage.exports} />
              <BreakdownRow label={t.storage.database} bytes={status.usage.database} />
            </div>

            <div className="pt-2">
              <Button variant="secondary" onClick={forceCleanup} loading={busy}>
                <Trash2 size={14} /> {t.storage.forceCleanup}
              </Button>
              <p className="mt-1.5 text-[11px] text-gray-500">{t.storage.forceCleanupHint}</p>
            </div>
          </CardBody>
        </Card>

        {/* RIGHT — config */}
        <Card>
          <CardHeader>{t.storage.config}</CardHeader>
          <CardBody className="space-y-3">
            <Field label={t.storage.warningGb} hint={t.storage.warningGbHint}>
              <Input type="number" min={1} value={warningGb} onChange={(e) => setWarningGb(+e.target.value)} />
            </Field>
            <Field label={t.storage.thresholdGb} hint={t.storage.thresholdGbHint}>
              <Input type="number" min={1} value={thresholdGb} onChange={(e) => setThresholdGb(+e.target.value)} />
            </Field>
            <Field label={t.storage.gracePeriodDays} hint={t.storage.gracePeriodDaysHint}>
              <Input type="number" min={0} max={90} value={gracePeriodDays} onChange={(e) => setGracePeriodDays(+e.target.value)} />
            </Field>
            <Button onClick={saveCfg} loading={busy}>{t.app.save}</Button>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function BreakdownRow({ label, bytes }: { label: string; bytes: number }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-gray-700">{label}</span>
      <span className="font-mono text-gray-900">{formatBytes(bytes)}</span>
    </div>
  );
}
