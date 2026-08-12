/**
 * ProductsPage — owner's catalog. Each product carries name, price, description,
 * tags, and references to MediaFile rows (image/video/audio for display).
 * Linked into bots from the AI section so the AI engine can quote prices and
 * send the right media when customers ask.
 */
import { useEffect, useState } from 'react';
import { Plus, Package, Trash2, Edit3, X, Image as ImageIcon, Mic, Video, FileText } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { PageHeader } from '../../components/ui/PageHeader';
import { Card, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Input, Field, Textarea } from '../../components/ui/Input';
import { Empty } from '../../components/ui/Empty';
import { MediaPickerModal } from '../builder/parts/MediaPickerModal';

interface Product {
  id: string;
  name: string;
  description: string | null;
  price: string | null;
  currency: string | null;
  sku: string | null;
  tags: string[];
  mediaIds: string[];
  isActive: boolean;
  notes: string | null;
}

interface Media { id: string; name: string; type: string }

export function ProductsPage() {
  const { t } = useI18n();
  const [products, setProducts] = useState<Product[]>([]);
  const [editing, setEditing] = useState<Product | null>(null);
  const [adding, setAdding] = useState(false);

  const load = () => api.get<Product[]>('/products').then(setProducts);
  useEffect(() => { load(); }, []);

  const remove = async (id: string) => {
    if (!confirm(t.app.delete + '?')) return;
    await api.delete(`/products/${id}`);
    load();
  };

  return (
    <>
      <PageHeader
        title={t.products.title}
        subtitle={t.products.subtitle}
        actions={<Button onClick={() => setAdding(true)}><Plus size={14} /> {t.products.add}</Button>}
      />

      {products.length === 0 ? (
        <Card>
          <CardBody>
            <Empty
              title={t.products.emptyTitle}
              hint={t.products.emptyHint}
              icon={<Package size={28} />}
            />
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <Card key={p.id}>
              <CardBody className="space-y-2">
                <ProductPreview product={p} />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-gray-900">{p.name}</div>
                    {p.price && (
                      <div className="mt-0.5 text-sm font-medium text-brand-700">
                        {p.price} {p.currency ?? ''}
                      </div>
                    )}
                    {p.description && (
                      <div className="mt-1 line-clamp-2 text-xs text-gray-500">{p.description}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button onClick={() => setEditing(p)} className="rounded p-1 text-gray-500 hover:bg-gray-100">
                      <Edit3 size={13} />
                    </button>
                    <button onClick={() => remove(p.id)} className="rounded p-1 text-red-500 hover:bg-red-50">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {p.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {p.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600">{tag}</span>
                    ))}
                  </div>
                )}
                {!p.isActive && (
                  <div className="text-[10px] font-medium text-amber-700">⚠ {t.products.inactive}</div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <ProductEditor
        open={adding || !!editing}
        editing={editing}
        onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={() => { setAdding(false); setEditing(null); load(); }}
      />
    </>
  );
}

function ProductPreview({ product }: { product: Product }) {
  const [media, setMedia] = useState<Media | null>(null);

  useEffect(() => {
    if (!product.mediaIds.length) { setMedia(null); return; }
    api.get<Media[]>('/media').then((all) => {
      setMedia(all.find((m) => m.id === product.mediaIds[0]) ?? null);
    });
  }, [product.mediaIds]);

  if (!media) {
    return (
      <div className="flex h-32 items-center justify-center rounded-md bg-gray-50 text-gray-400">
        <Package size={24} />
      </div>
    );
  }
  if (media.type === 'image') {
    return <img src={`/api/media/${media.id}/raw`} className="h-32 w-full rounded-md object-cover" />;
  }
  if (media.type === 'video') {
    return <video src={`/api/media/${media.id}/raw`} className="h-32 w-full rounded-md bg-black object-contain" />;
  }
  return (
    <div className="flex h-32 items-center justify-center rounded-md bg-gray-50 text-gray-400">
      {media.type === 'audio' ? <Mic size={24} /> : <FileText size={24} />}
    </div>
  );
}

function ProductEditor({ open, editing, onClose, onSaved }: {
  open: boolean; editing: Product | null; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('');
  const [description, setDescription] = useState('');
  const [sku, setSku] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [mediaIndex, setMediaIndex] = useState<Map<string, Media>>(new Map());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setPrice(editing?.price ?? '');
    setCurrency(editing?.currency ?? '');
    setDescription(editing?.description ?? '');
    setSku(editing?.sku ?? '');
    setTagsText((editing?.tags ?? []).join(', '));
    setMediaIds(editing?.mediaIds ?? []);
    setNotes(editing?.notes ?? '');
    setIsActive(editing?.isActive ?? true);
    api.get<Media[]>('/media').then((all) => {
      const m = new Map<string, Media>();
      all.forEach((x) => m.set(x.id, x));
      setMediaIndex(m);
    });
  }, [open, editing]);

  const save = async () => {
    if (!name.trim()) { toast.error(t.products.nameRequired); return; }
    setBusy(true);
    try {
      const tags = tagsText.split(',').map((x) => x.trim()).filter(Boolean);
      const payload = {
        name: name.trim(),
        price: price.trim() || null,
        currency: currency.trim() || null,
        description: description.trim() || null,
        sku: sku.trim() || null,
        tags,
        mediaIds,
        isActive,
        notes: notes.trim() || null,
      };
      if (editing) await api.patch(`/products/${editing.id}`, payload);
      else await api.post('/products', payload);
      toast.success(t.app.saved);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally { setBusy(false); }
  };

  const removeMedia = (id: string) => setMediaIds((prev) => prev.filter((x) => x !== id));
  const addMedia = (id: string) => {
    setMediaIds((prev) => prev.includes(id) ? prev : [...prev, id]);
    setPickerOpen(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? t.products.edit : t.products.add} wide
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t.app.cancel}</Button>
        <Button onClick={save} loading={busy}>{t.app.save}</Button>
      </>}>
      <div className="space-y-3">
        <Field label={t.products.name} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t.products.price}>
            <Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="199" />
          </Field>
          <Field label={t.products.currency}>
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="د.م" />
          </Field>
          <Field label={t.products.sku}>
            <Input value={sku} onChange={(e) => setSku(e.target.value)} />
          </Field>
        </div>
        <Field label={t.products.description}>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={t.products.tags} hint={t.products.tagsHint}>
          <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="رجالي, شتوي, جديد" />
        </Field>

        <Field label={t.products.media}>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {mediaIds.map((id) => {
                const m = mediaIndex.get(id);
                if (!m) return null;
                const Icon = m.type === 'image' ? ImageIcon : m.type === 'video' ? Video : m.type === 'audio' ? Mic : FileText;
                return (
                  <span key={id} className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs">
                    <Icon size={11} /> {m.name}
                    <button onClick={() => removeMedia(id)} className="text-red-500 hover:text-red-700"><X size={11} /></button>
                  </span>
                );
              })}
            </div>
            <Button variant="secondary" onClick={() => setPickerOpen(true)}>+ {t.products.addMedia}</Button>
          </div>
        </Field>

        <Field label={t.products.notes} hint={t.products.notesHint}>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          {t.products.active}
        </label>
      </div>

      <MediaPickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={addMedia} />
    </Modal>
  );
}
