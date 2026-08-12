import { useState, useEffect } from 'react';
import { Image as ImageIcon, Mic, Video, FileText, X } from 'lucide-react';
import { api } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { Input, Field, Textarea } from '../../../components/ui/Input';
import { Button } from '../../../components/ui/Button';
import { MediaPickerModal } from './MediaPickerModal';
import type { Bot, BotStep, MessageBlock, DisplayMode } from '../types';

/** Debounced auto-save on every text field. */
function useDebouncedSave(blockId: string, onChanged: () => void) {
  return (patch: any) => {
    const tm = setTimeout(async () => {
      await api.patch(`/blocks/${blockId}`, patch);
      onChanged();
    }, 600);
    return () => clearTimeout(tm);
  };
}

export function BlockEditor({ bot, step, block, onChanged }: { bot: Bot; step: BotStep; block: MessageBlock; onChanged: () => void }) {
  void bot; void step;
  switch (block.type) {
    case 'text':     return <TextBlock block={block} onChanged={onChanged} />;
    case 'image':    return <MediaBlock kind="image"    block={block} onChanged={onChanged} />;
    case 'audio':    return <MediaBlock kind="audio"    block={block} onChanged={onChanged} />;
    case 'video':    return <MediaBlock kind="video"    block={block} onChanged={onChanged} />;
    case 'document': return <MediaBlock kind="document" block={block} onChanged={onChanged} />;
    case 'delay':    return <DelayBlock  block={block} onChanged={onChanged} />;
    case 'options':  return <OptionsBlock block={block} onChanged={onChanged} />;
    case 'action':   return <ActionBlock block={block} onChanged={onChanged} />;
  }
}

function TextBlock({ block, onChanged }: { block: MessageBlock; onChanged: () => void }) {
  const { t } = useI18n();
  const [val, setVal] = useState(block.content ?? '');
  useEffect(() => { setVal(block.content ?? ''); }, [block.id]);
  useEffect(() => {
    if (val === (block.content ?? '')) return;
    const tm = setTimeout(async () => {
      await api.patch(`/blocks/${block.id}`, { content: val });
      onChanged();
    }, 700);
    return () => clearTimeout(tm);
  }, [val]);

  return (
    <Textarea
      value={val}
      onChange={(e) => setVal(e.target.value)}
      placeholder={t.builder.block_text_placeholder}
      rows={3}
    />
  );
}

function MediaBlock({ kind, block, onChanged }: { kind: 'image' | 'audio' | 'video' | 'document'; block: MessageBlock; onChanged: () => void }) {
  const { t } = useI18n();
  const [pick, setPick] = useState(false);
  const [caption, setCaption] = useState(block.caption ?? '');
  useEffect(() => { setCaption(block.caption ?? ''); }, [block.id]);
  useEffect(() => {
    if (caption === (block.caption ?? '')) return;
    const tm = setTimeout(() => api.patch(`/blocks/${block.id}`, { caption }).then(onChanged), 700);
    return () => clearTimeout(tm);
  }, [caption]);

  const detach = async () => { await api.patch(`/blocks/${block.id}`, { mediaId: null }); onChanged(); };

  const Icon = kind === 'image' ? ImageIcon : kind === 'audio' ? Mic : kind === 'video' ? Video : FileText;

  return (
    <div className="space-y-2">
      {block.media ? (
        <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-2">
          {kind === 'image' ? (
            <img src={`/api/media/${block.media.id}/raw`} className="h-16 w-16 rounded object-cover" />
          ) : kind === 'video' ? (
            <video src={`/api/media/${block.media.id}/raw`} className="h-16 w-24 rounded bg-black" />
          ) : kind === 'audio' ? (
            <audio src={`/api/media/${block.media.id}/raw`} controls className="max-w-full" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded bg-white"><Icon size={22} className="text-gray-500" /></div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{block.media.name}</div>
            <div className="text-xs text-gray-500">{block.media.mimeType}</div>
          </div>
          <button onClick={detach} className="rounded p-1 text-red-500 hover:bg-red-50"><X size={14} /></button>
        </div>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setPick(true)}>
          <Icon size={14} /> {t.builder.block_pick_media}
        </Button>
      )}

      {(kind === 'image' || kind === 'video' || kind === 'document') && (
        <Field label={t.builder.block_caption}>
          <Input value={caption} onChange={(e) => setCaption(e.target.value)} />
        </Field>
      )}

      <MediaPickerModal
        open={pick}
        kindFilter={kind}
        onClose={() => setPick(false)}
        onPick={async (mediaId) => {
          await api.patch(`/blocks/${block.id}`, { mediaId });
          setPick(false); onChanged();
        }}
      />
    </div>
  );
}

function DelayBlock({ block, onChanged }: { block: MessageBlock; onChanged: () => void }) {
  const { t } = useI18n();
  const [secs, setSecs] = useState(block.delaySeconds ?? 2);
  useEffect(() => { setSecs(block.delaySeconds ?? 2); }, [block.id]);
  useEffect(() => {
    if (secs === (block.delaySeconds ?? 2)) return;
    const tm = setTimeout(() => api.patch(`/blocks/${block.id}`, { delaySeconds: secs }).then(onChanged), 600);
    return () => clearTimeout(tm);
  }, [secs]);

  return (
    <Field label={t.builder.block_delay_seconds}>
      <Input type="number" min={0} max={60} value={secs} onChange={(e) => setSecs(+e.target.value)} className="max-w-[160px]" />
    </Field>
  );
}

function OptionsBlock({ block, onChanged }: { block: MessageBlock; onChanged: () => void }) {
  const { t } = useI18n();
  const [content, setContent] = useState(block.content ?? '');
  const meta = (() => { try { return block.metadata ? JSON.parse(block.metadata) : {}; } catch { return {}; } })();
  const [mode, setMode] = useState<DisplayMode>((meta.displayMode ?? 'poll') as DisplayMode);

  useEffect(() => { setContent(block.content ?? ''); setMode((meta.displayMode ?? 'poll') as DisplayMode); }, [block.id]);

  useEffect(() => {
    if (content === (block.content ?? '')) return;
    const tm = setTimeout(() => api.patch(`/blocks/${block.id}`, { content }).then(onChanged), 700);
    return () => clearTimeout(tm);
  }, [content]);

  const updateMode = async (v: DisplayMode) => {
    setMode(v);
    await api.patch(`/blocks/${block.id}`, { metadata: { ...meta, displayMode: v } });
    onChanged();
  };

  return (
    <div className="space-y-2">
      <Field label={t.builder.options_header}>
        <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={2} />
      </Field>
      <Field label={t.builder.options_display_mode}>
        <select className="block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={mode} onChange={(e) => updateMode(e.target.value as DisplayMode)}>
          {Object.entries(t.builder.options_modes).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      {mode === 'poll' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">
          ✓ {t.builder.options_hint_poll}
        </div>
      )}
      {mode === 'buttons' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          ⚠ {t.builder.options_warn_buttons}
        </div>
      )}
      <p className="text-xs text-gray-500">↓ الاختيارات نفسهم تتعرفهم في الأسفل / Les options elles-mêmes se définissent ci-dessous</p>
    </div>
  );
}

function ActionBlock({ block, onChanged }: { block: MessageBlock; onChanged: () => void }) {
  const { t } = useI18n();
  const [type, setType] = useState(block.actionType ?? 'pause_bot');
  useEffect(() => { setType(block.actionType ?? 'pause_bot'); }, [block.id]);

  const update = async (v: string) => {
    setType(v);
    await api.patch(`/blocks/${block.id}`, { actionType: v });
    onChanged();
  };

  return (
    <Field label={t.builder.action_type}>
      <select className="block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={type} onChange={(e) => update(e.target.value)}>
        {Object.entries(t.builder.actions).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
    </Field>
  );
}
