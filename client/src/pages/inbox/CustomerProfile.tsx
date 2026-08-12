import { useState } from 'react';
import { Pause, Play, ShieldOff, ShieldCheck, Save, Plus, X, ShoppingCart, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input, Field, Textarea } from '../../components/ui/Input';
import type { ContactDetail } from './types';

const phoneFromJid = (jid: string) => {
  const at = jid.indexOf('@');
  const head = at === -1 ? jid : jid.slice(0, at);
  const colon = head.indexOf(':');
  return colon === -1 ? head : head.slice(0, colon);
};

const STATUSES = ['new', 'interested', 'ordered', 'rejected', 'needs_human', 'cold', 'hot'] as const;

export function CustomerProfile({ contact, onChanged }: { contact: ContactDetail; onChanged: () => void }) {
  const { t } = useI18n();
  const [tags, setTags] = useState<string[]>(contact.tags ?? []);
  const [newTag, setNewTag] = useState('');
  const [name, setName] = useState(contact.name ?? '');
  const [city, setCity] = useState(contact.city ?? '');
  const [address, setAddress] = useState(contact.address ?? '');
  const [noteBody, setNoteBody] = useState('');

  const togglePause = async () => {
    await api.post(`/inbox/conversations/${contact.id}/${contact.botPaused ? 'resume-bot' : 'pause-bot'}`);
    onChanged();
  };

  const setStatus = async (status: string) => {
    await api.post(`/inbox/conversations/${contact.id}/status`, { status });
    onChanged();
    toast.success(t.app.saved);
  };

  const setDnc = async (v: boolean) => {
    await api.post(`/inbox/conversations/${contact.id}/do-not-contact`, { doNotContact: v });
    onChanged();
  };

  const addTag = async () => {
    const v = newTag.trim();
    if (!v) return;
    const next = Array.from(new Set([...tags, v]));
    setTags(next); setNewTag('');
    await api.post(`/inbox/conversations/${contact.id}/tags`, { tags: next });
    onChanged();
  };
  const removeTag = async (tag: string) => {
    const next = tags.filter((x) => x !== tag);
    setTags(next);
    await api.post(`/inbox/conversations/${contact.id}/tags`, { tags: next });
    onChanged();
  };

  const saveProfile = async () => {
    await api.patch(`/inbox/conversations/${contact.id}/profile`, { name, city, address });
    toast.success(t.app.saved);
    onChanged();
  };

  const addNote = async () => {
    const v = noteBody.trim();
    if (!v) return;
    await api.post(`/inbox/conversations/${contact.id}/notes`, { body: v });
    setNoteBody('');
    onChanged();
  };
  const deleteNote = async (id: string) => {
    await api.delete(`/inbox/notes/${id}`);
    onChanged();
  };

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col overflow-hidden border-s border-gray-200 bg-white">
      <div className="border-b border-gray-100 p-4 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-brand-100 to-brand-200 text-xl font-bold text-brand-700">
          {(contact.name ?? phoneFromJid(contact.jid)).slice(0, 2).toUpperCase()}
        </div>
        <div className="mt-2 text-base font-semibold">{contact.name ?? phoneFromJid(contact.jid)}</div>
        <div className="text-xs text-gray-500" dir="ltr">+{phoneFromJid(contact.jid)}</div>
        <div className="mt-1 text-xs text-gray-400">{contact.account.name}</div>
        {contact.repliesLast24h && (
          <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600" dir="ltr">
            <span className="font-medium">Replies 24h:</span>
            <span className={
              contact.repliesLast24h.cap > 0 && contact.repliesLast24h.count >= contact.repliesLast24h.cap
                ? 'font-semibold text-red-600'
                : ''
            }>
              {contact.repliesLast24h.count}{contact.repliesLast24h.cap > 0 ? ` / ${contact.repliesLast24h.cap}` : ''}
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 scrollbar-thin">
        {/* Status pills */}
        <Card>
          <CardHeader>{t.app.status}</CardHeader>
          <CardBody className="flex flex-wrap gap-1">
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                  contact.status === s ? 'bg-brand-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {(t.inbox.statuses as any)[s] ?? s}
              </button>
            ))}
          </CardBody>
        </Card>

        {/* Quick actions */}
        <Card>
          <CardBody className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={contact.botPaused ? 'primary' : 'secondary'}
              onClick={togglePause}
            >
              {contact.botPaused ? <><Play size={14} /> {t.inbox.resumeBot}</> : <><Pause size={14} /> {t.inbox.pauseBot}</>}
            </Button>
            <Button
              size="sm"
              variant={contact.doNotContact ? 'danger' : 'ghost'}
              onClick={() => setDnc(!contact.doNotContact)}
            >
              {contact.doNotContact ? <><ShieldCheck size={14} /> {t.inboxNew.allowContact}</> : <><ShieldOff size={14} /> {t.inboxNew.doNotContact}</>}
            </Button>
          </CardBody>
        </Card>

        {/* Tags */}
        <Card>
          <CardHeader>{t.inboxNew.tags}</CardHeader>
          <CardBody>
            <div className="mb-2 flex flex-wrap gap-1">
              {tags.length === 0 && <span className="text-xs text-gray-400">—</span>}
              {tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700">
                  {tag}
                  <button onClick={() => removeTag(tag)} className="rounded-full p-0.5 hover:bg-brand-100">
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-1">
              <Input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTag()}
                placeholder={t.inboxNew.addTag}
              />
              <Button size="sm" variant="secondary" onClick={addTag}><Plus size={12} /></Button>
            </div>
          </CardBody>
        </Card>

        {/* Profile fields */}
        <Card>
          <CardHeader actions={<Button size="sm" variant="ghost" onClick={saveProfile}><Save size={12} /></Button>}>
            {t.inboxNew.profile}
          </CardHeader>
          <CardBody className="space-y-2">
            <Field label={t.app.name}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label={t.inboxNew.city}><Input value={city} onChange={(e) => setCity(e.target.value)} /></Field>
            <Field label={t.inboxNew.address}><Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
          </CardBody>
        </Card>

        {/* Orders */}
        {contact.orders.length > 0 && (
          <Card>
            <CardHeader>{t.inboxNew.orders}</CardHeader>
            <CardBody className="space-y-1.5">
              {contact.orders.map((o) => (
                <div key={o.id} className="flex items-center gap-2 rounded border border-gray-100 p-2 text-xs">
                  <ShoppingCart size={12} className="text-emerald-600" />
                  <span className="flex-1 truncate">{o.fullName ?? '—'} · {o.quantity ?? '—'}</span>
                  <span className="rounded bg-gray-100 px-1.5 py-0 text-[10px]">{o.status}</span>
                </div>
              ))}
            </CardBody>
          </Card>
        )}

        {/* Notes */}
        <Card>
          <CardHeader>{t.inboxNew.notes}</CardHeader>
          <CardBody className="space-y-2">
            <div className="flex gap-1">
              <Textarea
                rows={2}
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                placeholder={t.inboxNew.addNote}
              />
              <Button size="sm" variant="secondary" onClick={addNote} disabled={!noteBody.trim()}><Plus size={12} /></Button>
            </div>
            <ul className="space-y-1">
              {contact.notesList.length === 0 && <li className="text-xs text-gray-400">—</li>}
              {contact.notesList.map((n) => (
                <li key={n.id} className="group flex items-start gap-1 rounded border border-gray-100 p-2 text-xs">
                  <span className="flex-1 whitespace-pre-wrap">{n.body}</span>
                  <span className="text-[10px] text-gray-400">{new Date(n.createdAt).toLocaleDateString()}</span>
                  <button
                    onClick={() => deleteNote(n.id)}
                    className="rounded p-0.5 text-gray-300 opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-500"
                  >
                    <Trash2 size={11} />
                  </button>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        {/* Meta */}
        <Card>
          <CardHeader>{t.inboxNew.meta}</CardHeader>
          <CardBody className="space-y-1 text-xs text-gray-600">
            <Row label={t.inboxNew.firstContact} value={contact.firstMessageAt} />
            <Row label={t.inboxNew.lastContact} value={contact.lastInteractionAt} />
            <Row label={t.inboxNew.source} value={contact.source ?? '—'} />
            {contact.campaignName && <Row label={t.inboxNew.campaign} value={contact.campaignName} />}
          </CardBody>
        </Card>
      </div>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  let display = value ?? '—';
  if (value && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    display = new Date(value).toLocaleString();
  }
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-400">{label}</span>
      <span className="text-end">{display}</span>
    </div>
  );
}
