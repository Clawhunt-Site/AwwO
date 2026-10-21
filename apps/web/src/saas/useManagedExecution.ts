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
import { announceRouteUsageChanged } from './routeUsage';
import { useSaaSPreferences } from './preferences';
import { useAccountPreferences } from './accountPreferences';
import { notifyTaskFinished } from './taskNotifications';
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
// A submission that made a task, here or in another page of this canvas, is announced under a sibling key, written and
// removed at once so only the storage event carries it: the other pages list the task and link it to their request.
const STARTED_KEY = 'awwo.execution.started-submission.v1';
const canvasKey = (userId: string, tenantId: string, canvasId: string, name: string) =>
  `awwo.saas:${[userId, tenantId, canvasId].map(encodeURIComponent).join(':')}:${name}`;
// The model the reader chose for the canvas assistant, kept for the account in this workspace (every canvas of it), so
// a choice made once holds on the next canvas and after a reload. Only a choice the reader made is kept: until then the
// service's first model is used and the components a plan adds keep the workspace default.
const MODEL_KEY = 'awwo.assistant.model.v1';
const workspaceKey = (userId: string, tenantId: string, name: string) => `awwo.saas:${[userId, tenantId].map(encodeURIComponent).join(':')}:${name}`;
function readStoredModel(key: string | null): string {
  if (!key) return '';
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null') as unknown;
    return Array.isArray(raw) && raw.length === 2 && raw.every(part => typeof part === 'string' && part !== '' && part.length <= 256) ? JSON.stringify(raw) : '';
  } catch { return ''; }
}
function storeModel(key: string | null, model: string) {
  if (!key) return;
  try { if (model) localStorage.setItem(key, model); else localStorage.removeItem(key); }
  catch { /* The choice holds for this page only. */ }
}
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
function announceStarted(key: string | null, operationId: string, taskId: string) {
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify({ operationId, taskId, at: Date.now() })); localStorage.removeItem(key); }
  catch { /* The other pages list the task when they read the canvas's tasks again. */ }
}
function readStarted(value: string | null): { operationId: string; taskId: string } | null {
  try {
    const raw = JSON.parse(value || 'null') as { operationId?: unknown; taskId?: unknown } | null;
    return raw && typeof raw.operationId === 'string' && /^execution-[0-9a-f-]{36}$/.test(raw.operationId)
      && typeof raw.taskId === 'string' && raw.taskId !== '' && raw.taskId.length <= 200 ? { operationId: raw.operationId, taskId: raw.taskId } : null;
  } catch { return null; }
}
type ConfirmedTask = { taskId: string; operationId: string; here?: boolean };
// A send gives up after its 15 s request limit: past this, no send of a submission is still in flight anywhere.
const SEND_SETTLED_MS = 20000;
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
  /** The workspace the tasks run in. */
  tenantId: string;
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
  /** The model the reader chose (not the default the service lists first): the components a plan adds start on it. */
  componentModel?: { runtime: string; model: string };
  effort: string;
  setEffort: (effort: string) => void;
  knowledgeCount: number;
  history: ExecutionRuns;
  /** The canvas's task list could not be read; refreshAll reads it again. */
  historyFailed: boolean;
  /** The tasks confirmed on this canvas since it was opened, each with the submission it was, once per submission (its
   *  first answer): one a reconcile pressed in this page found (`here`), or one another page of this canvas announced. */
  confirmedTasks: ReadonlyArray<ConfirmedTask>;
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
  const [confirmedTasks, setConfirmedTasks] = useState<ReadonlyArray<ConfirmedTask>>([]);
  // The notice shown waits on the open task's next state; its end answers it.
  const awaitingOutcome = useRef(false);
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [modelKey, setModelKey] = useState('');
  const modelKeyRef = useRef('');
  const chooseKey = useCallback((key: string) => { modelKeyRef.current = key; setModelKey(key); }, []);
  // The label of a chosen model the latest catalogue no longer lists, so it stays visible and must be changed.
  const [staleLabel, setStaleLabel] = useState('');
  // Whether the chosen model is the reader's own choice (kept for the workspace), not the service's first model.
  const [chosenByReader, setChosenByReader] = useState(false);
  const chosenByReaderRef = useRef(false);
  chosenByReaderRef.current = chosenByReader;
  // The account's default model (设置 → 通用 → 画布助手默认模型), as a model key; '' when none.
  const accountDefault = useAccountPreferences()?.preferences?.defaultModel;
  const accountDefaultKey = !readOnly && accountDefault ? executionModelKey(accountDefault.runtime, accountDefault.model) : '';
  const accountDefaultRef = useRef(accountDefaultKey);
  accountDefaultRef.current = accountDefaultKey;
  useEffect(() => {
    // Settings that arrive after the catalogue take the place of the service's first model, never of a reader's pick.
    const models = runtimeRef.current?.models;
    const offered = (key: string) => Boolean(key) && Boolean(models?.some(item => executionModelKey(item.runtime, item.id) === key));
    if (!accountDefaultKey || chosenByReaderRef.current || offered(readStoredModel(modelStoreKey)) || !offered(accountDefaultKey)) return;
    if (accountDefaultKey !== modelKeyRef.current) setEffort('');
    chooseKey(accountDefaultKey); setStaleLabel('');
  }, [accountDefaultKey, chooseKey]);
  const modelStoreKey = !readOnly && userId ? workspaceKey(userId, tenantId, MODEL_KEY) : null;
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
  const storeKey = !readOnly && userId ? canvasKey(userId, tenantId, canvasId, PENDING_KEY) : null;
  const startedKey = !readOnly && userId ? canvasKey(userId, tenantId, canvasId, STARTED_KEY) : null;
  const [pendingSubmission, setPendingSubmission] = useState<ExecutionInput | null>(() => readPending(storeKey));
  // The last submission settled with no task (a reconcile the service definitely refused, or one given up): the canvas
  // settles its request.
  const [startRefusal, setStartRefusal] = useState<{ reason: string; at: number; operationId: string; givenUp?: boolean } | null>(null);
  // Another page of this canvas (a second tab) waiting on a submission, or settling one, is seen here at once. One
  // settled there (its task, a refusal, given up) has this canvas's tasks read again, so a task it did start is listed
  // here too; one stored again (its send ended unconfirmed after this page gave it up) is waited for again; a task it
  // announces is linked to the request this page recorded for it, given up or not.
  const pendingNow = useRef(pendingSubmission);
  pendingNow.current = pendingSubmission;
  // Reads this page makes on its own account (another page settled a submission, a give-up's late read) leave a shown
  // error as it is: only the user's own actions clear it.
  const quietRead = useRef(false);
  const readTasksQuietly = useCallback(() => { quietRead.current = true; setCatalogueRevision(revision => revision + 1); }, []);
  // The tasks this page knows its submissions made (its own sends, or announced by another page): a send of one that
  // ends unconfirmed is that task, never a submission to wait on again.
  const startedTasks = useRef(new Map<string, string>());
  // The tasks seen ending on this page: each tells the header meter once that its calls may have changed.
  const endedTasks = useRef(new Set<string>());
  // The submission a shown error is about (a reconcile's that ended unconfirmed): it is cleared once that submission
  // settles, here or in another page; any other error stays until the user moves on.
  const errorAbout = useRef<string | null>(null);
  const clearErrorAbout = useCallback((operationId: string) => {
    if (errorAbout.current !== operationId) return;
    errorAbout.current = null; setError(null);
  }, []);
  // The submission a reconcile pressed in this page is reconciling: a task another page announces for it meanwhile
  // answers that reconcile too (`here`), whose box goes with it, however this page's own request then ends.
  const reconciling = useRef<string | null>(null);
  // Adds a confirmed task to the canvas's list, once per submission: a later answer to the same one (this page's own
  // request after another page's announcement, a second announcement) changes nothing, so the canvas sees each once,
  // with its first answer. Added through the list it is given, so two that come before one draw are both kept.
  const confirmTask = useCallback((next: ConfirmedTask) => setConfirmedTasks(previous =>
    previous.some(entry => entry.operationId === next.operationId) ? previous : [...previous, next]), []);
  useEffect(() => {
    if (!storeKey) return;
    const sync = (event: StorageEvent) => {
      if (event.key === startedKey) {
        const started = readStarted(event.newValue);
        if (!started) return;
        startedTasks.current.set(started.operationId, started.taskId);
        // Stored back by a send here that ended unconfirmed just before this page heard of the task: released.
        releasePending(storeKey, started.operationId);
        confirmTask(reconciling.current === started.operationId ? { ...started, here: true } : started);
        setPendingSubmission(previous => previous?.operationId === started.operationId ? null : previous);
        setStartRefusal(previous => previous?.operationId === started.operationId ? null : previous);
        clearErrorAbout(started.operationId);
        readTasksQuietly();
        return;
      }
      if (event.key !== storeKey && event.key !== null) return;
      // One whose task this page knows (stored back by a send that ended unconfirmed just before its page heard of the
      // task) is released, not waited on.
      const stored = readPending(storeKey);
      const waiting = stored && startedTasks.current.has(stored.operationId) ? null : stored;
      if (stored && !waiting) releasePending(storeKey, stored.operationId);
      // The submission waited on until now settled there if another (or none) waits instead.
      const settled = pendingNow.current && pendingNow.current.operationId !== waiting?.operationId ? pendingNow.current.operationId : null;
      if (settled) { clearErrorAbout(settled); readTasksQuietly(); }
      setPendingSubmission(waiting);
      if (waiting) setStartRefusal(previous => previous?.operationId === waiting.operationId ? null : previous);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [storeKey, startedKey, readTasksQuietly, clearErrorAbout, confirmTask]);
  // A give-up reads the canvas's tasks again once more after any send still in flight elsewhere has ended.
  const settledRead = useRef<number | undefined>(undefined);
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
    window.clearTimeout(settledRead.current); startedTasks.current.clear(); reconciling.current = null; quietRead.current = false;
    controllers.current.forEach(controller => controller.abort()); controllers.current.clear();
    importOperations.current.clear(); lock.current = false; shownBefore.current = false;
    runtimeRef.current = null; setRuntime(null); setHistory({ items: [] }); chooseKey(''); setChosenByReader(false); setStaleLabel(''); setEffort('');
    setSelectedId(''); setPreview(null); setRun(null); setDetailLoading(false); setPollingPaused(false); setBusy(false);
    setError(null); setNotice(''); setNoticeWarning(false); setPendingSubmission(readPending(storeKey)); setStartRefusal(null); setAnswers({}); setUncertainResponses({});
    setPendingImport(null); setImportTitle(''); setKnowledgeCount(0); setHistoryFailed(false); setConfirmedTasks([]);
  }, [scope, chooseKey]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; window.clearTimeout(settledRead.current); controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); }; }, []);

  // A lost session or access forgets what was read; handleError also shows the error, while the canvas shows a
  // start's or a stop's itself.
  const forgetIfDenied = useCallback((cause: unknown) => {
    if (cause instanceof SaaSApiError && [401, 403].includes(cause.status)) {
      setRun(null); setSelectedId(''); setHistory({ items: [] }); setRuntime(null); setPendingImport(null); setPreview(null);
    }
  }, []);
  const handleError = useCallback((cause: unknown, about: string | null = null) => {
    setError(cause); errorAbout.current = about; forgetIfDenied(cause);
  }, [forgetIfDenied]);

  // The service and this canvas's tasks, read once the canvas activates them, when they are shown again, and on
  // every explicit refresh.
  useEffect(() => {
    const quiet = quietRead.current;
    quietRead.current = false;
    if (!activated) return;
    const controller = new AbortController(); setLoading(true);
    if (!quiet) setError(null);
    void Promise.allSettled([readExecutionRuntime(tenantId, controller.signal), readExecutionRuns(tenantId, canvasId, controller.signal)]).then(([service, runs]) => {
      if (controller.signal.aborted) return;
      const denied = [service, runs].find(result => result.status === 'rejected' && result.reason instanceof SaaSApiError && [401, 403].includes(result.reason.status));
      if (denied?.status === 'rejected') { handleError(denied.reason); setLoading(false); return; }
      if (service.status === 'fulfilled') {
        const models = service.value.models;
        const earlier = runtimeRef.current; runtimeRef.current = service.value;
        setRuntime(service.value);
        const previous = modelKeyRef.current;
        if (!previous) {
          // The reader's earlier choice in this workspace, where the service still offers it; else its first model.
          // Then the default model of the account's settings (设置 → 通用), where this workspace offers it.
          const stored = readStoredModel(modelStoreKey);
          const offered = (key: string) => Boolean(key) && models.some(item => executionModelKey(item.runtime, item.id) === key);
          // Only the reader's pick here becomes the model of the components a plan adds; the account default is the
          // assistant's alone, so they keep the workspace default.
          const kept = offered(stored) ? stored : offered(accountDefaultRef.current) ? accountDefaultRef.current : '';
          chooseKey(kept || (models[0] ? executionModelKey(models[0].runtime, models[0].id) : '')); setChosenByReader(Boolean(kept) && kept === stored); setStaleLabel('');
        }
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
  }, [activated, tenantId, canvasId, catalogueRevision, handleError, chooseKey, modelStoreKey]);

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
            if (!endedTasks.current.has(value.id)) { endedTasks.current.add(value.id); announceRouteUsageChanged(); }
            // Only a task seen running in this read ends here; one already over when it was opened tells no one.
            if (attempt > 0) notifyTaskFinished({
              title: value.status === 'completed' ? t('任务已完成', 'Task finished') : t('任务已结束，未完成', 'Task ended without finishing'),
              // Not the task's text: a notification can show on a locked screen.
              body: t('回到 AwwO 查看结果。', 'Open AwwO to see the result.'), failed: value.status !== 'completed',
            });
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

  // Lists a created task at once as the open one, before its first read answers (or fails). A task made proves this
  // page may start tasks: an alert that access was refused no longer holds.
  const created = (id: string, status: string, text: string) => {
    const now = new Date().toISOString();
    setHistory(previous => ({ ...previous, items: [{ id, status, prompt: text, createdAt: now, updatedAt: now },
      ...previous.items.filter(item => item.id !== id)] }));
    setSelectedId(id); setRun(null); setPendingImport(null); setPreview(null); setDetailRevision(value => value + 1);
    setPendingSubmission(null);
    setError((previous: unknown) => previous instanceof SaaSApiError && previous.status === 403 ? null : previous);
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
      startedTasks.current.set(operationId, run.id);
      // Announced before it is released, so another page links the task before it would call the request lost.
      announceStarted(startedKey, operationId, run.id);
      releasePending(storeKey, operationId);
      return run.id;
    } catch (cause) {
      const unconfirmed = !controller.signal.aborted && isUncertain(cause);
      // Another page announced this submission's task while the send was in flight (its reconcile found it; hearing it
      // released the stored copy): started.
      const announced = unconfirmed ? startedTasks.current.get(operationId) : undefined;
      if (announced) { created(announced, 'queued', prompt); return announced; }
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
    reconciling.current = input.operationId;
    try {
      const run = await createExecutionRun(tenantId, canvasId, input, signal);
      if (!signal.aborted) {
        created(run.id, run.status, input.prompt); startedTasks.current.set(input.operationId, run.id);
        announceStarted(startedKey, input.operationId, run.id); releasePending(storeKey, input.operationId);
        confirmTask({ taskId: run.id, operationId: input.operationId, here: true });
      }
    } catch (cause) {
      if (signal.aborted) throw cause;
      // Its task announced by another page while this reconcile was in flight: settled there and linked here, so it is
      // neither waited on nor stored; only a lost session or access is still said.
      if (startedTasks.current.has(input.operationId)) {
        setPendingSubmission(previous => previous?.operationId === input.operationId ? null : previous);
        releasePending(storeKey, input.operationId);
        if (cause instanceof SaaSApiError && [401, 403].includes(cause.status)) throw cause;
        return;
      }
      // Only a refusal that proves the start never happened settles it; any other keeps it waiting for another
      // reconcile (or to be given up on by hand), as the first send may have started the task. Kept waiting, it is
      // stored again (another page may have given it up while this reconcile was in flight), and this page waits on
      // what the store then holds.
      if (cause instanceof SaaSApiError && NEVER_STARTED.has(cause.code)) {
        setPendingSubmission(null); releasePending(storeKey, input.operationId);
        setStartRefusal({ reason: saasErrorMessage(cause, locale), at: Date.now(), operationId: input.operationId });
        throw cause;
      }
      const kept = claimPending(storeKey, input);
      setPendingSubmission(kept ? input : readPending(storeKey));
      // Its error is this submission's, cleared once the submission settles; with another one waiting instead it would
      // only stand over that one, so it is not shown. A lost session or access is said either way, as no submission's.
      const denial = cause instanceof SaaSApiError && [401, 403].includes(cause.status);
      if (alive.current && (kept || denial)) handleError(cause, kept && !denial ? input.operationId : null);
    } finally { if (reconciling.current === input.operationId) reconciling.current = null; }
  });
  // Gives the waiting submission up without knowing its outcome: it is neither reconciled nor sent again from here. The
  // canvas's tasks are read again, so one it did start is listed, and its request is settled as given up (not put back
  // in the box: sending it again unread could start a second task). They are read once more after a send that another
  // page may still have in flight has ended, in case that page goes away before it announces a task.
  const discardPending = () => {
    const input = pendingSubmission;
    if (!input || lock.current) return;
    releasePending(storeKey, input.operationId);
    setPendingSubmission(null);
    setCatalogueRevision(revision => revision + 1);
    window.clearTimeout(settledRead.current);
    settledRead.current = window.setTimeout(() => { if (alive.current) readTasksQuietly(); }, SEND_SETTLED_MS);
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
    tenantId,
    activated, activate: () => setActivatedScope(scope), setVisible, readOnly, loading, runtime, ready, serviceReason, needsModel,
    choice: { key: modelKey, model: choiceModel, ...(staleLabel ? { unavailableLabel: staleLabel } : {}) },
    // Effort belongs to one model: choosing another starts again from the model's default. A choice the reader makes is
    // kept for this workspace and becomes the model of the components a plan adds.
    chooseModel: key => { if (key !== modelKeyRef.current) setEffort(''); chooseKey(key); setStaleLabel(''); setChosenByReader(Boolean(key)); storeModel(modelStoreKey, key); },
    // A model the workspace's plan does not include (requiresUpgrade, e.g. Claude Opus 5.5 without Pro or Max) is never
    // put on them: they would only be refused when they run.
    ...(chosenByReader && choiceModel && !staleLabel && choiceModel.requiresUpgrade !== true ? { componentModel: { runtime: choiceModel.runtime, model: choiceModel.id } } : {}),
    effort, setEffort, knowledgeCount,
    history, historyFailed, confirmedTasks, startRefusal, selectedId,
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
