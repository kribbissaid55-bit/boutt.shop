import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { PageHeader } from '../components/ui/PageHeader';
import { Card, CardBody } from '../components/ui/Card';
import { Empty } from '../components/ui/Empty';

type LogEntry = { id: string; level: string; scope: string; accountId: string | null; message: string; meta: string | null; createdAt: string };

export function LogsPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState('');
  const [scope, setScope] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    const qs = new URLSearchParams();
    if (level) qs.set('level', level);
    if (scope) qs.set('scope', scope);
    setLoading(true);
    try {
      const rows = await api.get<LogEntry[]>(`/logs?${qs}`);
      setItems(rows);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to load logs');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [level, scope]);

  const colors: Record<string, string> = {
    error: 'text-red-600 bg-red-50',
    warn: 'text-amber-600 bg-amber-50',
    info: 'text-blue-600 bg-blue-50',
  };

  return (
    <>
      <PageHeader title={t.logs.title} />
      <Card className="mb-4">
        <CardBody className="flex flex-wrap gap-3">
          <select className="rounded-lg border border-gray-200 px-3 py-2 text-sm" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">{t.contacts.all} ({t.logs.level})</option>
            <option value="error">error</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
          </select>
          <select className="rounded-lg border border-gray-200 px-3 py-2 text-sm" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">{t.contacts.all} ({t.logs.scope})</option>
            <option value="adapter">adapter</option>
            <option value="engine">engine</option>
            <option value="api">api</option>
            <option value="queue">queue</option>
          </select>
        </CardBody>
      </Card>

      {items.length === 0 ? (
        <Card><Empty /></Card>
      ) : (
        <Card>
          <CardBody className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 text-xs uppercase text-gray-500">
                <tr>
                  <th className="p-3 text-start">{t.logs.time}</th>
                  <th className="p-3 text-start">{t.logs.level}</th>
                  <th className="p-3 text-start">{t.logs.scope}</th>
                  <th className="p-3 text-start">{t.logs.message}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l) => (
                  <tr key={l.id} className="border-b border-gray-50">
                    <td className="p-3 text-xs text-gray-500">{new Date(l.createdAt).toLocaleString()}</td>
                    <td className="p-3"><span className={`rounded px-2 py-0.5 text-xs font-medium ${colors[l.level] ?? 'bg-gray-50 text-gray-600'}`}>{l.level}</span></td>
                    <td className="p-3 text-xs text-gray-500">{l.scope}</td>
                    <td className="p-3 text-gray-800">{l.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </>
  );
}
