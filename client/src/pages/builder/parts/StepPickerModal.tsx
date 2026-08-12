import { useI18n } from '../../../i18n';
import { Modal } from '../../../components/ui/Modal';
import type { Bot } from '../types';

export function StepPickerModal({ open, bot, excludeId, onClose, onPick }: {
  open: boolean; bot: Bot; excludeId: string | null;
  onClose: () => void; onPick: (stepId: string) => void;
}) {
  const { t } = useI18n();
  const visible = bot.steps.filter((s) => s.id !== excludeId);
  return (
    <Modal open={open} onClose={onClose} title={t.builder.pick_target} wide>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {visible.map((s) => (
          <button key={s.id} onClick={() => onPick(s.id)}
            className="flex items-start gap-2 rounded-lg border border-gray-200 p-3 text-start hover:border-brand-500">
            <div className="rounded-md bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700">{(t.builder.step_types as any)[s.type] ?? s.type}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{s.title}</div>
              <div className="text-xs text-gray-500">{s.blocks.length} blocks · {s.options.length} options</div>
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}
