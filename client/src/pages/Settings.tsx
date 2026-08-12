import { useEffect, useState } from 'react';
import { Save, AlertTriangle, X, Image as ImageIcon, Mic, Video, Settings as SettingsIcon, Users } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { PageHeader } from '../components/ui/PageHeader';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input, Field, Textarea } from '../components/ui/Input';
import { MediaPickerModal } from './builder/parts/MediaPickerModal';
import { AccountAndTeamTab } from './settings/AccountAndTeamTab';

type Settings = {
  default_fallback_text: string;
  welcome_enabled: boolean;
  bot_globally_enabled: boolean;
  emergency_stop: boolean;
  typing_simulation: boolean;
  read_receipts: boolean;
  ignore_groups_default: boolean;
  media_text_delay_ms: number;
  min_send_delay_ms: number;
  max_send_delay_ms: number;
  per_contact_rate_per_min: number;
  per_contact_rate_per_hour: number;
  cold_start_ignore_seconds: number;
  burst_threshold_count: number;
  burst_window_minutes: number;
  burst_cooldown_seconds: number;
  handover_keywords: string[];
  handover_message: string;
  working_hours: { enabled: boolean; start: string; end: string; tz: string };
  auto_reject_calls: boolean;
  call_rejection_message_type: 'none' | 'text' | 'audio' | 'image' | 'video';
  call_rejection_message_text: string;
  call_rejection_media_id: string | null;
};

type Media = { id: string; name: string; type: string; mimeType: string; sizeBytes: number };
type Tab = 'bot' | 'account';

function BotSettingsTab() {
  const { t } = useI18n();
  const [s, setS] = useState<Settings | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickedMedia, setPickedMedia] = useState<Media | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);

  useEffect(() => {
    setLoadError(null);
    api.get<Settings>('/settings').then(setS).catch((e) => {
      setLoadError(e?.message ?? 'load_failed');
    });
  }, [loadTick]);

  useEffect(() => {
    if (!s?.call_rejection_media_id) { setPickedMedia(null); return; }
    if (pickedMedia?.id === s.call_rejection_media_id) return;
    api.get<Media[]>('/media').then((all) => {
      setPickedMedia(all.find((m) => m.id === s.call_rejection_media_id) ?? null);
    });
  }, [s?.call_rejection_media_id]);

  if (loadError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <div className="mb-2">{t.app.error}</div>
        <Button size="sm" variant="secondary" onClick={() => setLoadTick((n) => n + 1)}>
          {t.app.back}
        </Button>
      </div>
    );
  }
  if (!s) return <div className="text-gray-400">{t.app.loading}</div>;

  const update = (patch: Partial<Settings>) => setS({ ...s, ...patch });

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.patch('/settings', s);
      toast.success(t.app.saved);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally { setSaving(false); }
  };

  const Toggle = ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
    <label className="relative inline-flex cursor-pointer items-center">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div className="h-5 w-9 rounded-full bg-gray-200 peer-checked:bg-brand-500 transition" />
      <div className="absolute start-0.5 top-0.5 h-4 w-4 rounded-full bg-white peer-checked:translate-x-4 rtl:peer-checked:-translate-x-4 transition" />
    </label>
  );

  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-sm text-gray-700">{label}</span>
      {children}
    </div>
  );

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button onClick={save} loading={saving}><Save size={16} />{t.app.save}</Button>
      </div>

      {s.emergency_stop && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <AlertTriangle size={18} /> {t.settings.emergencyStop}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>{t.settings.general}</CardHeader>
          <CardBody className="divide-y divide-gray-50">
            <Row label={t.settings.botGloballyEnabled}><Toggle checked={s.bot_globally_enabled} onChange={(v) => update({ bot_globally_enabled: v })} /></Row>
            <Row label={t.settings.welcomeEnabled}><Toggle checked={s.welcome_enabled} onChange={(v) => update({ welcome_enabled: v })} /></Row>
            <Row label={t.settings.ignoreGroups}><Toggle checked={s.ignore_groups_default} onChange={(v) => update({ ignore_groups_default: v })} /></Row>
            <Row label={t.settings.typingSimulation}><Toggle checked={s.typing_simulation} onChange={(v) => update({ typing_simulation: v })} /></Row>
            <div className="py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-700">{t.settings.readReceipts}</span>
                <Toggle checked={s.read_receipts} onChange={(v) => update({ read_receipts: v })} />
              </div>
              <p className="mt-1 text-[11px] text-gray-500">{t.settings.readReceiptsHint}</p>
            </div>
            <Row label={t.settings.emergencyStop}><Toggle checked={s.emergency_stop} onChange={(v) => update({ emergency_stop: v })} /></Row>
            <div className="pt-3">
              <Field label={t.settings.fallbackText}>
                <Textarea value={s.default_fallback_text} onChange={(e) => update({ default_fallback_text: e.target.value })} />
              </Field>
              <p className="mt-1 text-[11px] text-gray-500">{t.settings.fallbackTextHint}</p>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>{t.settings.safety}</CardHeader>
          <CardBody className="space-y-3">
            <Field label={t.settings.minDelay}><Input type="number" value={s.min_send_delay_ms} onChange={(e) => update({ min_send_delay_ms: +e.target.value })} /></Field>
            <Field label={t.settings.maxDelay}><Input type="number" value={s.max_send_delay_ms} onChange={(e) => update({ max_send_delay_ms: +e.target.value })} /></Field>
            <Field label={t.settings.mediaTextDelay}><Input type="number" value={s.media_text_delay_ms} onChange={(e) => update({ media_text_delay_ms: +e.target.value })} /></Field>
            <Field label={t.settings.perMinRate}><Input type="number" value={s.per_contact_rate_per_min} onChange={(e) => update({ per_contact_rate_per_min: +e.target.value })} /></Field>
            <Field label={t.settings.perHourRate}><Input type="number" value={s.per_contact_rate_per_hour} onChange={(e) => update({ per_contact_rate_per_hour: +e.target.value })} /></Field>
            <Field label={t.settings.coldStartIgnore}><Input type="number" value={s.cold_start_ignore_seconds} onChange={(e) => update({ cold_start_ignore_seconds: +e.target.value })} /></Field>
            <hr className="border-gray-100" />
            <Field label={t.settings.burstThreshold}><Input type="number" value={s.burst_threshold_count} onChange={(e) => update({ burst_threshold_count: +e.target.value })} /></Field>
            <Field label={t.settings.burstWindow}><Input type="number" value={s.burst_window_minutes} onChange={(e) => update({ burst_window_minutes: +e.target.value })} /></Field>
            <Field label={t.settings.burstCooldown}><Input type="number" value={s.burst_cooldown_seconds} onChange={(e) => update({ burst_cooldown_seconds: +e.target.value })} /></Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>{t.settings.handover}</CardHeader>
          <CardBody className="space-y-3">
            <Field label={t.settings.handoverKeywords}>
              <Textarea
                rows={5}
                value={s.handover_keywords.join('\n')}
                onChange={(e) => update({ handover_keywords: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })}
              />
            </Field>
            <Field label={t.settings.handoverMessage}>
              <Textarea value={s.handover_message} onChange={(e) => update({ handover_message: e.target.value })} />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>{t.settings.calls.title}</CardHeader>
          <CardBody className="space-y-3">
            <Row label={t.settings.calls.autoReject}>
              <Toggle
                checked={s.auto_reject_calls}
                onChange={(v) => update({ auto_reject_calls: v })}
              />
            </Row>
            <p className="text-[11px] text-gray-500">{t.settings.calls.autoRejectHint}</p>
            {s.auto_reject_calls && (
              <>
                <Field label={t.settings.calls.responseType}>
                  <select
                    className="block w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                    value={s.call_rejection_message_type}
                    onChange={(e) => {
                      const v = e.target.value as Settings['call_rejection_message_type'];
                      update({
                        call_rejection_message_type: v,
                        ...(v === 'text' || v === 'none' ? { call_rejection_media_id: null } : {}),
                      });
                    }}
                  >
                    <option value="none">{t.settings.calls.typeNone}</option>
                    <option value="text">{t.settings.calls.typeText}</option>
                    <option value="audio">{t.settings.calls.typeAudio}</option>
                    <option value="image">{t.settings.calls.typeImage}</option>
                    <option value="video">{t.settings.calls.typeVideo}</option>
                  </select>
                </Field>
                {s.call_rejection_message_type === 'text' && (
                  <Field label={t.settings.calls.text}>
                    <Textarea
                      value={s.call_rejection_message_text}
                      onChange={(e) => update({ call_rejection_message_text: e.target.value })}
                    />
                  </Field>
                )}
                {(s.call_rejection_message_type === 'audio'
                  || s.call_rejection_message_type === 'image'
                  || s.call_rejection_message_type === 'video') && (
                  <Field label={t.settings.calls.media}>
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" onClick={() => setPickerOpen(true)}>
                        {s.call_rejection_message_type === 'image' ? <ImageIcon size={14} />
                          : s.call_rejection_message_type === 'audio' ? <Mic size={14} />
                          : <Video size={14} />}
                        {t.settings.calls.pickMedia}
                      </Button>
                      {pickedMedia ? (
                        <span className="flex items-center gap-1 truncate text-xs text-gray-600">
                          {pickedMedia.name}
                          <button
                            type="button"
                            onClick={() => update({ call_rejection_media_id: null })}
                            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                            title={t.app.cancel}
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">{t.settings.calls.noMedia}</span>
                      )}
                    </div>
                  </Field>
                )}
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>{t.settings.workingHours}</CardHeader>
          <CardBody className="space-y-3">
            <Row label={t.settings.workingHoursEnabled}>
              <Toggle checked={s.working_hours.enabled} onChange={(v) => update({ working_hours: { ...s.working_hours, enabled: v } })} />
            </Row>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t.settings.start}><Input type="time" value={s.working_hours.start} onChange={(e) => update({ working_hours: { ...s.working_hours, start: e.target.value } })} /></Field>
              <Field label={t.settings.end}><Input type="time" value={s.working_hours.end} onChange={(e) => update({ working_hours: { ...s.working_hours, end: e.target.value } })} /></Field>
            </div>
            <Field label={t.settings.timezone}><Input value={s.working_hours.tz} onChange={(e) => update({ working_hours: { ...s.working_hours, tz: e.target.value } })} /></Field>
          </CardBody>
        </Card>
      </div>

      <MediaPickerModal
        open={pickerOpen}
        kindFilter={
          s.call_rejection_message_type === 'audio' ? 'audio'
          : s.call_rejection_message_type === 'image' ? 'image'
          : s.call_rejection_message_type === 'video' ? 'video'
          : undefined
        }
        onClose={() => setPickerOpen(false)}
        onPick={(id) => {
          update({ call_rejection_media_id: id });
          setPickerOpen(false);
        }}
      />
    </>
  );
}

export function SettingsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('bot');

  const tabBtn = (id: Tab, label: string, Icon: typeof SettingsIcon) => (
    <button
      onClick={() => setTab(id)}
      className={clsx(
        'flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition',
        tab === id ? 'border-brand-500 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-700',
      )}
    >
      <Icon size={16} /> {label}
    </button>
  );

  return (
    <>
      <PageHeader title={t.settings.title} />
      <div className="mb-4 flex items-center gap-1 border-b border-gray-200">
        {tabBtn('bot', t.settings.tabs.bot, SettingsIcon)}
        {tabBtn('account', t.settings.tabs.account, Users)}
      </div>
      {tab === 'bot' ? <BotSettingsTab /> : <AccountAndTeamTab />}
    </>
  );
}
