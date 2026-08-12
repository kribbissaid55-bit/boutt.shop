/**
 * UnifiedBotTest — the single, all-in-one preview that replaces the old
 * BotTestSimulator modal, the AI-only preview, and the standalone voice
 * sample button. Routes each turn through the right execution path:
 *
 *   - engineMode='disabled'  → input disabled, shows a banner.
 *   - engineMode='rule_only' → `/bots/:id/test/*` (rule sandbox).
 *   - engineMode='ai_only'   → `/bots/:id/ai/test` (AI envelope).
 *   - engineMode='hybrid'    → first turn rule (welcome step), then AI.
 *
 * Toolbar adds: simulate-call, send-next-followup, voice-preview sample,
 * and a quick text⇄voice toggle for the next user turn.
 */
import { useRef, useState } from 'react';
import { MessageCircle, Phone, X, Send, Mic, Paperclip, PhoneIncoming, Clock, Volume2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import { Input } from '../../../components/ui/Input';

type EngineMode = 'rule_only' | 'ai_only' | 'hybrid' | 'rule_priority' | 'disabled';
type PreviewStage = 'sent_no_reply' | 'replied' | 'ordered' | null;
type MediaPreview = { id: string; name: string; type: string; mimeType: string; rawUrl: string };

type ChatTurn = {
  role: 'user' | 'assistant';
  content: string;
  imageUrl?: string;
  audioUrl?: string;
  mediaPreviews?: MediaPreview[];
  orderDone?: boolean;
  /** Prefix badge: 📞 for call rejection, ✨ for follow-up — bot-side only. */
  badge?: '📞' | '✨';
};

type RenderedBlock = {
  kind: 'text' | 'audio' | 'image' | 'video' | 'document' | 'delay' | 'options' | 'action';
  body?: string;
  caption?: string;
  delaySeconds?: number;
  options?: { number: string; label: string }[];
  mediaPreview?: MediaPreview;
};

type VirtualEvent =
  | { kind: 'text'; text: string }
  | { kind: 'audio' | 'image' | 'video' | 'document'; mediaId: string; mimeType: string; fileName: string; caption?: string }
  | { kind: 'options'; header: string; options: { number: string; label: string }[]; mode: string }
  | { kind: 'typing'; ms: number };

interface AiTestResp {
  reply: string;
  mode?: 'text' | 'voice';
  audioBase64?: string;
  audioMime?: string;
  transcript?: string;
  draftUpdates?: Record<string, string>;
  orderDone?: boolean;
  mediaPreviews?: MediaPreview[];
}

interface RuleTestItem {
  id: string;
  ts: number;
  direction: 'in' | 'out';
  text?: string;
  events?: VirtualEvent[];
  matched?: string;
  suggestions?: { number: string; label: string }[];
}

export function UnifiedBotTest({ botId, engineMode }: { botId: string; engineMode: EngineMode }) {
  const { t } = useI18n();
  // Preview state (kept internal — UnifiedBotTest manages its own session).
  const [chatHistory, setChatHistory] = useState<ChatTurn[]>([]);
  const [chatDraft, setChatDraft] = useState<Record<string, string>>({});
  const [chatStage, setChatStage] = useState<PreviewStage>(null);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatImage, setChatImage] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<{ rec: MediaRecorder | null; chunks: Blob[] }>({ rec: null, chunks: [] });
  // Rule-sandbox session (used for rule_only + hybrid first turn).
  const [ruleSessionId, setRuleSessionId] = useState<string | null>(null);
  const [turnCount, setTurnCount] = useState(0);
  // UI affordances
  const [pendingFollowup, setPendingFollowup] = useState(false);
  const [forceVoiceNext, setForceVoiceNext] = useState(false);

  const disabled = engineMode === 'disabled';

  const reset = async () => {
    setChatHistory([]);
    setChatDraft({});
    setChatStage(null);
    setTurnCount(0);
    setForceVoiceNext(false);
    if (ruleSessionId) {
      try { await api.post(`/bots/${botId}/test/reset`, { sessionId: ruleSessionId }); } catch {}
    }
    setRuleSessionId(null);
  };

  // Render rule-sandbox VirtualEvents as a single assistant turn (concatenates
  // texts + collects media previews into the bubble).
  const renderRuleEvents = (events: VirtualEvent[]): ChatTurn => {
    const texts: string[] = [];
    const mediaPreviews: MediaPreview[] = [];
    for (const ev of events) {
      if (ev.kind === 'text') texts.push(ev.text);
      else if (ev.kind === 'options') {
        texts.push(ev.header);
        texts.push(ev.options.map((o) => `${o.number} - ${o.label}`).join('\n'));
      } else if (ev.kind === 'image' || ev.kind === 'video' || ev.kind === 'audio' || ev.kind === 'document') {
        // mediaId is local to the sandbox; we have no rawUrl but we can show a placeholder pill.
        mediaPreviews.push({
          id: ev.mediaId, name: ev.fileName, type: ev.kind,
          mimeType: ev.mimeType, rawUrl: `/api/media/${ev.mediaId}/raw`,
        });
        if (ev.caption) texts.push(ev.caption);
      }
    }
    return { role: 'assistant', content: texts.join('\n\n') || '', mediaPreviews };
  };

  // ─── Routing ───
  const sendChat = async (audioBase64?: string, audioMime?: string) => {
    const hasContent = chatInput.trim() || chatImage || audioBase64;
    if (!hasContent || chatBusy || disabled) return;

    const userText = chatInput.trim() || (audioBase64 ? '[رسالة صوتية]' : (chatImage ? '[صورة]' : ''));
    const imageToSend = chatImage;
    setChatHistory((h) => [...h, { role: 'user', content: userText, imageUrl: imageToSend ?? undefined }]);
    setChatInput('');
    setChatImage(null);
    setChatBusy(true);
    try {
      const useRulePath = engineMode === 'rule_only' || (engineMode === 'hybrid' && turnCount === 0);
      if (useRulePath) {
        let activeSid = ruleSessionId;
        if (!activeSid) {
          const fresh = await api.post<{ sessionId: string }>(`/bots/${botId}/test/start`);
          activeSid = fresh.sessionId;
          setRuleSessionId(activeSid);
        }
        let r: { items: RuleTestItem[] };
        try {
          r = await api.post<{ items: RuleTestItem[] }>(`/bots/${botId}/test/message`, {
            sessionId: activeSid, text: chatInput.trim() || userText || '(media)',
          });
        } catch (e: any) {
          if (e?.status === 404 || /session not found/i.test(e?.message ?? '')) {
            const fresh = await api.post<{ sessionId: string }>(`/bots/${botId}/test/start`);
            activeSid = fresh.sessionId; setRuleSessionId(activeSid);
            r = await api.post<{ items: RuleTestItem[] }>(`/bots/${botId}/test/message`, {
              sessionId: activeSid, text: chatInput.trim() || userText || '(media)',
            });
          } else { throw e; }
        }
        const out = (r.items ?? []).find((x) => x.direction === 'out');
        if (out?.events?.length) {
          setChatHistory((h) => [...h, renderRuleEvents(out.events!)]);
        }
        setTurnCount((c) => c + 1);
        // Move to 'replied' stage after first interaction so hybrid AI knows.
        setChatStage((s) => s ?? 'replied');
      } else {
        const payload: any = {
          userMessage: chatInput.trim() || '(media)',
          history: chatHistory.slice(-10).map((h) => ({ role: h.role, content: h.content })),
          draft: chatDraft,
          stage: chatStage,
        };
        if (imageToSend) payload.imageDataUrl = imageToSend;
        if (audioBase64) { payload.audioBase64 = audioBase64; payload.audioMime = audioMime ?? 'audio/ogg'; }
        const r = await api.post<AiTestResp>(`/bots/${botId}/ai/test`, payload);
        if (r.transcript) {
          setChatHistory((h) => {
            const cp = [...h];
            for (let i = cp.length - 1; i >= 0; i--) {
              if (cp[i].role === 'user') { cp[i] = { ...cp[i], content: r.transcript! }; break; }
            }
            return cp;
          });
        }
        let audioUrl: string | undefined;
        if (r.audioBase64 && r.audioMime) {
          const bin = atob(r.audioBase64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: r.audioMime });
          audioUrl = URL.createObjectURL(blob);
        }
        if (r.draftUpdates && Object.keys(r.draftUpdates).length) {
          setChatDraft((d) => ({ ...d, ...r.draftUpdates }));
        }
        setChatStage((s) => {
          if (r.orderDone) return 'ordered';
          if (s === 'ordered') return 'ordered';
          return 'replied';
        });
        setChatHistory((h) => [...h, {
          role: 'assistant',
          content: r.reply,
          audioUrl,
          mediaPreviews: r.mediaPreviews,
          orderDone: r.orderDone,
        }]);
        setTurnCount((c) => c + 1);
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'AI request failed');
    } finally {
      setChatBusy(false);
      setForceVoiceNext(false);
    }
  };

  // ─── Toolbar actions ───
  const simulateCall = async () => {
    if (disabled) return;
    setChatBusy(true);
    try {
      const r = await api.post<{ enabled: boolean; delaySeconds: number; blocks: RenderedBlock[] }>(
        `/bots/${botId}/ai/test/simulate-call`,
      );
      if (!r.enabled) {
        toast(t.builder.unifiedTest.callDisabled, { icon: '📞' });
        return;
      }
      if (!r.blocks.length) {
        toast(t.builder.unifiedTest.callNoSequence, { icon: '📞' });
        return;
      }
      setChatHistory((h) => [
        ...h,
        { role: 'user', content: t.builder.unifiedTest.incomingCallLabel, badge: '📞' },
      ]);
      for (const b of r.blocks) {
        const text = [b.body, b.caption].filter(Boolean).join('\n');
        setChatHistory((h) => [...h, {
          role: 'assistant',
          content: text || '',
          mediaPreviews: b.mediaPreview ? [b.mediaPreview] : undefined,
          badge: '📞',
        }]);
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'simulate_call_failed');
    } finally {
      setChatBusy(false);
    }
  };

  const sendNextFollowup = async (minutes: number) => {
    if (disabled) return;
    setChatBusy(true);
    setPendingFollowup(false);
    try {
      const r = await api.post<{ matched: boolean; ruleName?: string; stepDelayMinutes?: number; blocks: RenderedBlock[] }>(
        `/bots/${botId}/ai/test/next-followup`,
        { sessionSilentMinutes: minutes },
      );
      if (!r.matched) {
        toast(t.builder.unifiedTest.followupNoMatch, { icon: '⏰' });
        return;
      }
      const header = `${r.ruleName ?? '—'} · بعد ${r.stepDelayMinutes ?? minutes}د`;
      setChatHistory((h) => [...h, {
        role: 'assistant',
        content: r.blocks.map((b) => [b.body, b.caption].filter(Boolean).join('\n')).filter(Boolean).join('\n\n') || header,
        mediaPreviews: r.blocks.flatMap((b) => b.mediaPreview ? [b.mediaPreview] : []),
        badge: '✨',
      }]);
    } catch (e: any) {
      toast.error(e?.message ?? 'next_followup_failed');
    } finally {
      setChatBusy(false);
    }
  };

  const voicePreview = async () => {
    if (disabled) return;
    // Contextual A/B sample: prefer the LAST assistant text bubble so the
    // operator can A/B compare voices on what the bot would actually say.
    // Fall back to whatever they're typing, else the server's default sample.
    let sample: string | undefined;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      if (chatHistory[i].role === 'assistant' && chatHistory[i].content?.trim()) {
        sample = chatHistory[i].content; break;
      }
    }
    if (!sample && chatInput.trim()) sample = chatInput.trim();
    try {
      const r = await api.post<{ audioBase64: string; audioMime: string }>(
        `/bots/${botId}/ai/voice-preview`,
        sample ? { text: sample.slice(0, 500) } : {},
      );
      const bin = atob(r.audioBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: r.audioMime });
      const url = URL.createObjectURL(blob);
      const a = new Audio(url); a.play().catch(() => {});
    } catch (e: any) {
      toast.error(e?.message ?? 'voice_preview_failed');
    }
  };

  // ─── Input media ───
  const onPickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setChatImage(reader.result as string);
    reader.readAsDataURL(f);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recorderRef.current = { rec, chunks: [] };
      rec.ondataavailable = (ev) => { if (ev.data.size > 0) recorderRef.current.chunks.push(ev.data); };
      rec.onstop = async () => {
        const blob = new Blob(recorderRef.current.chunks, { type: 'audio/webm' });
        const buf = await blob.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        await sendChat(b64, 'audio/webm');
      };
      rec.start();
      setRecording(true);
    } catch (e: any) {
      toast.error(e?.message ?? 'mic_denied');
    }
  };
  const stopRecording = () => recorderRef.current.rec?.stop();

  return (
    <Card className="sticky top-4 self-start">
      <CardHeader>
        <span className="inline-flex items-center gap-2"><MessageCircle size={16} className="text-emerald-600" /> {t.builder.ai.preview}</span>
      </CardHeader>
      <CardBody className="flex h-[640px] flex-col bg-[#efeae2] p-2">
        <div className="-m-2 mb-2 flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><Phone size={14} /></div>
          <div className="flex-1 text-sm font-semibold">{t.builder.ai.testCustomer}</div>
          <span className="rounded-full bg-violet-100 px-2 py-0.5 font-mono text-[10px] text-violet-700">
            {engineMode}
          </span>
          {chatHistory.length > 0 && (
            <button onClick={reset} title="reset" className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700">
              <X size={14} />
            </button>
          )}
        </div>

        {disabled && (
          <div className="-m-2 mb-2 border-b border-gray-200 bg-gray-100 px-3 py-2 text-center text-[11px] text-gray-600">
            {t.builder.unifiedTest.disabledBanner}
          </div>
        )}

        {Object.keys(chatDraft).length > 0 && (
          <div className="-m-2 mb-2 flex flex-wrap items-center gap-1 border-b border-gray-200 bg-amber-50/70 px-2 py-1.5 text-[11px]">
            <span className="font-semibold text-amber-800">📋 الطلب الجاري:</span>
            {Object.entries(chatDraft).filter(([, v]) => v).map(([k, v]) => (
              <span key={k} className="rounded-full bg-white px-2 py-0.5 text-amber-700 shadow-sm">
                {k}=<span className="font-mono">{v}</span>
              </span>
            ))}
            {chatStage && (
              <span className="ms-auto rounded-full bg-violet-100 px-2 py-0.5 font-mono text-[10px] text-violet-700">
                STAGE={chatStage}
              </span>
            )}
          </div>
        )}

        {/* Toolbar */}
        <div className="-m-2 mb-2 flex flex-wrap items-center gap-1 border-b border-gray-200 bg-white px-2 py-1.5">
          <ToolbarBtn onClick={simulateCall} disabled={disabled || chatBusy} icon={<PhoneIncoming size={11} />}>
            {t.builder.unifiedTest.simulateCall}
          </ToolbarBtn>
          <div className="relative">
            <ToolbarBtn onClick={() => setPendingFollowup((p) => !p)} disabled={disabled || chatBusy} icon={<Clock size={11} />}>
              {t.builder.unifiedTest.sendFollowup}
            </ToolbarBtn>
            {pendingFollowup && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setPendingFollowup(false)} />
                <div className="absolute end-0 top-7 z-20 flex flex-col gap-0.5 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
                  {[5, 30, 120, 1440].map((m) => (
                    <button key={m} onClick={() => sendNextFollowup(m)}
                      className="rounded px-3 py-1 text-start text-[11px] hover:bg-gray-50">
                      {m < 60 ? `${m} د` : m < 1440 ? `${m / 60} س` : `${m / 1440} ي`}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <ToolbarBtn onClick={voicePreview} disabled={disabled} icon={<Volume2 size={11} />}>
            {t.builder.unifiedTest.voicePreview}
          </ToolbarBtn>
          <button
            onClick={() => setForceVoiceNext((v) => !v)}
            disabled={disabled || chatBusy}
            className={`ms-auto rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              forceVoiceNext
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100'
            }`}
          >
            {forceVoiceNext ? t.builder.unifiedTest.nextVoice : t.builder.unifiedTest.nextText}
          </button>
        </div>

        <div className="flex-1 space-y-1.5 overflow-y-auto scrollbar-thin">
          {chatHistory.length === 0 && (
            <div className="mt-12 text-center text-xs text-gray-400">{t.builder.ai.previewHint}</div>
          )}
          {chatHistory.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[78%] rounded-lg px-2.5 py-1.5 text-[14px] shadow-sm ${
                m.role === 'user' ? 'rounded-tr-sm bg-[#d9fdd3]' : 'rounded-tl-sm bg-white'
              }`}>
                {m.badge && (
                  <div className="mb-1 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-700">
                    {m.badge} {m.badge === '📞' ? t.builder.unifiedTest.callRejection : t.builder.unifiedTest.followup}
                  </div>
                )}
                {m.imageUrl && <img src={m.imageUrl} className="mb-1 max-h-40 rounded" />}
                {m.audioUrl && <audio src={m.audioUrl} controls className="mb-1 h-8 max-w-[230px]" />}
                {m.mediaPreviews?.map((mp) => (
                  <div key={mp.id} className="mb-1">
                    {mp.type === 'image' && <img src={mp.rawUrl} className="max-h-40 rounded" alt={mp.name} />}
                    {mp.type === 'video' && <video src={mp.rawUrl} controls className="max-h-40 max-w-[230px] rounded" />}
                    {mp.type === 'audio' && <audio src={mp.rawUrl} controls className="h-8 max-w-[230px]" />}
                    {mp.type === 'document' && (
                      <a href={mp.rawUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded bg-gray-50 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-100">
                        📎 {mp.name}
                      </a>
                    )}
                  </div>
                ))}
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
                {m.orderDone && (
                  <div className="mt-1.5 rounded bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700">
                    ✅ {t.builder.unifiedTest.orderDoneNote}
                  </div>
                )}
              </div>
            </div>
          ))}
          {chatBusy && (
            <div className="flex justify-start">
              <div className="rounded-lg rounded-tl-sm bg-white px-3 py-2 shadow-sm">
                <span className="inline-block animate-pulse">●●●</span>
              </div>
            </div>
          )}
        </div>

        {chatImage && (
          <div className="mt-1 flex items-center gap-2 rounded bg-white p-1 text-xs">
            <img src={chatImage} className="h-12 w-12 rounded object-cover" />
            <span className="flex-1 truncate text-gray-600">{t.builder.ai.imageReady}</span>
            <button onClick={() => setChatImage(null)} className="text-red-500"><X size={12} /></button>
          </div>
        )}

        <div className="-m-2 mt-2 flex items-center gap-1.5 border-t border-gray-200 bg-[#f0f2f5] px-2 py-2">
          <label className={`flex h-8 w-8 items-center justify-center rounded-full text-gray-500 ${disabled ? 'opacity-40' : 'cursor-pointer hover:bg-gray-100'}`}>
            <Paperclip size={16} />
            <input type="file" accept="image/*" className="hidden" onChange={onPickImage} disabled={disabled} />
          </label>
          <Input
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') sendChat(); }}
            placeholder={disabled ? t.builder.unifiedTest.disabledInputPh : t.builder.ai.previewPlaceholder}
            className="flex-1"
            disabled={disabled}
          />
          {chatInput.trim() || chatImage ? (
            <button onClick={() => sendChat()} disabled={chatBusy || disabled}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500 text-white shadow-sm hover:bg-brand-600 disabled:opacity-40">
              <Send size={16} />
            </button>
          ) : recording ? (
            <button onClick={stopRecording}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500 text-white shadow-sm hover:bg-red-600">
              <span className="h-3 w-3 rounded-sm bg-white" />
            </button>
          ) : (
            <button onClick={startRecording} disabled={chatBusy || disabled}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500 text-white shadow-sm hover:bg-brand-600 disabled:opacity-40">
              <Mic size={16} />
            </button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function ToolbarBtn({
  onClick, disabled, icon, children,
}: { onClick: () => void; disabled?: boolean; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon} {children}
    </button>
  );
}
