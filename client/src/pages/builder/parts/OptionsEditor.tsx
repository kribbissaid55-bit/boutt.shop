import { useState } from 'react';
import { Plus, Trash2, ArrowRight } from 'lucide-react';
import { api } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { StepPickerModal } from './StepPickerModal';
import type { Bot, BotStep, BotOption } from '../types';

export function OptionsEditor({ bot, step, onChanged }: { bot: Bot; step: BotStep; onChanged: () => void }) {
  const { t } = useI18n();
  const [pickFor, setPickFor] = useState<string | null>(null);

  const stepsById = new Map(bot.steps.map((s) => [s.id, s]));

  const addOption = async () => {
    const num = String(step.options.length + 1);
    const target = bot.steps.find((s) => s.id !== step.id);
    await api.post(`/steps/${step.id}/options`, {
      number: num,
      label: `Option ${num}`,
      targetStepId: target?.id ?? null,
    });
    onChanged();
  };

  const update = async (opt: BotOption, patch: any) => {
    await api.patch(`/options/${opt.id}`, patch);
    onChanged();
  };

  const remove = async (id: string) => {
    await api.delete(`/options/${id}`);
    onChanged();
  };

  const quickAdd = async (kind: 'back_to_main' | 'send_to_human' | 'collect_order') => {
    const main = bot.steps.find((s) => s.type === 'welcome');
    const human = bot.steps.find((s) => s.type === 'handover');
    const order = bot.steps.find((s) => s.type === 'order');
    let target: BotStep | undefined;
    let label = '';
    if (kind === 'back_to_main') { target = main; label = t.builder.quick_back_to_main; }
    if (kind === 'send_to_human') { target = human; label = t.builder.quick_send_to_human; }
    if (kind === 'collect_order') { target = order; label = t.builder.quick_collect_order; }
    if (!target) { alert('No matching step in this bot'); return; }
    const num = String(step.options.length + 1);
    await api.post(`/steps/${step.id}/options`, { number: num, label, targetStepId: target.id });
    onChanged();
  };

  return (
    <div className="space-y-3">
      {step.options.length > 0 && (
        <div className="space-y-2">
          {step.options.map((o) => (
            <div key={o.id} className="grid grid-cols-12 items-start gap-2 rounded-lg border border-gray-100 p-2">
              <Input className="col-span-1 text-center font-bold" value={o.number} onChange={(e) => update(o, { number: e.target.value })} />
              <Input className="col-span-5" placeholder={t.builder.option_label} value={o.label} onChange={(e) => update(o, { label: e.target.value })} />
              <Input className="col-span-3" placeholder={t.builder.option_keywords}
                value={parseKw(o.keywords)} onChange={(e) => update(o, { keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
              <button
                className="col-span-2 flex items-center justify-between gap-1 rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs hover:border-brand-500"
                onClick={() => setPickFor(o.id)}
              >
                <span className="truncate">{o.targetStepId ? (stepsById.get(o.targetStepId)?.title ?? '—') : t.builder.pick_target}</span>
                <ArrowRight size={12} className="shrink-0 ltr-flip rtl:ltr-flip" />
              </button>
              <button onClick={() => remove(o.id)} className="col-span-1 rounded p-1 text-red-500 hover:bg-red-50"><Trash2 size={14} /></button>

              {pickFor === o.id && (
                <StepPickerModal
                  open={true}
                  bot={bot}
                  excludeId={null}
                  onClose={() => setPickFor(null)}
                  onPick={async (stepId) => { await update(o, { targetStepId: stepId }); setPickFor(null); }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={addOption}><Plus size={12} /> {t.builder.add_option}</Button>
        <Button size="sm" variant="ghost" onClick={() => quickAdd('back_to_main')}>↩ {t.builder.quick_back_to_main}</Button>
        <Button size="sm" variant="ghost" onClick={() => quickAdd('send_to_human')}>👤 {t.builder.quick_send_to_human}</Button>
        <Button size="sm" variant="ghost" onClick={() => quickAdd('collect_order')}>🛒 {t.builder.quick_collect_order}</Button>
      </div>
    </div>
  );
}

function parseKw(s: string | null): string {
  if (!s) return '';
  try { return (JSON.parse(s) as string[]).join(', '); } catch { return ''; }
}
