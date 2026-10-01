import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, FileText, Play, RefreshCw, Square, TerminalSquare, X } from 'lucide-react';
import { SaaSApiError, saasErrorMessage } from './api';
import { accountURL } from './PersonalAccount';
import { useSaaSPreferences } from './preferences';
import { createKnowledgeSource, KNOWLEDGE_CONTENT_BYTES, type KnowledgeContextItem, type KnowledgeDocument } from './knowledgeApi';
import { cancelExecutionRun, createExecutionRun, executionArtifactURL, executionTerminal, readExecutionRun, readExecutionRuns,
  readExecutionRuntime, respondToExecutionRun, type ExecutionApproval, type ExecutionArtifact, type ExecutionInput,
  type ExecutionResponseInput, type ExecutionRun, type ExecutionRuns, type ExecutionRuntime } from './managedExecutionApi';
import './managed-execution.css';

export interface ManagedExecutionPanelProps {
  tenantId: string; canvasId: string; readOnly?: boolean;
  knowledgeReferences?: Pick<KnowledgeContextItem, 'revisionId' | 'title'>[];
  onClose?: () => void; onArtifactsChanged?: () => void;
  onImported?: (document: KnowledgeDocument) => void | Promise<void>;
}
const modelKey = (runtime: string, model: string) => JSON.stringify([runtime, model]);
const responseKey = (runId: string, requestId: string) => JSON.stringify([runId, requestId]);
const operationId = () => `execution-${crypto.randomUUID()}`;
const isUncertain = (error: unknown) => !(error instanceof SaaSApiError) || error.status >= 500 || [408, 409].includes(error.status);
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 3000);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
export function ManagedExecutionPanel(props: ManagedExecutionPanelProps) {
  return <ExecutionView key={`${props.tenantId}/${props.canvasId}`} {...props} />;
}
function ExecutionView({ tenantId, canvasId, readOnly = false, knowledgeReferences = [], onClose, onArtifactsChanged, onImported }: ManagedExecutionPanelProps) {
  const { t, locale } = useSaaSPreferences();
  const [runtime, setRuntime] = useState<ExecutionRuntime | null>(null);
  const [history, setHistory] = useState<ExecutionRuns>({ items: [] });
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selectedId, setSelectedId] = useState('');
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
  const alive = useRef(true);
  const lock = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const submissions = useRef(new Map<string, string>());
  const importOperations = useRef(new Map<string, string>());
  const changed = useRef(onArtifactsChanged);
  changed.current = onArtifactsChanged;
  const selectedModel = runtime?.models.find(item => modelKey(item.runtime, item.id) === model);
  const needsModel = runtime?.capabilities.workspace === true && runtime.models.length === 0;
  const serviceReason = runtime?.reason === 'Configure an available model in My engines'
    ? t('连接一个模型即可开始。请在「我的引擎」中选择或添加可用模型。', 'Connect a model to begin. Choose or add an available model in My engines.')
    : runtime?.reason === 'Managed execution service is not ready'
      ? t('工作区执行服务暂时不可用，请稍后刷新。', 'Workspace execution is temporarily unavailable. Refresh later.') : runtime?.reason;
  const currentRun = run?.id === selectedId ? run : null;
  const handleError = useCallback((cause: unknown) => {
    setError(cause);
    if (cause instanceof SaaSApiError && [401, 403].includes(cause.status)) {
      setRun(null); setSelectedId(''); setHistory({ items: [] }); setRuntime(null); setPendingImport(null);
    }
  }, []);

  useEffect(() => { alive.current = true; return () => { alive.current = false; controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    void Promise.allSettled([readExecutionRuntime(tenantId, controller.signal), readExecutionRuns(tenantId, canvasId, controller.signal)]).then(([service, runs]) => {
      if (controller.signal.aborted) return;
      const denied = [service, runs].find(result => result.status === 'rejected' && result.reason instanceof SaaSApiError && [401, 403].includes(result.reason.status));
      if (denied?.status === 'rejected') { handleError(denied.reason); setLoading(false); return; }
      if (service.status === 'fulfilled') {
        setRuntime(service.value);
        setModel(previous => service.value.models.some(item => modelKey(item.runtime, item.id) === previous)
          ? previous : service.value.models[0] ? modelKey(service.value.models[0].runtime, service.value.models[0].id) : '');
      } else { setRuntime(null); handleError(service.reason); }
      if (runs.status === 'fulfilled') { setHistory(runs.value); setSelectedId(previous => previous || runs.value.items[0]?.id || ''); }
      else { setHistory({ items: [] }); handleError(runs.reason); }
      setLoading(false);
    });
    return () => controller.abort();
  }, [tenantId, canvasId, catalogueRevision, handleError]);
  useEffect(() => { if (!selectedModel?.efforts?.includes(effort)) setEffort(''); }, [selectedModel, effort]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController(); setDetailLoading(true); setPollingPaused(false);
    let lastArtifacts = '';
    void (async () => {
      try {
        for (let attempt = 0; attempt < 120; attempt++) {
          const value = await readExecutionRun(tenantId, selectedId, controller.signal);
          if (controller.signal.aborted) return;
          setRun(value); setDetailLoading(false);
          setHistory(previous => ({ ...previous, items: [value, ...previous.items.filter(item => item.id !== value.id)] }));
          setUncertainResponses(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => {
            const approval = value.approvals.find(item => responseKey(value.id, item.requestId) === key);
            return !approval || !['allowed', 'denied'].includes(approval.status);
          })));
          const artifacts = JSON.stringify(value.artifacts.map(item => [item.id, item.sha256]));
          if (artifacts !== lastArtifacts && value.artifacts.length) changed.current?.();
          lastArtifacts = artifacts;
          if (executionTerminal(value.status)) return;
          await pause(controller.signal);
        }
        if (!controller.signal.aborted) setPollingPaused(true);
      } catch (cause) { if (!controller.signal.aborted) { handleError(cause); setDetailLoading(false); setPollingPaused(true); } }
    })();
    return () => controller.abort();
  }, [tenantId, selectedId, detailRevision, handleError]);

  const mutate = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (readOnly || lock.current) return;
    lock.current = true; setBusy(true); setError(null); setNotice(''); setNoticeWarning(false);
    const controller = new AbortController(); controllers.current.add(controller);
    try { await action(controller.signal); }
    catch (cause) { if (!controller.signal.aborted && alive.current) handleError(cause); }
    finally { controllers.current.delete(controller); lock.current = false; if (alive.current) setBusy(false); }
  };
  const submit = (retry?: ExecutionInput) => void mutate(async signal => {
    if (!retry && (!runtime?.ready || !runtime.capabilities.workspace || !selectedModel || !prompt.trim())) return;
    if (!retry && (new TextEncoder().encode(prompt.trim()).length > 32768 || knowledgeReferences.length > 8)) throw new Error(t('任务内容最多 32 KiB，知识引用最多 8 份。', 'Use at most 32 KiB of task text and eight knowledge references.'));
    const draft = retry ?? { prompt: prompt.trim(), runtime: selectedModel!.runtime, model: selectedModel!.id,
      ...(effort ? { effort } : {}), knowledgeRevisionIds: knowledgeReferences.map(item => item.revisionId), operationId: '' };
    const fingerprint = JSON.stringify({ ...draft, operationId: '' });
    const input = retry ?? { ...draft, operationId: submissions.current.get(fingerprint) ?? operationId() };
    submissions.current.set(fingerprint, input.operationId);
    try {
      const created = await createExecutionRun(tenantId, canvasId, input, signal);
      if (signal.aborted) return;
      setSelectedId(created.id); setRun(null); setPendingImport(null); setDetailRevision(value => value + 1);
      setPendingSubmission(null); setPrompt(''); setNotice(t('任务已提交。关闭面板后仍可从历史任务继续查看。', 'Task submitted. Reopen its history to continue viewing it after closing this panel.'));
      submissions.current.delete(fingerprint);
    } catch (cause) {
      if (!signal.aborted && isUncertain(cause)) setPendingSubmission(input);
      throw cause;
    }
  });
  const respond = (approval: ExecutionApproval, behavior: 'allow' | 'deny', retry?: ExecutionResponseInput) => void mutate(async signal => {
    if (!currentRun?.canRespond || executionTerminal(currentRun.status) || (!retry && approval.status !== 'pending')) return;
    const key = responseKey(currentRun.id, approval.requestId);
    const message = answers[key]?.trim();
    if (!retry && approval.kind === 'question' && behavior === 'allow' && !message) return;
    if (!retry && message && new TextEncoder().encode(message).length > 8192) throw new Error(t('回复内容最多 8 KiB，请缩短后发送。', 'Keep the response within 8 KiB before sending.'));
    const input = retry ?? { requestId: approval.requestId, behavior, ...(message ? { message } : {}), operationId: operationId() };
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
    const id = importOperations.current.get(key) ?? operationId(); importOperations.current.set(key, id);
    const document = await createKnowledgeSource(tenantId, { title: importTitle.trim(), artifactId: pendingImport.id, operationId: id }, signal);
    if (signal.aborted) return;
    setPendingImport(null); setNotice(t('产物已保存为原始资料，可在知识地图中整理并审核。', 'Artifact saved as a source. Organize and review it in the knowledge map.'));
    await onImported?.(document);
  });
  const statusLabel = (status: string) => ({ queued: t('排队中', 'Queued'), running: t('执行中', 'Running'), completed: t('已完成', 'Completed'),
    failed: t('失败', 'Failed'), cancelled: t('已停止', 'Stopped'), interrupted: t('已中断', 'Interrupted') })[status] ?? status;
  const approvalLabel = (status: ExecutionApproval['status']) => ({ pending: t('待回应', 'Awaiting response'), sending: t('正在确认回应', 'Confirming response'),
    allowed: t('已允许 / 已回复', 'Allowed / answered'), denied: t('已拒绝', 'Denied'), unknown: t('回应结果待核对', 'Response outcome unconfirmed') })[status];

  return <section className="managed-execution" aria-label={t('执行助手', 'Execution assistant')}>
    <header className="managed-execution-header"><div><TerminalSquare size={24} /><div><h2>{t('执行助手', 'Execution assistant')}</h2><p>{t('使用已有模型，在工作区执行命令、读写文件并交付结果', 'Use your existing models to run commands, work with files, and deliver results')}</p></div></div><div><button type="button" aria-label={t('刷新执行服务和历史', 'Refresh execution service and history')} disabled={loading} onClick={() => setCatalogueRevision(value => value + 1)}><RefreshCw size={16} /></button>{onClose && <button type="button" aria-label={t('关闭执行助手', 'Close execution assistant')} onClick={onClose}><X size={19} /></button>}</div></header>
    {error !== null && <p className="managed-execution-error" role="alert">{saasErrorMessage(error, locale)}</p>}
    {notice && <p className={noticeWarning ? 'managed-execution-warning' : 'managed-execution-notice'} role="status">{notice}</p>}
    <div className="managed-execution-layout"><aside className="managed-execution-compose">
      <div className="managed-execution-service"><strong>{loading ? t('正在读取执行服务…', 'Reading execution service…') : needsModel ? t('先选择执行模型', 'Choose an execution model') : runtime?.ready && runtime.capabilities.workspace ? t('工作区执行已就绪', 'Workspace execution ready') : t('执行服务尚未就绪', 'Execution service is not ready')}</strong>
        {serviceReason && <p>{serviceReason}</p>}
        {!loading && runtime && !runtime.models.length && <a href={accountURL('engines')}>{t('管理我的引擎', 'Manage my engines')}</a>}
        {runtime?.capabilities.approvals && <p>{t('需要授权或补充信息时，会在本次任务中显示请求。', 'Permission and information requests appear inside this task.')}</p>}
      </div>
      {!readOnly && <form onSubmit={event => { event.preventDefault(); submit(); }}>
        <h3>{t('创建任务', 'Create a task')}</h3>
        <label>{t('执行模型', 'Execution model')}<select value={model} disabled={busy || loading || !!pendingSubmission} onChange={event => setModel(event.target.value)}><option value="">{t('选择模型', 'Choose a model')}</option>{runtime?.models.map(item => <option key={modelKey(item.runtime, item.id)} value={modelKey(item.runtime, item.id)}>{item.label || item.id} · {item.runtime}</option>)}</select></label>
        {!!selectedModel?.efforts?.length && <label>{t('推理强度', 'Reasoning effort')}<select value={effort} disabled={busy || !!pendingSubmission} onChange={event => setEffort(event.target.value)}><option value="">{t('模型默认', 'Model default')}</option>{selectedModel.efforts.map(item => <option key={item} value={item}>{item}</option>)}</select></label>}
        <label>{t('任务目标与角色要求', 'Task goal and role')}<textarea rows={7} maxLength={12000} value={prompt} disabled={busy || !!pendingSubmission} onChange={event => setPrompt(event.target.value)} placeholder={t('说明要完成什么、工作边界和需要交付的文件。', 'Describe the goal, scope, and files to deliver.')} /></label>
        {knowledgeReferences.length > 0 && <div className="managed-execution-evidence"><strong>{t(`引用 ${knowledgeReferences.length} 份知识版本`, `${knowledgeReferences.length} knowledge revisions attached`)}</strong>{knowledgeReferences.map(item => <span key={item.revisionId}><FileText size={12} />{item.title}</span>)}</div>}
        <button className="managed-primary" type="submit" disabled={busy || loading || !runtime?.ready || !runtime.capabilities.workspace || !selectedModel || !prompt.trim() || !!pendingSubmission}><Play size={15} />{t('创建并执行', 'Create and run')}</button>
      </form>}
      {pendingSubmission && <div className="managed-execution-warning" role="status"><strong>{t('本次提交结果尚未确认', 'Submission outcome is unconfirmed')}</strong><p>{t('核对会使用原提交标识，不创建第二份任务。', 'Reconcile using the original submission identity without creating a second task.')}</p><code>{pendingSubmission.operationId}</code>{!readOnly && <button type="button" disabled={busy} onClick={() => submit(pendingSubmission)}>{t('核对本次提交', 'Reconcile this submission')}</button>}</div>}
      <nav className="managed-execution-history" aria-label={t('执行任务历史', 'Execution history')}><h3>{t('历史任务', 'Previous tasks')}</h3>{history.items.length === 0 && <p>{t('还没有任务。创建后可随时回来查看。', 'No tasks yet. Return here to view tasks after creating one.')}</p>}{history.items.map(item => <button type="button" key={item.id} aria-pressed={selectedId === item.id} disabled={busy} onClick={() => { setSelectedId(item.id); setDetailRevision(value => value + 1); setError(null); setPendingImport(null); }}><strong>{item.prompt || item.id}</strong><span>{statusLabel(item.status)} · {new Date(item.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</span></button>)}{history.truncated && <p>{t('仅显示最近的任务记录。', 'Only recent task records are shown.')}</p>}</nav>
    </aside><main className="managed-execution-detail">
      {!selectedId && <div className="managed-execution-empty"><TerminalSquare size={36} /><h3>{t('让任务产生可保存的结果', 'Turn a task into a saved result')}</h3><p>{t('描述目标，检查执行过程，再将需要的产物存入知识库。', 'Describe a goal, review the execution, and save useful artifacts to your knowledge base.')}</p></div>}
      {selectedId && <><div className="managed-execution-detail-bar"><h3>{t('任务详情', 'Task details')}</h3><span role="status">{detailLoading ? t('正在读取…', 'Loading…') : currentRun ? statusLabel(currentRun.status) : t('状态未读取', 'Status not loaded')}</span><button type="button" aria-label={t('刷新当前任务', 'Refresh current task')} disabled={detailLoading} onClick={() => { setError(null); setDetailRevision(value => value + 1); }}><RefreshCw size={15} /></button>{!readOnly && currentRun?.canCancel && !executionTerminal(currentRun.status) && <button type="button" disabled={busy} onClick={stop}><Square size={13} />{t('停止任务', 'Stop task')}</button>}</div>
        {pollingPaused && <p className="managed-execution-warning">{t('自动读取已暂停；任务可能仍在运行。点击刷新继续核对。', 'Automatic reading is paused. The task may still be running; refresh to continue checking.')}</p>}
        {currentRun && <><p className="managed-execution-prompt">{currentRun.prompt}</p><code className="managed-execution-id">{currentRun.id}</code>
          {currentRun.truncated && <p className="managed-execution-warning">{t('当前记录超过显示上限，部分历史未展示。', 'The display limit was reached; some history is not shown.')}</p>}
          {currentRun.error && <p className="managed-execution-error">{currentRun.error}</p>}
          <section className="managed-execution-approvals" aria-label={t('任务请求', 'Task requests')}>{currentRun.approvals.map(approval => {
            const key = responseKey(currentRun.id, approval.requestId);
            const uncertain = uncertainResponses[key];
            const canRespond = !readOnly && currentRun.canRespond && !executionTerminal(currentRun.status);
            return <article key={approval.id} className="managed-execution-request"><div><strong>{approval.title || (approval.kind === 'question' ? t('需要补充信息', 'Information needed') : t('需要本次授权', 'Permission needed'))}</strong><span>{approvalLabel(approval.status)}</span></div><p>{approval.description}</p>
              {Object.keys(approval.arguments).length > 0 && <details open={approval.status === 'pending'}><summary>{t('请求参数', 'Request arguments')}</summary><pre>{JSON.stringify(approval.arguments, null, 2)}</pre></details>}
              {!canRespond && approval.status === 'pending' && <p>{t('仅本次任务发起人可以回应请求。', 'Only the task creator can respond to this request.')}</p>}
              {canRespond && approval.status === 'pending' && !uncertain && <div><label>{approval.kind === 'question' ? t('回复内容', 'Your answer') : t('说明（可选）', 'Note (optional)')}<textarea rows={3} maxLength={8000} value={answers[key] ?? ''} disabled={busy} onChange={event => setAnswers(previous => ({ ...previous, [key]: event.target.value }))} /></label><div className="managed-execution-actions"><button type="button" disabled={busy} onClick={() => respond(approval, 'deny')}>{t('拒绝本次请求', 'Deny this request')}</button><button className="managed-primary" type="button" disabled={busy || (approval.kind === 'question' && !answers[key]?.trim())} onClick={() => respond(approval, 'allow')}><Check size={15} />{approval.kind === 'question' ? t('发送回复', 'Send answer') : t('仅允许本次', 'Allow once')}</button></div></div>}
              {canRespond && uncertain && <div className="managed-execution-warning"><p>{t('已发送此回应，结果尚待核对。未自动重发。', 'This response was sent; its outcome is unconfirmed. It has not been retried automatically.')}</p><button type="button" disabled={busy} onClick={() => { setError(null); setDetailRevision(value => value + 1); }}>{t('读取回应状态', 'Read response status')}</button>{approval.status === 'pending' && <button type="button" disabled={busy} onClick={() => respond(approval, uncertain.behavior, uncertain)}>{t('核对本次回应', 'Reconcile this response')}</button>}</div>}
            </article>;
          })}</section>
          <section className="managed-execution-messages" aria-label={t('执行消息', 'Execution messages')}>{currentRun.messages.map(message => <article key={message.id}><div><strong>{message.role}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</time></div><pre>{message.text}</pre>{message.truncated && <p className="managed-execution-warning">{t('此消息内容已截断。', 'This message has been truncated.')}</p>}</article>)}</section>
          {currentRun.output && <section className="managed-execution-output"><h3>{t('任务结果', 'Task result')}</h3><pre>{currentRun.output}</pre>{currentRun.outputTruncated && <p className="managed-execution-warning">{t('此结果内容已截断，请查看已保存产物。', 'This result has been truncated. Check the saved artifacts.')}</p>}</section>}
          <section className="managed-execution-artifacts"><h3>{t('已保存产物', 'Saved artifacts')}</h3>{currentRun.artifacts.length === 0 && <p>{t('暂无已保存文件。', 'No files have been saved yet.')}</p>}{currentRun.artifacts.map(artifact => <article key={artifact.id}><FileText size={18} /><div><strong>{artifact.name}</strong><small>{artifact.size.toLocaleString()} B</small></div><a href={executionArtifactURL(tenantId, artifact.id)} download={artifact.name}><Download size={14} />{t('下载', 'Download')}</a>{!readOnly && <button type="button" disabled={busy || artifact.size > KNOWLEDGE_CONTENT_BYTES} title={t('保存服务器上的 UTF-8 文本原件，最多 256 KiB', 'Save the server-held UTF-8 text source, up to 256 KiB')} onClick={() => { setPendingImport(artifact); setImportTitle(artifact.name); }}>{t('存入知识库', 'Save to knowledge')}</button>}</article>)}</section>
        </>}
      </>}
      {pendingImport && !readOnly && <form className="managed-execution-import" onSubmit={event => { event.preventDefault(); importArtifact(); }}><h3>{t('保存原始产物', 'Save the original artifact')}</h3><p>{pendingImport.name} · {pendingImport.size.toLocaleString()} B</p><p>{t('将服务器保存的 UTF-8 文本原件入库，并保留任务与文件来源。', 'Import the server-held UTF-8 text and preserve its task and file provenance.')}</p><label>{t('资料标题', 'Source title')}<input maxLength={500} value={importTitle} required onChange={event => setImportTitle(event.target.value)} /></label><div className="managed-execution-actions"><button type="button" onClick={() => setPendingImport(null)}>{t('取消', 'Cancel')}</button><button type="submit" className="managed-primary" disabled={busy || !importTitle.trim()}>{t('确认保存原始产物', 'Save original artifact')}</button></div></form>}
    </main></div>
  </section>;
}
