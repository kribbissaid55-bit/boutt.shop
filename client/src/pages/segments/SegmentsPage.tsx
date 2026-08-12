import { useEffect, useState } from 'react';
import { Plus, Trash2, Copy, Eye, Filter, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { PageHeader } from '../../components/ui/PageHeader';
import { Card, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Input, Field, Textarea } from '../../components/ui/Input';
import { Empty } from '../../components/ui/Empty';

interface Clause { field: string; op: string; value: any }
interface DSL { all?: Clause[]; any?: Clause[] }
interface Segment { id: string; name: string; description: string | null; filters: DSL; createdAt: string }

const FIELDS = [
  { key: 'status',                   label: 'الحالة' },
  { key: 'accountId',                label: 'حساب واتساب' },
  { key: 'city',                     label: 'المدينة' },
  { key: 'tags',                     label: 'وسوم' },
  { key: 'doNotContact',             label: 'منع المراسلة' },
  { key: 'lastInteractionAt',        label: 'آخر تفاعل' },
  { key: 'firstMessageAt',           label: 'أول رسالة' },
  { key: 'hasOrder',                 label: 'لديه طلب' },
  { key: 'source',                   label: 'المصدر' },
  { key: 'importBatchId',            label: 'دفعة الاستيراد' },
];

const OPS_PER_FIELD: Record<string, string[]> = {
  status:               ['eq', 'neq', 'in', 'not_in'],
  accountId:            ['eq', 'in', 'not_in'],
  city:                 ['eq', 'neq', 'in'],
  tags:                 ['contains_any'],
  doNotContact:         ['eq'],
  lastInteractionAt:    ['older_than_hours', 'younger_than_hours'],
  firstMessageAt:       ['older_than_hours', 'younger_than_hours'],
  hasOrder:             ['eq'],
  source:               ['eq', 'in'],
  importBatchId:        ['eq', 'in'],
};

const OP_LABEL: Record<string, string> = {
  eq: '=', neq: '≠', in: 'ضمن', not_in: 'ليس ضمن',
  contains_any: 'يحتوي على', older_than_hours: 'أقدم من (س)',
  younger_than_hours: 'أحدث من (س)', between: 'بين', exists: 'موجود',
};

export function SegmentsPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<Segment[]>([]);
  const [editing, setEditing] = useState<Segment | null>(null);
  const [adding, setAdding] = useState(false);

  const load = () => api.get<Segment[]>('/segments').then(setItems);
  useEffect(() => { load(); }, []);

  const remove = async (id: string) => {
    if (!confirm(t.app.delete + '?')) return;
    await api.delete(`/segments/${id}`); load();
  };
  const duplicate = async (id: string) => {
    await api.post(`/segments/${id}/duplicate`); load();
  };

  return (
    <>
      <PageHeader
        title={t.segments.title}
        subtitle={t.segments.subtitle}
        actions={<Button onClick={() => setAdding(true)}><Plus size={16} /> {t.segments.create}</Button>}
      />
      {items.length === 0 ? (
        <Card><Empty title={t.segments.emptyTitle} hint={t.segments.emptyHint} /></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {items.map((s) => (
            <Card key={s.id}>
              <CardBody>
                <div className="flex items-start gap-2">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-purple-100 text-purple-700">
                    <Filter size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-gray-900 truncate">{s.name}</div>
                    <div className="text-xs text-gray-500">{(s.filters.all?.length ?? 0)} {t.segments.filtersCount}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1 text-[10px] text-gray-500">
                  {(s.filters.all ?? []).slice(0, 4).map((c, i) => (
                    <span key={i} className="rounded bg-gray-100 px-1.5 py-0.5">
                      {c.field} {OP_LABEL[c.op] ?? c.op} {String(c.value).slice(0, 20)}
                    </span>
                  ))}
                </div>
                <div className="mt-3 flex justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(s)}><Eye size={14} /></Button>
                  <Button size="sm" variant="ghost" onClick={() => duplicate(s.id)}><Copy size={14} /></Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(s.id)}><Trash2 size={14} className="text-red-500" /></Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      <SegmentEditor
        open={adding || !!editing}
        editing={editing}
        onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={() => { setAdding(false); setEditing(null); load(); }}
      />
    </>
  );
}

function SegmentEditor({ open, editing, onClose, onSaved }: {
  open: boolean; editing: Segment | null; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [clauses, setClauses] = useState<Clause[]>([]);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setDescription(editing?.description ?? '');
      setClauses(editing?.filters?.all ?? []);
      setPreviewCount(null);
    }
  }, [open, editing]);

  const addClause = () => setClauses((c) => [...c, { field: 'status', op: 'eq', value: 'new' }]);
  const updateClause = (i: number, patch: Partial<Clause>) => {
    setClauses((cs) => cs.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  };
  const removeClause = (i: number) => setClauses((cs) => cs.filter((_, idx) => idx !== i));

  const runPreview = async () => {
    try {
      const r = await api.post<{ total: number }>('/segments/preview-dsl', { filters: { all: clauses } });
      setPreviewCount(r.total);
    } catch (e: any) {
      toast.error(e?.data?.reason ?? e?.message ?? t.app.error);
    }
  };

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const payload = { name, description: description || null, filters: { all: clauses } };
      if (editing) await api.put(`/segments/${editing.id}`, payload);
      else await api.post('/segments', payload);
      toast.success(t.app.saved);
      onSaved();
    } catch (e: any) {
      toast.error(e?.data?.reason ?? e?.message ?? t.app.error);
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? t.app.edit : t.segments.create} wide
      footer={<>
        <Button variant="secondary" onClick={runPreview}>{t.segments.previewBtn} {previewCount !== null && `(${previewCount})`}</Button>
        <div className="flex-1" />
        <Button variant="secondary" onClick={onClose}>{t.app.cancel}</Button>
        <Button onClick={save} loading={busy} disabled={!name.trim()}>{t.app.save}</Button>
      </>}>
      <div className="space-y-3">
        <Field label={t.segments.nameField} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label={t.segments.descField}>
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">{t.segments.filtersTitle}</span>
            <Button size="sm" variant="secondary" onClick={addClause}><Plus size={12} /> {t.segments.addFilter}</Button>
          </div>
          {clauses.length === 0 ? (
            <p className="text-xs text-gray-400">{t.segments.noFilters}</p>
          ) : (
            <div className="space-y-2">
              {clauses.map((c, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <select className="col-span-4 rounded-lg border border-gray-200 px-2 py-1.5 text-sm" value={c.field} onChange={(e) => updateClause(i, { field: e.target.value, op: OPS_PER_FIELD[e.target.value]?.[0] ?? 'eq' })}>
                    {FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                  <select className="col-span-3 rounded-lg border border-gray-200 px-2 py-1.5 text-sm" value={c.op} onChange={(e) => updateClause(i, { op: e.target.value })}>
                    {(OPS_PER_FIELD[c.field] ?? ['eq']).map((op) => <option key={op} value={op}>{OP_LABEL[op] ?? op}</option>)}
                  </select>
                  <Input className="col-span-4" value={String(c.value ?? '')} onChange={(e) => {
                    let v: any = e.target.value;
                    if (c.field === 'doNotContact' || c.field === 'hasOrder') v = v === 'true';
                    if (c.op === 'older_than_hours' || c.op === 'younger_than_hours') v = Number(v) || 0;
                    if (c.op === 'in' || c.op === 'not_in' || c.op === 'contains_any') v = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
                    updateClause(i, { value: v });
                  }} />
                  <button onClick={() => removeClause(i)} className="col-span-1 rounded p-1 text-red-500 hover:bg-red-50">
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
