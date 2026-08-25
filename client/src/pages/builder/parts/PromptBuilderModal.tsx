/**
 * PromptBuilderModal v2 — polished chat assistant that interviews the
 * operator about their product and writes a professional Darija sales
 * system-prompt.
 *
 * Inputs: text, voice notes (recorded in-browser → server-side Darija STT),
 * product images (auto-downscaled, analyzed with vision), and small text
 * documents (.txt/.md/.csv — merged into the assistant's context).
 * When the assistant emits a final prompt, a highlighted card offers a
 * one-click adopt into the bot's systemPrompt field (operator still saves).
 */
import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, ImagePlus, FileText, Mic, Square, X, Check, Copy } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';

type Attachment = { name: string; text: string };
type Msg = {
  role: 'user' | 'assistant';
  content: string;
  imagePreview?: string;
  voice?: boolean;
  files?: string[];
};

const PREFERRED_MIME = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];
const pickMime = (): string | undefined => {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return PREFERRED_MIME.find((m) => {
    try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
  });
};
const MAX_REC_SECONDS = 60;
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function PromptBuilderModal({
  open, onClose, botId, onAdopt,
}: {
  open: boolean;
  onClose: () => void;
  botId: string;
  onAdopt: (prompt: string) => void;
}) {
  const { t } = useI18n();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [docs, setDocs] = useState<Attachment[]>([]);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  // Voice recording state
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

  const imgRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setMsgs([{ role: 'assistant', content: t.builder.ai.pbIntro }]);
      setInput(''); setImage(null); setDocs([]); setLastPrompt(null);
    } else {
      stopTracks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy, lastPrompt]);

  const stopTracks = () => {
    try { recorderRef.current?.stream.getTracks().forEach((tr) => tr.stop()); } catch {}
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    recorderRef.current = null;
    setRecording(false);
    setRecSeconds(0);
  };

  // ── Image: downscale to ≤1024px JPEG so the JSON body stays small ──────
  const pickImage = (f: File | undefined | null) => {
    if (!f || !f.type.startsWith('image/')) return;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const MAX = 1024;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
      try { setImage(canvas.toDataURL('image/jpeg', 0.85)); } catch { toast.error('image error'); }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast.error('image error'); };
    img.src = url;
  };

  // ── Text documents (.txt/.md/.csv/.json ≤ 200KB, trimmed to 18k chars) ─
  const pickDoc = (f: File | undefined | null) => {
    if (!f) return;
    const okExt = /\.(txt|md|csv|json)$/i.test(f.name) || f.type.startsWith('text/');
    if (!okExt) { toast.error(t.builder.ai.pbFileType); return; }
    if (f.size > 200 * 1024) { toast.error(t.builder.ai.pbFileTooBig); return; }
    if (docs.length >= 3) { toast.error('≤ 3'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '').slice(0, 18_000);
      if (text.trim()) setDocs((prev) => [...prev, { name: f.name.slice(0, 100), text }]);
    };
    reader.readAsText(f);
  };

  // ── Voice recording ─────────────────────────────────────────────────────
  const startRecording = async () => {
    if (busy || recording) return;
    const mime = pickMime();
    if (!mime) { toast.error(t.builder.ai.pbMicUnsupported); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      cancelledRef.current = false;
      const rec = new MediaRecorder(stream, { mimeType: mime });
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        if (cancelledRef.current) return;
        const blob = new Blob(chunksRef.current, { type: mime });
        if (blob.size < 800) return; // too short to be meaningful
        if (blob.size > 1_100_000) { toast.error(t.builder.ai.pbVoiceTooLong); return; }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result ?? '');
          const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
          void send(undefined, { audioBase64: b64, audioMime: mime });
        };
        reader.readAsDataURL(blob);
      };
      recorderRef.current = rec;
      rec.start(250);
      setRecording(true);
      setRecSeconds(0);
      timerRef.current = setInterval(() => {
        setRecSeconds((s) => {
          if (s + 1 >= MAX_REC_SECONDS) { void finishRecording(); return s; }
          return s + 1;
        });
      }, 1000);
    } catch {
      toast.error(t.builder.ai.pbMicDenied);
    }
  };

  const finishRecording = async () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setRecording(false);
    try { recorderRef.current?.stop(); } catch {}
  };

  const cancelRecording = () => {
    cancelledRef.current = true;
    stopTracks();
    try { recorderRef.current?.stop(); } catch {}
  };

  // ── Send a turn ─────────────────────────────────────────────────────────
  const send = async (
    forcedText?: string,
    voice?: { audioBase64: string; audioMime: string },
  ) => {
    const text = (forcedText ?? input).trim() || (voice ? '🎤' : '');
    if (!text || busy) return;
    const userIdx = msgs.length;
    const userMsg: Msg = {
      role: 'user',
      content: voice && text === '🎤' ? t.builder.ai.pbVoiceNote : text,
      imagePreview: image ?? undefined,
      voice: !!voice,
      files: docs.length ? docs.map((d) => d.name) : undefined,
    };
    const history = [...msgs, userMsg];
    setMsgs(history);
    setInput('');
    setBusy(true);
    const sentImage = image; setImage(null);
    const sentDocs = docs; setDocs([]);
    try {
      const payload: any = {
        messages: history
          .filter((m, i) => !(i === 0 && m.role === 'assistant'))
          .map((m, i, arr) => ({
            role: m.role,
            // The literal text sent for THIS voice turn is '🎤'; the server
            // replaces it with the transcript. Older voice turns keep their
            // displayed transcript content.
            content: m.role === 'user' && m.voice && i === arr.length - 1 && voice ? '🎤' : m.content,
          }))
          .slice(-30),
      };
      if (sentImage) payload.imageDataUrl = sentImage;
      if (sentDocs.length) payload.attachments = sentDocs;
      if (voice) { payload.audioBase64 = voice.audioBase64; payload.audioMime = voice.audioMime; }
      const r = await api.post<{ reply: string; prompt: string | null; transcript?: string }>(
        `/bots/${botId}/ai/prompt-builder`, payload,
      );
      // Reveal what the assistant heard in the voice bubble.
      if (voice && r.transcript) {
        setMsgs((prev) => prev.map((m, i) => (i === userIdx ? { ...m, content: `🎤 ${r.transcript}` } : m)));
      }
      if (r.reply) setMsgs((prev) => [...prev, { role: 'assistant', content: r.reply }]);
      if (r.prompt) setLastPrompt(r.prompt);
    } catch (e: any) {
      const raw = String(e?.message ?? '');
      const friendly = raw.startsWith('no_credentials_for_')
        ? `${t.builder.ai.pbError} (${raw.replace('no_credentials_for_', '')} key)`
        : raw.startsWith('stt_failed') ? t.builder.ai.pbSttFailed : t.builder.ai.pbError;
      toast.error(friendly);
      setMsgs((prev) => prev.slice(0, -1));
      if (!voice) setInput(text);
      if (sentImage) setImage(sentImage);
      if (sentDocs.length) setDocs(sentDocs);
    } finally {
      setBusy(false);
    }
  };

  const adopt = () => {
    if (!lastPrompt) return;
    onAdopt(lastPrompt);
    toast.success(t.builder.ai.pbAdopted);
    onClose();
  };

  const copyPrompt = async () => {
    if (!lastPrompt) return;
    try { await navigator.clipboard.writeText(lastPrompt); toast.success('✓'); } catch {}
  };

  return (
    <Modal open={open} onClose={onClose} wide tall title={undefined}>
      <div className="flex h-full flex-col">
        {/* Hero header */}
        <div className="mb-3 shrink-0 text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-lg shadow-violet-200">
            <Sparkles size={22} className="text-white" />
          </div>
          <h3 className="bg-gradient-to-r from-violet-700 to-fuchsia-600 bg-clip-text text-lg font-bold text-transparent">
            {t.builder.ai.pbTitle}
          </h3>
          <p className="mx-auto max-w-md text-xs text-gray-500">{t.builder.ai.pbSubtitle}</p>
        </div>

        {/* Conversation */}
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto rounded-2xl border border-violet-100 bg-gradient-to-b from-gray-50 to-white p-3 scrollbar-thin">
          {msgs.map((m, i) => (
            <div key={i} className={`flex items-end gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {m.role === 'assistant' && (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow">
                  <Sparkles size={13} className="text-white" />
                </div>
              )}
              <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
                m.role === 'user'
                  ? 'rounded-ee-md bg-gradient-to-br from-violet-600 to-violet-700 text-white'
                  : 'rounded-es-md border border-gray-100 bg-white text-gray-800'
              }`}>
                {m.imagePreview && <img src={m.imagePreview} alt="" className="mb-2 max-h-36 rounded-xl" />}
                {m.files?.map((f) => (
                  <span key={f} className="mb-1 me-1 inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px]">
                    <FileText size={11} /> {f}
                  </span>
                ))}
                {m.files?.length ? <br /> : null}
                {m.content}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex items-end gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow">
                <Sparkles size={13} className="text-white" />
              </div>
              <div className="inline-flex items-center gap-1.5 rounded-2xl rounded-es-md border border-gray-100 bg-white px-4 py-3 shadow-sm">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400 [animation-delay:0ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-fuchsia-500 [animation-delay:300ms]" />
              </div>
            </div>
          )}
          {lastPrompt && (
            <div className="rounded-2xl border-2 border-emerald-300 bg-gradient-to-b from-emerald-50 to-white p-3 shadow-sm">
              <div className="mb-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl bg-white p-3 text-xs leading-relaxed text-gray-700 shadow-inner scrollbar-thin">
                {lastPrompt}
              </div>
              <div className="flex gap-2">
                <Button onClick={adopt} className="flex-1">
                  <Check size={15} /> {t.builder.ai.pbAdopt}
                </Button>
                <Button variant="secondary" onClick={copyPrompt} title="Copy">
                  <Copy size={14} />
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="mt-3 shrink-0">
          {(image || docs.length > 0) && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {image && (
                <span className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 p-1 pe-2 shadow-sm">
                  <img src={image} alt="" className="h-10 w-10 rounded-lg object-cover" />
                  <button type="button" onClick={() => setImage(null)} className="rounded-full p-0.5 text-violet-600 hover:bg-violet-100"><X size={14} /></button>
                </span>
              )}
              {docs.map((d, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-medium text-sky-700 shadow-sm">
                  <FileText size={12} /> {d.name}
                  <button type="button" onClick={() => setDocs((prev) => prev.filter((_, j) => j !== i))} className="rounded-full p-0.5 hover:bg-sky-100"><X size={11} /></button>
                </span>
              ))}
            </div>
          )}

          {recording ? (
            <div className="flex items-center gap-3 rounded-2xl border-2 border-red-300 bg-red-50 p-3 shadow-sm">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
              </span>
              <span className="flex-1 text-sm font-medium text-red-700">
                {t.builder.ai.pbRecording} {fmtClock(recSeconds)} / {fmtClock(MAX_REC_SECONDS)}
              </span>
              <button type="button" onClick={cancelRecording} title={t.builder.ai.pbRecCancel}
                className="rounded-full border border-red-200 bg-white p-2 text-red-500 shadow-sm hover:bg-red-100">
                <X size={16} />
              </button>
              <button type="button" onClick={() => void finishRecording()} title={t.builder.ai.pbRecSend}
                className="rounded-full bg-red-500 p-2 text-white shadow hover:bg-red-600">
                <Square size={16} />
              </button>
            </div>
          ) : (
            <div className="flex items-end gap-1.5 rounded-2xl border border-violet-200 bg-white p-2 shadow-sm focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-100">
              <button type="button" title={t.builder.ai.pbAttach} onClick={() => imgRef.current?.click()}
                className="shrink-0 rounded-full p-2 text-gray-500 hover:bg-violet-50 hover:text-violet-600">
                <ImagePlus size={18} />
              </button>
              <button type="button" title={t.builder.ai.pbAttachDoc} onClick={() => docRef.current?.click()}
                className="shrink-0 rounded-full p-2 text-gray-500 hover:bg-sky-50 hover:text-sky-600">
                <FileText size={18} />
              </button>
              <input ref={imgRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ''; }} />
              <input ref={docRef} type="file" accept=".txt,.md,.csv,.json,text/*" className="hidden"
                onChange={(e) => { pickDoc(e.target.files?.[0]); e.target.value = ''; }} />
              <textarea
                rows={1}
                value={input}
                disabled={busy}
                placeholder={t.builder.ai.pbPlaceholder}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                className="max-h-28 min-h-[38px] flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none"
              />
              <button type="button" title={t.builder.ai.pbRecord} disabled={busy} onClick={() => void startRecording()}
                className="shrink-0 rounded-full p-2 text-gray-500 hover:bg-red-50 hover:text-red-500 disabled:opacity-40">
                <Mic size={18} />
              </button>
              <button type="button" disabled={busy || !input.trim()} onClick={() => void send()}
                className="shrink-0 rounded-full bg-gradient-to-br from-violet-600 to-fuchsia-600 p-2.5 text-white shadow-md shadow-violet-200 transition hover:opacity-90 disabled:opacity-40">
                <Send size={16} />
              </button>
            </div>
          )}

          <div className="mt-1.5 text-center">
            <button
              type="button"
              disabled={busy || recording || msgs.filter((m) => m.role === 'user').length === 0}
              onClick={() => void send(t.builder.ai.pbGenerate)}
              className="text-xs font-medium text-violet-600 hover:underline disabled:opacity-40"
            >
              ⚡ {t.builder.ai.pbGenerate}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
