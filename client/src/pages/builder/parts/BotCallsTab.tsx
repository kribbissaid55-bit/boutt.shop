/**
 * BotCallsTab — per-bot incoming call handling.
 *
 * Toggles auto-rejection for this bot, sets a "ring before reject" delay
 * (so the call doesn't end abruptly), and lets the owner compose a multi-block
 * follow-up sequence (text + image + video + audio + document, repeatable)
 * that is sent right after the rejection.
 *
 * The reply uses the same MessageSequence shape as the bot's welcome step,
 * so the engine reuses runMessageSequence verbatim.
 */
import { useEffect, useState } from 'react';
import { Save, Plus, Trash2, ChevronUp, ChevronDown, Image as ImageIcon, Mic, Video, FileText, Type } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { api } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Input, Field, Textarea } from '../../../components/ui/Input';
import { MediaPickerModal } from './MediaPickerModal';

type BlockType = 'text' | 'image' | 'video' | 'audio' | 'document';

interface Block {
  type: BlockType;
  content?: string;
  mediaId?: string;
  caption?: string;
  enabled: boolean;
}

interface BotSettings {
  callRejectionEnabled?: boolean;
  callRejectionDelaySeconds?: number;
  callRejectionSequence?: { blocks: Block[] } | null;
  // ... other settings
}

interface Media { id: string; name: string; type: string }

export function BotCallsTab({ botId }: { botId: string }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [delaySec, setDelaySec] = useState(0);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState(false);
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [mediaIndex, setMediaIndex] = useState<Map<string, Media>>(new Map());

  // load settings
  useEffect(() => {
    (async () => {
      const bot = await api.get<{ settings: BotSettings | null }>(`/bots/${botId}`);
      const s = bot.settings ?? {};
      setEnabled(!!s.callRejectionEnabled);
      setDelaySec(s.callRejectionDelaySeconds ?? 0);
      const raw = s.callRejectionSequence;
      const parsed = typeof raw === 'string' ? safeParse(raw) : raw;
      setBlocks(parsed?.blocks ?? []);
    })().catch(() => {});
    // load media library once for name lookups
    api.get<Media[]>('/media').then((all) => {
      const m = new Map<string, Media>();
      all.forEach((x) => m.set(x.id, x));
      setMediaIndex(m);
    }).catch(() => {});
  }, [botId]);

  const addBlock = (type: BlockType) => {
    setBlocks((prev) => [...prev, { type, enabled: true }]);
  };
  const removeBlock = (i: number) => setBlocks((prev) => prev.filter((_, idx) => idx !== i));
  const moveBlock = (i: number, dir: -1 | 1) => {
    setBlocks((prev) => {
      const copy = [...prev];
      const j = i + dir;
      if (j < 0 || j >= copy.length) return prev;
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  };
  const updateBlock = (i: number, patch: Partial<Block>) => {
    setBlocks((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  };

  const save = async () => {
    // Validate before save — silent-failures are the worst UX.
    if (enabled) {
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type === 'text' && !(b.content ?? '').trim()) {
          toast.error(`${labelForType(t, 'text')} #${i + 1}: ${t.builder.calls.textPh}`);
          return;
        }
        if (b.type !== 'text' && !b.mediaId) {
          toast.error(`${labelForType(t, b.type)} #${i + 1}: ${t.builder.calls.noMedia}`);
          return;
        }
      }
    }
    const cleanDelay = Number.isFinite(delaySec) && delaySec >= 0 ? Math.min(10, delaySec) : 0;
    setBusy(true);
    try {
      await api.patch(`/bots/${botId}/settings`, {
        callRejectionEnabled: enabled,
        callRejectionDelaySeconds: cleanDelay,
        callRejectionSequence: { blocks },
      });
      toast.success(t.app.saved);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <Card>
        <CardHeader>{t.builder.calls.title}</CardHeader>
        <CardBody className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-800">{t.builder.calls.autoReject}</span>
            <label className="relative inline-flex cursor-pointer items-center">
              <input type="checkbox" className="peer sr-only" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <div className="h-5 w-9 rounded-full bg-gray-200 peer-checked:bg-brand-500 transition" />
              <div className="absolute start-0.5 top-0.5 h-4 w-4 rounded-full bg-white peer-checked:translate-x-4 rtl:peer-checked:-translate-x-4 transition" />
            </label>
          </div>
          <p className="text-[11px] text-gray-500">{t.builder.calls.autoRejectHint}</p>

          {enabled && (
            <Field label={t.builder.calls.ringDelay}>
              <Input
                type="number"
                min={0}
                max={10}
                value={delaySec}
                onChange={(e) => setDelaySec(+e.target.value)}
                className="max-w-[120px]"
              />
              <p className="mt-1 text-[11px] text-gray-500">{t.builder.calls.ringDelayHint}</p>
            </Field>
          )}
        </CardBody>
      </Card>

      {enabled && (
        <Card>
          <CardHeader>{t.builder.calls.replySequence}</CardHeader>
          <CardBody className="space-y-2">
            {blocks.length === 0 && (
              <p className="text-xs text-gray-400">{t.builder.calls.noBlocks}</p>
            )}
            {blocks.map((b, i) => (
              <div key={i} className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className={clsx('inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium', typeBadge(b.type))}>
                    {typeIcon(b.type)} {labelForType(t, b.type)}
                  </span>
                  <div className="ms-auto flex items-center gap-1">
                    <button onClick={() => moveBlock(i, -1)} disabled={i === 0} className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30">
                      <ChevronUp size={14} />
                    </button>
                    <button onClick={() => moveBlock(i, 1)} disabled={i === blocks.length - 1} className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30">
                      <ChevronDown size={14} />
                    </button>
                    <button onClick={() => removeBlock(i)} className="rounded p-1 text-red-500 hover:bg-red-50">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {b.type === 'text' ? (
                  <Textarea
                    rows={2}
                    value={b.content ?? ''}
                    onChange={(e) => updateBlock(i, { content: e.target.value })}
                    placeholder={t.builder.calls.textPh}
                  />
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" onClick={() => setPickerFor(i)}>
                        {t.builder.calls.pickMedia}
                      </Button>
                      <span className="text-xs text-gray-600">
                        {b.mediaId
                          ? (mediaIndex.get(b.mediaId)?.name ?? b.mediaId.slice(0, 8))
                          : t.builder.calls.noMedia}
                      </span>
                    </div>
                    <Input
                      value={b.caption ?? ''}
                      onChange={(e) => updateBlock(i, { caption: e.target.value })}
                      placeholder={t.builder.calls.captionPh}
                    />
                  </div>
                )}
              </div>
            ))}

            <div className="flex flex-wrap gap-2 pt-2">
              <AddBtn onClick={() => addBlock('text')}><Type size={12} /> {labelForType(t, 'text')}</AddBtn>
              <AddBtn onClick={() => addBlock('image')}><ImageIcon size={12} /> {labelForType(t, 'image')}</AddBtn>
              <AddBtn onClick={() => addBlock('video')}><Video size={12} /> {labelForType(t, 'video')}</AddBtn>
              <AddBtn onClick={() => addBlock('audio')}><Mic size={12} /> {labelForType(t, 'audio')}</AddBtn>
              <AddBtn onClick={() => addBlock('document')}><FileText size={12} /> {labelForType(t, 'document')}</AddBtn>
            </div>
          </CardBody>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={save} loading={busy}>
          <Save size={14} /> {t.app.save}
        </Button>
      </div>

      <MediaPickerModal
        open={pickerFor !== null}
        kindFilter={pickerFor !== null ? blocks[pickerFor]?.type as any : undefined}
        onClose={() => setPickerFor(null)}
        onPick={(id) => {
          if (pickerFor !== null) updateBlock(pickerFor, { mediaId: id });
          setPickerFor(null);
        }}
      />
    </div>
  );
}

function AddBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:border-brand-400 hover:text-brand-700"
    >
      <Plus size={12} /> {children}
    </button>
  );
}

function typeBadge(t: BlockType): string {
  if (t === 'text') return 'bg-gray-100 text-gray-700';
  if (t === 'image') return 'bg-blue-50 text-blue-700';
  if (t === 'video') return 'bg-purple-50 text-purple-700';
  if (t === 'audio') return 'bg-emerald-50 text-emerald-700';
  return 'bg-amber-50 text-amber-700';
}
function typeIcon(t: BlockType) {
  const sz = 11;
  if (t === 'text') return <Type size={sz} />;
  if (t === 'image') return <ImageIcon size={sz} />;
  if (t === 'video') return <Video size={sz} />;
  if (t === 'audio') return <Mic size={sz} />;
  return <FileText size={sz} />;
}
function labelForType(t: any, type: BlockType): string {
  return t.builder.calls.types[type] ?? type;
}
function safeParse(s: string): { blocks: Block[] } | null {
  try { return JSON.parse(s); } catch { return null; }
}
