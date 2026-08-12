/**
 * LinkAccountsModal — connect/disconnect a Bot to WhatsApp accounts.
 *
 * One bot ↔ many accounts (many-to-many via the BotAccount join table).
 * Toggle a chip to link/unlink. Empty list → guidance to first create
 * an account on the Accounts page.
 */
import { useEffect, useState } from 'react';
import { Link as LinkIcon, Smartphone, Check, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { api } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';
import { Empty } from '../../../components/ui/Empty';
import { StatusPill } from '../../../components/domain/StatusPill';
import type { Bot } from '../types';

interface Account {
  id: string;
  name: string;
  status: string;
  phoneNumber: string | null;
}

export function LinkAccountsModal({
  open, bot, onClose, onChanged,
}: {
  open: boolean;
  bot: Bot;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api.get<Account[]>('/accounts').then(setAccounts).catch(() => {});
  }, [open]);

  const linkedIds = new Set(bot.accounts.map((a) => a.account.id));

  const toggle = async (acc: Account) => {
    setBusy(acc.id);
    try {
      if (linkedIds.has(acc.id)) {
        await api.delete(`/bots/${bot.id}/accounts/${acc.id}`);
        toast.success(t.bots.unlinked.replace('{name}', acc.name));
      } else {
        await api.post(`/bots/${bot.id}/accounts`, { accountId: acc.id });
        toast.success(t.bots.linked.replace('{name}', acc.name));
      }
      onChanged();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally {
      setBusy(null);
    }
  };

  const linkedCount = bot.accounts.length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.bots.linkAccounts}
      wide
      footer={
        <Button variant="secondary" onClick={onClose}>{t.app.close}</Button>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">
          <LinkIcon size={14} />
          <span>{t.bots.linkHint}</span>
          <span className="ms-auto rounded-full bg-blue-100 px-2 py-0.5 font-bold">
            {linkedCount}
          </span>
        </div>

        {accounts.length === 0 ? (
          <div className="py-6">
            <Empty
              icon={<Smartphone size={32} />}
              title={t.bots.noAccountsYet}
              hint={t.bots.noAccountsHint}
            />
            <div className="mt-3 flex justify-center">
              <Link to="/accounts">
                <Button size="sm">
                  <Plus size={14} /> {t.accounts.create}
                </Button>
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {accounts.map((a) => {
              const linked = linkedIds.has(a.id);
              const isBusy = busy === a.id;
              return (
                <button
                  key={a.id}
                  onClick={() => !isBusy && toggle(a)}
                  disabled={isBusy}
                  className={clsx(
                    'flex items-center gap-3 rounded-lg border p-3 text-start transition disabled:opacity-50',
                    linked
                      ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500/20 hover:bg-brand-100'
                      : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50',
                  )}
                >
                  <div
                    className={clsx(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                      linked ? 'bg-brand-500 text-white' : 'bg-gray-100 text-gray-500',
                    )}
                  >
                    {linked ? <Check size={16} /> : <Smartphone size={16} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-gray-900">{a.name}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                      <StatusPill status={a.status} />
                      {a.phoneNumber && <span dir="ltr">+{a.phoneNumber}</span>}
                    </div>
                  </div>
                  <span
                    className={clsx(
                      'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                      linked ? 'bg-brand-500 text-white' : 'bg-gray-100 text-gray-600',
                    )}
                  >
                    {linked ? t.bots.linkedBadge : t.bots.linkBadge}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
