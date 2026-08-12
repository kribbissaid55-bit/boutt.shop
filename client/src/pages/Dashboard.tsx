import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Smartphone, Wifi, WifiOff, Bot, AlertTriangle, HardDrive } from 'lucide-react';
import { api } from '../api/client';
import { events } from '../api/sse';
import { useI18n } from '../i18n';
import { PageHeader } from '../components/ui/PageHeader';
import { Card, CardBody } from '../components/ui/Card';

type Stats = {
  accounts: number;
  connectedAccounts: number;
  disconnectedAccounts: number;
  bots: number;
  activeBots: number;
};

interface StorageStatus {
  usage: { total: number };
  config: { thresholdGb: number; warningGb: number; gracePeriodDays: number };
  state: { phase: 'ok' | 'warning' | 'critical_warned' | 'cleanup_required'; firstWarnedAt?: string };
}

export function DashboardPage() {
  const { t } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);

  // Silent-catch here is intentional: the dashboard polls on SSE ticks and we
  // don't want a transient network blip to spam toasts. Errors still surface
  // in the browser network console. When stats never resolve, cards show 0.
  const load = () => api.get<Stats>('/dashboard/stats').then(setStats).catch((e) => {
    console.warn('[Dashboard] load stats failed', e);
  });
  const loadStorage = () => api.get<StorageStatus>('/storage/status').then(setStorage).catch((e) => {
    console.warn('[Dashboard] load storage failed', e);
  });

  useEffect(() => {
    load();
    loadStorage();
    return events.on((e) => {
      if (e.type === 'message.in' || e.type === 'account.status') load();
    });
  }, []);

  const StatCard = ({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) => (
    <Card>
      <CardBody className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${color}`}>{icon}</div>
        <div>
          <div className="text-2xl font-bold leading-none">{value}</div>
          <div className="mt-1 text-xs text-gray-500">{label}</div>
        </div>
      </CardBody>
    </Card>
  );

  const GB = 1024 ** 3;
  const usedGb = (storage?.usage.total ?? 0) / GB;
  const showBanner = storage && storage.state.phase !== 'ok';
  const bannerColor =
    storage?.state.phase === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-900'
    : storage?.state.phase === 'critical_warned' ? 'bg-red-50 border-red-300 text-red-900'
    : storage?.state.phase === 'cleanup_required' ? 'bg-blue-50 border-blue-300 text-blue-900'
    : '';
  const daysSinceWarning = storage?.state.firstWarnedAt
    ? Math.floor((Date.now() - new Date(storage.state.firstWarnedAt).getTime()) / 86_400_000)
    : null;
  const daysUntilCleanup = daysSinceWarning !== null && storage
    ? Math.max(0, storage.config.gracePeriodDays - daysSinceWarning)
    : null;

  return (
    <>
      <PageHeader title={t.dashboard.title} />
      {showBanner && storage && (
        <div className={`mb-4 flex items-start gap-3 rounded-lg border px-4 py-3 ${bannerColor}`}>
          <AlertTriangle size={20} className="mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-semibold">
              {storage.state.phase === 'warning' && t.dashboard.storageWarning}
              {storage.state.phase === 'critical_warned' && t.dashboard.storageCritical}
              {storage.state.phase === 'cleanup_required' && t.dashboard.storageCleanup}
            </div>
            <div className="mt-0.5 text-sm">
              {t.dashboard.storageUsage}: <strong>{usedGb.toFixed(2)} GB</strong> / {storage.config.thresholdGb} GB
              {storage.state.phase === 'critical_warned' && daysUntilCleanup !== null && (
                <span>{' '}— {t.dashboard.storageCleanupIn} <strong>{daysUntilCleanup}</strong> {t.dashboard.storageDays}</span>
              )}
            </div>
          </div>
          <Link to="/storage" className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-gray-50">
            <HardDrive size={14} /> {t.dashboard.storageManage}
          </Link>
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatCard icon={<Smartphone size={20} className="text-blue-700" />} label={t.dashboard.accountsTotal} value={stats?.accounts ?? 0} color="bg-blue-50" />
        <StatCard icon={<Wifi size={20} className="text-green-700" />} label={t.dashboard.connected} value={stats?.connectedAccounts ?? 0} color="bg-green-50" />
        <StatCard icon={<WifiOff size={20} className="text-gray-600" />} label={t.dashboard.disconnected} value={stats?.disconnectedAccounts ?? 0} color="bg-gray-100" />
        <StatCard icon={<Bot size={20} className="text-purple-700" />} label={t.dashboard.botsTotal} value={stats?.bots ?? 0} color="bg-purple-50" />
        <StatCard icon={<Bot size={20} className="text-brand-700" />} label={t.dashboard.activeBots} value={stats?.activeBots ?? 0} color="bg-brand-50" />
      </div>

    </>
  );
}
