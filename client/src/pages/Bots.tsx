import { useEffect, useState } from 'react';
import { Plus, Bot, Trash2, Edit2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { PageHeader } from '../components/ui/PageHeader';
import { Card, CardBody } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Input, Field, Textarea } from '../components/ui/Input';
import { Empty } from '../components/ui/Empty';

type BotItem = {
  id: string; name: string; description: string | null;
  isActive: boolean; priority: number;
  accounts: { account: { id: string; name: string } }[];
  _count: { steps: number };
};

export function BotsPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<BotItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const load = () => api.get<BotItem[]>('/bots').then(setItems);
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!name.trim()) return;
    try {
      await api.post('/bots', { name: name.trim(), description: description.trim() || undefined });
      setName(''); setDescription(''); setCreating(false);
      await load();
      toast.success(t.app.saved);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.save);
    }
  };
  const remove = async (id: string) => {
    if (!confirm(t.app.delete + '?')) return;
    try {
      await api.delete(`/bots/${id}`);
      await load();
      toast.success(t.app.saved);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.delete);
    }
  };
  const toggle = async (b: BotItem) => {
    try {
      await api.patch(`/bots/${b.id}`, { isActive: !b.isActive });
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.save);
    }
  };

  return (
    <>
      <PageHeader title={t.bots.title} actions={<Button onClick={() => setCreating(true)}><Plus size={16} />{t.bots.create}</Button>} />

      {items.length === 0 ? (
        <Card><Empty icon={<Bot size={36} />} /></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {items.map((b) => (
            <Card key={b.id}>
              <CardBody>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <Link to={`/bots/${b.id}`} className="font-semibold text-gray-900 hover:text-brand-600">{b.name}</Link>
                    {b.description && <div className="mt-1 text-xs text-gray-500 line-clamp-2">{b.description}</div>}
                  </div>
                  <label className="relative inline-flex cursor-pointer items-center">
                    <input type="checkbox" className="peer sr-only" checked={b.isActive} onChange={() => toggle(b)} />
                    <div className="h-5 w-9 rounded-full bg-gray-200 peer-checked:bg-brand-500 transition" />
                    <div className="absolute start-0.5 top-0.5 h-4 w-4 rounded-full bg-white peer-checked:translate-x-4 rtl:peer-checked:-translate-x-4 transition" />
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-1 text-xs text-gray-500">
                  {b.accounts.length === 0 ? (
                    <span className="text-gray-400">— {t.bots.linkAccounts}</span>
                  ) : b.accounts.map((a) => (
                    <span key={a.account.id} className="rounded bg-gray-100 px-2 py-0.5">{a.account.name}</span>
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-xs text-gray-500">{t.bots.nodesCount}: <b>{b._count.steps}</b></span>
                  <div className="flex gap-1">
                    <Link to={`/bots/${b.id}`}><Button size="sm" variant="ghost"><Edit2 size={14} /></Button></Link>
                    <Button size="sm" variant="ghost" onClick={() => remove(b.id)}><Trash2 size={14} className="text-red-500" /></Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={creating} onClose={() => setCreating(false)} title={t.bots.create}
        footer={<><Button variant="secondary" onClick={() => setCreating(false)}>{t.app.cancel}</Button><Button onClick={create}>{t.app.create}</Button></>}
      >
        <div className="space-y-3">
          <Field label={t.bots.name} required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label={t.bots.description}><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
      </Modal>
    </>
  );
}
