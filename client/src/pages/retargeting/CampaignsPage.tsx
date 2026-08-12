import { useEffect, useState } from 'react';
import { Plus, Play, Pause, Square, Trash2, Megaphone, BarChart3, Image as ImageIcon, Mic, Video, X } from 'lucide-react';
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
import { MediaPickerModal } from '../builder/parts/MediaPickerModal';

type MsgKind = 'text' | 'audio' | 'image' | 'video';
interface Media { id: string; name: string; type: string }

interface Campaign {
  id: string;
  name: string;
  description: string | null;
  status: string;
  segmentId: string;
  accountId: string;
  messageSequence: { blocks: any[] };
  segment: { id: string; name: string };
  account: { id: string; name: string; status: string };
  _count: { logs: number };
  createdAt: string;
}

interface PreviewResult {
  recipientCount: number;
  doNotContactCount: number;
  recentlyContactedCount: number;
  etaMinutes: number | null;
  blockCount: number;
  errors: string[];
}

interface Segment { id: string; name: string }
interface Account { id: string; name: string; status: string }

const statusCls = (s: string): string => {
  if (s === 'running') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (s === 'paused') return 'bg-amber-50 text-amber-700 border-amber-200';
  if (s === 'completed') return 'bg-blue-50 text-blue-700 border-blue-200';
  if (s === 'canceled' || s === 'failed') return 'bg-red-50 text-red-700 border-red-200';
  return 'bg-gray-50 text-gray-600 border-gray-200';
};

export function CampaignsPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<Campaign[]>([]);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [adding, setAdding] = useState(false);
  const [previewOf, setPreviewOf] = useState<Campaign | null>(null);

  const load = () => api.get<Campaign[]>('/retargeting/campaigns').then(setItems);
  useEffect(() => { load(); }, []);

  const remove = async (id: string) => {
    if (!confirm(t.app.delete + '?')) return;
    await api.delete(`/retargeting/campaigns/${id}`); load();
  };
  const start = async (id: string) => {
    try {
      const r = await api.post<{ recipientCount: number }>(`/retargeting/campaigns/${id}/start`);
      toast.success(`${r.recipientCount} ${t.campaigns.recipientsQueued}`);
      load();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    }
  };
  const pause = async (id: string) => { await api.post(`/retargeting/campaigns/${id}/pause`); load(); };
  const resume = async (id: string) => { await api.post(`/retargeting/campaigns/${id}/resume`); load(); };
  const cancel = async (id: string) => {
    if (!confirm(t.campaigns.confirmCancel)) return;
    await api.post(`/retargeting/campaigns/${id}/cancel`); load();
  };

  return (
    <>
      <PageHeader
        title={t.campaigns.title}
        subtitle={t.campaigns.subtitle}
        actions={<Button onClick={() => setAdding(true)}><Plus size={16} /> {t.campaigns.create}</Button>}
      />

      {items.length === 0 ? (
        <Card><Empty title={t.campaigns.emptyTitle} hint={t.campaigns.emptyHint} /></Card>
      ) : (
        <div className="space-y-2">
          {items.map((c) => (
            <Card key={c.id}>
              <CardBody>
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-purple-100 text-purple-700">
                    <Megaphone size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{c.name}</span>
                      <span className={clsx('rounded-full border px-2 py-0.5 text-[10px] font-medium', statusCls(c.status))}>
                        {(t.campaigns.statuses as any)[c.status] ?? c.status}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-gray-500">
                      {c.segment?.name ?? '—'} · {c.account?.name ?? '—'} · {c._count.logs} {t.campaigns.recipients}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setPreviewOf(c)}><BarChart3 size={14} /></Button>
                    {c.status === 'draft' && (
                      <Button size="sm" onClick={() => start(c.id)}><Play size={14} /> {t.campaigns.start}</Button>
                    )}
                    {c.status === 'running' && (
                      <Button size="sm" variant="secondary" onClick={() => pause(c.id)}><Pause size={14} /> {t.campaigns.pause}</Button>
                    )}
                    {c.status === 'paused' && (
                      <Button size="sm" onClick={() => resume(c.id)}><Play size={14} /> {t.campaigns.resume}</Button>
                    )}
                    {(c.status === 'running' || c.status === 'paused') && (
                      <Button size="sm" variant="secondary" onClick={() => cancel(c.id)}><Square size={14} /></Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>{t.app.edit}</Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(c.id)}><Trash2 size={14} className="text-red-500" /></Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <CampaignEditor
        open={adding || !!editing}
        editing={editing}
        onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={() => { setAdding(false); setEditing(null); load(); }}
      />
      <CampaignPreview campaign={previewOf} onClose={() => setPreviewOf(null)} />
    </>
  );
}

function CampaignEditor({ open, editing, onClose, onSaved }: {
  open: boolean; editing: Campaign | null; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [msgKind, setMsgKind] = useState<MsgKind>('text');
  const [text, setText] = useState('');
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [media, setMedia] = useState<Media | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [perMinute, setPerMinute] = useState(5);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      api.get<Segment[]>('/segments').then(setSegments);
      api.get<Account[]>('/accounts').then(setAccounts);
      setName(editing?.name ?? '');
      setDescription(editing?.description ?? '');
      setSegmentId(editing?.segmentId ?? '');
      setAccountId(editing?.accountId ?? '');
      const firstBlock = editing?.messageSequence?.blocks?.find((b: any) => b.enabled !== false);
      if (firstBlock?.type === 'audio' || firstBlock?.type === 'image' || firstBlock?.type === 'video') {
        setMsgKind(firstBlock.type);
        setMediaId(firstBlock.mediaId ?? null);
        setText(firstBlock.caption ?? '');
      } else {
        setMsgKind('text');
        setMediaId(null);
        setText(firstBlock?.content ?? '');
      }
      setMedia(null);
    }
  }, [open, editing]);

  // Resolve picked-media name for display
  useEffect(() => {
    if (!mediaId) { setMedia(null); return; }
    if (media?.id === mediaId) return;
    api.get<Media[]>('/media').then((all) => {
      setMedia(all.find((m) => m.id === mediaId) ?? null);
    });
  }, [mediaId]);

  const save = async () => {
    if (!name.trim() || !segmentId || !accountId) return;
    if (msgKind !== 'text' && !mediaId) {
      toast.error(t.followups.mediaRequired);
      return;
    }
    setBusy(true);
    try {
      const block: any = msgKind === 'text'
        ? (text.trim() ? { type: 'text', content: text.trim(), enabled: true } : null)
        : { type: msgKind, mediaId, caption: text.trim() || undefined, enabled: true };
      const blocks = block ? [block] : [];
      const payload = {
        name, description: description || null, segmentId, accountId,
        messageSequence: { blocks },
        sendingSpeed: { perMinute },
      };
      if (editing) await api.put(`/retargeting/campaigns/${editing.id}`, payload);
      else await api.post('/retargeting/campaigns', payload);
      toast.success(t.app.saved);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? t.app.edit : t.campaigns.create} wide
      footer={<><Button variant="secondary" onClick={onClose}>{t.app.cancel}</Button>
              <Button onClick={save} loading={busy} disabled={!name.trim() || !segmentId || !accountId}>{t.app.save}</Button></>}>
      <div className="space-y-3">
        <Field label={t.campaigns.nameField} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t.campaigns.segmentField} required>
            <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
              <option value="">— {t.app.search} —</option>
              {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label={t.campaigns.accountField} required>
            <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">— {t.app.search} —</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        </div>

        <Field label={t.followups.msgKind}>
          <select
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            value={msgKind}
            onChange={(e) => {
              const v = e.target.value as MsgKind;
              setMsgKind(v);
              if (v === 'text') { setMediaId(null); setMedia(null); }
            }}
          >
            <option value="text">{t.followups.kindText}</option>
            <option value="audio">{t.followups.kindAudio}</option>
            <option value="image">{t.followups.kindImage}</option>
            <option value="video">{t.followups.kindVideo}</option>
          </select>
        </Field>

        {msgKind === 'text' ? (
          <Field label={t.campaigns.messageText}>
            <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="السلام، عرض جديد..." />
          </Field>
        ) : (
          <>
            <Field label={t.followups.media}>
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => setPickerOpen(true)}>
                  {msgKind === 'image' ? <ImageIcon size={14} />
                    : msgKind === 'audio' ? <Mic size={14} />
                    : <Video size={14} />}
                  {t.followups.pickMedia}
                </Button>
                {media ? (
                  <span className="flex items-center gap-1 truncate text-xs text-gray-600">
                    {media.name}
                    <button
                      type="button"
                      onClick={() => { setMediaId(null); setMedia(null); }}
                      className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ) : (
                  <span className="text-xs text-gray-400">{t.followups.noMedia}</span>
                )}
              </div>
            </Field>
            <Field label={t.followups.captionOptional}>
              <Input value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          </>
        )}

        <Field label={t.campaigns.perMinute} hint={t.campaigns.perMinuteHint}>
          <Input type="number" min={1} max={60} value={perMinute} onChange={(e) => setPerMinute(+e.target.value)} className="max-w-[160px]" />
        </Field>
      </div>

      <MediaPickerModal
        open={pickerOpen}
        kindFilter={msgKind === 'text' ? undefined : msgKind}
        onClose={() => setPickerOpen(false)}
        onPick={(id) => { setMediaId(id); setPickerOpen(false); }}
      />
    </Modal>
  );
}

function CampaignPreview({ campaign, onClose }: { campaign: Campaign | null; onClose: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<PreviewResult | null>(null);
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    if (!campaign) return;
    api.post<PreviewResult>(`/retargeting/campaigns/${campaign.id}/preview`).then(setData);
    api.get(`/retargeting/campaigns/${campaign.id}/stats`).then(setStats);
  }, [campaign]);

  if (!campaign) return null;
  return (
    <Modal open={!!campaign} onClose={onClose} title={`${campaign.name} — ${t.campaigns.previewTitle}`} wide
      footer={<Button variant="secondary" onClick={onClose}>{t.app.close}</Button>}>
      {data && (
        <div className="grid gap-3 md:grid-cols-3">
          <Stat label={t.campaigns.totalRecipients} value={data.recipientCount} cls="bg-blue-50 text-blue-700" />
          <Stat label={t.campaigns.doNotContact} value={data.doNotContactCount} cls="bg-red-50 text-red-700" />
          <Stat label={t.campaigns.eta} value={data.etaMinutes ?? 0} cls="bg-emerald-50 text-emerald-700" />
        </div>
      )}
      {stats && (
        <div className="mt-4 grid gap-2 text-sm md:grid-cols-4">
          <Stat label={t.campaigns.statuses.sent} value={stats.sent} cls="bg-emerald-50 text-emerald-700" />
          <Stat label={t.campaigns.statuses.skipped} value={stats.skipped} cls="bg-gray-100 text-gray-600" />
          <Stat label={t.campaigns.statuses.failed} value={stats.failed} cls="bg-red-50 text-red-700" />
          <Stat label={t.campaigns.statuses.replied} value={stats.replied} cls="bg-blue-50 text-blue-700" />
        </div>
      )}
      {data?.errors.length ? (
        <div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          {data.errors.join(', ')}
        </div>
      ) : null}
    </Modal>
  );
}

function Stat({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={`rounded-lg p-3 text-center ${cls}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}
