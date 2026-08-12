import clsx from 'clsx';
import { useI18n } from '../../i18n';

export function StatusPill({ status }: { status: string }) {
  const { t } = useI18n();
  const map: Record<string, { cls: string; label: string }> = {
    connected:    { cls: 'bg-green-50 text-green-700 border-green-200', label: t.accounts.statuses.connected },
    connecting:   { cls: 'bg-blue-50 text-blue-700 border-blue-200',   label: t.accounts.statuses.connecting },
    qr_required:  { cls: 'bg-amber-50 text-amber-700 border-amber-200', label: t.accounts.statuses.qr_required },
    disconnected: { cls: 'bg-gray-50 text-gray-700 border-gray-200',   label: t.accounts.statuses.disconnected },
    error:        { cls: 'bg-red-50 text-red-700 border-red-200',     label: t.accounts.statuses.error },
  };
  const m = map[status] ?? { cls: 'bg-gray-50 text-gray-700 border-gray-200', label: status };
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', m.cls)}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', status === 'connected' ? 'bg-green-500' : status === 'qr_required' ? 'bg-amber-500' : status === 'connecting' ? 'bg-blue-500' : status === 'error' ? 'bg-red-500' : 'bg-gray-400')} />
      {m.label}
    </span>
  );
}
