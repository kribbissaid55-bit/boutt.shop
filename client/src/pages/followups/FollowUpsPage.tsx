import { useEffect, useState } from 'react';
import { Plus, Play, Pause, Trash2, Copy, RefreshCw, Clock, Image as ImageIcon, Mic, Video, X, ChevronUp, ChevronDown, FileText, Type, Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { PageHeader } from '../../components/ui/PageHeader';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Input, Field, Textarea } from '../../components/ui/Input';
import { Empty } from '../../components/ui/Empty';
import { MediaPickerModal } from '../builder/parts/MediaPickerModal';
import { FOLLOWUP_TEMPLATES, type StepRecipe } from './templates';

type BlockType = 'text' | 'image' | 'video' | 'audio' | 'document';

interface Block {
  type: BlockType;
  content?: string;
  mediaId?: string;
  caption?: string;
  enabled?: boolean;
}

interface Step {
  id: string;
  delayValue: number;
  delayUnit: 'minutes' | 'hours' | 'days';
  messageSequence: { blocks: Block[] };
}

interface Rule {
  id: string;
  name: string;
  isActive: boolean;
  triggerType: string;
  accountId: string | null;
  botId: string | null;
  activatedAt: string | null;
  steps: Step[];
}

interface AccountOpt { id: string; name: string; status: string }
interface Media { id: string; name: string; type: string }
type MsgKind = 'text' | 'audio' | 'image' | 'video';

interface Dashboard {
  activeRules: number;
  pausedRules: number;
  pending: number;
  sentToday: number;
  failedToday: number;
  skippedToday: number;
}

export function FollowUpsPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader
        title={t.followups.title}
        subtitle={t.followups.subtitle}
      />
      <FollowUpsPanel />
    </>
  );
}

/**
 * FollowUpsPanel — the rule list + editor, reusable both at the global
 * `/followups` page and inside the bot builder. When a `botId` is provided,
 * the panel filters rules by `botId === botId` and forces created/edited
 * rules to belong to that bot (the account-picker is hidden because the
 * audience is implicit: every account linked to the bot via `BotAccount`).
 */
export function FollowUpsPanel({ botId }: { botId?: string } = {}) {
  const { t } = useI18n();
  const [rules, setRules] = useState<Rule[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    const [r, d] = await Promise.all([
      api.get<Rule[]>('/follow-ups/rules'),
      api.get<Dashboard>('/follow-ups/dashboard'),
    ]);
    const filtered = botId ? r.filter((x) => x.botId === botId) : r;
    setRules(filtered); setDashboard(d);
  };
  useEffect(() => { load(); }, [botId]);

  const toggle = async (r: Rule) => {
    try {
      if (r.isActive) await api.post(`/follow-ups/rules/${r.id}/pause`);
      else await api.post(`/follow-ups/rules/${r.id}/activate`);
      load();
    } catch (e: any) {
      toast.error(e?.data?.issues?.join(', ') ?? e?.message ?? t.app.error);
    }
  };
  const remove = async (id: string) => {
    if (!confirm(t.app.delete + '?')) return;
    await api.delete(`/follow-ups/rules/${id}`); load();
  };
  const duplicate = async (id: string) => {
    await api.post(`/follow-ups/rules/${id}/duplicate`); load();
  };
  const runCheck = async (id: string) => {
    await api.post(`/follow-ups/rules/${id}/run-check`);
    toast.success(t.app.saved);
    setTimeout(load, 1500);
  };

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setAdding(true)}><Plus size={16} /> {t.followups.create}</Button>
      </div>

      {dashboard && (
        <div className="mb-4 grid gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Stat label={t.followups.activeRules} value={dashboard.activeRules} cls="bg-emerald-50 text-emerald-700" />
          <Stat label={t.followups.pausedRules} value={dashboard.pausedRules} cls="bg-gray-100 text-gray-600" />
          <Stat label={t.followups.pending} value={dashboard.pending} cls="bg-amber-50 text-amber-700" />
          <Stat label={t.followups.sentToday} value={dashboard.sentToday} cls="bg-blue-50 text-blue-700" />
          <Stat label={t.followups.failedToday} value={dashboard.failedToday} cls="bg-red-50 text-red-700" />
          <Stat label={t.followups.skippedToday} value={dashboard.skippedToday} cls="bg-purple-50 text-purple-700" />
        </div>
      )}

      {rules.length === 0 ? (
        <Card><Empty title={t.followups.emptyTitle} hint={t.followups.emptyHint} /></Card>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <Card key={r.id}>
              <CardBody>
                <div className="flex items-start gap-3">
                  <div className={clsx(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                    r.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500',
                  )}>
                    <Clock size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-gray-900">{r.name}</div>
                    <div className="mt-0.5 text-xs text-gray-500">
                      {(t.followups.triggers as any)[r.triggerType] ?? r.triggerType}
                      {' · '}
                      {r.steps.length} {t.followups.stepsLabel}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => runCheck(r.id)} title={t.followups.runCheck}>
                      <RefreshCw size={14} />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => duplicate(r.id)} title={t.followups.duplicate}>
                      <Copy size={14} />
                    </Button>
                    <Button size="sm" variant={r.isActive ? 'secondary' : 'primary'} onClick={() => toggle(r)}>
                      {r.isActive ? <><Pause size={14} /> {t.followups.pauseRule}</> : <><Play size={14} /> {t.followups.activateRule}</>}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>{t.app.edit}</Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(r.id)}><Trash2 size={14} className="text-red-500" /></Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <RuleEditor
        open={adding || !!editing}
        editing={editing}
        botId={botId}
        onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={() => { setAdding(false); setEditing(null); load(); }}
      />
    </>
  );
}

function Stat({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={`rounded-lg p-3 ${cls}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}

interface DraftStep {
  id?: string;                                     // existing step id (when editing)
  delayValue: number;
  delayUnit: 'minutes' | 'hours' | 'days';
  blocks: Block[];
}

function RuleEditor({ open, editing, botId, onClose, onSaved }: {
  open: boolean; editing: Rule | null; botId?: string; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState('no_reply');
  const [accountId, setAccountId] = useState('');
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [pickerFor, setPickerFor] = useState<{ stepIdx: number; blockIdx: number } | null>(null);
  // Which block is currently open in the inline-expand editor (format: `${stepIdx}-${blockIdx}`).
  // Only one block expanded at a time keeps the modal navigable.
  const [expandedBlock, setExpandedBlock] = useState<string | null>('0-0');
  const [mediaIndex, setMediaIndex] = useState<Map<string, Media>>(new Map());
  const [busy, setBusy] = useState(false);

  // When the panel is embedded inside the bot builder, `botId` is set and the
  // audience is implicit (the bot's linked accounts via BotAccount). The
  // account picker is hidden, validation drops the accountId requirement,
  // and the save payload carries `botId` instead of `accountId`.
  const bound = !!botId;

  useEffect(() => {
    if (!open) return;
    if (!bound) api.get<AccountOpt[]>('/accounts').then(setAccounts);
    api.get<Media[]>('/media').then((all) => {
      const m = new Map<string, Media>();
      all.forEach((x) => m.set(x.id, x));
      setMediaIndex(m);
    });
  }, [open, bound]);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setTriggerType(editing?.triggerType ?? 'no_reply');
    setAccountId(editing?.accountId ?? '');
    if (editing?.steps?.length) {
      setSteps(editing.steps.map((s) => ({
        id: s.id,
        delayValue: s.delayValue,
        delayUnit: s.delayUnit,
        blocks: (s.messageSequence?.blocks ?? []).map((b) => ({ ...b, enabled: b.enabled !== false })),
      })));
    } else {
      // start with one empty step
      setSteps([{ delayValue: 1, delayUnit: 'hours', blocks: [{ type: 'text', enabled: true }] }]);
    }
  }, [open, editing]);

  const applyTemplate = (key: string) => {
    const tpl = FOLLOWUP_TEMPLATES.find((x) => x.key === key);
    if (!tpl) return;
    setSteps(tpl.steps.map((sr: StepRecipe) => ({
      delayValue: sr.delayValue,
      delayUnit: sr.delayUnit,
      blocks: sr.blocks.map((b) => ({ ...b, enabled: true })),
    })));
    toast.success(t.followups.templateApplied);
  };

  const updateStep = (i: number, patch: Partial<DraftStep>) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const removeStep = (i: number) => setSteps((prev) => prev.filter((_, idx) => idx !== i));
  const moveStep = (i: number, dir: -1 | 1) => setSteps((prev) => {
    const cp = [...prev];
    const j = i + dir;
    if (j < 0 || j >= cp.length) return prev;
    [cp[i], cp[j]] = [cp[j], cp[i]];
    return cp;
  });
  const addStep = () => setSteps((prev) => [...prev, { delayValue: 1, delayUnit: 'days', blocks: [{ type: 'text', enabled: true }] }]);

  const updateBlock = (si: number, bi: number, patch: Partial<Block>) =>
    setSteps((prev) => prev.map((s, idx) => idx !== si ? s : ({
      ...s,
      blocks: s.blocks.map((b, j) => (j === bi ? { ...b, ...patch } : b)),
    })));
  const addBlock = (si: number, type: BlockType) =>
    setSteps((prev) => prev.map((s, idx) => idx !== si ? s : ({ ...s, blocks: [...s.blocks, { type, enabled: true }] })));
  const removeBlock = (si: number, bi: number) =>
    setSteps((prev) => prev.map((s, idx) => idx !== si ? s : ({ ...s, blocks: s.blocks.filter((_, j) => j !== bi) })));
  const moveBlock = (si: number, bi: number, dir: -1 | 1) =>
    setSteps((prev) => prev.map((s, idx) => {
      if (idx !== si) return s;
      const cp = [...s.blocks];
      const j = bi + dir;
      if (j < 0 || j >= cp.length) return s;
      [cp[bi], cp[j]] = [cp[j], cp[bi]];
      return { ...s, blocks: cp };
    }));

  const validate = (): string | null => {
    if (!name.trim()) return t.followups.ruleName;
    if (!bound && !accountId) return t.followups.accountRequired;
    if (!steps.length) return t.followups.mediaRequired;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s.blocks.length) return `${t.followups.stepConfig} #${i + 1}: ${t.followups.mediaRequired}`;
      for (const b of s.blocks) {
        if (b.type === 'text' && !(b.content ?? '').trim()) return `${t.followups.stepConfig} #${i + 1}: ${t.followups.messageText}`;
        if (b.type !== 'text' && !b.mediaId) return `${t.followups.stepConfig} #${i + 1}: ${t.followups.mediaRequired}`;
      }
    }
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    setBusy(true);
    try {
      let ruleId = editing?.id;
      const audience = bound
        ? { botId, accountId: null }
        : { accountId, botId: null };
      if (editing) {
        await api.patch(`/follow-ups/rules/${editing.id}`, { name, triggerType, ...audience });
      } else {
        const r = await api.post<Rule>('/follow-ups/rules', { name, triggerType, ...audience });
        ruleId = r.id;
      }
      // Sync steps: update existing, create new, delete removed.
      const existingIds = new Set((editing?.steps ?? []).map((s) => s.id));
      const keepIds = new Set(steps.filter((s) => s.id).map((s) => s.id!));
      // Delete steps that were removed
      for (const oldId of existingIds) {
        if (!keepIds.has(oldId)) {
          await api.delete(`/follow-ups/steps/${oldId}`);
        }
      }
      // Upsert steps in order
      for (const s of steps) {
        const messageSequence = { blocks: s.blocks.filter((b) => b.enabled !== false) };
        if (s.id) {
          await api.patch(`/follow-ups/steps/${s.id}`, {
            delayValue: s.delayValue, delayUnit: s.delayUnit, messageSequence,
          });
        } else if (ruleId) {
          await api.post(`/follow-ups/rules/${ruleId}/steps`, {
            delayValue: s.delayValue, delayUnit: s.delayUnit, messageSequence,
          });
        }
      }
      toast.success(t.app.saved);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? t.app.edit : t.followups.create} wide tall
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t.app.cancel}</Button>
        <Button onClick={save} loading={busy} disabled={!name.trim()}>{t.app.save}</Button>
      </>}>
      <div className="space-y-3">
        {/* Compact header: name + account/badge + trigger in ONE row */}
        <div className={`grid gap-2 ${bound ? 'grid-cols-1 md:grid-cols-2' : 'md:grid-cols-3'}`}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.followups.ruleName}
            autoFocus
          />
          {!bound && (
            <select
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">— {t.followups.pickAccount} —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name} {a.status !== 'connected' ? `(${a.status})` : ''}</option>
              ))}
            </select>
          )}
          <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={triggerType} onChange={(e) => setTriggerType(e.target.value)}>
            {Object.entries(t.followups.triggers).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}
          </select>
        </div>

        {bound && (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-0.5 text-[11px] text-violet-700">
            📌 {t.builder.followups.scopedHint}
          </div>
        )}

        {/* Collapsed templates picker */}
        <details className="group rounded-lg border border-dashed border-brand-200 bg-brand-50/40">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50/80">
            <Sparkles size={12} />
            <span>{t.followups.templates.label}</span>
            <span className="text-[10px] text-brand-500">({FOLLOWUP_TEMPLATES.length})</span>
            <ChevronDown size={12} className="ms-auto text-brand-600 transition group-open:rotate-180" />
          </summary>
          <div className="border-t border-brand-100 px-2 py-1.5">
            <select
              className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs"
              value=""
              onChange={(e) => { if (e.target.value) applyTemplate(e.target.value); }}
            >
              <option value="">{t.followups.templates.choose}</option>
              {FOLLOWUP_TEMPLATES.map((tpl) => (
                <option key={tpl.key} value={tpl.key}>{(t.followups.templates as any)[tpl.key] ?? tpl.key}</option>
              ))}
            </select>
          </div>
        </details>

        {/* Steps — compact rows */}
        {steps.map((s, i) => (
          <div key={i} className="rounded-lg border border-gray-200 bg-gray-50/60">
            {/* Step header: ONE row — badge · delay · actions */}
            <div className="flex items-center gap-1.5 border-b border-gray-100 bg-white px-2 py-1.5">
              <span className="shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold text-brand-700">
                {t.followups.stepConfig} {i + 1}
              </span>
              <span className="shrink-0 text-[11px] text-gray-500">{t.followups.delayValue}:</span>
              <input
                type="number"
                min={1}
                value={s.delayValue}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  updateStep(i, { delayValue: Number.isFinite(v) && v > 0 ? v : 1 });
                }}
                className="h-6 w-12 rounded border border-gray-200 px-1 text-center text-xs"
              />
              <select
                value={s.delayUnit}
                onChange={(e) => updateStep(i, { delayUnit: e.target.value as any })}
                className="h-6 rounded border border-gray-200 px-1 text-xs"
              >
                <option value="minutes">{t.followups.units.minutes}</option>
                <option value="hours">{t.followups.units.hours}</option>
                <option value="days">{t.followups.units.days}</option>
              </select>
              <span className="hidden text-[10px] text-gray-400 md:inline">· {t.followups.sinceLastConvo}</span>
              <div className="ms-auto flex items-center gap-0.5">
                <button onClick={() => moveStep(i, -1)} disabled={i === 0} className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30"><ChevronUp size={12} /></button>
                <button onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30"><ChevronDown size={12} /></button>
                <button onClick={() => removeStep(i)} disabled={steps.length === 1} className="rounded p-1 text-red-500 hover:bg-red-50 disabled:opacity-30"><Trash2 size={12} /></button>
              </div>
            </div>

            {/* Blocks — single-row each, expand-on-click */}
            <div className="space-y-0.5 px-1.5 py-1">
              {s.blocks.map((b, bi) => {
                const isExpanded = expandedBlock === `${i}-${bi}`;
                const preview = b.type === 'text'
                  ? (b.content?.trim() || t.followups.captionOptional).slice(0, 80)
                  : b.mediaId ? (mediaIndex.get(b.mediaId)?.name ?? b.mediaId.slice(0, 8)) : t.followups.noMedia;
                return (
                  <div key={bi} className="rounded border border-gray-200 bg-white">
                    <button
                      type="button"
                      onClick={() => setExpandedBlock(isExpanded ? null : `${i}-${bi}`)}
                      className="group flex w-full items-center gap-2 px-1.5 py-1 text-start hover:bg-gray-50"
                    >
                      <span className={clsx('inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium', typeBadge(b.type))}>
                        {typeIcon(b.type)} {labelForType(t, b.type)}
                      </span>
                      <span className="flex-1 truncate text-[12px] text-gray-700">{preview}</span>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                        <button onClick={(e) => { e.stopPropagation(); moveBlock(i, bi, -1); }} disabled={bi === 0} className="rounded p-0.5 text-gray-400 hover:bg-gray-100 disabled:opacity-30"><ChevronUp size={11} /></button>
                        <button onClick={(e) => { e.stopPropagation(); moveBlock(i, bi, 1); }} disabled={bi === s.blocks.length - 1} className="rounded p-0.5 text-gray-400 hover:bg-gray-100 disabled:opacity-30"><ChevronDown size={11} /></button>
                        <button onClick={(e) => { e.stopPropagation(); removeBlock(i, bi); }} className="rounded p-0.5 text-red-500 hover:bg-red-50"><Trash2 size={11} /></button>
                      </div>
                      <ChevronDown size={11} className={`shrink-0 text-gray-400 transition ${isExpanded ? 'rotate-180' : ''}`} />
                    </button>
                    {isExpanded && (
                      <div className="border-t border-gray-100 p-1.5">
                        {b.type === 'text' ? (
                          <Textarea
                            rows={3}
                            value={b.content ?? ''}
                            onChange={(e) => updateBlock(i, bi, { content: e.target.value })}
                            placeholder="..."
                            autoFocus
                          />
                        ) : (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-2">
                              <Button size="sm" variant="secondary" onClick={() => setPickerFor({ stepIdx: i, blockIdx: bi })}>
                                {t.followups.pickMedia}
                              </Button>
                              <span className="text-[11px] text-gray-600">
                                {b.mediaId ? (mediaIndex.get(b.mediaId)?.name ?? b.mediaId.slice(0, 8)) : t.followups.noMedia}
                              </span>
                            </div>
                            <Input value={b.caption ?? ''} onChange={(e) => updateBlock(i, bi, { caption: e.target.value })} placeholder={t.followups.captionOptional} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Inline add-block chips */}
              <div className="flex flex-wrap gap-1 pt-0.5">
                <AddBlockBtn onClick={() => { addBlock(i, 'text');     setExpandedBlock(`${i}-${s.blocks.length}`); }}><Type size={10} /> {labelForType(t, 'text')}</AddBlockBtn>
                <AddBlockBtn onClick={() => { addBlock(i, 'image');    setExpandedBlock(`${i}-${s.blocks.length}`); }}><ImageIcon size={10} /> {labelForType(t, 'image')}</AddBlockBtn>
                <AddBlockBtn onClick={() => { addBlock(i, 'video');    setExpandedBlock(`${i}-${s.blocks.length}`); }}><Video size={10} /> {labelForType(t, 'video')}</AddBlockBtn>
                <AddBlockBtn onClick={() => { addBlock(i, 'audio');    setExpandedBlock(`${i}-${s.blocks.length}`); }}><Mic size={10} /> {labelForType(t, 'audio')}</AddBlockBtn>
                <AddBlockBtn onClick={() => { addBlock(i, 'document'); setExpandedBlock(`${i}-${s.blocks.length}`); }}><FileText size={10} /> {labelForType(t, 'document')}</AddBlockBtn>
              </div>
            </div>
          </div>
        ))}

        {/* Sticky add-step bar */}
        <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-gray-100 bg-white/95 px-4 py-2 backdrop-blur">
          <button
            onClick={addStep}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-gray-300 bg-white py-1.5 text-xs font-medium text-gray-600 hover:border-brand-400 hover:text-brand-700"
          >
            <Plus size={14} /> {t.followups.addStep}
          </button>
        </div>
      </div>

      <MediaPickerModal
        open={pickerFor !== null}
        kindFilter={pickerFor !== null ? steps[pickerFor.stepIdx]?.blocks[pickerFor.blockIdx]?.type as any : undefined}
        onClose={() => setPickerFor(null)}
        onPick={(id) => {
          if (pickerFor) updateBlock(pickerFor.stepIdx, pickerFor.blockIdx, { mediaId: id });
          setPickerFor(null);
        }}
      />
    </Modal>
  );
}

function AddBlockBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:border-brand-400 hover:text-brand-700"
    >
      <Plus size={10} /> {children}
    </button>
  );
}
function typeBadge(t: BlockType): string {
  if (t === 'text') return 'bg-gray-100 text-gray-700';
  if (t === 'image') return 'bg-blue-50 text-blue-700';
  if (t === 'video') return 'bg-purple-50 text-purple-700';
  if (t === 'audio') return 'bg-emerald-50 text-emerald-700';
  return 'bg-amber-50 text-amber-700';
}
function typeIcon(t: BlockType) {
  if (t === 'text') return <Type size={10} />;
  if (t === 'image') return <ImageIcon size={10} />;
  if (t === 'video') return <Video size={10} />;
  if (t === 'audio') return <Mic size={10} />;
  return <FileText size={10} />;
}
function labelForType(t: any, type: BlockType): string {
  return t.followups.kindLabels?.[type] ?? type;
}
