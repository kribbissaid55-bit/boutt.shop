import { useState } from 'react';
import { DndContext, closestCenter, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { GripVertical, Trash2, Power } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { Empty } from '../../../components/ui/Empty';
import { BlockEditor } from './BlockEditor';
import type { Bot, BotStep, MessageBlock } from '../types';

export function MessageSequenceBuilder({ bot, step, onChanged }: { bot: Bot; step: BotStep; onChanged: () => void }) {
  const { t } = useI18n();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const oldIdx = step.blocks.findIndex((b) => b.id === e.active.id);
    const newIdx = step.blocks.findIndex((b) => b.id === e.over!.id);
    const reordered = arrayMove(step.blocks, oldIdx, newIdx);
    await api.post('/blocks/reorder', { stepId: step.id, ids: reordered.map((b) => b.id) });
    onChanged();
  };

  if (step.blocks.length === 0) {
    return <Empty hint={t.builder.add_block + ' →'} />;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} modifiers={[restrictToVerticalAxis]}>
      <SortableContext items={step.blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {step.blocks.map((b) => (
            <SortableBlock key={b.id} bot={bot} step={step} block={b} onChanged={onChanged} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableBlock({ bot, step, block, onChanged }: { bot: Bot; step: BotStep; block: MessageBlock; onChanged: () => void }) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const [enabled, setEnabled] = useState(block.enabled);

  const toggle = async (v: boolean) => {
    setEnabled(v);
    await api.patch(`/blocks/${block.id}`, { enabled: v });
    onChanged();
  };
  const remove = async () => {
    await api.delete(`/blocks/${block.id}`);
    onChanged();
  };

  return (
    <div
      ref={setNodeRef} style={style}
      className={clsx(
        'rounded-lg border bg-white p-3',
        enabled ? 'border-gray-200' : 'border-dashed border-gray-300 opacity-60'
      )}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <button {...attributes} {...listeners} className="cursor-grab text-gray-300 hover:text-gray-500">
            <GripVertical size={16} />
          </button>
          <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700">
            {(t.builder.block_types as any)[block.type] ?? block.type}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => toggle(!enabled)} className={clsx('rounded p-1', enabled ? 'text-gray-400 hover:bg-gray-100' : 'text-amber-500 hover:bg-amber-50')} title={t.builder.block_enabled}>
            <Power size={14} />
          </button>
          <button onClick={remove} className="rounded p-1 text-red-500 hover:bg-red-50" title={t.builder.block_delete}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <BlockEditor bot={bot} step={step} block={block} onChanged={onChanged} />
    </div>
  );
}
