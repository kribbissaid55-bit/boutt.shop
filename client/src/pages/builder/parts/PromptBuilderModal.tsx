/**
 * PromptBuilderModal — chat-style assistant that interviews the operator
 * about their product (text + optional product image) and writes a
 * professional Darija sales system-prompt. When the assistant emits a final
 * prompt, a highlighted card appears with a one-click "adopt" button that
 * injects it into the bot's systemPrompt field (the operator still saves).
 */
import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, ImagePlus, X, Check, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';

type Msg = { role: 'user' | 'assistant'; content: string; imagePreview?: string };

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB

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
  const [image, setImage] = useState<string | null>(null); // data URL, sent with next message
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset conversation each time the modal opens.
  useEffect(() => {
    if (open) {
      setMsgs([{ role: 'assistant', content: t.builder.ai.pbIntro }]);
      setInput('');
      setImage(null);
      setLastPrompt(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy, lastPrompt]);

  // Downscale to ≤1024px JPEG before sending — keeps the JSON body well
  // under the server's 2MB body limit and speeds up mobile connections.
  const pickImage = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) return;
    if (f.size > MAX_IMAGE_BYTES * 4) { toast.error('≤ 16MB'); return; }
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
      try {
        setImage(canvas.toDataURL('image/jpeg', 0.85));
      } catch {
        toast.error('image error');
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast.error('image error'); };
    img.src = url;
  };

  const send = async (forcedText?: string) => {
    const text = (forcedText ?? input).trim();
    if (!text || busy) return;
    const userMsg: Msg = { role: 'user', content: text, imagePreview: image ?? undefined };
    const history = [...msgs, userMsg];
    setMsgs(history);
    setInput('');
    setBusy(true);
    const sentImage = image;
    setImage(null);
    try {
      const payload: any = {
        // The intro message is UI-only — skip it so the server conversation
        // starts with the operator's own words.
        messages: history
          .filter((m, i) => !(i === 0 && m.role === 'assistant'))
          .map((m) => ({ role: m.role, content: m.content }))
          .slice(-30),
      };
      if (sentImage) payload.imageDataUrl = sentImage;
      const r = await api.post<{ reply: string; prompt: string | null }>(
        `/bots/${botId}/ai/prompt-builder`, payload,
      );
      if (r.reply) setMsgs((prev) => [...prev, { role: 'assistant', content: r.reply }]);
      if (r.prompt) setLastPrompt(r.prompt);
    } catch (e: any) {
      const raw = String(e?.message ?? '');
      const friendly = raw.startsWith('no_credentials_for_')
        ? `${t.builder.ai.pbError} (${raw.replace('no_credentials_for_', '')} key)`
        : t.builder.ai.pbError;
      toast.error(friendly);
      // Roll the user message back into the input so nothing is lost.
      setMsgs((prev) => prev.slice(0, -1));
      setInput(text);
      if (sentImage) setImage(sentImage);
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

  return (
    <Modal open={open} onClose={onClose} wide tall title={undefined}>
      <div className="flex h-full flex-col">
        {/* Header — mirrors the "Describe your agent" hero style */}
        <div className="mb-3 shrink-0 text-center">
          <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-100">
            <Sparkles size={22} className="text-violet-600" />
          </div>
          <h3 className="text-lg font-bold">{t.builder.ai.pbTitle}</h3>
          <p className="mx-auto max-w-md text-xs text-gray-500">{t.builder.ai.pbSubtitle}</p>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50 p-3 scrollbar-thin">
          {msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm ${
                m.role === 'user' ? 'bg-violet-600 text-white' : 'border border-gray-200 bg-white text-gray-800'
              }`}>
                {m.imagePreview && (
                  <img src={m.imagePreview} alt="" className="mb-2 max-h-32 rounded-lg" />
                )}
                {m.content}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 shadow-sm">
                <Loader2 size={14} className="animate-spin" /> {t.builder.ai.pbThinking}
              </div>
            </div>
          )}
          {lastPrompt && (
            <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 p-3">
              <div className="mb-2 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white p-2 text-xs leading-relaxed text-gray-700 scrollbar-thin">
                {lastPrompt}
              </div>
              <Button onClick={adopt} className="w-full">
                <Check size={15} /> {t.builder.ai.pbAdopt}
              </Button>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="mt-3 shrink-0">
          {image && (
            <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 p-1 pe-2">
              <img src={image} alt="" className="h-10 w-10 rounded object-cover" />
              <button type="button" onClick={() => setImage(null)} className="rounded-full p-0.5 text-violet-600 hover:bg-violet-100">
                <X size={14} />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-violet-200 bg-white p-2 shadow-sm">
            <button
              type="button"
              title={t.builder.ai.pbAttach}
              onClick={() => fileRef.current?.click()}
              className="shrink-0 rounded-full p-2 text-gray-500 hover:bg-violet-50 hover:text-violet-600"
            >
              <ImagePlus size={18} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ''; }}
            />
            <textarea
              rows={1}
              value={input}
              disabled={busy}
              placeholder={t.builder.ai.pbPlaceholder}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              className="max-h-28 min-h-[38px] flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none"
            />
            <button
              type="button"
              disabled={busy || !input.trim()}
              onClick={() => send()}
              className="shrink-0 rounded-full bg-violet-600 p-2 text-white shadow disabled:opacity-40"
            >
              <Send size={16} />
            </button>
          </div>
          <div className="mt-1.5 text-center">
            <button
              type="button"
              disabled={busy || msgs.filter((m) => m.role === 'user').length === 0}
              onClick={() => send(t.builder.ai.pbGenerate)}
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
