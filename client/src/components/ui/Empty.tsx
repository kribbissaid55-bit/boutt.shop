import { Inbox } from 'lucide-react';
import { useI18n } from '../../i18n';

export function Empty({ icon, title, hint }: { icon?: React.ReactNode; title?: string; hint?: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center text-gray-500">
      <div className="mb-3 text-gray-300">{icon ?? <Inbox size={36} />}</div>
      <p className="text-sm font-medium">{title ?? t.app.empty}</p>
      {hint && <p className="mt-1 max-w-md text-xs text-gray-400">{hint}</p>}
    </div>
  );
}
