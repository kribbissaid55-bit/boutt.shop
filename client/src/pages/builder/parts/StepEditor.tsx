import { useState, useEffect } from 'react';
import { Plus, Settings as SettingsIcon, Save, Type, Mic, Image as ImageIcon, Video, FileText, Clock, ListChecks, Zap } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Input, Field, Textarea } from '../../../components/ui/Input';
import { Modal } from '../../../components/ui/Modal';
import { MessageSequenceBuilder } from './MessageSequenceBuilder';
import { OptionsEditor } from './OptionsEditor';
import type { Bot, BotStep, BlockType } from '../types';

export function StepEditor({ bot, step, onChanged }: { bot: Bot; step: BotStep; onChanged: () => void; focusBlockId: string | null }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(step.title);
  const [description, setDescription] = useState(step.description ?? '');
  const [triggerValue, setTriggerValue] = useState(step.triggerValue ?? '');
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    setTitle(step.title);
    setDescription(step.description ?? '');
    setTriggerValue(step.triggerValue ?? '');
  }, [step.id]);

  const saveBasics = async () => {
    await api.patch(`/steps/${step.id}`, { title, description, triggerValue: triggerValue || null });
    toast.success(t.app.saved);
    onChanged();
  };

  const addBlock = async (type: BlockType) => {
    const defaults: any = { type };
    if (type === 'delay') defaults.delaySeconds = 2;
    if (type === 'options') defaults.content = '';
    if (type === 'action') defaults.actionType = 'pause_bot';
    await api.post(`/steps/${step.id}/blocks`, defaults);
    onChanged();
  };

  const showTrigger = step.type === 'keyword' || step.type === 'exact_match';
  const stepTypeLabel = (t.builder.step_types as any)[step.type] ?? step.type;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <Card>
        <CardHeader actions={
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setShowSettings(true)}><SettingsIcon size={14} /></Button>
            <Button size="sm" variant="secondary" onClick={saveBasics}><Save size={14} />{t.app.save}</Button>
          </div>
        }>
          <span className="rounded bg-brand-50 px-2 py-0.5 text-xs text-brand-700">{stepTypeLabel}</span>
        </CardHeader>
        <CardBody className="space-y-3">
          <Field label={t.builder.step_title} required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="text-base font-semibold" />
          </Field>
          {showTrigger && (
            <Field label={t.builder.trigger_value} hint={t.builder.trigger_value_help}>
              <Input value={triggerValue} onChange={(e) => setTriggerValue(e.target.value)} />
            </Field>
          )}
          <Field label={t.builder.step_description}>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader actions={<AddBlockToolbar onAdd={addBlock} />}>{t.builder.msg_sequence}</CardHeader>
        <CardBody>
          <MessageSequenceBuilder bot={bot} step={step} onChanged={onChanged} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>{t.builder.add_option}s</CardHeader>
        <CardBody>
          <OptionsEditor bot={bot} step={step} onChanged={onChanged} />
        </CardBody>
      </Card>

      <StepSettingsModal open={showSettings} step={step} onClose={() => setShowSettings(false)} onSaved={onChanged} />
    </div>
  );
}

function AddBlockToolbar({ onAdd }: { onAdd: (type: BlockType) => void }) {
  const { t } = useI18n();
  const items: { type: BlockType; icon: React.ComponentType<any>; label: string }[] = [
    { type: 'text',     icon: Type,       label: t.builder.block_types.text },
    { type: 'image',    icon: ImageIcon,  label: t.builder.block_types.image },
    { type: 'audio',    icon: Mic,        label: t.builder.block_types.audio },
    { type: 'video',    icon: Video,      label: t.builder.block_types.video },
    { type: 'document', icon: FileText,   label: t.builder.block_types.document },
    { type: 'delay',    icon: Clock,      label: t.builder.block_types.delay },
    { type: 'options',  icon: ListChecks, label: t.builder.block_types.options },
    { type: 'action',   icon: Zap,        label: t.builder.block_types.action },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it) => (
        <button
          key={it.type}
          onClick={() => onAdd(it.type)}
          className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:border-brand-500 hover:text-brand-700"
        >
          <it.icon size={12} /> {it.label}
        </button>
      ))}
    </div>
  );
}

function StepSettingsModal({ open, step, onClose, onSaved }: {
  open: boolean; step: BotStep; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useI18n();
  const [isActive, setIsActive] = useState(step.isActive);
  useEffect(() => { setIsActive(step.isActive); }, [step.id]);

  const save = async () => {
    await api.patch(`/steps/${step.id}`, { isActive });
    onSaved(); onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={t.builder.step_settings}
      footer={<><Button variant="secondary" onClick={onClose}>{t.app.cancel}</Button><Button onClick={save}>{t.app.save}</Button></>}>
      <label className="flex items-center justify-between gap-2 py-2 text-sm">
        <span>{t.builder.step_active}</span>
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
      </label>
    </Modal>
  );
}
