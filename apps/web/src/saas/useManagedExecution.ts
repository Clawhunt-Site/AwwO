// The canvas assistant's tasks: a message the server routes to execution runs in a restricted workspace through
// the managed execution service. This hook owns their state; AssistantExecution draws it into the assistant's
// conversation. It keeps the rules the execution panel had: every request is bounded, a running task is polled
// (never streamed) while the conversation is on screen, an unknown submission or response is reconciled with
// its original operation id instead of being sent again, and requests are answered only by an explicit choice.
// Nothing loads until the canvas activates it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { TaskStartUnconfirmed } from '../canvas/assistantRouting';
import { SaaSApiError, saasErrorMessage } from './api';
import { canvasKnowledgeRevisionIds, subscribeCanvasKnowledge } from './canvasBridge';
import { createKnowledgeSource } from './knowledgeApi';
import { useSaaSPreferences } from './preferences';
import { cancelExecutionRun, createExecutionRun, executionArtifactURL, executionTerminal, readExecutionRun, readExecutionRuns, readExecutionRuntime,
  respondToExecutionRun, type ExecutionApproval, type ExecutionArtifact, type ExecutionInput, type ExecutionModel,
  type ExecutionResponseInput, type ExecutionRun, type ExecutionRuns, type ExecutionRuntime } from './managedExecutionApi';

export const executionModelKey = (runtime: string, model: string) => JSON.stringify([runtime, model]);
/** An agent's file name without control or direction characters, so it reads (and is saved) as what it is:
 *  "invoice\u202Egpj.exe" would otherwise display as "invoiceexe.jpg". */
export const executionFileName = (name: string) => name.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') || 'file';
export const executionResponseKey = (runId: string, requestId: string) => JSON.stringify([runId, requestId]);
const newOperationId = () => `execution-${crypto.randomUUID()}`;

// A submission whose outcome is unknown waits here for its reconcile, written before it is sent: a reload, or leaving
// while it is in flight, keeps its identity, so it can still be reconciled and never be sent a second time. The key
// is the account's and this canvas's, in the canvas storage's own namespace.
const PENDING_KEY = 'awwo.execution.pending-submission.v1';
const pendingKey = (userId: string, tenantId: string, canvasId: string) =>
  `awwo.saas:${[userId, tenantId, canvasId].map(encodeURIComponent).join(':')}:${PENDING_KEY}`;
function readPending(key: string | null): ExecutionInput | null {
  if (!key) return null;
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null') as Partial<ExecutionInput> | null;
    const valid = raw && typeof raw === 'object' && typeof raw.prompt === 'string' && raw.prompt.trim() !== ''
      && typeof raw.runtime === 'string' && typeof raw.model === 'string' && typeof raw.operationId === 'string'
      && /^execution-[0-9a-f-]{36}$/.test(raw.operationId) && (raw.effort === undefined || typeof raw.effort === 'string')
      && (raw.knowledgeRevisionIds === undefined || (Array.isArray(raw.knowledgeRevisionIds) && raw.knowledgeRevisionIds.every(id => typeof id === 'string')));
    return valid ? raw as ExecutionInput : null;
  } catch { return null; }
}
/** Stores the submission unless another one waits under the key (another tab's): false then, and nothing changes. */
function claimPending(key: string | null, input: ExecutionInput): boolean {
  if (!key) return true;
  const waiting = readPending(key);
  if (waiting && waiting.operationId !== input.operationId) return false;
  try { localStorage.setItem(key, JSON.stringify(input)); }
  catch { /* The submission stays unconfirmed in this page's memory only. */ }
  return true;
}
/** Removes the stored submission only if it is this one: another tab's stays. */
function releasePending(key: string | null, operationId: string) {
  if (!key) return;
  try { if (readPending(key)?.operationId === operationId) localStorage.removeItem(key); }
  catch { /* Nothing to remove. */ }
}
// The refusals the service gives only after it has looked a submission's identity up and found no task under it
// (createRun, past its operation lookup): a reconcile refused with one of these proves the start never happened. A
// lost session, access, a body or plan check made before the lookup says nothing about the first send.
const NEVER_STARTED = new Set(['quota_exceeded', 'plan_busy', 'computer_model_unsupported', 'context_limit', 'invalid_task_frame',
  'invalid_team', 'node_setup_required', 'computer_owner_required', 'model_unavailable', 'model_not_allowed', 'runtime_unavailable',
  'personal_engine_required', 'effort_unsupported', 'invalid_node_setup', 'invalid_knowledge', 'knowledge_context_limit']);
// Anything but a definite client error may have reached the service, so its outcome is unknown.
const isUncertain = (error: unknown) => !(error instanceof SaaSApiError) || error.status >= 500 || [408, 409].includes(error.status);
const PROMPT_BYTES = 32768;
const ANSWER_BYTES = 8192;
const POLL_READS = 120;
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 3000);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** The chosen model, or the earlier choice the catalogue no longer offers (kept, never silently replaced). */
export interface ExecutionModelChoice { key: string; model?: ExecutionModel; unavailableLabel?: string }

export interface ManagedExecution {
  activated: boolean;
  activate: () => void;
  /** The conversation is on screen; a task is read only while it is (set by the view). */
  setVisible: (visible: boolean) => void;
  readOnly: boolean;
  loading: boolean;
  runtime: ExecutionRuntime | null;
  /** The workspace can run a task now. */
  ready: boolean;
  /** Why it cannot, in the reader's language, when the service says. */
  serviceReason?: string;
  needsModel: boolean;
  choice: ExecutionModelChoice;
  chooseModel: (key: string) => void;
  effort: string;
  setEffort: (effort: string) => void;
  knowledgeCount: number;
  history: ExecutionRuns;
  /** The canvas's task list could not be read; refreshAll reads it again. */
  historyFailed: boolean;
  /** The task the last reconcile confirmed, with the submission it was. */
  confirmedTask: { taskId: string; operationId: string } | null;
  /** The last waiting submission settled with no task, and why: a reconcile the service refused in a way that proves
   *  the start never happened, or the submission given up here (`givenUp`). */
  startRefusal: { reason: string; at: number; operationId: string; givenUp?: boolean } | null;
  /** Gives the waiting submission up without knowing its outcome (settled as `startRefusal`). */
  discardPending: () => void;
  selectedId: string;
  select: (id: string) => void;
  /** The selected task's detail, once read. */
  run: ExecutionRun | null;
  detailLoading: boolean;
  pollingPaused: boolean;
  refreshDetail: () => void;
  refreshAll: () => void;
  busy: boolean;
  error: unknown;
  clearError: () => void;
  notice: string;
  noticeWarning: boolean;
  pendingSubmission: ExecutionInput | null;
  /** Why a task cannot start now, if it cannot (the service, the model, the read-only view, an unconfirmed submission). */
  startBlockedReason?: string;
  /** Starts a task with this text under the submission identity the caller names (its conversation keeps it):
   *  resolves with the task's id, rejects with the error to show. An unconfirmed outcome is kept as the pending
   *  submission, reconciled by `reconcile` and never sent again on its own. */
  start: (prompt: string, operationId?: string) => Promise<string>;
  /** Sends the pending submission again with its original operation id. */
  reconcile: () => void;
  /** Stops a task this user started: resolves once the stop is confirmed or the task had ended. */
  stopTask: (taskId: string) => Promise<void>;
  /** Whether a task of this canvas has ended, as last read. */
  finished: (taskId: string) => boolean;
  answers: Record<string, string>;
  setAnswer: (key: string, value: string) => void;
  uncertainResponses: Record<string, ExecutionResponseInput>;
  respond: (approval: ExecutionApproval, behavior: 'allow' | 'deny', retry?: ExecutionResponseInput) => void;
  stop: () => void;
  preview: { run: string; artifact: string } | null;
  togglePreview: (runId: string, artifactId: string) => void;
  pendingImport: ExecutionArtifact | null;
  importTitle: string;
  setImportTitle: (title: string) => void;
  startImport: (artifact: ExecutionArtifact) => void;
  cancelImport: () => void;
  importArtifact: () => void;
  /** Where a delivered file downloads from. */
  artifactURL: (artifactId: string) => string;
}

export function useManagedExecution(tenantId: string, canvasId: string, { readOnly = false, userId }: { readOnly?: boolean; userId?: string } = {}): ManagedExecution {
  const { t, locale } = useSaaSPreferences();
  const scope = `${tenantId}/${canvasId}`;
  const [activatedScope, setActivatedScope] = useState('');
  const [visible, setShown] = useState(false);
  // Showing the conversation again reads the service and the history again, so a task another member started
  // appears; the first showing is covered by the activation's own read.
  const shownBefore = useRef(false);
  const activatedNow = useRef(false);
  const setVisible = useCallback((value: boolean) => {
    setShown(value);
    if (!value) return;
    if (shownBefore.current && activatedNow.current) setCatalogueRevision(revision => revision + 1);
    shownBefore.current = true;
  }, []);
  const activated = activatedScope === scope;
  activatedNow.current = activated;
  const [runtime, setRuntime] = useState<ExecutionRuntime | null>(null);
  // The catalogue last read, so a chosen model it later drops keeps its name.
  const runtimeRef = useRef<ExecutionRuntime | null>(null);
  const [history, setHistory] = useState<ExecutionRuns>({ items: [] });
  const [historyFailed, setHistoryFailed] = useState(false);
  // The task the last reconcile confirmed: the canvas gives it the request it recorded as unconfirmed.
  const [confirmedTask, setConfirmedTask] = useState<{ taskId: string; operationId: string } | null>(null);
  // The notice shown waits on the open task's next state; its end answers it.
  const awaitingOutcome = useRef(false);
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [modelKey, setModelKey] = useState('');
  const modelKeyRef = useRef('');
  const chooseKey = useCallback((key: string) => { modelKeyRef.current = key; setModelKey(key); }, []);
  // The label of a chosen model the latest catalogue no longer lists, so it stays visible and must be changed.
  const [staleLabel, setStaleLabel] = useState('');
  const [effort, setEffort] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [preview, setPreview] = useState<{ run: string; artifact: string } | null>(null);
  const [run, setRun] = useState<ExecutionRun | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pollingPaused, setPollingPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [noticeWarning, setNoticeWarning] = useState(false);
  // Only an account's own canvas keeps an unconfirmed submission across reloads; a viewer starts nothing.
  const storeKey = !readOnly && userId ? pendingKey(userId, tenantId, canvasId) : null;
  const [pendingSubmission, setPendingSubmission] = useState<ExecutionInput | null>(() => readPending(storeKey));
  // The last submission settled with no task (a reconcile the service definitely refused, or one given up): the canvas
  // settles its request.
  const [startRefusal, setStartRefusal] = useState<{ reason: string; at: number; operationId: string; givenUp?: boolean } | null>(null);
  // Another page of this canvas (a second tab) waiting on a submission, or settling one, is seen here at once. One
  // settled there (its task, a refusal, given up) has this canvas's tasks read again, so a task it did start is listed
  // here too; one stored again (its send ended unconfirmed after this page gave it up) is waited for again.
  const pendingNow = useRef(pendingSubmission);
  pendingNow.current = pendingSubmission;
  useEffect(() => {
    if (!storeKey) return;
    const sync = (event: StorageEvent) => {
      if (event.key !== storeKey && event.key !== null) return;
      const waiting = readPending(storeKey);
      if (pendingNow.current && !waiting) setCatalogueRevision(revision => revision + 1);
      setPendingSubmission(waiting);
      if (waiting) setStartRefusal(previous => previous?.operationId === waiting.operationId ? null : previous);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [storeKey]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [uncertainResponses, setUncertainResponses] = useState<Record<string, ExecutionResponseInput>>({});
  const [pendingImport, setPendingImport] = useState<ExecutionArtifact | null>(null);
  const [importTitle, setImportTitle] = useState('');
  const [knowledgeCount, setKnowledgeCount] = useState(0);
  const alive = useRef(true);
  const lock = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const importOperations = useRef(new Map<string, string>());

  // Another canvas starts from nothing: no task, draft or operation of this one carries over.
  const lastScope = useRef(scope);
  useEffect(() => {
    if (lastScope.current === scope) return;
    lastScope.current = scope;
    controllers.current.forEach(controller => controller.abort()); controllers.current.clear();
    importOperations.current.clear(); lock.current = false; shownBefore.current = false;
    runtimeRef.current = null; setRuntime(null); setHistory({ items: [] }); chooseKey(''); setStaleLabel(''); setEffort('');
    setSelectedId(''); setPreview(null); setRun(null); setDetailLoading(false); setPollingPaused(false); setBusy(false);
    setError(null); setNotice(''); setNoticeWarning(false); setPendingSubmission(readPending(storeKey)); setStartRefusal(null); setAnswers({}); setUncertainResponses({});
    setPendingImport(null); setImportTitle(''); setKnowledgeCount(0); setHistoryFailed(false); setConfirmedTask(null);
  }, [scope, chooseKey]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); }; }, []);

  // A lost session or access forgets what was read; handleError also shows the error, while the canvas shows a
  // start's or a stop's itself.
  const forgetIfDenied = useCallback((cause: unknown) => {
    if (cause instanceof SaaSApiError && [401, 403].includes(cause.status)) {
      setRun(null); setSelectedId(''); setHistory({ items: [] }); setRuntime(null); setPendingImport(null); setPreview(null);
    }
  }, []);
  const handleError = useCallback((cause: unknown) => { setError(cause); forgetIfDenied(cause); }, [forgetIfDenied]);

  // The service and this canvas's tasks, read once the canvas activates them, when they are shown again, and on
  // every explicit refresh.
  useEffect(() => {
    if (!activated) return;
    const controller = new AbortController(); setLoading(true); setError(null);
    void Promise.allSettled([readExecutionRuntime(tenantId, controller.signal), readExecutionRuns(tenantId, canvasId, controller.signal)]).then(([service, runs]) => {
      if (controller.signal.aborted) return;
      const denied = [service, runs].find(result => result.status === 'rejected' && result.reason instanceof SaaSApiError && [401, 403].includes(result.reason.status));
      if (denied?.status === 'rejected') { handleError(denied.reason); setLoading(false); return; }
      if (service.status === 'fulfilled') {
        const models = service.value.models;
        const earlier = runtimeRef.current; runtimeRef.current = service.value;
        setRuntime(service.value);
        const previous = modelKeyRef.current;
        if (!previous) { chooseKey(models[0] ? executionModelKey(models[0].runtime, models[0].id) : ''); setStaleLabel(''); }
        else if (models.some(item => executionModelKey(item.runtime, item.id) === previous)) setStaleLabel('');
        else {
          // An earlier choice the catalogue dropped stays chosen and visible until the user picks another.
          const [runtimeId, modelId] = JSON.parse(previous) as [string, string];
          const known = earlier?.models.find(item => executionModelKey(item.runtime, item.id) === previous);
          setStaleLabel(current => current || (known ? known.label || known.id : `${modelId} · ${runtimeId}`));
        }
      // The canvas reads the service on open, unasked: a failure there says the service is unavailable (the
      // extras' quiet line), never an alert, and messages are planned meanwhile.
      } else setRuntime(null);
      if (runs.status === 'fulfilled') { setHistory(runs.value); setHistoryFailed(false); setSelectedId(previous => previous || runs.value.items[0]?.id || ''); }
      else { setHistory({ items: [] }); setHistoryFailed(true); }
      setLoading(false);
    });
    return () => controller.abort();
  }, [activated, tenantId, canvasId, catalogueRevision, handleError, chooseKey]);

  // The canvas's knowledge selection (made in the knowledge map) goes with each task.
  useEffect(() => {
    if (!activated) return;
    setKnowledgeCount(canvasKnowledgeRevisionIds().length);
    return subscribeCanvasKnowledge(() => setKnowledgeCount(canvasKnowledgeRevisionIds().length));
  }, [activated, scope]);

  const choiceModel = runtime?.models.find(item => executionModelKey(item.runtime, item.id) === modelKey);
  // Effort belongs to the model: a model that lists no levels gets none, and a change of model resets it.
  useEffect(() => { if (!choiceModel?.efforts?.includes(effort)) setEffort(''); }, [choiceModel, effort]);

  // The selected task, read until it ends, while its conversation is on screen (closing
  // the assistant stops reading, never the task); a long task pauses reading after six minutes until refreshed.
  useEffect(() => {
    if (!activated || !visible || !selectedId) return;
    const controller = new AbortController(); setDetailLoading(true); setPollingPaused(false);
    void (async () => {
      try {
        for (let attempt = 0; attempt < POLL_READS; attempt++) {
          const value = await readExecutionRun(tenantId, selectedId, controller.signal);
          if (controller.signal.aborted) return;
          setRun(value); setDetailLoading(false);
          setHistory(previous => ({ ...previous, items: [value, ...previous.items.filter(item => item.id !== value.id)] }));
          setUncertainResponses(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => {
            const approval = value.approvals.find(item => executionResponseKey(value.id, item.requestId) === key);
            return !approval || !['allowed', 'denied'].includes(approval.status);
          })));
          if (executionTerminal(value.status)) {
            // A notice that waited on this task's next state (a response or a stop being checked) is answered now.
            if (awaitingOutcome.current) { awaitingOutcome.current = false; setNotice(''); setNoticeWarning(false); }
            return;
          }
          await pause(controller.signal);
        }
        if (!controller.signal.aborted) setPollingPaused(true);
      } catch (cause) { if (!controller.signal.aborted) { handleError(cause); setDetailLoading(false); setPollingPaused(true); } }
    })();
    return () => controller.abort();
  }, [activated, visible, tenantId, selectedId, detailRevision, handleError]);

  const currentRun = run?.id === selectedId ? run : null;
  const mutate = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (readOnly || lock.current) return;
    lock.current = true; setBusy(true); setError(null); setNotice(''); setNoticeWarning(false);
    const controller = new AbortController(); controllers.current.add(controller);
    try { await action(controller.signal); }
    catch (cause) { if (!controller.signal.aborted && alive.current) handleError(cause); }
    finally { controllers.current.delete(controller); lock.current = false; if (alive.current) setBusy(false); }
  };

  const ready = Boolean(runtime?.ready && runtime.capabilities.workspace);
  const needsModel = runtime?.capabilities.workspace === true && runtime.models.length === 0;
  const serviceReason = runtime?.reason === 'Configure an available model in My engines'
    ? t('连接一个模型即可开始。请在「我的引擎」中选择或添加可用模型。', 'Connect a model to begin. Choose or add an available model in My engines.')
    : runtime?.reason === 'Managed execution service is not ready'
      ? t('工作区执行服务暂时不可用，请稍后重新检查。', 'Workspace execution is temporarily unavailable. Check again later.') : runtime?.reason;
  const startBlockedReason = readOnly ? t('只读访问不能发起任务。', 'Read-only access cannot start tasks.')
    // A read again of a service already known (the conversation shown again, a refresh) keeps what was read.
    : !activated || (loading && !runtime) ? t('正在读取执行服务，请稍候。', 'Reading the execution service. One moment.')
      : !ready ? (serviceReason || t('执行服务尚未就绪。', 'The execution service is not ready.'))
        : staleLabel ? t('所选模型已不可用，请重新选择。', 'The chosen model is no longer available. Choose another.')
          : !choiceModel ? t('先选择执行模型。', 'Choose an execution model first.')
            : pendingSubmission ? t('上一次提交的结果还没确认，请先核对。', 'The last submission is unconfirmed. Reconcile it first.')
              : knowledgeCount > 8 ? t('知识引用最多 8 份。', 'Use at most eight knowledge references.') : undefined;

  // Lists a created task at once as the open one, before its first read answers (or fails).
  const created = (id: string, status: string, text: string) => {
    const now = new Date().toISOString();
    setHistory(previous => ({ ...previous, items: [{ id, status, prompt: text, createdAt: now, updatedAt: now },
      ...previous.items.filter(item => item.id !== id)] }));
    setSelectedId(id); setRun(null); setPendingImport(null); setPreview(null); setDetailRevision(value => value + 1);
    setPendingSubmission(null);
  };
  // The canvas names each request's submission, so the conversation knows which turn a reconcile settles.
  const start = async (text: string, operationId: string = newOperationId()): Promise<string> => {
    const prompt = text.trim();
    const blocked = !prompt ? t('任务内容不能为空。', 'The task is empty.')
      : new TextEncoder().encode(prompt).length > PROMPT_BYTES ? t('任务内容最多 32 KiB。', 'Keep the task within 32 KiB.') : startBlockedReason;
    if (blocked) throw new Error(blocked);
    if (lock.current) throw new Error(t('上一个请求还在处理，请稍候。', 'The previous request is still being handled.'));
    const input: ExecutionInput = { prompt, runtime: choiceModel!.runtime, model: choiceModel!.id, ...(effort ? { effort } : {}),
      knowledgeRevisionIds: canvasKnowledgeRevisionIds(), operationId };
    // Written ahead, before it is sent. A submission another page of this canvas (a second tab) left waiting stays:
    // this page waits for its reconcile too, and sends nothing.
    if (!claimPending(storeKey, input)) {
      setPendingSubmission(readPending(storeKey));
      throw new Error(t('这张画布还有一个结果没确认的任务（可能在另一个标签页），请先核对。', 'This canvas has a task whose outcome is unconfirmed (perhaps in another tab). Reconcile it first.'));
    }
    lock.current = true; setBusy(true); setNotice(''); setNoticeWarning(false);
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const run = await createExecutionRun(tenantId, canvasId, input, controller.signal);
      created(run.id, run.status, prompt);
      releasePending(storeKey, operationId);
      return run.id;
    } catch (cause) {
      const unconfirmed = !controller.signal.aborted && isUncertain(cause);
      // Stored again: another page may have given it up while it was in flight, before its outcome was unknown.
      if (unconfirmed) { claimPending(storeKey, input); setPendingSubmission(input); }
      // A refused first send settles it: nothing exists under a new identity. An abort (the page going away) leaves
      // the outcome unknown, as stored.
      else if (!controller.signal.aborted) releasePending(storeKey, operationId);
      // A lost session or access clears what was read, as every other request does; the caller shows the error.
      forgetIfDenied(cause);
      // The conversation shows the message as it is, so it is already in the reader's words.
      const message = cause instanceof SaaSApiError ? saasErrorMessage(cause, locale) : cause instanceof Error ? cause.message : String(cause);
      throw unconfirmed ? new TaskStartUnconfirmed(message) : cause instanceof SaaSApiError ? new Error(message) : cause;
    } finally { controllers.current.delete(controller); lock.current = false; if (alive.current) setBusy(false); }
  };
  const reconcile = () => void mutate(async signal => {
    const input = pendingSubmission;
    if (!input) return;
    setStartRefusal(null);
    try {
      const run = await createExecutionRun(tenantId, canvasId, input, signal);
      if (!signal.aborted) {
        created(run.id, run.status, input.prompt); releasePending(storeKey, input.operationId);
        setConfirmedTask({ taskId: run.id, operationId: input.operationId });
      }
    } catch (cause) {
      // Only a refusal that proves the start never happened settles it; any other keeps it waiting for another
      // reconcile (or to be given up on by hand), as the first send may have started the task.
      if (!signal.aborted && cause instanceof SaaSApiError && NEVER_STARTED.has(cause.code)) {
        setPendingSubmission(null); releasePending(storeKey, input.operationId);
        setStartRefusal({ reason: saasErrorMessage(cause, locale), at: Date.now(), operationId: input.operationId });
      }
      throw cause;
    }
  });
  // Gives the waiting submission up without knowing its outcome: it is neither reconciled nor sent again from here. The
  // canvas's tasks are read again, so one it did start is listed, and its request is settled as given up (not put back
  // in the box: sending it again unread could start a second task).
  const discardPending = () => {
    const input = pendingSubmission;
    if (!input || lock.current) return;
    releasePending(storeKey, input.operationId);
    setPendingSubmission(null);
    setCatalogueRevision(revision => revision + 1);
    setStartRefusal({ reason: t('已放弃核对这次提交。如果任务其实已经开始，会列在这张画布之前的任务里；确认没有开始后，可以复制上面的请求重新发送。',
      'This submission was given up unconfirmed. If its task did start, it is listed among this canvas’s earlier tasks; once you are sure it did not, copy the request above and send it again.'),
    at: Date.now(), operationId: input.operationId, givenUp: true });
  };
  const finished = (taskId: string) => {
    const status = (run?.id === taskId ? run.status : history.items.find(item => item.id === taskId)?.status);
    return status !== undefined && executionTerminal(status);
  };
  const stopTask = async (taskId: string) => {
    if (readOnly) return;
    let result: Awaited<ReturnType<typeof cancelExecutionRun>>;
    try {
      // The open task is read while it is on screen; another's listed status may be old, so it is read first.
      const status = run?.id === taskId ? run.status : (await readExecutionRun(tenantId, taskId, new AbortController().signal)).status;
      if (executionTerminal(status)) return;
      result = await cancelExecutionRun(tenantId, taskId, new AbortController().signal);
    } catch (cause) {
      // Said by the canvas, in the reader's words, as a start's refusal is.
      forgetIfDenied(cause);
      throw cause instanceof SaaSApiError ? new Error(saasErrorMessage(cause, locale)) : cause;
    }
    if (alive.current) {
      awaitingOutcome.current = result.status !== 'cancelled'; setNotice(result.status === 'cancelled' ? t('任务已停止。', 'Task stopped.') : t('停止请求已提交，正在核对结果。', 'Stop requested. Checking the outcome.'));
      setDetailRevision(value => value + 1);
    }
  };
  const respond = (approval: ExecutionApproval, behavior: 'allow' | 'deny', retry?: ExecutionResponseInput) => void mutate(async signal => {
    if (!currentRun?.canRespond || executionTerminal(currentRun.status) || (!retry && approval.status !== 'pending')) return;
    const key = executionResponseKey(currentRun.id, approval.requestId);
    const message = answers[key]?.trim();
    if (!retry && approval.kind === 'question' && behavior === 'allow' && !message) return;
    if (!retry && message && new TextEncoder().encode(message).length > ANSWER_BYTES) throw new Error(t('回复内容最多 8 KiB，请缩短后发送。', 'Keep the response within 8 KiB before sending.'));
    const input = retry ?? { requestId: approval.requestId, behavior, ...(message ? { message } : {}), operationId: newOperationId() };
    setUncertainResponses(previous => ({ ...previous, [key]: input }));
    try {
      const result = await respondToExecutionRun(tenantId, currentRun.id, input, signal);
      if (signal.aborted) return;
      setNoticeWarning(!result.accepted);
      awaitingOutcome.current = true;
      setNotice(result.accepted ? t('回应已提交，正在核对任务状态。', 'Response submitted. Checking the task status.')
        : t('回应结果尚未确认。请读取任务状态，勿重复授权。', 'The response outcome is unconfirmed. Read the task status before authorizing again.'));
      setDetailRevision(value => value + 1);
    } catch (cause) {
      if (!signal.aborted && !isUncertain(cause)) setUncertainResponses(previous => { const next = { ...previous }; delete next[key]; return next; });
      throw cause;
    }
  });
  const stop = () => void mutate(async signal => {
    if (!currentRun?.canCancel || executionTerminal(currentRun.status)) return;
    const result = await cancelExecutionRun(tenantId, currentRun.id, signal);
    if (signal.aborted) return;
    awaitingOutcome.current = result.status !== 'cancelled'; setNotice(result.status === 'cancelled' ? t('任务已停止。', 'Task stopped.') : t('停止请求已提交，正在核对结果。', 'Stop requested. Checking the outcome.'));
    setDetailRevision(value => value + 1);
  });
  const importArtifact = () => void mutate(async signal => {
    if (!pendingImport || !importTitle.trim()) return;
    const key = JSON.stringify([pendingImport.id, importTitle.trim()]);
    const id = importOperations.current.get(key) ?? newOperationId(); importOperations.current.set(key, id);
    await createKnowledgeSource(tenantId, { title: importTitle.trim(), artifactId: pendingImport.id, operationId: id }, signal);
    if (signal.aborted) return;
    setPendingImport(null); setNotice(t('文件已存入知识库，可在知识地图中整理并审核。', 'File saved to knowledge. Organize and review it in the knowledge map.'));
  });

  return {
    activated, activate: () => setActivatedScope(scope), setVisible, readOnly, loading, runtime, ready, serviceReason, needsModel,
    choice: { key: modelKey, model: choiceModel, ...(staleLabel ? { unavailableLabel: staleLabel } : {}) },
    // Effort belongs to one model: choosing another starts again from the model's default.
    chooseModel: key => { if (key !== modelKeyRef.current) setEffort(''); chooseKey(key); setStaleLabel(''); }, effort, setEffort, knowledgeCount,
    history, historyFailed, confirmedTask, startRefusal, selectedId,
    select: id => { setSelectedId(id); setDetailRevision(value => value + 1); setError(null); setPendingImport(null); setPreview(null); },
    run: currentRun, detailLoading, pollingPaused,
    refreshDetail: () => { setError(null); setDetailRevision(value => value + 1); },
    refreshAll: () => { setError(null); setCatalogueRevision(value => value + 1); },
    busy, error, clearError: () => setError(null), notice, noticeWarning, pendingSubmission, startBlockedReason, start, reconcile, discardPending, stopTask, finished,
    answers, setAnswer: (key, value) => setAnswers(previous => ({ ...previous, [key]: value })), uncertainResponses, respond, stop,
    preview, togglePreview: (runId, artifactId) => setPreview(current => current?.run === runId && current.artifact === artifactId ? null : { run: runId, artifact: artifactId }),
    pendingImport, importTitle, setImportTitle,
    startImport: artifact => { setPendingImport(artifact); setImportTitle(executionFileName(artifact.name)); }, cancelImport: () => setPendingImport(null), importArtifact,
    artifactURL: artifactId => executionArtifactURL(tenantId, artifactId),
  };
}
