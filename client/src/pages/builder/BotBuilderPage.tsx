import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Phone, Sparkles, Clock } from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { BotTopBar } from './parts/BotTopBar';
import { BotStepsSidebar } from './parts/BotStepsSidebar';
import { StepEditor } from './parts/StepEditor';
import { WhatsAppPreviewPanel } from './parts/WhatsAppPreviewPanel';
import { BotValidationPanel } from './parts/BotValidationPanel';
import { BotCallsTab } from './parts/BotCallsTab';
import { BotAiTab } from './parts/BotAiTab';
import { FollowUpsPanel } from '../followups/FollowUpsPage';
import type { Bot, ValidationReport } from './types';

type Tab = 'steps' | 'calls' | 'ai' | 'followups';

export function BotBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { t } = useI18n();

  const [bot, setBot] = useState<Bot | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [tab, setTab] = useState<Tab>('steps');

  const reload = useCallback(async () => {
    if (!id) return;
    const fresh = await api.get<Bot>(`/bots/${id}`);
    setBot(fresh);
    setSelectedStepId((cur) => {
      if (cur && fresh.steps.find((s) => s.id === cur)) return cur;
      return fresh.steps[0]?.id ?? null;
    });
    setLastSavedAt(Date.now());
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  // re-validate quietly whenever bot changes (debounced)
  useEffect(() => {
    if (!id) return;
    const tm = setTimeout(() => {
      api.post<ValidationReport>(`/bots/${id}/validate`).then(setValidation).catch(() => {});
    }, 600);
    return () => clearTimeout(tm);
  }, [id, bot]);

  const selected = useMemo(
    () => bot?.steps.find((s) => s.id === selectedStepId) ?? null,
    [bot, selectedStepId]
  );

  const onPublish = async () => {
    if (!id) return;
    try {
      await api.post(`/bots/${id}/publish`);
      toast.success(t.builder.bot_status.active);
      reload();
    } catch (e: any) {
      const issues = e.data?.issues as ValidationReport | undefined;
      if (issues) {
        setValidation(issues);
        toast.error(t.builder.validation.errors + ': ' + (issues.errors[0]?.message ?? ''));
      } else {
        toast.error(t.app.error);
      }
    }
  };
  const onPause = async () => {
    if (!id) return;
    await api.post(`/bots/${id}/pause`);
    toast.success(t.builder.bot_status.paused);
    reload();
  };

  if (!bot) return <div className="p-8 text-gray-400">{t.app.loading}</div>;

  return (
    <div className="-m-6 flex h-[calc(100vh-1rem)] flex-col">
      <BotTopBar
        bot={bot}
        lastSavedAt={lastSavedAt}
        validation={validation}
        onChange={(patch) => { setBot({ ...bot, ...patch }); }}
        onSaveBasics={async (patch) => {
          await api.patch(`/bots/${id}`, patch);
          await reload();
        }}
        onPublish={onPublish}
        onPause={onPause}
        onBack={() => nav('/bots')}
        onLinksChanged={reload}
      />

      {/* Tabs row */}
      <div className="flex items-center gap-1 border-b border-gray-200 bg-white px-4">
        <TabButton active={tab === 'steps'} onClick={() => setTab('steps')}>
          {t.builder.tabs.steps}
        </TabButton>
        <TabButton active={tab === 'calls'} onClick={() => setTab('calls')}>
          <Phone size={14} className="me-1 inline" />
          {t.builder.tabs.calls}
        </TabButton>
        <TabButton active={tab === 'ai'} onClick={() => setTab('ai')}>
          <Sparkles size={14} className="me-1 inline" />
          {t.builder.tabs.ai}
        </TabButton>
        <TabButton active={tab === 'followups'} onClick={() => setTab('followups')}>
          <Clock size={14} className="me-1 inline" />
          {t.builder.tabs.followups}
        </TabButton>
      </div>

      {tab === 'steps' ? (
        <div className="flex flex-1 overflow-hidden">
          <BotStepsSidebar
            bot={bot}
            selectedStepId={selectedStepId}
            validation={validation}
            onSelect={setSelectedStepId}
            onChanged={reload}
          />

          <main className="flex-1 overflow-y-auto bg-gray-50 scrollbar-thin">
            {selected ? (
              <StepEditor
                key={selected.id}
                bot={bot}
                step={selected}
                onChanged={reload}
                focusBlockId={null}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-gray-400">{t.app.empty}</div>
            )}
          </main>

          <WhatsAppPreviewPanel step={selected} bot={bot} />
        </div>
      ) : tab === 'calls' ? (
        <main className="flex-1 overflow-y-auto bg-gray-50 scrollbar-thin">
          <BotCallsTab botId={bot.id} />
        </main>
      ) : tab === 'ai' ? (
        <main className="flex-1 overflow-y-auto bg-gray-50 scrollbar-thin">
          <BotAiTab botId={bot.id} onSwitchToSteps={() => setTab('steps')} />
        </main>
      ) : (
        <main className="flex-1 overflow-y-auto bg-gray-50 p-4 scrollbar-thin">
          <FollowUpsPanel botId={bot.id} />
        </main>
      )}

      <BotValidationPanel
        validation={validation}
        onJump={(stepId) => setSelectedStepId(stepId ?? null)}
      />

    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'border-b-2 px-3 py-2 text-sm font-medium transition',
        active ? 'border-brand-500 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-800',
      )}
    >
      {children}
    </button>
  );
}
