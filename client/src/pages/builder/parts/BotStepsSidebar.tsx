import { useState } from 'react';
import {
  DndContext, closestCenter, type DragEndEvent, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { Plus, Copy, Trash2, AlertCircle, GripVertical, MessageSquare, Star, KeyRound, Hash, ListChecks, ShieldQuestion, UserRoundCog, ShoppingCart, MessageCircle, StopCircle } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { api } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { Button } from '../../../components/ui/Button';
import { Modal } from '../../../components/ui/Modal';
import { Input, Field } from '../../../components/ui/Input';
import type { Bot, BotStep, StepType, ValidationReport } from '../types';

const TYPE_ICONS: Record<StepType, React.ComponentType<any>> = {
  welcome: Star, keyword: KeyRound, exact_match: Hash, option_reply: ListChecks,
  fallback: ShieldQuestion, handover: UserRoundCog, order: ShoppingCart, normal: MessageCircle, end: StopCircle,
};

export function BotStepsSidebar({
  bot, selectedStepId, validation, onSelect, onChanged,
}: {
  bot: Bot;
  selectedStepId: string | null;
  validation: ValidationReport | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const issuesByStep = (() => {
    const map = new Map<string, number>();
    if (!validation) return map;
    for (const set of [validation.errors, validation.warnings]) {
      for (const i of set) if (i.stepId) map.set(i.stepId, (map.get(i.stepId) ?? 0) + 1);
    }
    return map;
  })();

  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const oldIdx = bot.steps.findIndex((s) => s.id === e.active.id);
    const newIdx = bot.steps.findIndex((s) => s.id === e.over!.id);
    const reordered = arrayMove(bot.steps, oldIdx, newIdx);
    await api.post('/steps/reorder', { botId: bot.id, ids: reordered.map((s) => s.id) });
    onChanged();
  };

  const duplicate = async (stepId: string) => {
    await api.post(`/steps/${stepId}/duplicate`);
    onChanged();
  };
  const remove = async (stepId: string) => {
    if (!confirm(t.builder.delete_step_confirm)) return;
    await api.delete(`/steps/${stepId}`);
    onChanged();
    toast.success(t.app.saved);
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-e border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-100 p-3">
        <span className="text-sm font-semibold text-gray-700">{bot.steps.length} {t.builder.add_step.replace('إضافة ', '').replace('Ajouter une ', '')}</span>
        <Button size="sm" onClick={() => setAdding(true)}><Plus size={14} /> {t.builder.add_step}</Button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 scrollbar-thin">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} modifiers={[restrictToVerticalAxis]}>
          <SortableContext items={bot.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {bot.steps.map((s) => (
              <StepCard
                key={s.id}
                step={s}
                selected={selectedStepId === s.id}
                issueCount={issuesByStep.get(s.id) ?? 0}
                onSelect={() => onSelect(s.id)}
                onDuplicate={() => duplicate(s.id)}
                onDelete={() => remove(s.id)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      <AddStepModal
        open={adding}
        onClose={() => setAdding(false)}
        botId={bot.id}
        onCreated={(id) => { setAdding(false); onChanged(); setTimeout(() => onSelect(id), 100); }}
      />
    </aside>
  );
}

function StepCard({ step, selected, issueCount, onSelect, onDuplicate, onDelete }: {
  step: BotStep; selected: boolean; issueCount: number;
  onSelect: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const Icon = TYPE_ICONS[step.type] ?? MessageSquare;

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      className={clsx(
        'group mb-1 flex cursor-pointer items-start gap-2 rounded-lg border p-2 transition',
        selected ? 'border-brand-500 bg-brand-50' : 'border-transparent hover:bg-gray-50'
      )}
    >
      <button
        {...attributes} {...listeners}
        className="cursor-grab text-gray-300 hover:text-gray-500"
        onClick={(e) => e.stopPropagation()}
      ><GripVertical size={14} /></button>
      <div className={clsx('mt-0.5 rounded-md p-1', selected ? 'bg-white' : 'bg-gray-100')}>
        <Icon size={14} className="text-gray-700" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-gray-800">{step.title}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-500">
          <span>{(t.builder.step_types as any)[step.type] ?? step.type}</span>
          <span>· {step.blocks.length} {t.builder.block_types.text === 'نص' ? 'كتلة' : 'blocs'}</span>
          {step.options.length > 0 && <span>· {step.options.length} ⓘ</span>}
        </div>
      </div>
      {issueCount > 0 && (
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
          <AlertCircle size={10} className="mr-0.5 inline" />{issueCount}
        </span>
      )}
      <div className="opacity-0 transition group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
        <button onClick={onDuplicate} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"><Copy size={12} /></button>
        <button onClick={onDelete} className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={12} /></button>
      </div>
    </div>
  );
}

function AddStepModal({ open, onClose, botId, onCreated }: {
  open: boolean; onClose: () => void; botId: string; onCreated: (id: string) => void;
}) {
  const { t } = useI18n();
  const [type, setType] = useState<StepType>('normal');
  const [title, setTitle] = useState('');
  const [triggerValue, setTriggerValue] = useState('');

  const create = async () => {
    if (!title.trim()) return;
    const res = await api.post<{ id: string }>(`/bots/${botId}/steps`, {
      type,
      title: title.trim(),
      triggerValue: triggerValue.trim() || null,
    });
    onCreated(res.id);
    setTitle(''); setTriggerValue(''); setType('normal');
  };

  return (
    <Modal open={open} onClose={onClose} title={t.builder.add_step}
      footer={<><Button variant="secondary" onClick={onClose}>{t.app.cancel}</Button><Button onClick={create}>{t.app.create}</Button></>}>
      <div className="space-y-3">
        <Field label={t.builder.step_title} required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label={t.app.actions}>
          <select className="block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={type} onChange={(e) => setType(e.target.value as StepType)}>
            {Object.entries(t.builder.step_types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        {(type === 'keyword' || type === 'exact_match') && (
          <Field label={t.builder.trigger_value} hint={t.builder.trigger_value_help}>
            <Input value={triggerValue} onChange={(e) => setTriggerValue(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}
