import { useEffect, useState } from 'react';
import { Plus, Smartphone, Trash2, Power, RotateCw, LogOut, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { events } from '../api/sse';
import { useI18n } from '../i18n';
import { PageHeader } from '../components/ui/PageHeader';
import { Card, CardBody } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Input, Field } from '../components/ui/Input';
import { Empty } from '../components/ui/Empty';
import { StatusPill } from '../components/domain/StatusPill';
import { QRConnectModal } from '../components/domain/QRConnectModal';

type Account = {
  id: string; name: string; phoneNumber: string | null; status: string;
  ignoreGroups: boolean; dailySendCap: number; lastError: string | null;
};

export function AccountsPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<Account[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scanning, setScanning] = useState<{ id: string; name: string } | null>(null);

  const load = () => api.get<Account[]>('/accounts').then(setItems);

  useEffect(() => {
    load();
    return events.on((e) => {
      if (e.type === 'account.status') load();
    });
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    try {
      await api.post('/accounts', { name: name.trim() });
      setName(''); setCreating(false);
      await load();
      toast.success(t.app.saved);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    }
  };

  const remove = async (id: string) => {
    if (!confirm(t.accounts.deleteConfirm)) return;
    try {
      await api.delete(`/accounts/${id}`);
      await load();
      toast.success(t.app.saved);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    }
  };

  const connect = (a: Account) => { setScanning({ id: a.id, name: a.name }); };
  const disconnect = async (id: string) => {
    try {
      await api.post(`/accounts/${id}/disconnect`);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    }
  };
  const logout = async (id: string) => {
    if (!confirm(t.accounts.logout + '?')) return;
    try {
      await api.post(`/accounts/${id}/logout`);
      await load();
      toast.success(t.app.saved);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    }
  };

  return (
    <>
      <PageHeader
        title={t.accounts.title}
        actions={<Button onClick={() => setCreating(true)}><Plus size={16} />{t.accounts.create}</Button>}
      />

      {items.length === 0 ? (
        <Card><Empty icon={<Smartphone size={36} />} title={t.app.empty} /></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {items.map((a) => (
            <Card key={a.id}>
              <CardBody>
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/accounts/${a.id}`} className="min-w-0 flex-1">
                    <div className="font-semibold text-gray-900 hover:text-brand-600">{a.name}</div>
                    <div className="text-xs text-gray-500">{a.phoneNumber ?? '—'}</div>
                  </Link>
                  <StatusPill status={a.status} />
                </div>
                {a.lastError && (
                  <div className="mt-2 flex items-start gap-1 text-xs text-red-600">
                    <AlertCircle size={12} className="mt-0.5 shrink-0" />
                    <span className="truncate">{a.lastError}</span>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {a.status !== 'connected' && a.status !== 'connecting' && a.status !== 'qr_required' && (
                    <Button size="sm" onClick={() => connect(a)}><Power size={14} />{t.accounts.connect}</Button>
                  )}
                  {(a.status === 'connecting' || a.status === 'qr_required') && (
                    <Button size="sm" onClick={() => connect(a)}><Power size={14} />{t.accounts.connect}</Button>
                  )}
                  {(a.status === 'connected' || a.status === 'connecting' || a.status === 'qr_required') && (
                    <Button size="sm" variant="secondary" onClick={() => disconnect(a.id)}>
                      <RotateCw size={14} />{t.accounts.disconnect}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => logout(a.id)}><LogOut size={14} /></Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(a.id)}><Trash2 size={14} className="text-red-500" /></Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={t.accounts.create}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>{t.app.cancel}</Button>
            <Button onClick={create}>{t.app.create}</Button>
          </>
        }
      >
        <Field label={t.app.name} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.accounts.namePlaceholder} autoFocus />
        </Field>
      </Modal>

      <QRConnectModal
        open={!!scanning}
        accountId={scanning?.id ?? null}
        accountName={scanning?.name ?? ''}
        onClose={() => { setScanning(null); load(); }}
      />
    </>
  );
}
