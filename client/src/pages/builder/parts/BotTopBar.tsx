import { useState, useEffect } from 'react';
import { ArrowRight, ArrowLeft, Save, PlayCircle, Pause, AlertCircle, CheckCircle2, Link2 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { Button } from '../../../components/ui/Button';
import { LinkAccountsModal } from './LinkAccountsModal';
import type { Bot, ValidationReport } from '../types';
import clsx from 'clsx';

export function BotTopBar({
  bot, lastSavedAt, validation, onChange, onSaveBasics, onPublish, onPause, onBack, onLinksChanged,
}: {
  bot: Bot;
  lastSavedAt: number | null;
  validation: ValidationReport | null;
  onChange: (patch: Partial<Bot>) => void;
  onSaveBasics: (patch: { name?: string; description?: string }) => Promise<void>;
  onPublish: () => void;
  onPause: () => void;
  onBack: () => void;
  onLinksChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const Back = lang === 'ar' ? ArrowRight : ArrowLeft;
  const [name, setName] = useState(bot.name);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showLinks, setShowLinks] = useState(false);

  useEffect(() => { setName(bot.name); }, [bot.name]);

  const status = bot.status;
  const statusCls = status === 'active' ? 'bg-green-50 text-green-700 border-green-200'
                  : status === 'paused' ? 'bg-amber-50 text-amber-700 border-amber-200'
                  : 'bg-gray-50 text-gray-700 border-gray-200';

  const errCount = validation?.errors.length ?? 0;
  const warnCount = validation?.warnings.length ?? 0;
  const lastSavedText = lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString() : '—';

  const commit = async () => {
    if (name.trim() && name !== bot.name) {
      setSaving(true);
      onChange({ name: name.trim() });
      await onSaveBasics({ name: name.trim() });
      setSaving(false);
    }
    setEditing(false);
  };

  return (
    <div className="flex h-14 items-center gap-3 border-b border-gray-200 bg-white px-4">
      <button onClick={onBack} className="rounded p-1 text-gray-500 hover:bg-gray-100"><Back size={18} /></button>

      <div className="flex min-w-0 flex-1 items-center gap-3">
        {editing ? (
          <input
            autoFocus
            className="rounded-lg border border-brand-500 bg-white px-2 py-1 text-base font-semibold focus:outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="truncate text-start text-base font-semibold text-gray-900 hover:text-brand-600"
            title={t.builder.renameBot}
          >
            {bot.name}
          </button>
        )}
        <span className={clsx('rounded-full border px-2 py-0.5 text-xs font-medium', statusCls)}>
          {(t.builder.bot_status as any)[status] ?? status}
        </span>
        <button
          onClick={() => setShowLinks(true)}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition',
            bot.accounts.length === 0
              ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
              : 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100',
          )}
          title={t.builder.linked_accounts}
        >
          <Link2 size={12} />
          <span>{t.builder.linked_accounts}: <b>{bot.accounts.length}</b></span>
        </button>
      </div>

      <div className="flex items-center gap-3 text-xs text-gray-500">
        {saving ? (
          <span>{t.builder.saving}</span>
        ) : (
          <span>{t.builder.last_saved}: {lastSavedText}</span>
        )}
        {errCount > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-red-700"><AlertCircle size={12} /> {errCount}</span>
        )}
        {warnCount > 0 && errCount === 0 && (
          <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-amber-700"><AlertCircle size={12} /> {warnCount}</span>
        )}
        {errCount === 0 && warnCount === 0 && validation && (
          <span className="flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-green-700"><CheckCircle2 size={12} /> ok</span>
        )}
      </div>

      {status === 'active' ? (
        <Button size="sm" variant="secondary" onClick={onPause}><Pause size={14} /> {t.builder.pause}</Button>
      ) : (
        <Button size="sm" onClick={onPublish}><PlayCircle size={14} /> {t.builder.publish}</Button>
      )}

      <LinkAccountsModal
        open={showLinks}
        bot={bot}
        onClose={() => setShowLinks(false)}
        onChanged={onLinksChanged}
      />
    </div>
  );
}
