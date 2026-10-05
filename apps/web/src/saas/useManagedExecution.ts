// The canvas assistant's 直接执行 mode: a task runs in a restricted workspace through the managed execution
// service. This hook owns its state; AssistantExecution draws it. It keeps the rules the execution panel had:
// every request is bounded, a running task is polled (never streamed), an unknown submission or response is
// reconciled with its original operation id instead of being sent again, and requests are answered only by an
// explicit choice. Nothing loads until the mode is first opened.
import { useCallback, useEffect, useRef, useState } from 'react';
import { SaaSApiError } from './api';
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
  prompt: string;
  setPrompt: (prompt: string) => void;
  knowledgeCount: number;
  history: ExecutionRuns;
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
  /** Can the composer send now; when it cannot, why (shown, never a silent disabled button). */
  canSubmit: boolean;
  submitBlockedReason?: string;
  submit: (retry?: ExecutionInput) => void;
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

export function useManagedExecution(tenantId: string, canvasId: string, { readOnly = false }: { readOnly?: boolean } = {}): ManagedExecution {
  const { t } = useSaaSPreferences();
  const scope = `${tenantId}/${canvasId}`;
  const [activatedScope, setActivatedScope] = useState('');
  const [visible, setVisible] = useState(false);
  const activated = activatedScope === scope;
  const [runtime, setRuntime] = useState<ExecutionRuntime | null>(null);
  // The catalogue last read, so a chosen model it later drops keeps its name.
  const runtimeRef = useRef<ExecutionRuntime | null>(null);
  const [history, setHistory] = useState<ExecutionRuns>({ items: [] });
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [modelKey, setModelKey] = useState('');
  const modelKeyRef = useRef('');
  const chooseKey = useCallback((key: string) => { modelKeyRef.current = key; setModelKey(key); }, []);
  // The label of a chosen model the latest catalogue no longer lists, so it stays visible and must be changed.
  const [staleLabel, setStaleLabel] = useState('');
  const [effort, setEffort] = useState('');
  const [prompt, setPrompt] = useState('');
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
  const [pendingSubmission, setPendingSubmission] = useState<ExecutionInput | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [uncertainResponses, setUncertainResponses] = useState<Record<string, ExecutionResponseInput>>({});
  const [pendingImport, setPendingImport] = useState<ExecutionArtifact | null>(null);
  const [importTitle, setImportTitle] = useState('');
  const [knowledgeCount, setKnowledgeCount] = useState(0);
  const alive = useRef(true);
  const lock = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const submissions = useRef(new Map<string, string>());
  const importOperations = useRef(new Map<string, string>());

  // Another canvas starts from nothing: no task, draft or operation of this one carries over.
  const lastScope = useRef(scope);
  useEffect(() => {
    if (lastScope.current === scope) return;
    lastScope.current = scope;
    controllers.current.forEach(controller => controller.abort()); controllers.current.clear();
    submissions.current.clear(); importOperations.current.clear(); lock.current = false;
    runtimeRef.current = null; setRuntime(null); setHistory({ items: [] }); chooseKey(''); setStaleLabel(''); setEffort(''); setPrompt('');
    setSelectedId(''); setPreview(null); setRun(null); setDetailLoading(false); setPollingPaused(false); setBusy(false);
    setError(null); setNotice(''); setNoticeWarning(false); setPendingSubmission(null); setAnswers({}); setUncertainResponses({});
    setPendingImport(null); setImportTitle(''); setKnowledgeCount(0);
  }, [scope, chooseKey]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); }; }, []);

  const handleError = useCallback((cause: unknown) => {
    setError(cause);
    if (cause instanceof SaaSApiError && [401, 403].includes(cause.status)) {
      setRun(null); setSelectedId(''); setHistory({ items: [] }); setRuntime(null); setPendingImport(null); setPreview(null);
    }
  }, []);

  // The service and this canvas's tasks, read when the mode first opens and on every explicit refresh.
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
      } else { setRuntime(null); handleError(service.reason); }
      if (runs.status === 'fulfilled') { setHistory(runs.value); setSelectedId(previous => previous || runs.value.items[0]?.id || ''); }
      else { setHistory({ items: [] }); handleError(runs.reason); }
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

  // The selected task, read until it ends, while the conversation is on screen (leaving the mode or closing
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
          if (executionTerminal(value.status)) return;
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
  const promptTooLong = new TextEncoder().encode(prompt.trim()).length > PROMPT_BYTES;
  const submitBlockedReason = readOnly ? t('只读访问不能发起任务。', 'Read-only access cannot start tasks.')
    : loading ? undefined
      : !ready ? (serviceReason || t('执行服务尚未就绪。', 'The execution service is not ready.'))
        : staleLabel ? t('所选模型已不可用，请重新选择。', 'The chosen model is no longer available. Choose another.')
          : !choiceModel ? t('先选择执行模型。', 'Choose an execution model first.')
            : promptTooLong ? t('任务内容最多 32 KiB。', 'Keep the task within 32 KiB.')
              : knowledgeCount > 8 ? t('知识引用最多 8 份。', 'Use at most eight knowledge references.') : undefined;
  const canSubmit = !busy && !loading && !pendingSubmission && !submitBlockedReason && Boolean(prompt.trim());

  const submit = (retry?: ExecutionInput) => void mutate(async signal => {
    if (!retry && (!canSubmit || !choiceModel)) return;
    const draft = retry ?? { prompt: prompt.trim(), runtime: choiceModel!.runtime, model: choiceModel!.id,
      ...(effort ? { effort } : {}), knowledgeRevisionIds: canvasKnowledgeRevisionIds(), operationId: '' };
    const fingerprint = JSON.stringify({ ...draft, operationId: '' });
    const input = retry ?? { ...draft, operationId: submissions.current.get(fingerprint) ?? newOperationId() };
    submissions.current.set(fingerprint, input.operationId);
    try {
      const created = await createExecutionRun(tenantId, canvasId, input, signal);
      if (signal.aborted) return;
      // Listed at once as the user's message, before its first read answers (or fails).
      const now = new Date().toISOString();
      setHistory(previous => ({ ...previous, items: [{ id: created.id, status: created.status, prompt: input.prompt, createdAt: now, updatedAt: now },
        ...previous.items.filter(item => item.id !== created.id)] }));
      setSelectedId(created.id); setRun(null); setPendingImport(null); setPreview(null); setDetailRevision(value => value + 1);
      setPendingSubmission(null); setPrompt('');
      submissions.current.delete(fingerprint);
    } catch (cause) {
      if (!signal.aborted && isUncertain(cause)) setPendingSubmission(input);
      throw cause;
    }
  });
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
    setNotice(result.status === 'cancelled' ? t('任务已停止。', 'Task stopped.') : t('停止请求已提交，正在核对结果。', 'Stop requested. Checking the outcome.'));
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
    chooseModel: key => { if (key !== modelKeyRef.current) setEffort(''); chooseKey(key); setStaleLabel(''); }, effort, setEffort, prompt, setPrompt, knowledgeCount,
    history, selectedId,
    select: id => { setSelectedId(id); setDetailRevision(value => value + 1); setError(null); setPendingImport(null); setPreview(null); },
    run: currentRun, detailLoading, pollingPaused,
    refreshDetail: () => { setError(null); setDetailRevision(value => value + 1); },
    refreshAll: () => { setError(null); setCatalogueRevision(value => value + 1); },
    busy, error, clearError: () => setError(null), notice, noticeWarning, pendingSubmission, canSubmit, submitBlockedReason, submit,
    answers, setAnswer: (key, value) => setAnswers(previous => ({ ...previous, [key]: value })), uncertainResponses, respond, stop,
    preview, togglePreview: (runId, artifactId) => setPreview(current => current?.run === runId && current.artifact === artifactId ? null : { run: runId, artifact: artifactId }),
    pendingImport, importTitle, setImportTitle,
    startImport: artifact => { setPendingImport(artifact); setImportTitle(executionFileName(artifact.name)); }, cancelImport: () => setPendingImport(null), importArtifact,
    artifactURL: artifactId => executionArtifactURL(tenantId, artifactId),
  };
}
