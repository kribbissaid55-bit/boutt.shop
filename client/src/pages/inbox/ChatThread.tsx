import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bot, User, Megaphone, Clock as ClockIcon, FileText, Check, Play, Pause as PauseIcon, Mic } from 'lucide-react';
import clsx from 'clsx';
import { useI18n } from '../../i18n';
import type { ChatMessage } from './types';

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtDayLabel = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'اليوم';
  if (d.toDateString() === yesterday.toDateString()) return 'البارحة';
  return d.toLocaleDateString();
};

const senderTone: Record<string, { label: string; cls: string; Icon: any }> = {
  bot:       { label: 'البوت',     cls: 'text-blue-600',    Icon: Bot },
  admin:     { label: 'الإدارة',   cls: 'text-emerald-700', Icon: User },
  campaign:  { label: 'حملة',      cls: 'text-purple-700',  Icon: Megaphone },
  follow_up: { label: 'متابعة',    cls: 'text-amber-700',   Icon: ClockIcon },
};

interface ChatThreadProps {
  messages: ChatMessage[];
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void | Promise<void>;
}

export function ChatThread({ messages, hasMore, loadingOlder, onLoadOlder }: ChatThreadProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(0);
  // Distance-from-bottom snapshot. Set right before a prepend so we can
  // restore the same anchor after the DOM grows upward.
  const preserveFromBottom = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (preserveFromBottom.current !== null) {
      // Prepend just landed. Restore scrollTop so the message the user was
      // reading stays at the same visual position (distance-from-bottom is
      // invariant under content prepended above).
      el.scrollTop = el.scrollHeight - preserveFromBottom.current;
      preserveFromBottom.current = null;
    } else if (messages.length > prevLen.current) {
      // Growth at the tail (new incoming or initial load) — scroll to bottom.
      el.scrollTop = el.scrollHeight;
    }
    prevLen.current = messages.length;
  }, [messages.length]);

  const clickOlder = async () => {
    const el = scrollRef.current;
    if (!el || !onLoadOlder || loadingOlder) return;
    preserveFromBottom.current = el.scrollHeight - el.scrollTop;
    await onLoadOlder();
  };

  if (messages.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-gray-400">{t.inbox.selectContact}</div>;
  }

  const out: Array<{ day: string; items: ChatMessage[] }> = [];
  let currentDay = '';
  for (const m of messages) {
    const d = new Date(m.createdAt).toDateString();
    if (d !== currentDay) {
      currentDay = d;
      out.push({ day: m.createdAt, items: [m] });
    } else {
      out[out.length - 1].items.push(m);
    }
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto bg-[#efeae2] p-3 scrollbar-thin"
      style={{ backgroundImage: 'radial-gradient(circle at 20% 30%, rgba(168,155,138,0.08) 0, transparent 30%), radial-gradient(circle at 80% 60%, rgba(168,155,138,0.08) 0, transparent 30%)' }}
    >
      {hasMore && (
        <div className="flex justify-center pb-2">
          <button
            disabled={loadingOlder}
            onClick={clickOlder}
            className="rounded-full bg-white/95 px-3 py-1 text-[11px] font-medium text-gray-700 shadow-sm hover:bg-white disabled:opacity-60"
          >
            {loadingOlder ? '…' : '🔼 عرض الرسائل الأقدم'}
          </button>
        </div>
      )}
      {out.map((group, i) => (
        <div key={i}>
          <div className="my-3 flex justify-center">
            <span className="rounded-full bg-white/90 px-3 py-1 text-[10px] font-medium text-gray-600 shadow-sm">
              {fmtDayLabel(group.day)}
            </span>
          </div>
          {group.items.map((m, j) => {
            const prev = group.items[j - 1];
            const samePrev =
              prev && prev.direction === m.direction
              && (prev.senderType ?? 'customer') === (m.senderType ?? 'customer');
            return <Bubble key={m.id} m={m} grouped={samePrev} />;
          })}
        </div>
      ))}
    </div>
  );
}

function Bubble({ m, grouped }: { m: ChatMessage; grouped: boolean }) {
  const isOut = m.direction === 'out';
  const senderKey = m.senderType ?? (isOut ? 'bot' : 'customer');
  const tone = senderTone[senderKey];

  return (
    <div className={clsx('flex', isOut ? 'justify-end' : 'justify-start', grouped ? 'mb-0.5 mt-0.5' : 'mb-0.5 mt-2')}>
      <div className="flex max-w-[78%] flex-col">
        {/* Sender label — only on the first message of a run, only for non-customer outgoing */}
        {isOut && tone && !grouped && (
          <div className={clsx('mb-0.5 flex items-center gap-1 px-1 text-[10px] font-medium', tone.cls, 'self-end')}>
            <tone.Icon size={10} />
            <span>{tone.label}</span>
          </div>
        )}

        <div
          className={clsx(
            'relative rounded-lg px-2.5 pb-1.5 pt-1.5 text-[14px] shadow-sm',
            isOut
              ? 'rounded-tr-sm bg-[#d9fdd3] text-gray-900'
              : 'rounded-tl-sm bg-white text-gray-900',
          )}
        >
          {m.mediaId && (
            m.type === 'image' ? (
              <img src={`/api/media/${m.mediaId}/raw`} className="mb-1 max-h-72 rounded" />
            ) : m.type === 'video' ? (
              <video src={`/api/media/${m.mediaId}/raw`} controls className="mb-1 max-h-72 rounded bg-black" />
            ) : m.type === 'audio' ? (
              <AudioPlayer src={`/api/media/${m.mediaId}/raw`} isOut={isOut} />
            ) : (
              <a
                href={`/api/media/${m.mediaId}/raw`}
                target="_blank"
                rel="noreferrer"
                className="mb-1 flex items-center gap-2 rounded bg-black/5 p-2 text-xs hover:bg-black/10"
              >
                <FileText size={14} />
                <span>{m.body || 'document'}</span>
              </a>
            )
          )}

          {m.body && m.type === 'text' && (
            <div className="whitespace-pre-wrap break-words pe-12">{m.body}</div>
          )}

          <div className="absolute bottom-0.5 end-1.5 flex items-center gap-0.5 text-[10px] text-gray-500">
            <span>{fmtTime(m.createdAt)}</span>
            {isOut && (
              <>
                {m.status === 'sent' || m.status === 'delivered' || m.status === 'read' ? (
                  <Check size={10} className={m.status === 'read' ? 'text-[#34b7f1]' : 'text-gray-400'} />
                ) : null}
                {(m.status === 'delivered' || m.status === 'read') && (
                  <Check size={10} className={clsx('-ms-1.5', m.status === 'read' ? 'text-[#34b7f1]' : 'text-gray-400')} />
                )}
                {m.status === 'failed' && <span className="ms-0.5 text-red-500">⚠</span>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Slim WhatsApp-style audio player. Replaces the browser's default <audio controls>
 * which is bulky and inconsistent across browsers.
 */
function AudioPlayer({ src, isOut }: { src: string; isOut: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      setCurrent(a.currentTime);
      setProgress(a.duration ? a.currentTime / a.duration : 0);
    };
    const onMeta = () => setDuration(a.duration || 0);
    const onEnd = () => { setPlaying(false); setProgress(0); setCurrent(0); };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('ended', onEnd);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('ended', onEnd);
    };
  }, []);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); }
    else { a.play(); setPlaying(true); }
  };

  const fmtSec = (s: number) => {
    if (!s || !isFinite(s)) return '0:00';
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${mm}:${String(ss).padStart(2, '0')}`;
  };

  // 24 mini-bars to suggest a waveform
  const BARS = 24;
  const bars = Array.from({ length: BARS }, (_, i) => 6 + ((i * 17) % 14));

  return (
    <div className={clsx(
      'mb-1 flex w-[260px] items-center gap-2 rounded-md p-1.5',
      isOut ? 'bg-[#cdf3c5]' : 'bg-gray-50',
    )}>
      <button
        onClick={toggle}
        className={clsx(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          isOut ? 'bg-[#06cf9c] text-white' : 'bg-gray-200 text-gray-700',
        )}
      >
        {playing ? <PauseIcon size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      </button>
      <Mic size={12} className={clsx('shrink-0', isOut ? 'text-emerald-700' : 'text-gray-400')} />
      <div className="flex flex-1 items-center gap-px">
        {bars.map((h, i) => {
          const filled = i / BARS <= progress;
          return (
            <span
              key={i}
              className={clsx(
                'rounded-full',
                filled
                  ? (isOut ? 'bg-emerald-700' : 'bg-gray-600')
                  : (isOut ? 'bg-emerald-700/30' : 'bg-gray-300'),
              )}
              style={{ width: 2, height: h, transition: 'background 100ms' }}
            />
          );
        })}
      </div>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-gray-500">
        {fmtSec(playing || current ? current : duration)}
      </span>
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
    </div>
  );
}
