/**
 * MenuBubble — the "options as a separate message" bubble used by both the
 * test simulator and the live WhatsApp preview.
 *
 * Layout (matches what the customer will conceptually see):
 *
 *   ┌─────────────────────────┐
 *   │       [☰]               │  ← single icon at top center
 *   │                         │
 *   │   اختار من القائمة:     │  ← header (centered)
 *   │                         │
 *   │   ┌─────────────────┐  │
 *   │   │ [1]  السعر   →  │  │  ← stacked option rows, tappable
 *   │   └─────────────────┘  │
 *   │   ┌─────────────────┐  │
 *   │   │ [2]  التوصيل  →  │  │
 *   │   └─────────────────┘  │
 *   └─────────────────────────┘
 */
import { LayoutList, ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../../../i18n';

export interface MenuBubbleProps {
  header?: string;
  options: { number: string; label: string }[];
  mode?: 'numbered' | 'buttons' | 'list' | 'auto';
  onPick?: (number: string) => void;
  ts?: number;
  /** Compact mode for the live preview panel (slightly smaller). */
  compact?: boolean;
}

const fmtTime = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function MenuBubble({ header, options, mode = 'numbered', onPick, ts, compact }: MenuBubbleProps) {
  const { lang } = useI18n();
  const Chevron = lang === 'ar' ? ChevronLeft : ChevronRight;
  const tappable = !!onPick;

  return (
    <div className="flex justify-start">
      <div className={`max-w-[92%] rounded-lg rounded-tl-sm bg-white shadow-sm ${compact ? 'p-2' : 'p-3'}`}>
        {/* Single menu icon */}
        <div className="mb-1.5 flex justify-center">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-brand-700">
            <LayoutList size={16} />
          </div>
        </div>

        {/* Header */}
        {header && (
          <div className={`mb-2 whitespace-pre-wrap text-center font-medium text-gray-800 ${compact ? 'text-[12px]' : 'text-[13px]'}`}>
            {header}
          </div>
        )}

        {/* Stacked options */}
        <div className="space-y-1.5">
          {options.map((o) => (
            <button
              key={o.number}
              type="button"
              onClick={onPick ? () => onPick(o.number) : undefined}
              disabled={!tappable}
              className={`group flex w-full items-center gap-2 rounded-lg border border-gray-200 bg-white py-2 ps-2 pe-2 text-start transition ${
                tappable
                  ? 'cursor-pointer hover:border-brand-500 hover:bg-brand-50 active:scale-[0.98]'
                  : 'cursor-default'
              }`}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[11px] font-bold text-brand-700">
                {o.number}
              </span>
              <span className={`flex-1 truncate text-center text-gray-800 ${compact ? 'text-[12px]' : 'text-[13px]'}`}>
                {o.label}
              </span>
              {tappable && (
                <Chevron size={14} className="shrink-0 text-gray-300 group-hover:text-brand-500" />
              )}
            </button>
          ))}
        </div>

        {/* Footer: timestamp + (optional) mode badge */}
        <div className="mt-1.5 flex items-center justify-between gap-2">
          {mode !== 'numbered' ? (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">⚠ {mode}</span>
          ) : <span />}
          {ts !== undefined && <span className="text-[10px] text-gray-400">{fmtTime(ts)}</span>}
        </div>
      </div>
    </div>
  );
}
