import { useEffect, useState } from 'react';
import { Plus, Trash2, Edit2, Search, Hash, Tag } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { PageHeader } from '../../components/ui/PageHeader';
import { Card, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Input, Field, Textarea } from '../../components/ui/Input';
import { Empty } from '../../components/ui/Empty';

interface SavedReply {
  id: string;
  title: string;
  category: string | null;
  text: string | null;
  shortcut: string | null;
  isActive: boolean;
  mediaIds: string | null;
  tags: string | null;
  createdAt: string;
  updatedAt: string;
}

export function SavedRepliesPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<SavedReply[]>([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<SavedReply | null>(null);
  const [adding, setAdding] = useState(false);

  const load = () => {
    const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
    api.get<SavedReply[]>(`/saved-replies${qs}`).then(setItems);
  };
  useEffect(() => {
    const tm = setTimeout(load, 200);
    return () => clearTimeout(tm);
  }, [search]);

  const remove = async (id: string) => {
    if (!confirm(t.app.delete + '?')) return;
    await api.delete(`/saved-replies/${id}`);
    load();
  };
  const toggle = async (r: SavedReply) => {
    await api.patch(`/saved-replies/${r.id}`, { isActive: !r.isActive });
    load();
  };

  const grouped = (() => {
    const groups: Record<string, SavedReply[]> = {};
    for (const r of items) {
      const key = r.category ?? '—';
      (groups[key] ??= []).push(r);
    }
    return groups;
  })();

  return (
    <>
      <PageHeader
        title={t.savedReplies.title}
        subtitle={t.savedReplies.subtitle}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus size={16} /> {t.savedReplies.create}
          </Button>
        }
      />

      <Card className="mb-4">
        <CardBody>
          <div className="relative">
            <Search size={16} className="absolute start-3 top-2.5 text-gray-400" />
            <Input className="ps-9" placeholder={t.app.search} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </CardBody>
      </Card>

      {items.length === 0 ? (
        <Card><Empty title={t.savedReplies.emptyTitle} hint={t.savedReplies.emptyHint} /></Card>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([cat, list]) => (
            <div key={cat}>
              <div className="mb-2 flex items-center gap-1 text-xs font-bold uppercase text-gray-500">
                <Tag size={10} />{cat}
              </div>
              <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                {list.map((r) => (
                  <Card key={r.id}>
                    <CardBody>
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-gray-900">{r.title}</div>
                          {r.shortcut && (
                            <div className="mt-0.5 flex items-center gap-0.5 text-[11px] text-brand-600">
                              <Hash size={10} /><span className="font-mono">{r.shortcut}</span>
                            </div>
                          )}
                        </div>
                        <label className="relative inline-flex cursor-pointer items-center">
                          <input type="checkbox" className="peer sr-only" checked={r.isActive} onChange={() => toggle(r)} />
                          <div className={clsx(
                            'h-4 w-7 rounded-full transition',
                            r.isActive ? 'bg-brand-500' : 'bg-gray-200',
                          )} />
                          <div className={clsx(
                            'absolute start-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition',
                            r.isActive ? 'translate-x-3 rtl:-translate-x-3' : '',
                          )} />
                        </label>
                      </div>
                      <div className="line-clamp-3 text-xs text-gray-600">{r.text ?? <em className="text-gray-400">—</em>}</div>
                      <div className="mt-2 flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Edit2 size={12} /></Button>
                        <Button size="sm" variant="ghost" onClick={() => remove(r.id)}><Trash2 size={12} className="text-red-500" /></Button>
                      </div>
                    </CardBody>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <SavedReplyEditor
        open={adding || !!editing}
        editing={editing}
        onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={() => { setAdding(false); setEditing(null); load(); }}
      />
    </>
  );
}

function SavedReplyEditor({ open, editing, onClose, onSaved }: {
  open: boolean;
  editing: SavedReply | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [shortcut, setShortcut] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(editing?.title ?? '');
      setText(editing?.text ?? '');
      setCategory(editing?.category ?? '');
      setShortcut(editing?.shortcut ?? '');
    }
  }, [open, editing]);

  const save = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const payload = {
        title: title.trim(),
        text: text.trim() || null,
        category: category.trim() || null,
        shortcut: shortcut.trim() || null,
      };
      if (editing) await api.patch(`/saved-replies/${editing.id}`, payload);
      else await api.post('/saved-replies', payload);
      toast.success(t.app.saved);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t.app.edit : t.savedReplies.create}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t.app.cancel}</Button>
          <Button onClick={save} loading={busy} disabled={!title.trim()}>{t.app.save}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t.savedReplies.titleField} required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t.savedReplies.category}>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="السعر، التوصيل، ..." />
          </Field>
          <Field label={t.savedReplies.shortcut} hint={t.savedReplies.shortcutHint}>
            <Input value={shortcut} onChange={(e) => setShortcut(e.target.value)} placeholder="/price" />
          </Field>
        </div>
        <Field label={t.savedReplies.text}>
          <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="..." />
        </Field>
      </div>
    </Modal>
  );
}
