/**
 * VoiceRecorder — captures audio from the browser mic and sends it as a
 * WhatsApp voice note via the existing inbox send-media path.
 *
 * State machine: idle → recording → preview → uploading → done/canceled
 *
 * Cleanup invariants: any path that leaves the recording/preview state must
 * release the mic stream and clear the timer interval, so we never leak the
 * mic indicator in the browser tab.
 */
import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Trash2, Send, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useI18n } from '../../i18n';

// Preferred output format. OGG/Opus first when supported (Firefox), so
// WhatsApp displays it natively as a voice note. Chrome only outputs webm —
// the server overrides the mimetype to audio/ogg on the wire so WhatsApp
// still treats it as a voice note (the codec inside is opus either way).
const PREFERRED_MIME = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

const MAX_SECONDS = 60;
const PROGRESS_BARS = 24;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return PREFERRED_MIME.find((m) => {
    try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
  });
}

function extFor(mime: string): string {
  if (mime.startsWith('audio/webm')) return 'webm';
  if (mime.startsWith('audio/ogg')) return 'ogg';
  if (mime.startsWith('audio/mp4')) return 'm4a';
  return 'bin';
}

const fmtClock = (s: number) => {
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
};

type Phase = 'recording' | 'preview' | 'uploading';

export function VoiceRecorder({
  contactId, onSent, onCancel,
}: {
  contactId: string;
  onSent: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('recording');
  const [seconds, setSeconds] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedMime, setRecordedMime] = useState<string>('audio/webm');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const tickRef = useRef<number | null>(null);

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  const stopTick = () => {
    if (tickRef.current !== null) { clearInterval(tickRef.current); tickRef.current = null; }
  };
  const cleanup = () => {
    stopTick();
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop(); } catch {}
    }
    releaseStream();
  };

  // Start recording on mount
  useEffect(() => {
    let aborted = false;
    const mime = pickMime();
    if (!mime) {
      toast.error(t.voice.unsupported);
      onCancel();
      return;
    }

    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e: any) {
        toast.error(t.voice.permissionDenied);
        if (!aborted) onCancel();
        return;
      }
      if (aborted) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      const rec = new MediaRecorder(stream, { mimeType: mime });
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime });
        if (blob.size === 0) { onCancel(); return; }
        setRecordedBlob(blob);
        setRecordedMime(mime);
        setPreviewUrl(URL.createObjectURL(blob));
        setPhase('preview');
        releaseStream();
        stopTick();
      };
      rec.start();

      // 1 Hz tick — stops at MAX_SECONDS
      tickRef.current = window.setInterval(() => {
        setSeconds((s) => {
          const next = s + 1;
          if (next >= MAX_SECONDS) {
            try { rec.stop(); } catch {}
          }
          return next;
        });
      }, 1000);
    })();

    return () => {
      aborted = true;
      cleanup();
      // Don't revoke previewUrl here — preview state still needs it; revoked on send/cancel.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      try { recorderRef.current.stop(); } catch {}
    }
  };

  const discard = () => {
    cleanup();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    onCancel();
  };

  const send = async () => {
    if (!recordedBlob) return;
    setPhase('uploading');
    try {
      const ext = extFor(recordedMime);
      const file = new File([recordedBlob], `voice-${Date.now()}.${ext}`, { type: recordedMime });
      const fd = new FormData();
      fd.append('file', file);
      fd.append('forceKind', 'audio');

      const upRes = await fetch('/api/media', { method: 'POST', credentials: 'include', body: fd });
      if (!upRes.ok) throw new Error(`upload_failed_${upRes.status}`);
      const media = await upRes.json() as { id: string };

      const sendRes = await fetch(`/api/inbox/conversations/${contactId}/send-media`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaId: media.id }),
      });
      if (!sendRes.ok) throw new Error(`send_failed_${sendRes.status}`);

      if (previewUrl) URL.revokeObjectURL(previewUrl);
      onSent();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
      // Stay in preview so user can retry
      setPhase('preview');
    }
  };

  // Animated bars (purely visual, no real waveform)
  const bars = Array.from({ length: PROGRESS_BARS }, (_, i) => {
    const offset = (i + (seconds % 5)) % PROGRESS_BARS;
    const h = phase === 'recording' ? 6 + ((offset * 7) % 18) : 4;
    return h;
  });

  if (phase === 'recording') {
    return (
      <div className="flex items-center gap-2 rounded-2xl bg-red-50 px-3 py-2 text-sm">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
        </span>
        <span className="font-mono text-xs font-semibold text-red-700 tabular-nums">{fmtClock(seconds)}</span>
        <div className="flex flex-1 items-center gap-0.5 overflow-hidden">
          {bars.map((h, i) => (
            <span
              key={i}
              className="rounded-full bg-red-300/80"
              style={{ width: 2, height: h, transition: 'height 100ms' }}
            />
          ))}
        </div>
        <button
          onClick={discard}
          className="flex h-8 w-8 items-center justify-center rounded-full text-gray-500 hover:bg-white"
          title={t.voice.cancel}
        >
          <Trash2 size={14} />
        </button>
        <button
          onClick={stopRecording}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500 text-white shadow-sm hover:bg-red-600"
          title={t.voice.stop}
        >
          <Square size={14} fill="currentColor" />
        </button>
      </div>
    );
  }

  if (phase === 'preview' || phase === 'uploading') {
    return (
      <div className="flex items-center gap-2 rounded-2xl bg-emerald-50 px-3 py-2">
        <Mic size={14} className="shrink-0 text-emerald-700" />
        <audio src={previewUrl ?? undefined} controls className="h-8 flex-1" />
        <button
          onClick={discard}
          disabled={phase === 'uploading'}
          className="flex h-8 w-8 items-center justify-center rounded-full text-gray-500 hover:bg-white disabled:opacity-40"
          title={t.voice.cancel}
        >
          <Trash2 size={14} />
        </button>
        <button
          onClick={send}
          disabled={phase === 'uploading'}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-[#25d366] text-white shadow-sm hover:bg-[#1faa55] disabled:opacity-40"
          title={t.voice.send}
        >
          {phase === 'uploading'
            ? <span className="h-3 w-3 rounded-full border-2 border-white border-r-transparent animate-spin" />
            : <Send size={14} />}
        </button>
      </div>
    );
  }

  // Should not reach here, fallback
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">
      <AlertCircle size={14} /> <span>{t.app.error}</span>
    </div>
  );
}
