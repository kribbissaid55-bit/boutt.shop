/**
 * QRConnectModal — beautiful dark modal for pairing a WhatsApp account.
 *
 * Strategy for "QR must always appear":
 *   1. On open, if account isn't already 'connected', logout first (wipes
 *      session creds) and then connect. This guarantees Baileys MUST go
 *      through the QR-pair path instead of trying to resume stale creds.
 *   2. Subscribe to SSE for QR + status events (primary delivery).
 *   3. Poll GET /accounts/:id every 2s as a fallback while in loading state,
 *      to recover any QR that SSE missed (race conditions on Vite HMR, etc.).
 *   4. Phased status messages keep the user informed (preparing → requesting →
 *      still waiting → fresh retry).
 *   5. After 15s of nothing, auto-fire one logout+connect cycle.
 *   6. Manual retry button always does logout+connect (real reset).
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Smartphone, Clock, CheckCircle2, AlertCircle, Loader2, RotateCw } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../api/client';
import { events } from '../../api/sse';
import { useI18n } from '../../i18n';

interface Account {
  id: string;
  name: string;
  status: string;
  phoneNumber: string | null;
  lastError: string | null;
  lastQr?: string;
}

const QR_TTL_SEC = 60;

export function QRConnectModal({
  open, accountId, accountName, onClose,
}: {
  open: boolean;
  accountId: string | null;
  accountName: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [acc, setAcc] = useState<Account | null>(null);
  const [qr, setQr] = useState<string | undefined>();
  const [qrAt, setQrAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [openedAt, setOpenedAt] = useState<number>(0);
  const [autoRetried, setAutoRetried] = useState(false);
  const closeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const startedRef = useRef(false);

  /** Force a fresh session: logout (wipes creds) → wait → connect. */
  const freshSession = useCallback(async () => {
    if (!accountId) return;
    try {
      await api.post(`/accounts/${accountId}/logout`).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      await api.post(`/accounts/${accountId}/connect`).catch(() => {});
    } catch {}
  }, [accountId]);

  // 1) On open: kick the session lifecycle and subscribe SSE.
  useEffect(() => {
    if (!open || !accountId) {
      startedRef.current = false;
      setAcc(null); setQr(undefined); setQrAt(null);
      setAutoRetried(false);
      return;
    }

    let alive = true;
    setOpenedAt(Date.now());

    const start = async () => {
      try {
        // First peek at current state.
        const fresh = await api.get<Account>(`/accounts/${accountId}`);
        if (!alive) return;
        setAcc(fresh);
        if (fresh.lastQr) { setQr(fresh.lastQr); setQrAt(Date.now()); }

        // If not already connected and we haven't kicked off, force a fresh session.
        if (!startedRef.current && fresh.status !== 'connected') {
          startedRef.current = true;
          await freshSession();
        } else if (!startedRef.current) {
          startedRef.current = true;
        }
      } catch {}
    };
    start();

    const off = events.on((e) => {
      if (!alive) return;
      if (e.type === 'qr' && e.accountId === accountId) {
        setQr(e.dataUrl); setQrAt(Date.now());
      }
      if (e.type === 'account.status' && e.accountId === accountId) {
        setAcc((prev) => prev
          ? { ...prev, status: e.status, phoneNumber: e.phoneNumber ?? prev.phoneNumber, lastError: e.lastError ?? null }
          : prev
        );
        if (e.status === 'connected') {
          if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
          closeTimerRef.current = setTimeout(onClose, 1800);
        }
      }
    });

    return () => {
      alive = false;
      off();
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, [open, accountId, onClose, freshSession]);

  // 2) Polling fallback while loading: pick up lastQr if SSE missed it.
  useEffect(() => {
    if (!open || !accountId) return;
    if (qr) return; // already have one
    const id = setInterval(async () => {
      try {
        const fresh = await api.get<Account>(`/accounts/${accountId}`);
        setAcc(fresh);
        if (fresh.lastQr) {
          setQr(fresh.lastQr);
          setQrAt(Date.now());
        }
      } catch {}
    }, 2000);
    return () => clearInterval(id);
  }, [open, accountId, qr]);

  // 3) 1Hz tick for the countdown ring + phased status messages.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [open]);

  // 4) Auto-retry once after 15s of nothing (no QR, no connection).
  useEffect(() => {
    if (!open || !accountId) return;
    if (qr || acc?.status === 'connected') return;
    if (autoRetried) return;
    const elapsedSec = (now - openedAt) / 1000;
    if (elapsedSec >= 15) {
      setAutoRetried(true);
      freshSession();
    }
  }, [open, accountId, qr, acc?.status, autoRetried, now, openedAt, freshSession]);

  // ESC closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !accountId) return null;

  const status = acc?.status ?? 'connecting';
  const elapsed = qrAt ? Math.max(0, (now - qrAt) / 1000) : 0;
  const remaining = qr ? Math.max(0, Math.ceil(QR_TTL_SEC - elapsed)) : 0;
  const progress = qr ? Math.min(1, elapsed / QR_TTL_SEC) : 0;

  // Phased loading status text (only relevant before the QR arrives).
  const sinceOpenSec = (now - openedAt) / 1000;
  let loadingLabel = t.qrModal.preparing;
  if (sinceOpenSec >= 3) loadingLabel = t.qrModal.requestingQr;
  if (sinceOpenSec >= 8) loadingLabel = t.qrModal.stillWaiting;
  if (autoRetried) loadingLabel = t.qrModal.freshRetry;

  // Status pill colors
  let pill = { label: t.qrModal.connecting, dot: 'bg-blue-400', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' };
  if (status === 'qr_required') pill = { label: t.qrModal.waitingScan, dot: 'bg-amber-400', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' };
  if (status === 'connected') pill = { label: t.qrModal.connected, dot: 'bg-emerald-400', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
  if (status === 'error') pill = { label: t.qrModal.error, dot: 'bg-red-400', cls: 'bg-red-500/15 text-red-300 border-red-500/30' };

  const retry = async () => {
    setQr(undefined); setQrAt(null);
    setOpenedAt(Date.now());
    setAutoRetried(false);
    await freshSession();
  };

  // Show error state only if we have a real error AND no QR is available.
  // While 'connecting', errors during retries are normal and shouldn't panic the user.
  const showError = !qr && status !== 'connected' && acc?.lastError &&
    (status === 'error' || (status === 'disconnected' && sinceOpenSec > 6));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose} dir="rtl">
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl bg-[#0f172a] text-white shadow-2xl ring-1 ring-white/5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-white/5 p-4">
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-white/70 hover:bg-white/5 hover:text-white"
            aria-label="close"
          >
            <X size={18} />
          </button>
          <div className="flex-1" />
          <div className="flex flex-col items-end gap-1">
            <span className="text-base font-semibold">{accountName}</span>
            <span className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium', pill.cls)}>
              <span className={clsx('h-1.5 w-1.5 rounded-full animate-pulse', pill.dot)} />
              {pill.label}
            </span>
          </div>
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-700/40 text-teal-200 ring-1 ring-teal-500/30">
            <Smartphone size={18} />
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-col items-center px-6 py-6">
          {status === 'connected' ? (
            <ConnectedState phone={acc?.phoneNumber ?? ''} />
          ) : qr ? (
            <>
              <div className="rounded-2xl bg-white p-4 shadow-lg">
                <img src={qr} alt="QR" className="block h-64 w-64" />
              </div>
              <div className="mt-4 h-1.5 w-72 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full bg-gradient-to-r from-teal-400 to-emerald-400 transition-[width] duration-500 ease-linear"
                  style={{ width: `${(1 - progress) * 100}%` }}
                />
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-xs text-white/50">
                <Clock size={12} />
                <span>{t.qrModal.expiresIn.replace('{n}', String(remaining))}</span>
              </div>
            </>
          ) : showError ? (
            <ErrorState message={acc?.lastError ?? t.qrModal.error} onRetry={retry} />
          ) : (
            <LoadingState label={loadingLabel} canRetry={sinceOpenSec >= 8} onRetry={retry} />
          )}
        </div>

        {/* Steps */}
        <div className="space-y-3 border-t border-white/5 bg-white/[0.02] p-5">
          <Step n="1" label={t.qrModal.step1} />
          <Step n="2" label={t.qrModal.step2} />
          <Step n="3" label={t.qrModal.step3} />
        </div>
      </div>
    </div>
  );
}

function Step({ n, label }: { n: string; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-700/40 text-[11px] font-bold text-teal-200 ring-1 ring-teal-500/30">
        {n}
      </span>
      <span className="text-sm text-white/80">{label}</span>
    </div>
  );
}

function LoadingState({ label, canRetry, onRetry }: { label: string; canRetry: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex h-72 w-full flex-col items-center justify-center gap-3">
      <Loader2 size={32} className="animate-spin text-teal-400" />
      <span className="text-sm text-white/70 text-center px-4">{label}</span>
      {canRetry && (
        <button
          onClick={onRetry}
          className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/10"
        >
          <RotateCw size={12} /> {t.qrModal.retry}
        </button>
      )}
    </div>
  );
}

function ConnectedState({ phone }: { phone: string }) {
  const { t } = useI18n();
  return (
    <div className="flex h-72 w-full flex-col items-center justify-center gap-3">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20 ring-2 ring-emerald-400/40">
        <CheckCircle2 size={36} className="text-emerald-400" />
      </div>
      <span className="text-base font-semibold text-emerald-300">{t.qrModal.successTitle}</span>
      {phone && <span className="text-xs text-white/50" dir="ltr">+{phone}</span>}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex h-72 w-full flex-col items-center justify-center gap-3 px-4 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500/20 ring-2 ring-red-400/40">
        <AlertCircle size={28} className="text-red-400" />
      </div>
      <span className="text-sm text-red-300">{message}</span>
      <button
        onClick={onRetry}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/10"
      >
        <RotateCw size={12} />
        {t.qrModal.retry}
      </button>
    </div>
  );
}
