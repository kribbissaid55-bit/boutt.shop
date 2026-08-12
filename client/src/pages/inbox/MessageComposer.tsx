import { useState, useRef, useEffect } from 'react';
import { Send, Paperclip, Smile, Pause, ShoppingCart, Image as ImageIcon, Hash, Mic, Video } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui/Button';
import { MediaPickerModal } from '../builder/parts/MediaPickerModal';
import { VoiceRecorder } from './VoiceRecorder';

interface SavedReplyItem {
  id: string;
  title: string;
  text: string | null;
  shortcut: string | null;
  mediaIds: string[];
}

export function MessageComposer({ contactId, onSent }: { contactId: string; onSent: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickMedia, setPickMedia] = useState<'image' | 'audio' | 'video' | 'document' | null>(null);
  const [suggestions, setSuggestions] = useState<SavedReplyItem[]>([]);
  const [shownIndex, setShownIndex] = useState(0);
  const [recording, setRecording] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Saved-reply typeahead: when current line starts with "/", fetch matching shortcuts.
  useEffect(() => {
    const m = text.match(/(?:^|\n)(\/[\w\-أ-ي]*)$/);
    if (!m) { setSuggestions([]); return; }
    const prefix = m[1];
    const tm = setTimeout(async () => {
      try {
        const items = await api.get<SavedReplyItem[]>(`/saved-replies/typeahead?prefix=${encodeURIComponent(prefix)}`);
        setSuggestions(items);
        setShownIndex(0);
      } catch {}
    }, 150);
    return () => clearTimeout(tm);
  }, [text]);

  const applyReply = async (r: SavedReplyItem) => {
    // Replace the trailing /shortcut token with the saved text
    const newText = text.replace(/(\/[\w\-أ-ي]*)$/, '');
    setText(newText + (r.text ?? ''));
    setSuggestions([]);
    // If reply has media attached, send each one (admin still types text and clicks send)
    if (r.mediaIds.length > 0) {
      for (const mid of r.mediaIds) {
        try {
          await api.post(`/inbox/conversations/${contactId}/send-media`, { mediaId: mid });
        } catch {}
      }
      onSent();
    }
    taRef.current?.focus();
  };

  const send = async (alsoPause = false, alsoOrder = false) => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await api.post(`/inbox/conversations/${contactId}/send-text`, { text: value });
      if (alsoOrder) {
        await api.post(`/inbox/conversations/${contactId}/status`, { status: 'ordered' });
      }
      if (alsoPause) {
        await api.post(`/inbox/conversations/${contactId}/pause-bot`);
      }
      setText('');
      onSent();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally {
      setBusy(false);
      taRef.current?.focus();
    }
  };

  const sendMedia = async (mediaId: string) => {
    setPickMedia(null);
    setBusy(true);
    try {
      await api.post(`/inbox/conversations/${contactId}/send-media`, { mediaId, caption: text.trim() || undefined });
      setText('');
      onSent();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally {
      setBusy(false);
    }
  };

  // Single shared style for the icon-only attachment buttons
  const iconBtn = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40';

  return (
    <>
      <div className="shrink-0 border-t border-gray-200 bg-[#f0f2f5] px-3 py-2">
        {recording ? (
          <VoiceRecorder
            contactId={contactId}
            onSent={() => { setRecording(false); onSent(); }}
            onCancel={() => setRecording(false)}
          />
        ) : (
        <div className="flex items-end gap-1.5">
          {/* Attachment icons — slim row, like WhatsApp Web */}
          <button onClick={() => setPickMedia('image')} disabled={busy} className={iconBtn} title={t.builder.block_types.image}>
            <ImageIcon size={18} />
          </button>
          <button onClick={() => setPickMedia('video')} disabled={busy} className={iconBtn} title={t.builder.block_types.video}>
            <Video size={18} />
          </button>
          <button onClick={() => setPickMedia('document')} disabled={busy} className={iconBtn} title={t.builder.block_types.document}>
            <Paperclip size={18} />
          </button>
          <button className={iconBtn} title="emoji">
            <Smile size={18} />
          </button>

          <div className="relative flex-1">
            {suggestions.length > 0 && (
              <div className="absolute bottom-full mb-2 max-h-64 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg scrollbar-thin">
                <div className="border-b border-gray-100 px-3 py-1.5 text-[10px] font-bold uppercase text-gray-400">
                  {t.savedReplies.title}
                </div>
                {suggestions.map((r, i) => (
                  <button
                    key={r.id}
                    onMouseEnter={() => setShownIndex(i)}
                    onClick={() => applyReply(r)}
                    className={`flex w-full items-start gap-2 border-b border-gray-50 px-3 py-2 text-start hover:bg-gray-50 ${
                      i === shownIndex ? 'bg-brand-50' : ''
                    }`}
                  >
                    <Hash size={12} className="mt-0.5 shrink-0 text-brand-600" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-gray-900">{r.title}</span>
                        {r.shortcut && <span className="font-mono text-[10px] text-brand-600">{r.shortcut}</span>}
                      </div>
                      {r.text && <div className="mt-0.5 line-clamp-2 text-[11px] text-gray-500">{r.text}</div>}
                    </div>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (suggestions.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setShownIndex((i) => Math.min(suggestions.length - 1, i + 1));
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setShownIndex((i) => Math.max(0, i - 1));
                    return;
                  }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                    e.preventDefault();
                    applyReply(suggestions[shownIndex]);
                    return;
                  }
                  if (e.key === 'Escape') { setSuggestions([]); return; }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={t.inbox.typeMessage}
              rows={1}
              className="w-full resize-none rounded-2xl border-0 bg-white px-4 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              style={{ maxHeight: 120 }}
            />
          </div>

          {/* Send (text) OR Mic (voice note) — matches WhatsApp Web pattern */}
          {text.trim() ? (
            <Button
              onClick={() => send()}
              disabled={busy}
              loading={busy}
              className="!h-9 !w-9 !rounded-full !p-0"
              title={t.inbox.send}
            >
              <Send size={16} />
            </Button>
          ) : (
            <button
              onClick={() => setRecording(true)}
              disabled={busy}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white shadow-sm transition hover:bg-brand-600 disabled:opacity-40"
              title={t.voice.start}
            >
              <Mic size={16} />
            </button>
          )}
        </div>
        )}

        {/* Action shortcuts — appear only with typed text */}
        {!recording && text.trim() && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            <button
              onClick={() => send(true, false)}
              disabled={busy}
              className="flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-40"
            >
              <Pause size={11} /> {t.inboxNew.sendAndPause}
            </button>
            <button
              onClick={() => send(false, true)}
              disabled={busy}
              className="flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-40"
            >
              <ShoppingCart size={11} /> {t.inboxNew.sendAndMarkOrdered}
            </button>
          </div>
        )}
      </div>

      <MediaPickerModal
        open={!!pickMedia}
        kindFilter={pickMedia ?? undefined}
        onClose={() => setPickMedia(null)}
        onPick={sendMedia}
      />
    </>
  );
}
