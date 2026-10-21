import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Loader2, Square, Undo2, X } from 'lucide-react';
import './canvas-assistant.css';
import { useCanvasI18n, type CanvasTextKey, type CanvasTranslate } from './i18n';
import { getAgentTemplates } from './agentTemplates';
import { useEnterToSend } from './composerKeys';
import type { PlanProgress } from './canvasPlanning';
import type { AssistantPending, AssistantPendingPhase, AssistantRoute } from './assistantRouting';
import type { UiLocale } from '../locale';
import { AttachButton, AttachmentTray, MessageWithAttachments, useComposerAttachments } from './ComposerAttachments';
import { ComposerNotes } from './ComposerNotes';

export interface CanvasAssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'applied' | 'error' | 'stale' | 'unconfirmed';
  route?: AssistantRoute;
  taskId?: string;
}

/** A host that can also do tasks: one conversation whose messages the server routes (assistantRouting.ts). */
export interface UnifiedAssistant {
  /** A message being handled before it joins the conversation: routed, becoming a task, or waiting for the task it
   *  replaces to stop. */
  pending?: AssistantPending;
  renderTask: (taskId: string) => ReactNode;
  /** Earlier tasks of this canvas the conversation does not mention, at its top. */
  earlier?: ReactNode;
  /** Above the composer: the task service's notices. */
  notices?: ReactNode;
  /** In the composer's toolbar, beside the attach button: the model (and effort) a direct task uses. */
  settings?: ReactNode;
  /** How messages are handled while one way is closed. */
  notice?: string;
  /** Viewing only: the conversation and its tasks, without a composer. */
  readOnly?: boolean;
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
  /** A host that can also do tasks (the hosted app): there is no mode to pick, the server routes each message. */
  unified?: UnifiedAssistant;
  /** What to do next, offered without being asked: the host works it out from the canvas (nextSteps.ts) and acts on
   *  a choice itself. Shown above the composer while nothing is being handled. */
  nextSteps?: AssistantNextSteps;
  /** In 用户须知: what a message costs where calls are counted, and which questions cost nothing. */
  costNote?: string;
  /** Whether the box takes back the focus a message's wait dropped once the message is done (by default it does). False
   *  where the host does that itself: the canvas hands it back to its side panel only where the reader stayed with it. */
  focusBack?: boolean;
}

export interface AssistantNextAction {
  id: string;
  label: string;
  /** The accessible name when the visible label is short and repeats across items ("Fill in"). */
  ariaLabel?: string;
  /** The one step the situation most calls for, drawn as the main button. */
  primary?: boolean;
  /** A link instead of a button (it opens in a new tab); onSelect may still record the choice. */
  href?: string;
  onSelect?: () => void;
}
/** One line of a checklist: what it is about, what it still needs, and the step that settles it. */
export interface AssistantNextItem { id: string; title: string; detail: string; action?: AssistantNextAction }
export interface AssistantNextSteps {
  lead: string;
  actions: ReadonlyArray<AssistantNextAction>;
  /** Everything the canvas still needs from the reader, each settled by its own step. */
  items?: ReadonlyArray<AssistantNextItem>;
  /** After the items: what follows once they are done. */
  footnote?: string;
  /** That working this out cost nothing (the hosted app counts calls): said in 用户须知, not on the card. */
  note?: string;
}

// What a message being handled is waiting for, said in the composer.
const PENDING_HEADLINE: Record<AssistantPendingPhase, CanvasTextKey> = {
  routing: 'assistant.routing', starting: 'assistant.starting', stopping: 'assistant.stopping',
};

/** The four observable steps of a plan. They advance only on events the run reported. */
const STEPS: ReadonlyArray<CanvasTextKey> = ['assistant.stepSubmit', 'assistant.stepThink', 'assistant.stepWrite', 'assistant.stepCheck'];
function stepOf(stage: PlanProgress['stage'] | undefined): number {
  if (stage === 'running' || stage === 'thinking') return 1;
  if (stage === 'streaming') return 2;
  if (stage === 'validating') return 3;
  return 0; // not yet reported, queued, or starting over after a malformed plan
}

/** The four steps as a bar, the one under way marked: in the composer, whose status names it, and on the stage
 *  (StageActivity.tsx), which gives it its own `label`. */
export function PlanSteps({ stage, label }: { stage: PlanProgress['stage'] | undefined; label?: string }) {
  const { t } = useCanvasI18n();
  const step = stepOf(stage);
  return <div className="awwo-assistant-steps" role="progressbar" {...(label ? { 'aria-label': label } : {})} aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={step}
    aria-valuetext={t('assistant.progressStep', { step: step + 1, total: STEPS.length, name: t(STEPS[step]) })}>
    {STEPS.map((label, index) => <span key={label} className={`awwo-assistant-step ${index < step ? 'is-done' : index === step ? 'is-active' : ''}`}>
      <i aria-hidden="true" /><span>{t(label)}</span>
    </span>)}
  </div>;
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
    case 'retrying': return t(progress.retry === 'provider' ? 'assistant.statusRetryingProvider' : 'assistant.statusRetrying');
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
    case 'set_task': return about('assistant.statusSettingTask', 'assistant.statusSettingTaskAs');
    case 'set_model': return about('assistant.statusSettingModel', 'assistant.statusSettingModelAs');
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
  const { stage, characters, reasoning, nodes, edges, template, operation, target, attempt, retry } = progress;
  return [stage, characters, reasoning, nodes, edges, template ?? '', operation ?? '', target ?? '', attempt, retry ?? ''].join('|');
}

/** A next step's control: a link opens beside the canvas (the plans page), anything else is a button. */
function nextActionControl(action: AssistantNextAction): ReactNode {
  return action.href
    ? <a key={action.id} className={action.primary ? 'is-primary' : undefined} href={action.href} target="_blank" rel="noopener noreferrer"
      aria-label={action.ariaLabel} onClick={() => action.onSelect?.()}>{action.label}</a>
    : <button key={action.id} type="button" className={action.primary ? 'is-primary' : undefined} aria-label={action.ariaLabel}
      onClick={() => action.onSelect?.()}>{action.label}</button>;
}

/** Presentation only: the host owns requests, applying changes, drafts and undo history. */
export function CanvasAssistant({ mode, messages, draft, onDraftChange, busy, error, onSend, onCancel,
  onClose, onUndo, canUndo = false, runtimeControls, progress, expectedSeconds, submitLabel, submitDisabled = false, recovery, unified, nextSteps, costNote,
  focusBack = true }: CanvasAssistantProps) {
  const { locale, t } = useCanvasI18n();
  const examples = [t('assistant.exampleSaas'), t('assistant.exampleData'), t('assistant.exampleContent')];
  const welcome = mode === 'welcome';
  const pending = unified?.pending;
  const routing = Boolean(pending);
  const sendLabel = submitLabel || t(unified ? 'assistant.send' : welcome ? 'assistant.generate' : 'assistant.modify');
  const errorId = useId();
  const disclaimerId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const canSend = !busy && !routing && !recovery && !submitDisabled && Boolean(draft.trim());
  const waitingForReply = busy || routing;
  const attach = useComposerAttachments({ value: draft, onChange: onDraftChange, disabled: waitingForReply || Boolean(unified?.readOnly) });
  // The request itself is bounded at 8 000 characters, file lines included.
  const bodyLimit = Math.max(0, 8000 - (draft.length - attach.body.length));
  const lastMessage = messages.at(-1);
  const duplicateLastError = lastMessage?.role === 'assistant' && lastMessage.status === 'error' && lastMessage.content === error;
  useEffect(() => {
    // Scroll only the conversation region, never the surrounding canvas or page.
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages.length, lastMessage?.content, lastMessage?.status, busy, routing]);

  // Elapsed time is the one progress fact available even before the run emits anything, so a
  // silent model is still visibly alive. It is measured from this request, never accumulated.
  // Deciding how to handle a message is part of the same request.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startedAt = useRef(0);
  const waiting = busy || routing;
  useEffect(() => {
    if (!waiting) { setElapsedSeconds(0); return; }
    startedAt.current = Date.now();
    setElapsedSeconds(0);
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  // The box is disabled while a message is handled, which drops the focus; it comes back to the box after, unless the
  // host hands it back itself (focusBack).
  const wasWaiting = useRef(waiting);
  useEffect(() => {
    if (focusBack && wasWaiting.current && !waiting && (!document.activeElement || document.activeElement === document.body)) input.current?.focus();
    wasWaiting.current = waiting;
  }, [waiting, focusBack]);
  // How long the current stage has lasted, so a hint follows the stage rather than the request.
  // Taken when the stage changes, in the same render, so a new stage never inherits a hint.
  const stage = busy ? progress?.stage : undefined;
  const stageStartedAt = useMemo(() => Date.now(), [stage, busy]);
  const stageSeconds = busy ? Math.max(0, Math.floor((Date.now() - stageStartedAt) / 1000)) : 0;
  // How long since the run last reported anything new, taken the same way.
  const signature = busy ? progressSignature(progress) : 'idle';
  const changedAt = useMemo(() => Date.now(), [signature]);
  const quietSeconds = busy ? Math.max(0, Math.floor((Date.now() - changedAt) / 1000)) : 0;

  const send = () => { if (canSend && !attach.busy) { attach.markSent(); onSend(); } };
  const composerKeys = useEnterToSend(send);
  // Like a chat app's box, nothing is printed around it (owner request 2026-10-12): the standing notices are in
  // 用户须知, the model sits in the toolbar, and undo is an icon in the panel's header (in the toolbar on the welcome).
  const notes = [t('composer.disclaimerFull'), costNote, nextSteps?.note ? t('assistant.notesNextFree') : undefined];
  const undoButton = onUndo && !unified?.readOnly ? <button type="button" className="awwo-assistant-icon-button awwo-assistant-undo"
    disabled={waiting || !canUndo} aria-label={t('assistant.undo')} title={t('assistant.undo')} onClick={onUndo}>
    <Undo2 size={16} aria-hidden="true" />
  </button> : null;

  let status: ReactNode = null;
  if (pending && !busy) {
    status = <div className="awwo-assistant-status" role="status">
      <p className="awwo-assistant-status-headline"><Loader2 size={14} aria-hidden="true" /><span>{t(PENDING_HEADLINE[pending.phase])}</span></p>
      <p className="awwo-assistant-status-meta" aria-hidden="true">
        <span className="awwo-assistant-status-dot" />
        <span className="awwo-assistant-status-facts">{formatDuration(t, elapsedSeconds)}</span>
      </p>
    </div>;
  } else if (busy) {
    // A media node is named by what it makes (图像生成, 视频生成, 3D 模型生成), like the add menu.
    const mediaTitles: Record<string, string> = { image: t('node.addImage'), video: t('node.addVideo'), model3d: t('node.addModel3d'), audio: t('node.addAudio') };
    const titleOf = (id: string | undefined) => id ? mediaTitles[id] ?? getAgentTemplates(locale).find(item => item.id === id)?.title : undefined;
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
      <PlanSteps stage={progress?.stage} />
    </div>;
  }

  const shown = messages.filter(message => !(duplicateLastError && message === lastMessage));
  return <section className={`awwo-canvas-assistant awwo-canvas-assistant--${mode}`} aria-label={t('assistant.panelTitle')}>
    <header className="awwo-assistant-header">
      {welcome ? <h1>{t('assistant.title')}</h1> : <h2>{t('assistant.panelTitle')}</h2>}
      {!welcome && (undoButton || onClose) ? <div className="awwo-assistant-header-actions">
        {undoButton}
        {onClose ? <button type="button" className="awwo-assistant-icon-button" aria-label={t('assistant.close')} onClick={onClose}>
          <X size={17} aria-hidden="true" />
        </button> : null}
      </div> : null}
    </header>

    {(!welcome || messages.length > 0 || pending) && <div ref={log} className="awwo-assistant-messages" role="log" aria-label={t('assistant.conversation')} aria-live="polite" aria-relevant="additions text">
      {unified?.earlier}
      {shown.length || pending ? <ol>
        {shown.map(message => <li className={`awwo-assistant-message awwo-assistant-message--${message.role}${message.taskId ? ' awwo-execution-card' : ''}`} key={message.id}>
          {/* How the server handled the request: said on each reply, never asked of the user beforehand. A plan reply
              that changed nothing (an answer, a question back, every step skipped) says the canvas is as it was. */}
          {unified && message.role === 'assistant' && message.route ? <span className={`awwo-assistant-route is-${message.route}`}>
            {t(message.route === 'execute' ? 'assistant.routeExecute' : message.status ? 'assistant.routePlan' : 'assistant.routeReply')}</span> : null}
          {message.taskId && unified ? unified.renderTask(message.taskId)
            : message.role === 'user' ? <MessageWithAttachments text={message.content} />
            : <p role={message.status === 'error' ? 'alert' : undefined}>{message.content}</p>}
          {message.status === 'applied' ? <span className="awwo-assistant-message-status" role="status">{t('assistant.applied')}</span>
            : message.status === 'stale' ? <span className="awwo-assistant-message-status is-stale" role="alert">{t('assistant.stale')}</span> : null}
        </li>)}
        {pending ? <li className="awwo-assistant-message awwo-assistant-message--user is-pending"><MessageWithAttachments text={pending.prompt} /></li> : null}
      {/* A viewer sends nothing, so it is the host's task list that says whether there is anything to see. */}
      </ol> : unified?.readOnly ? null : <p className="awwo-assistant-empty">{t(unified ? 'assistant.unifiedEmpty' : 'assistant.empty')}</p>}
    </div>}

    {unified?.readOnly ? <div className="awwo-assistant-composer-block"><p className="awwo-assistant-readonly">{t('assistant.readOnlyTasks')}</p></div> : <>
    <div className="awwo-assistant-composer-block">
      {error ? <p className="awwo-assistant-error" role="alert" id={errorId}>{error}</p> : null}
      {recovery ? <div className="awwo-assistant-recovery" role="group" aria-label={t('assistant.recoveryTitle')}>
        <p>{t('assistant.recoveryTitle')}</p>
        <div className="awwo-assistant-recovery-prompt"><MessageWithAttachments text={recovery.prompt} /></div>
        <p>{t(recovery.canResume ? 'assistant.recoveryHint' : 'assistant.recoveryChanged')}</p>
        <div className="awwo-assistant-composer-actions">
          <button type="button" className="awwo-assistant-cancel" disabled={busy || routing || recovery.busy} onClick={recovery.onStop}>{t('assistant.recoveryStop')}</button>
          <button type="button" className="awwo-assistant-send" disabled={busy || routing || recovery.busy || !recovery.canResume} onClick={recovery.onResume}>{t('assistant.recoveryResume')}</button>
        </div>
      </div> : null}
      {runtimeControls ? <div className="awwo-assistant-runtime">{runtimeControls}</div> : null}
      {unified?.notice ? <p className="awwo-assistant-route-notice" role="status">{unified.notice}</p> : null}
      {unified?.notices}
      {/* Offered unasked once the canvas has something to do next, and never while a message or a plan is handled. */}
      {nextSteps && (nextSteps.actions.length > 0 || (nextSteps.items?.length ?? 0) > 0) && !welcome && !waiting && !recovery ? <div className="awwo-assistant-next" role="group" aria-label={t('assistant.nextTitle')}>
        <p><strong>{t('assistant.nextTitle')}</strong><span>{nextSteps.lead}</span></p>
        {nextSteps.items?.length ? <ul className="awwo-assistant-next-items">
          {nextSteps.items.map(item => <li key={item.id}>
            <span className="awwo-assistant-next-item-title">{item.title}</span>
            <span className="awwo-assistant-next-item-detail">{item.detail}</span>
            {item.action ? nextActionControl(item.action) : null}
          </li>)}
        </ul> : null}
        {nextSteps.footnote ? <p className="awwo-assistant-next-footnote">{nextSteps.footnote}</p> : null}
        {nextSteps.actions.length ? <div className="awwo-assistant-next-actions">{nextSteps.actions.map(nextActionControl)}</div> : null}
      </div> : null}
      <form className={`awwo-assistant-composer${attach.dragging ? ' is-dropping' : ''}`} aria-label={t('assistant.form')} onSubmit={event => { event.preventDefault(); send(); }} {...attach.dropProps}>
        <AttachmentTray state={attach} disabled={waiting} />
        <textarea ref={input} aria-label={t('assistant.input')} aria-describedby={error ? errorId : disclaimerId}
          placeholder={t(unified ? (welcome ? 'assistant.unifiedWelcomePlaceholder' : 'assistant.unifiedPlaceholder')
            : welcome ? 'assistant.welcomePlaceholder' : 'assistant.panelPlaceholder')}
          value={attach.body} disabled={waiting} rows={welcome ? 3 : 2} maxLength={bodyLimit}
          onChange={event => attach.setBody(event.target.value)} onPaste={attach.onPaste} {...composerKeys} />
        {status}
        {/* One toolbar, as in a chat app: files and the model on the left; 用户须知, stop and send on the right. */}
        <div className="awwo-assistant-composer-actions">
          <div className="awwo-assistant-composer-tools">
            <AttachButton state={attach} className="awwo-assistant-attach" />
            {unified?.settings}
            {welcome && canUndo ? undoButton : null}
          </div>
          <div className="awwo-assistant-composer-submit">
            <ComposerNotes notes={notes} />
            {busy || pending?.phase === 'routing' ? <button type="button" className="awwo-assistant-cancel" title={t('assistant.cancel')} onClick={onCancel}>
              <Square size={11} aria-hidden="true" /><span>{t('assistant.cancel')}</span></button> : null}
            <button type="submit" className="awwo-assistant-send" disabled={!canSend || attach.busy} title={attach.busy ? t('attach.waiting') : sendLabel}>
              <span>{sendLabel}</span><ArrowUp size={16} aria-hidden="true" /></button>
          </div>
        </div>
      </form>
      {/* The notice the box used to print under it, still the box's description for a screen reader. */}
      <p id={disclaimerId} className="sr-only">{t('composer.disclaimerFull')}</p>
    </div>

    {/* An example takes the words' place through the box, which keeps its files: one that has just landed too. */}
    {welcome && !recovery ? <div className="awwo-assistant-examples" role="group" aria-label={t('assistant.examples')}>
      {examples.map(example => <button type="button" key={example} disabled={waiting}
        onClick={() => { attach.setBody(example); input.current?.focus(); }}>{example}</button>)}
    </div> : null}
    </>}
  </section>;
}
