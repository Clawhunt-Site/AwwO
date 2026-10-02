import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Loader2, Square, Undo2, X } from 'lucide-react';
import './canvas-assistant.css';
import { useCanvasI18n, type CanvasTextKey, type CanvasTranslate } from './i18n';
import { getAgentTemplates } from './agentTemplates';
import { useEnterToSend } from './composerKeys';
import type { PlanProgress } from './canvasPlanning';
import type { UiLocale } from '../locale';

export interface CanvasAssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'applied' | 'error' | 'stale';
}

export interface CanvasAssistantProps {
  mode: 'welcome' | 'panel';
  messages: CanvasAssistantMessage[];
  draft: string;
  onDraftChange: (value: string) => void;
  busy: boolean;
  error?: string;
  onSend: () => void;
  onCancel: () => void;
  onClose?: () => void;
  onUndo?: () => void;
  canUndo?: boolean;
  runtimeControls?: ReactNode;
  submitLabel?: string;
  submitDisabled?: boolean;
  /** An accepted cloud request is awaiting observation; it must not become a new submission. */
  recovery?: { prompt: string; canResume: boolean; busy: boolean; onResume: () => void; onStop: () => void };
  /** Last progress the host observed for the in-flight plan; absent until the run reports. */
  progress?: PlanProgress;
  /** Seconds the last successful plan took, measured on this device; shown as an expectation. */
  expectedSeconds?: number;
}

/** The four observable steps of a plan. They advance only on events the run reported. */
const STEPS: ReadonlyArray<CanvasTextKey> = ['assistant.stepSubmit', 'assistant.stepThink', 'assistant.stepWrite', 'assistant.stepCheck'];
function stepOf(stage: PlanProgress['stage'] | undefined): number {
  if (stage === 'running' || stage === 'thinking') return 1;
  if (stage === 'streaming') return 2;
  if (stage === 'validating') return 3;
  return 0; // not yet reported, queued, or starting over after a malformed plan
}

// A stage that has lasted this long gets a line saying what the wait usually means, so the
// status never reads the same for a minute. Each is a fact about the stage, not a forecast.
const HINT_AFTER: Partial<Record<PlanProgress['stage'], { seconds: number; key: CanvasTextKey }>> = {
  queued: { seconds: 8, key: 'assistant.hintQueued' },
  running: { seconds: 15, key: 'assistant.hintRunning' },
  thinking: { seconds: 20, key: 'assistant.hintThinking' },
};
// A run that keeps reporting is progressing however long it takes; only a run that has reported
// nothing new for this long is told the wait may not end on its own.
const STALLED_AFTER_SECONDS = 30;
// Before the host reports anything, the request is only known to be in flight.
const AWAITING_AFTER_SECONDS = 4;

function formatDuration(t: CanvasTranslate, seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return whole < 60 ? t('assistant.durationSeconds', { seconds: whole })
    : t('assistant.durationMinutes', { minutes: Math.floor(whole / 60), seconds: whole % 60 });
}

function formatCount(locale: UiLocale, value: number): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** What the run is doing, in one line: the stage, and within writing, which part of the plan. */
function headline(t: CanvasTranslate, progress: PlanProgress | undefined, template: string | undefined, target: string | undefined,
  waitedSeconds: number): string {
  if (!progress) return t(waitedSeconds >= AWAITING_AFTER_SECONDS ? 'assistant.statusAwaiting' : 'assistant.statusSubmitting');
  switch (progress.stage) {
    case 'queued': return t('assistant.statusQueued');
    case 'retrying': return t('assistant.statusRetrying');
    case 'running': return t('assistant.statusRunning');
    case 'thinking': return t('assistant.statusThinking');
    case 'validating': return t('assistant.statusValidating');
    case 'streaming': return writingHeadline(t, progress, template, target);
  }
}

/** Within writing: the operation the plan is on, and the node it concerns when the host could name
 * it. A host that reports no operation leaves the order plans are written in: nodes, then connections. */
function writingHeadline(t: CanvasTranslate, progress: PlanProgress, template: string | undefined, target: string | undefined): string {
  const node = () => template ? t('assistant.statusPlanningNodeAs', { count: progress.nodes, template })
    : t('assistant.statusPlanningNode', { count: progress.nodes });
  const about = (plain: CanvasTextKey, named: CanvasTextKey) => target ? t(named, { template: target }) : t(plain);
  switch (progress.operation) {
    case 'add_node': return progress.nodes > 0 ? node() : t('assistant.statusWriting');
    case 'set_input': return about('assistant.statusFillingInputs', 'assistant.statusFillingInputsAs');
    case 'update_node': return about('assistant.statusUpdatingNode', 'assistant.statusUpdatingNodeAs');
    case 'add_field': case 'update_field': case 'remove_field': return about('assistant.statusEditingFields', 'assistant.statusEditingFieldsAs');
    case 'remove_node': return about('assistant.statusRemovingNode', 'assistant.statusRemovingNodeAs');
    case 'connect': return t('assistant.statusConnecting');
    case 'disconnect': case 'set_edge_kind': return t('assistant.statusRewiring');
    case 'set_execution': return t('assistant.statusSettingExecution');
    case undefined:
      // Connections are declared after the nodes they join, so they are the later part of a plan.
      if (progress.edges > 0) return t('assistant.statusConnecting');
      return progress.nodes > 0 ? node() : t('assistant.statusWriting');
  }
}

/** Everything the run has reported, so a change in any of it counts as progress. */
function progressSignature(progress: PlanProgress | undefined): string {
  if (!progress) return 'awaiting';
  const { stage, characters, reasoning, nodes, edges, template, operation, target, attempt } = progress;
  return [stage, characters, reasoning, nodes, edges, template ?? '', operation ?? '', target ?? '', attempt].join('|');
}

/** Presentation only: the host owns requests, applying changes, drafts and undo history. */
export function CanvasAssistant({ mode, messages, draft, onDraftChange, busy, error, onSend, onCancel,
  onClose, onUndo, canUndo = false, runtimeControls, progress, expectedSeconds, submitLabel, submitDisabled = false, recovery }: CanvasAssistantProps) {
  const { locale, t } = useCanvasI18n();
  const examples = [t('assistant.exampleSaas'), t('assistant.exampleData'), t('assistant.exampleContent')];
  const welcome = mode === 'welcome';
  const sendLabel = submitLabel || t(welcome ? 'assistant.generate' : 'assistant.modify');
  const errorId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const canSend = !busy && !recovery && !submitDisabled && Boolean(draft.trim());
  const lastMessage = messages.at(-1);
  const duplicateLastError = lastMessage?.role === 'assistant' && lastMessage.status === 'error' && lastMessage.content === error;
  useEffect(() => {
    // Scroll only the conversation region, never the surrounding canvas or page.
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages.length, lastMessage?.content, lastMessage?.status, busy]);

  // Elapsed time is the one progress fact available even before the run emits anything, so a
  // silent model is still visibly alive. It is measured from this request, never accumulated.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startedAt = useRef(0);
  useEffect(() => {
    if (!busy) { setElapsedSeconds(0); return; }
    startedAt.current = Date.now();
    setElapsedSeconds(0);
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  // How long the current stage has lasted, so a hint follows the stage rather than the request.
  // Taken when the stage changes, in the same render, so a new stage never inherits a hint.
  const stage = busy ? progress?.stage : undefined;
  const stageStartedAt = useMemo(() => Date.now(), [stage, busy]);
  const stageSeconds = busy ? Math.max(0, Math.floor((Date.now() - stageStartedAt) / 1000)) : 0;
  // How long since the run last reported anything new, taken the same way.
  const signature = busy ? progressSignature(progress) : 'idle';
  const changedAt = useMemo(() => Date.now(), [signature]);
  const quietSeconds = busy ? Math.max(0, Math.floor((Date.now() - changedAt) / 1000)) : 0;

  const send = () => { if (canSend) onSend(); };
  const composerKeys = useEnterToSend(send);

  let status: ReactNode = null;
  if (busy) {
    const step = stepOf(progress?.stage);
    const titleOf = (id: string | undefined) => id ? getAgentTemplates(locale).find(item => item.id === id)?.title : undefined;
    const template = titleOf(progress?.template);
    const target = titleOf(progress?.target);
    const facts = [formatDuration(t, elapsedSeconds)];
    if (progress?.stage === 'thinking' && progress.reasoning > 0) facts.push(t('assistant.factReasoning', { count: formatCount(locale, progress.reasoning) }));
    if (progress && progress.nodes > 0) facts.push(t('assistant.factNodes', { count: progress.nodes }));
    if (progress && progress.edges > 0) facts.push(t('assistant.factEdges', { count: progress.edges }));
    if (progress && progress.characters > 0) facts.push(t('assistant.factCharacters', { count: formatCount(locale, progress.characters) }));
    if (progress && progress.attempt > 1) facts.push(t('assistant.factAttempt', { count: progress.attempt }));
    if (expectedSeconds) facts.push(t('assistant.factExpected', { duration: formatDuration(t, expectedSeconds) }));
    // A queue wait is not a stall (its own hint explains it), and a plan being checked is moments from done.
    const stalled = quietSeconds >= STALLED_AFTER_SECONDS && progress?.stage !== 'queued' && progress?.stage !== 'validating';
    const hint = stalled ? t('assistant.hintStalled', { duration: formatDuration(t, quietSeconds) })
      : (() => { const rule = progress ? HINT_AFTER[progress.stage] : undefined; return rule && stageSeconds >= rule.seconds ? t(rule.key) : ''; })();
    status = <div className="awwo-assistant-status" role="status" aria-label={t('assistant.progressDetail')}>
      <p className="awwo-assistant-status-headline">
        <Loader2 size={14} aria-hidden="true" />
        <span>{headline(t, progress, template, target, elapsedSeconds)}</span>
      </p>
      {/* The clock ticks every second; it is left to the headline and step to be announced. */}
      <p className="awwo-assistant-status-meta" aria-hidden="true">
        <span className="awwo-assistant-status-dot" />
        <span className="awwo-assistant-status-facts">{facts.join(' · ')}</span>
        {hint ? <span className="awwo-assistant-status-hint">{hint}</span> : null}
      </p>
      <div className="awwo-assistant-steps" role="progressbar" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={step}
        aria-valuetext={t('assistant.progressStep', { step: step + 1, total: STEPS.length, name: t(STEPS[step]) })}>
        {STEPS.map((label, index) => <span key={label} className={`awwo-assistant-step ${index < step ? 'is-done' : index === step ? 'is-active' : ''}`}>
          <i aria-hidden="true" /><span>{t(label)}</span>
        </span>)}
      </div>
    </div>;
  }

  return <section className={`awwo-canvas-assistant awwo-canvas-assistant--${mode}`} aria-label={t('assistant.panelTitle')}>
    <header className="awwo-assistant-header">
      {welcome ? <h1>{t('assistant.title')}</h1> : <h2>{t('assistant.panelTitle')}</h2>}
      {!welcome && onClose ? <button type="button" className="awwo-assistant-icon-button" aria-label={t('assistant.close')} onClick={onClose}>
        <X size={17} aria-hidden="true" />
      </button> : null}
    </header>

    {(!welcome || messages.length > 0) && <div ref={log} className="awwo-assistant-messages" role="log" aria-label={t('assistant.conversation')} aria-live="polite" aria-relevant="additions text">
      {messages.length ? <ol>
        {messages.filter(message => !(duplicateLastError && message === lastMessage)).map(message => <li className={`awwo-assistant-message awwo-assistant-message--${message.role}`} key={message.id}>
          <p role={message.status === 'error' ? 'alert' : undefined}>{message.content}</p>
          {message.status === 'applied' ? <span className="awwo-assistant-message-status" role="status">{t('assistant.applied')}</span>
            : message.status === 'stale' ? <span className="awwo-assistant-message-status is-stale" role="alert">{t('assistant.stale')}</span> : null}
        </li>)}
      </ol> : <p className="awwo-assistant-empty">{t('assistant.empty')}</p>}
    </div>}

    <div className="awwo-assistant-composer-block">
      {error ? <p className="awwo-assistant-error" role="alert" id={errorId}>{error}</p> : null}
      {recovery ? <div className="awwo-assistant-recovery" role="group" aria-label={t('assistant.recoveryTitle')}>
        <p>{t('assistant.recoveryTitle')}</p>
        <p className="awwo-assistant-recovery-prompt">{recovery.prompt}</p>
        <p>{t(recovery.canResume ? 'assistant.recoveryHint' : 'assistant.recoveryChanged')}</p>
        <div className="awwo-assistant-composer-actions">
          <button type="button" className="awwo-assistant-cancel" disabled={busy || recovery.busy} onClick={recovery.onStop}>{t('assistant.recoveryStop')}</button>
          <button type="button" className="awwo-assistant-send" disabled={busy || recovery.busy || !recovery.canResume} onClick={recovery.onResume}>{t('assistant.recoveryResume')}</button>
        </div>
      </div> : null}
      {runtimeControls ? <div className="awwo-assistant-runtime">{runtimeControls}</div> : null}
      <form className="awwo-assistant-composer" aria-label={t('assistant.form')} onSubmit={event => { event.preventDefault(); send(); }}>
        <textarea ref={input} aria-label={t('assistant.input')} aria-describedby={error ? errorId : undefined}
          placeholder={t(welcome ? 'assistant.welcomePlaceholder' : 'assistant.panelPlaceholder')}
          value={draft} disabled={busy} rows={3} maxLength={8000}
          onChange={event => onDraftChange(event.target.value)} {...composerKeys} />
        {status}
        <div className="awwo-assistant-composer-actions">
          {busy ? <button type="button" className="awwo-assistant-cancel" onClick={onCancel}><Square size={12} aria-hidden="true" />{t('assistant.cancel')}</button> : null}
          <button type="submit" className="awwo-assistant-send" disabled={!canSend}><span>{sendLabel}</span><ArrowUp size={15} aria-hidden="true" /></button>
        </div>
      </form>
      {onUndo ? <button type="button" className="awwo-assistant-undo" disabled={busy || !canUndo} onClick={onUndo}>
        <Undo2 size={14} aria-hidden="true" />{t('assistant.undo')}
      </button> : null}
    </div>

    {welcome && !recovery ? <div className="awwo-assistant-examples" role="group" aria-label={t('assistant.examples')}>
      {examples.map(example => <button type="button" key={example} disabled={busy}
        onClick={() => { onDraftChange(example); input.current?.focus(); }}>{example}</button>)}
    </div> : null}
  </section>;
}
