import { useEffect, useState } from 'react';
import { Search, Filter, Pause, ShieldOff, Plus } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { Input, Field } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Empty } from '../../components/ui/Empty';
import type { ConversationSummary } from './types';

interface Account { id: string; name: string; status: string; phoneNumber: string | null }

const phoneFromJid = (jid: string) => {
  const at = jid.indexOf('@');
  const head = at === -1 ? jid : jid.slice(0, at);
  const colon = head.indexOf(':');
  return colon === -1 ? head : head.slice(0, colon);
};

const fmtAgo = (iso: string | null): string => {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'الآن';
  if (s < 3600) return `${Math.floor(s / 60)}د`;
  if (s < 86400) return `${Math.floor(s / 3600)}س`;
  return `${Math.floor(s / 86400)}ي`;
};

const statusDot: Record<string, string> = {
  new: 'bg-blue-400',
  interested: 'bg-amber-400',
  ordered: 'bg-emerald-500',
  rejected: 'bg-gray-400',
  needs_human: 'bg-red-500',
  cold: 'bg-slate-400',
  hot: 'bg-orange-500',
};

const derivedChip: Record<string, { bg: string; fg: string; emoji: string }> = {
  sent_no_reply: { bg: 'bg-red-50',     fg: 'text-red-700',     emoji: '🟡' },
  replied:       { bg: 'bg-blue-50',    fg: 'text-blue-700',    emoji: '🔵' },
  ordered:       { bg: 'bg-emerald-50', fg: 'text-emerald-700', emoji: '🟢' },
};

type FilterKey = 'all' | 'unread' | 'needs_human' | 'paused' | 'new' | 'interested' | 'ordered' | 'rejected';

export function ConversationList({
  selectedId, onSelect, refreshKey,
}: {
  selectedId: string | null;
  onSelect: (id: string, name: string) => void;
  refreshKey: number;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [loading, setLoading] = useState(false);
  const [composing, setComposing] = useState(false);

  const load = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (filter === 'unread') params.set('unread', 'true');
    if (filter === 'needs_human') params.set('needsHuman', 'true');
    if (filter === 'paused') params.set('botPaused', 'true');
    if (['new', 'interested', 'ordered', 'rejected'].includes(filter)) params.set('status', filter);
    try {
      const data = await api.get<ConversationSummary[]>(`/inbox/conversations?${params}`);
      setItems(data);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [filter, refreshKey]);
  useEffect(() => {
    const tm = setTimeout(load, 250);
    return () => clearTimeout(tm);
  }, [search]);

  const filterChips: { key: FilterKey; label: string }[] = [
    { key: 'all', label: t.inboxNew.all },
    { key: 'unread', label: t.inboxNew.unread },
    { key: 'needs_human', label: t.inboxNew.needsHuman },
    { key: 'paused', label: t.inboxNew.paused },
    { key: 'new', label: t.inbox.statuses.new },
    { key: 'interested', label: t.inbox.statuses.interested },
    { key: 'ordered', label: t.inbox.statuses.ordered },
    { key: 'rejected', label: t.inbox.statuses.rejected },
  ];

  return (
    <div className="flex h-full flex-col border-e border-gray-200 bg-white">
      <div className="border-b border-gray-100 p-3">
        <div className="mb-2 flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute start-3 top-2.5 text-gray-400" />
            <Input
              className="ps-9"
              placeholder={t.inboxNew.searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            onClick={() => setComposing(true)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white shadow-sm transition hover:bg-brand-600"
            title={t.inboxNew.newChat}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-1 overflow-x-auto pb-1 scrollbar-thin">
          <Filter size={14} className="shrink-0 text-gray-400" />
          {filterChips.map((c) => (
            <button
              key={c.key}
              onClick={() => setFilter(c.key)}
              className={clsx(
                'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition',
                filter === c.key
                  ? 'bg-brand-500 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {loading && items.length === 0 ? (
          <div className="p-4 text-center text-xs text-gray-400">…</div>
        ) : items.length === 0 ? (
          <Empty title={t.app.empty} />
        ) : (
          <ul>
            {items.map((c) => {
              const initials = (c.name ?? phoneFromJid(c.jid)).slice(0, 2).toUpperCase();
              return (
                <li key={c.id}>
                  <button
                    onClick={() => onSelect(c.id, c.name ?? phoneFromJid(c.jid))}
                    className={clsx(
                      'flex w-full items-center gap-3 border-b border-gray-50 p-3 text-start hover:bg-gray-50',
                      selectedId === c.id && 'bg-brand-50',
                    )}
                  >
                    <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-100 to-brand-200 text-sm font-bold text-brand-700">
                      {initials}
                      <span
                        className={clsx(
                          'absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full border-2 border-white',
                          statusDot[c.status] ?? 'bg-gray-300',
                        )}
                        title={(t.inbox.statuses as any)[c.status] ?? c.status}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-gray-900">
                          {c.name ?? phoneFromJid(c.jid)}
                        </span>
                        {c.derivedStatus && derivedChip[c.derivedStatus] && (
                          <span
                            className={clsx(
                              'shrink-0 rounded-full px-1.5 py-0 text-[10px] font-bold',
                              derivedChip[c.derivedStatus].bg,
                              derivedChip[c.derivedStatus].fg,
                            )}
                            title={(t.inbox.derived as any)?.[c.derivedStatus] ?? c.derivedStatus}
                          >
                            {derivedChip[c.derivedStatus].emoji} {(t.inbox.derived as any)?.[c.derivedStatus] ?? ''}
                          </span>
                        )}
                        {c.botPaused && <Pause size={11} className="text-amber-500" />}
                        {c.doNotContact && <ShieldOff size={11} className="text-red-500" />}
                        <span className="ms-auto shrink-0 text-[10px] text-gray-400">{fmtAgo(c.lastMessageAt)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs text-gray-500">
                          {c.lastMessageDirection === 'out' && '↩ '}
                          {c.lastMessageType === 'text' ? c.lastMessageBody : `[${c.lastMessageType}]`}
                        </span>
                        {c.unread > 0 && (
                          <span className="ms-auto shrink-0 rounded-full bg-brand-500 px-1.5 py-0 text-[10px] font-bold text-white">
                            {c.unread > 99 ? '99+' : c.unread}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-gray-400">
                        <span className="truncate">{c.account.name}</span>
                        {c.tags.slice(0, 2).map((tag) => (
                          <span key={tag} className="rounded bg-gray-100 px-1.5 py-0">{tag}</span>
                        ))}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <NewChatModal
        open={composing}
        onClose={() => setComposing(false)}
        onCreated={(c) => { setComposing(false); onSelect(c.id, c.name ?? c.jid); }}
      />
    </div>
  );
}

function NewChatModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: { id: string; name: string | null; jid: string }) => void;
}) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.get<Account[]>('/accounts').then((r) => {
      setAccounts(r);
      const connected = r.find((a) => a.status === 'connected');
      setAccountId(connected?.id ?? r[0]?.id ?? '');
    });
    setPhone(''); setName('');
  }, [open]);

  const submit = async () => {
    if (!accountId || !phone.trim()) return;
    setBusy(true);
    try {
      const c = await api.post<{ id: string; name: string | null; jid: string }>(
        '/inbox/conversations/new',
        { accountId, phone: phone.trim(), name: name.trim() || undefined }
      );
      toast.success(t.app.saved);
      onCreated(c);
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
      title={t.inboxNew.newChat}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t.app.cancel}</Button>
          <Button onClick={submit} loading={busy} disabled={!accountId || !phone.trim()}>
            {t.inboxNew.startChat}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t.accounts.title} required>
          <select
            className="block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id} disabled={a.status !== 'connected'}>
                {a.name} {a.status !== 'connected' ? `(${a.status})` : '✓'}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t.inboxNew.phoneNumber} required hint={t.inboxNew.phoneHint}>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+212 612 345 678"
            dir="ltr"
            autoFocus
          />
        </Field>
        <Field label={`${t.app.name} (${t.app.no} ${t.app.confirm})`}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
