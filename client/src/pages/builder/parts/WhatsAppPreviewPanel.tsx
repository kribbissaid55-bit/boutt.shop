import { Mic, FileText, Clock, Zap, Image as ImageIcon, Video } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { MenuBubble } from './MenuBubble';
import type { Bot, BotStep, MessageBlock } from '../types';

export function WhatsAppPreviewPanel({ step, bot }: { step: BotStep | null; bot: Bot }) {
  const { t } = useI18n();
  void bot;
  return (
    <aside className="hidden w-80 shrink-0 border-s border-gray-200 bg-gray-100 lg:flex lg:flex-col">
      <div className="border-b border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-700">
        {t.builder.preview_phone}
      </div>
      <div className="flex flex-1 flex-col overflow-hidden p-3">
        <div className="flex h-full flex-col overflow-hidden rounded-2xl border-8 border-gray-800 bg-[#e5ddd5] shadow-xl" style={{ backgroundImage: 'linear-gradient(rgba(229,221,213,0.6),rgba(229,221,213,0.6))' }}>
          <div className="flex items-center gap-2 bg-[#075e54] p-3 text-white">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-sm font-semibold">B</div>
            <div className="text-sm font-medium">{step?.title ?? '—'}</div>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3 scrollbar-thin">
            {!step || step.blocks.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-gray-500">—</div>
            ) : step.blocks.filter((b) => b.enabled).map((b) => (
              <BlockBubble key={b.id} block={b} step={step} />
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

function BlockBubble({ block, step }: { block: MessageBlock; step: BotStep }) {
  if (block.type === 'text') {
    return <Bubble><div className="whitespace-pre-wrap text-[13px]">{block.content || <em className="text-gray-400">—</em>}</div></Bubble>;
  }
  if (block.type === 'image') {
    return (
      <Bubble>
        {block.media
          ? <img src={`/api/media/${block.media.id}/raw`} className="mb-1 max-h-44 rounded-lg" />
          : <div className="flex h-32 items-center justify-center rounded-lg bg-gray-200 text-gray-400"><ImageIcon /></div>
        }
        {block.caption && <div className="text-[13px]">{block.caption}</div>}
      </Bubble>
    );
  }
  if (block.type === 'video') {
    return (
      <Bubble>
        {block.media
          ? <video src={`/api/media/${block.media.id}/raw`} className="mb-1 max-h-44 rounded-lg bg-black" />
          : <div className="flex h-32 items-center justify-center rounded-lg bg-gray-200 text-gray-400"><Video /></div>
        }
        {block.caption && <div className="text-[13px]">{block.caption}</div>}
      </Bubble>
    );
  }
  if (block.type === 'audio') {
    return (
      <Bubble>
        <div className="flex items-center gap-2"><Mic size={14} className="text-gray-500" />
        {block.media ? <audio src={`/api/media/${block.media.id}/raw`} controls className="max-w-[180px]" /> : <em className="text-xs text-gray-400">—</em>}
        </div>
      </Bubble>
    );
  }
  if (block.type === 'document') {
    return (
      <Bubble>
        <div className="flex items-center gap-2 rounded bg-gray-50 p-2">
          <FileText size={18} className="text-gray-500" />
          <div className="min-w-0 flex-1 text-[12px]">
            <div className="truncate">{block.media?.name ?? '—'}</div>
            <div className="text-[10px] text-gray-400">{block.media?.mimeType ?? ''}</div>
          </div>
        </div>
        {block.caption && <div className="mt-1 text-[13px]">{block.caption}</div>}
      </Bubble>
    );
  }
  if (block.type === 'delay') {
    return (
      <div className="my-1 flex justify-center">
        <span className="flex items-center gap-1 rounded-full bg-gray-200 px-3 py-1 text-[11px] text-gray-600">
          <Clock size={11} /> {block.delaySeconds}s
        </span>
      </div>
    );
  }
  if (block.type === 'options') {
    if (!step.options.length) return null;
    let mode: any = 'numbered';
    try { if (block.metadata) mode = JSON.parse(block.metadata).displayMode ?? 'numbered'; } catch {}
    return (
      <MenuBubble
        header={block.content || undefined}
        options={step.options.filter((o) => o.enabled).map((o) => ({ number: o.number, label: o.label }))}
        mode={mode}
        compact
      />
    );
  }
  if (block.type === 'action') {
    return (
      <div className="my-1 flex justify-center">
        <span className="flex items-center gap-1 rounded-full bg-purple-100 px-3 py-1 text-[11px] text-purple-700">
          <Zap size={11} /> {block.actionType}
        </span>
      </div>
    );
  }
  return null;
}

function Bubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex">
      <div className="max-w-[85%] rounded-lg bg-white p-2 shadow-sm">{children}</div>
    </div>
  );
}
