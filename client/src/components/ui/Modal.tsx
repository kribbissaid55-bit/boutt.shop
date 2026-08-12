import { useEffect } from 'react';
import { X } from 'lucide-react';

export function Modal({
  open, onClose, title, children, footer, wide, tall,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  /** When true, the modal claims 85vh and the body scrolls internally —
   *  header + footer stay pinned. Use for long forms (e.g. RuleEditor). */
  tall?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    if (open) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className={`flex max-h-[85vh] w-full flex-col rounded-xl bg-white shadow-xl ${
          wide ? 'max-w-3xl' : 'max-w-md'
        } ${tall ? 'h-[85vh]' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex shrink-0 items-center justify-between border-b border-gray-100 p-4">
            <h3 className="text-lg font-semibold">{title}</h3>
            <button onClick={onClose} className="rounded p-1 hover:bg-gray-100"><X size={18} /></button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">{children}</div>
        {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-gray-100 p-4">{footer}</div>}
      </div>
    </div>
  );
}
