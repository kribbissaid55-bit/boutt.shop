import { useState } from 'react';
import { AlertCircle, AlertTriangle, Lightbulb, ChevronUp, ChevronDown, CheckCircle2 } from 'lucide-react';
import clsx from 'clsx';
import { useI18n } from '../../../i18n';
import type { ValidationReport } from '../types';

export function BotValidationPanel({ validation, onJump }: {
  validation: ValidationReport | null;
  onJump: (stepId?: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const e = validation?.errors.length ?? 0;
  const w = validation?.warnings.length ?? 0;
  const s = validation?.suggestions.length ?? 0;

  const total = e + w + s;
  if (!validation) return null;

  return (
    <div className="border-t border-gray-200 bg-white">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-2 text-sm hover:bg-gray-50">
        {total === 0 ? (
          <><CheckCircle2 size={14} className="text-green-600" /><span className="text-green-700 font-medium">{t.builder.validation.no_issues}</span></>
        ) : (
          <>
            <AlertCircle size={14} className={e ? 'text-red-600' : 'text-amber-600'} />
            <span className="font-medium">{t.builder.validation.title}</span>
            {e > 0 && <span className="rounded-full bg-red-50 px-2 text-red-700">{e} {t.builder.validation.errors}</span>}
            {w > 0 && <span className="rounded-full bg-amber-50 px-2 text-amber-700">{w} {t.builder.validation.warnings}</span>}
            {s > 0 && <span className="rounded-full bg-blue-50 px-2 text-blue-700">{s} {t.builder.validation.suggestions}</span>}
          </>
        )}
        <span className="ms-auto">{open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</span>
      </button>
      {open && total > 0 && (
        <div className="max-h-48 overflow-y-auto border-t border-gray-100 p-3 scrollbar-thin">
          <List label={t.builder.validation.errors} items={validation.errors} icon={AlertCircle} cls="text-red-600 bg-red-50" onJump={onJump} />
          <List label={t.builder.validation.warnings} items={validation.warnings} icon={AlertTriangle} cls="text-amber-600 bg-amber-50" onJump={onJump} />
          <List label={t.builder.validation.suggestions} items={validation.suggestions} icon={Lightbulb} cls="text-blue-600 bg-blue-50" onJump={onJump} />
        </div>
      )}
    </div>
  );
}

function List({ label, items, icon: Icon, cls, onJump }: {
  label: string;
  items: { code: string; message: string; stepId?: string }[];
  icon: React.ComponentType<any>;
  cls: string;
  onJump: (id?: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mb-3">
      <div className="mb-1 text-[11px] font-bold uppercase text-gray-500">{label}</div>
      <ul className="space-y-1">
        {items.map((i, idx) => (
          <li key={idx}>
            <button onClick={() => onJump(i.stepId)} className={clsx('flex w-full items-start gap-2 rounded p-1.5 text-start text-xs hover:bg-gray-50', cls)}>
              <Icon size={12} />
              <span className="flex-1">{i.message}</span>
              <span className="text-[10px] opacity-50">{i.code}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
