import { useEffect, useState, useMemo } from 'react';
import { Search, Filter, Tag, Trash2, Download, Upload, ShieldOff, ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { PageHeader } from '../../components/ui/PageHeader';
import { Card, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Empty } from '../../components/ui/Empty';

interface Customer {
  id: string;
  jid: string;
  name: string | null;
  status: string;
  city: string | null;
  source: string | null;
  tags: string[];
  doNotContact: boolean;
  botPaused: boolean;
  lastInteractionAt: string | null;
  account: { id: string; name: string };
  _count: { messages: number; orders: number };
}

interface Account { id: string; name: string }

const phoneFromJid = (jid: string) => {
  const at = jid.indexOf('@');
  return at === -1 ? jid : jid.slice(0, at);
};

export function CustomersPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [search, setSearch] = useState('');
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(0);
  const take = 50;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => { api.get<Account[]>('/accounts').then(setAccounts); }, []);

  const load = () => {
    setLoading(true);
    const p = new URLSearchParams();
    if (search.trim()) p.set('search', search.trim());
    if (accountId) p.set('accountId', accountId);
    if (status) p.set('status', status);
    p.set('take', String(take));
    p.set('skip', String(page * take));
    api.get<{ items: Customer[]; total: number }>(`/customers?${p}`)
      .then((r) => { setItems(r.items); setTotal(r.total); })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const tm = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(tm);
  }, [search, accountId, status, page]);

  const toggleSelect = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (selected.size === items.length) setSelected(new Set());
    else setSelected(new Set(items.map((c) => c.id)));
  };

  const bulk = async (patch: any) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    await api.patch('/customers/bulk', { ids, patch });
    setSelected(new Set());
    toast.success(t.app.saved);
    load();
  };
  const bulkDelete = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    if (!confirm(`${t.app.delete} (${ids.length})?`)) return;
    await api.delete('/customers/bulk');
    // delete-bulk doesn't accept body well via plain api; do raw fetch
    await fetch('/api/customers/bulk', {
      method: 'DELETE', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    setSelected(new Set());
    toast.success(t.app.saved);
    load();
  };

  const downloadExport = async (kind: 'excel' | 'csv') => {
    const filters: any = {};
    if (accountId) filters.accountId = accountId;
    if (status) filters.status = status;
    if (search.trim()) filters.search = search.trim();
    try {
      const r = await fetch(`/api/customers/export/${kind}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `customers_${Date.now()}.${kind === 'excel' ? 'xlsx' : 'csv'}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t.app.saved);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    }
  };

  const totalPages = useMemo(() => Math.ceil(total / take), [total]);

  return (
    <>
      <PageHeader
        title={t.customers.title}
        subtitle={`${total} ${t.customers.contactsCount}`}
        actions={
          <div className="flex gap-2">
            <Link to="/customers/import">
              <Button variant="secondary"><Upload size={16} /> {t.customers.importBtn}</Button>
            </Link>
            <Button onClick={() => downloadExport('excel')}><Download size={16} /> Excel</Button>
            <Button variant="secondary" onClick={() => downloadExport('csv')}><Download size={16} /> CSV</Button>
          </div>
        }
      />

      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[240px] flex-1">
            <Search size={16} className="absolute start-3 top-2.5 text-gray-400" />
            <Input className="ps-9" placeholder={t.app.search} value={search} onChange={(e) => { setPage(0); setSearch(e.target.value); }} />
          </div>
          <select className="rounded-lg border border-gray-200 px-3 py-2 text-sm" value={accountId} onChange={(e) => { setPage(0); setAccountId(e.target.value); }}>
            <option value="">{t.contacts.all} ({t.contacts.filterAccount})</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select className="rounded-lg border border-gray-200 px-3 py-2 text-sm" value={status} onChange={(e) => { setPage(0); setStatus(e.target.value); }}>
            <option value="">{t.contacts.all}</option>
            {Object.entries(t.inbox.statuses).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <Filter size={14} className="text-gray-400" />
        </CardBody>
      </Card>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 p-2 text-sm">
          <span className="font-semibold text-brand-700">{selected.size} {t.customers.selected}</span>
          <select
            className="rounded border border-gray-200 px-2 py-1 text-xs"
            onChange={(e) => { if (e.target.value) bulk({ status: e.target.value }); }}
            defaultValue=""
          >
            <option value="">{t.customers.bulkSetStatus}</option>
            {Object.entries(t.inbox.statuses).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <Button size="sm" variant="secondary" onClick={() => {
            const tag = prompt(t.customers.bulkAddTag);
            if (tag?.trim()) bulk({ tagsAdd: [tag.trim()] });
          }}><Tag size={12} /> {t.customers.bulkAddTagBtn}</Button>
          <Button size="sm" variant="secondary" onClick={() => bulk({ doNotContact: true })}><ShieldOff size={12} /> {t.inboxNew.doNotContact}</Button>
          <Button size="sm" variant="ghost" onClick={bulkDelete}><Trash2 size={12} className="text-red-500" /></Button>
          <button onClick={() => setSelected(new Set())} className="ms-auto text-xs text-gray-500 hover:text-gray-700">{t.app.cancel}</button>
        </div>
      )}

      {loading && items.length === 0 ? (
        <Card><CardBody className="text-center text-xs text-gray-400">…</CardBody></Card>
      ) : items.length === 0 ? (
        <Card><Empty /></Card>
      ) : (
        <Card>
          <CardBody className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="p-3 text-start">
                    <input
                      type="checkbox"
                      checked={selected.size === items.length && items.length > 0}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="p-3 text-start">{t.app.name}</th>
                  <th className="p-3 text-start">{t.accounts.title}</th>
                  <th className="p-3 text-start">{t.app.status}</th>
                  <th className="p-3 text-start">{t.inboxNew.tags}</th>
                  <th className="p-3 text-start">{t.inboxNew.city}</th>
                  <th className="p-3 text-start">{t.inboxNew.source}</th>
                  <th className="p-3 text-start">{t.contacts.lastSeen}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className={clsx('border-b border-gray-50 hover:bg-gray-50', selected.has(c.id) && 'bg-brand-50')}>
                    <td className="p-3">
                      <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} />
                    </td>
                    <td className="p-3">
                      <Link to={`/inbox?contact=${c.id}`} className="font-medium text-gray-800 hover:text-brand-600">
                        {c.name ?? phoneFromJid(c.jid)}
                      </Link>
                      <div className="text-xs text-gray-400" dir="ltr">+{phoneFromJid(c.jid)}</div>
                    </td>
                    <td className="p-3 text-gray-600">{c.account.name}</td>
                    <td className="p-3"><span className="rounded bg-gray-100 px-2 py-0.5 text-xs">{(t.inbox.statuses as any)[c.status] ?? c.status}</span></td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1">
                        {c.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="rounded bg-brand-50 px-1.5 py-0 text-[10px] text-brand-700">{tag}</span>
                        ))}
                        {c.tags.length > 3 && <span className="text-[10px] text-gray-400">+{c.tags.length - 3}</span>}
                      </div>
                    </td>
                    <td className="p-3 text-xs text-gray-600">{c.city ?? '—'}</td>
                    <td className="p-3 text-xs text-gray-500">{c.source ?? '—'}</td>
                    <td className="p-3 text-xs text-gray-500">
                      {c.lastInteractionAt ? new Date(c.lastInteractionAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
          <span>{page * take + 1}–{Math.min((page + 1) * take, total)} / {total}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
              <ChevronLeft size={14} />
            </Button>
            <span className="px-2 py-1.5">{page + 1} / {totalPages}</span>
            <Button size="sm" variant="secondary" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
