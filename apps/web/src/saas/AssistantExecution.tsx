// The canvas assistant's tasks, in its one conversation. The server routes each message (canvas/assistantRouting.ts);
// one it routes to execution becomes a task, drawn here as the assistant's card under the user's message: a live
// one-line status while it runs, the requests it needs answered, then the result and its files. Also drawn here:
// the canvas's earlier tasks, the service's notices above the composer and the execution model under it. State and
// every request live in useManagedExecution; `executionHost` hands them to the canvas.
import { Fragment, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Download, Eye, EyeOff, FileText, Loader2, RefreshCw, Square, X } from 'lucide-react';
import { StoredArtifactPreview } from '../canvas/ArtifactPreview';
import type { AssistantExecutionHost } from '../canvas/assistantRouting';
import { ARTIFACT_REF_PREFIX } from './canvasBridge';
import { renderInertMarkdown } from './inertMarkdown';
import { saasErrorMessage } from './api';
import { runErrorText } from './canvasErrors';
import type { UiLocale } from '../locale';
import { accountURL } from './PersonalAccount';
import { useSaaSPreferences } from './preferences';
import { KNOWLEDGE_CONTENT_BYTES } from './knowledgeApi';
import { executionTerminal, type ExecutionApproval, type ExecutionRun, type ExecutionRunSummary } from './managedExecutionApi';
import { executionFileName, executionModelKey, executionResponseKey, type ManagedExecution } from './useManagedExecution';
import './assistant-execution.css';

type T = ReturnType<typeof useSaaSPreferences>['t'];
const statusLabel = (t: T, status: string) => ({ queued: t('排队中', 'Queued'), running: t('执行中', 'Running'), completed: t('已完成', 'Done'),
  failed: t('失败', 'Failed'), cancelled: t('已停止', 'Stopped'), interrupted: t('已中断', 'Interrupted') })[status] ?? status;
const statusTone = (status: string) => status === 'completed' ? 'done' : status === 'failed' || status === 'interrupted' ? 'failed'
  : status === 'cancelled' ? 'stopped' : 'running';
const approvalLabel = (t: T, status: ExecutionApproval['status']) => ({ pending: t('等你回应', 'Waiting for you'), sending: t('正在确认回应', 'Confirming'),
  allowed: t('已允许', 'Allowed'), denied: t('已拒绝', 'Denied'), unknown: t('回应结果待核对', 'Outcome unconfirmed') })[status];
const roleLabel = (t: T, role: string) => ({ assistant: t('助手', 'Assistant'), user: t('任务', 'Task'), tool: t('工具', 'Tool'), system: t('系统', 'System') })[role] ?? role;
const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/** Keeps `el` in view inside the scrolling thread: its top at the top ('start'), or just enough to show it. */
function reveal(thread: HTMLElement, el: HTMLElement, align: 'start' | 'nearest') {
  const view = thread.getBoundingClientRect(); const box = el.getBoundingClientRect(); const gap = 12;
  if (align === 'start' || box.top < view.top) thread.scrollTop += box.top - view.top - gap;
  else if (box.bottom > view.bottom) thread.scrollTop += Math.min(box.bottom - view.bottom + gap, box.top - view.top - gap);
}
function elapsed(from: string, to: number): string {
  const seconds = Math.max(0, Math.floor((to - new Date(from).getTime()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
/** Why a task ended without its result, in the reader's words; an unknown code is still named. */
function taskErrorText(t: T, locale: UiLocale, code: string): string {
  const known: Record<string, [string, string]> = {
    computer_busy: ['工作区正忙：它一次只运行一个任务。等当前任务结束后再试。', 'The workspace is busy: it runs one task at a time. Try again when the current task ends.'],
    computer_unavailable: ['工作区执行服务暂时不可用，请稍后再试。', 'Workspace execution is temporarily unavailable. Try again later.'],
    computer_rejected: ['执行服务没有接受这个任务，请稍后再试。', 'The execution service did not accept this task. Try again later.'],
    computer_execution_failed: ['任务执行失败，没有完成。', 'The task failed before it finished.'],
    computer_stream_ended: ['与执行服务的连接中断，任务没有完成。', 'The connection to the execution service ended before the task finished.'],
    computer_model_failed: ['模型调用失败，任务没有完成。', 'A model call failed, so the task did not finish.'],
    computer_admission_denied: ['模型额度或权限不足，任务停在了这里。', 'The model allowance or permission ran out, so the task stopped here.'],
    computer_output_limit: ['任务的输出超过了上限。', 'The task produced more output than allowed.'],
    quota_exceeded: ['今天的调用次数已用完，任务没有开始。', 'Today’s calls are used up, so the task did not start.'],
  };
  const text = known[code];
  // The run errors every run shares (the paid plan's and the daily allowances') read as they do on a node.
  return text ? t(text[0], text[1]) : runErrorText(code, locale) ?? t(`任务没有完成（${code}）。`, `The task did not finish (${code}).`);
}

/** What the canvas assistant needs from the hosted app's managed execution. */
export function executionHost(execution: ManagedExecution): AssistantExecutionHost {
  return {
    readOnly: execution.readOnly,
    ready: !execution.startBlockedReason,
    activate: execution.activate,
    setVisible: execution.setVisible,
    start: execution.start,
    stop: execution.stopTask,
    finished: execution.finished,
    renderTask: taskId => <ExecutionTaskCard execution={execution} taskId={taskId} />,
    renderEarlier: (mentioned, open) => <ExecutionEarlier execution={execution} mentioned={mentioned} open={open} />,
    renderNotices: planAvailable => <ExecutionNotices execution={execution} planAvailable={planAvailable} />,
    settings: <ExecutionSettings execution={execution} />,
    ...(execution.confirmedTask ? { confirmedTask: execution.confirmedTask } : {}),
    ...(execution.pendingSubmission ? { pendingOperation: execution.pendingSubmission.operationId } : {}),
    ...(execution.startRefusal ? { startRefusal: execution.startRefusal } : {}),
  };
}

/** One task's card: the open task in full, any other as a line that opens it. */
function ExecutionTaskCard({ execution, taskId }: { execution: ManagedExecution; taskId: string }) {
  const { t } = useSaaSPreferences();
  const card = useRef<HTMLDivElement>(null);
  const open = taskId === execution.selectedId;
  // A task opened from its line starts at the top of the conversation; a new one is left to the conversation's
  // own scroll to its newest message, and later reads leave the scroll alone.
  const wasOpen = useRef(open);
  useEffect(() => {
    const log = card.current?.closest<HTMLElement>('.awwo-assistant-messages');
    if (open && !wasOpen.current && log && card.current) reveal(log, card.current, 'start');
    wasOpen.current = open;
  }, [open]);
  const task = execution.history.items.find(item => item.id === taskId);
  return <div ref={card} className="awwo-execution-task" data-task={taskId}>
    {open ? <TaskDetail execution={execution} />
      : task ? <TaskSummary execution={execution} task={task} />
        : execution.loading || !execution.activated ? <p className="awwo-execution-loading" role="status"><Loader2 size={14} aria-hidden="true" />{t('正在读取任务…', 'Reading the task…')}</p>
          : <p className="awwo-execution-note">{t('这个任务不在最近的记录里。', 'This task is not among the recent ones.')}</p>}
  </div>;
}

/** The canvas's tasks the conversation does not mention: earlier ones, or ones started elsewhere. */
function ExecutionEarlier({ execution, mentioned, open }: { execution: ManagedExecution; mentioned: ReadonlySet<string>; open: boolean }) {
  const { t, locale } = useSaaSPreferences();
  const tasks = execution.history.items.filter(task => !mentioned.has(task.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!tasks.length) {
    // A viewer has only this list (no extras), so it says whether the tasks are being read, could not be read, or
    // there are none.
    if (!execution.readOnly) return null;
    if (execution.error !== null) return <p className="awwo-assistant-error" role="alert">{saasErrorMessage(execution.error, locale)}</p>;
    if (!execution.activated || execution.loading) return <p className="awwo-execution-loading" role="status"><Loader2 size={14} aria-hidden="true" />{t('正在读取这张画布的任务…', 'Reading this canvas’s tasks…')}</p>;
    if (execution.historyFailed) return <HistoryFailed execution={execution} />;
    return <p className="awwo-assistant-empty">{t('这张画布还没有任务。', 'This canvas has no tasks yet.')}</p>;
  }
  return <details className="awwo-execution-earlier" open={open}>
    <summary>{t(`这张画布之前的任务（${tasks.length}）`, `Earlier tasks on this canvas (${tasks.length})`)}</summary>
    <ol>
      {execution.history.truncated && <li className="awwo-execution-note">{t('只显示最近的任务。', 'Only recent tasks are shown.')}</li>}
      {tasks.map(task => <Fragment key={task.id}>
        <li className="awwo-assistant-message awwo-assistant-message--user"><p>{task.prompt || t('（无任务说明）', '(No task text)')}</p></li>
        <li className="awwo-assistant-message awwo-assistant-message--assistant awwo-execution-card"><ExecutionTaskCard execution={execution} taskId={task.id} /></li>
      </Fragment>)}
    </ol>
  </details>;
}

/** The canvas's tasks could not be read: said once, with the way to read them again. */
function HistoryFailed({ execution }: { execution: ManagedExecution }) {
  const { t } = useSaaSPreferences();
  return <div className="awwo-execution-warning" role="status"><p>{t('没读到这张画布的任务。', 'This canvas’s tasks could not be read.')}</p>
    <button type="button" disabled={execution.loading} onClick={execution.refreshAll}>{t('重新读取', 'Read again')}</button></div>;
}

function TaskSummary({ execution, task }: { execution: ManagedExecution; task: ExecutionRunSummary }) {
  const { t, locale } = useSaaSPreferences();
  return <button type="button" className="awwo-execution-summary" disabled={execution.busy} onClick={() => execution.select(task.id)}
    aria-label={t(`查看任务：${task.prompt}（${statusLabel(t, task.status)}）`, `Open task: ${task.prompt} (${statusLabel(t, task.status)})`)}>
    <span className={`awwo-execution-chip is-${statusTone(task.status)}`}>{statusLabel(t, task.status)}</span>
    <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
    <span>{t('查看', 'Open')}</span><ChevronRight size={14} aria-hidden="true" />
  </button>;
}

function TaskDetail({ execution }: { execution: ManagedExecution }) {
  const { t, locale } = useSaaSPreferences();
  const run = execution.run;
  // A request waiting for you is brought into view inside the conversation.
  const detail = useRef<HTMLDivElement>(null);
  const waiting = run?.approvals.filter(item => item.status === 'pending').map(item => item.id).join(' ') ?? '';
  useEffect(() => {
    const log = detail.current?.closest<HTMLElement>('.awwo-assistant-messages');
    const request = detail.current?.querySelector<HTMLElement>('.awwo-execution-request.is-pending');
    if (log && request && waiting) reveal(log, request, 'nearest');
  }, [waiting]);
  if (!run) return execution.detailLoading || (!execution.error && !execution.pollingPaused)
    ? <p className="awwo-execution-loading" role="status"><Loader2 size={14} aria-hidden="true" />{t('正在读取任务…', 'Reading the task…')}</p>
    // A read that failed or stopped says so, with a way to read again; the task itself may well be running.
    : <p className="awwo-execution-warning" role="status">{t('还没读到这个任务的状态，任务可能仍在运行。', 'This task’s status has not been read yet; it may still be running.')}
      <button type="button" onClick={execution.refreshDetail}>{t('重新读取', 'Read again')}</button></p>;
  const terminal = executionTerminal(run.status);
  const pending = run.approvals.filter(item => item.status === 'pending' || item.status === 'sending' || item.status === 'unknown');
  const answered = run.approvals.filter(item => !pending.includes(item));
  return <div ref={detail} className="awwo-execution-detail">
    <RunStatus execution={execution} run={run} />
    {execution.pollingPaused && <p className="awwo-execution-warning" role="status">{t('自动读取已暂停，任务可能仍在运行。', 'Automatic reading is paused; the task may still be running.')}
      <button type="button" onClick={execution.refreshDetail}>{t('继续读取', 'Keep reading')}</button></p>}
    {run.truncated && <p className="awwo-execution-note">{t('记录超过显示上限，部分过程未展示。', 'The record exceeds the display limit; part of the process is not shown.')}</p>}
    {run.error && <p className="awwo-execution-error" role="alert">{taskErrorText(t, locale, run.error)}</p>}
    {pending.map(approval => <RequestCard key={approval.id} execution={execution} run={run} approval={approval} />)}
    {run.output && <section className="awwo-execution-result" aria-label={t('任务结果', 'Task result')}>
      <div className="awwo-execution-markdown">{renderInertMarkdown(run.output)}</div>
      {run.outputTruncated && <p className="awwo-execution-note">{t('结果过长已截断，完整内容见下面的文件。', 'The result was truncated; see the files below for everything.')}</p>}
    </section>}
    {run.artifacts.length > 0 && <Files execution={execution} run={run} />}
    {terminal && !run.output && !run.artifacts.length && !run.error && <p className="awwo-execution-note">{t('这次任务没有留下结果或文件。', 'This task left no result or files.')}</p>}
    {(run.messages.length > 0 || answered.length > 0) && <details className="awwo-execution-process">
      <summary>{t(`执行过程（${run.messages.length} 条记录）`, `Process (${run.messages.length} entries)`)}</summary>
      {answered.map(approval => <RequestCard key={approval.id} execution={execution} run={run} approval={approval} />)}
      <ol>{run.messages.map(message => <li key={message.id}>
        <span className="awwo-execution-role">{roleLabel(t, message.role)}</span>
        <pre>{message.text}</pre>
        {message.truncated && <small>{t('此条已截断。', 'Truncated.')}</small>}
      </li>)}</ol>
    </details>}
  </div>;
}

/** The one-line live status while a task runs, from what the service reported; a final state once it ends. */
function RunStatus({ execution, run }: { execution: ManagedExecution; run: ExecutionRun }) {
  const { t } = useSaaSPreferences();
  const terminal = executionTerminal(run.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (terminal) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [terminal]);
  const waiting = run.approvals.some(item => item.status === 'pending');
  const facts = [terminal ? t(`用时 ${elapsed(run.createdAt, new Date(run.updatedAt).getTime())}`, `Took ${elapsed(run.createdAt, new Date(run.updatedAt).getTime())}`)
    : t(`已运行 ${elapsed(run.createdAt, now)}`, `Running for ${elapsed(run.createdAt, now)}`)];
  if (run.messages.length) facts.push(t(`${run.messages.length} 条进展`, `${run.messages.length} updates`));
  if (run.artifacts.length) facts.push(t(`${run.artifacts.length} 个文件`, `${run.artifacts.length} files`));
  const headline = terminal ? statusLabel(t, run.status) : waiting ? t('等你回应后继续', 'Waiting for your response')
    : run.status === 'queued' ? t('排队中，即将开始', 'Queued, starting soon') : t('正在执行任务', 'Working on the task');
  return <div className={`awwo-execution-status is-${statusTone(run.status)}`} role="status">
    <p className="awwo-execution-status-headline">
      {terminal ? <i aria-hidden="true" /> : <Loader2 size={14} aria-hidden="true" />}
      <span>{headline}</span>
    </p>
    <p className="awwo-execution-status-meta" aria-hidden="true">
      <span>{facts.join(' · ')}</span>
      {!terminal && !waiting && <span className="awwo-execution-status-hint">{t('关闭画布助手不会停止任务。', 'Closing the assistant does not stop the task.')}</span>}
    </p>
    <div className="awwo-execution-status-actions">
      {!terminal && <button type="button" className="awwo-assistant-icon-button" aria-label={t('刷新这个任务', 'Refresh this task')} disabled={execution.detailLoading} onClick={execution.refreshDetail}><RefreshCw size={14} aria-hidden="true" /></button>}
      {!execution.readOnly && run.canCancel && !terminal && <button type="button" className="awwo-assistant-cancel" disabled={execution.busy} onClick={execution.stop}>
        <Square size={11} aria-hidden="true" />{t('停止', 'Stop')}</button>}
    </div>
  </div>;
}

/** A permission or a question from the task: answered only by an explicit choice, never automatically. */
function RequestCard({ execution, run, approval }: { execution: ManagedExecution; run: ExecutionRun; approval: ExecutionApproval }) {
  const { t } = useSaaSPreferences();
  const key = executionResponseKey(run.id, approval.requestId);
  const uncertain = execution.uncertainResponses[key];
  const canRespond = !execution.readOnly && run.canRespond && !executionTerminal(run.status);
  const question = approval.kind === 'question';
  const answer = execution.answers[key] ?? '';
  const hasArguments = Object.keys(approval.arguments).length > 0;
  return <article className={`awwo-execution-request${approval.status === 'pending' ? ' is-pending' : ''}`} aria-label={approval.title || (question ? t('助手的问题', 'A question from the assistant') : t('需要你确认', 'Needs your permission'))}>
    <header>
      <strong>{approval.title || (question ? t('助手想问你', 'The assistant asks') : t('需要你确认', 'Needs your permission'))}</strong>
      <span className="awwo-execution-chip">{approvalLabel(t, approval.status)}</span>
    </header>
    {approval.description && <p>{approval.description}</p>}
    {hasArguments && <details open={approval.status === 'pending'}>
      <summary>{question ? t('问题详情', 'Question details') : t('它要做什么（详情）', 'What it will do (details)')}</summary>
      <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
    </details>}
    {!canRespond && approval.status === 'pending' && <p className="awwo-execution-note">{execution.readOnly
      ? t('只读访问不能回应。', 'Read-only access cannot respond.') : t('只有发起这个任务的人可以回应。', 'Only the person who started this task can respond.')}</p>}
    {canRespond && approval.status === 'pending' && !uncertain && <div className="awwo-execution-respond">
      <textarea aria-label={question ? t('你的回复', 'Your answer') : t('附一句说明（可选）', 'Add a note (optional)')} rows={question ? 3 : 2} maxLength={8000}
        placeholder={question ? t('回复助手的问题…', 'Answer the question…') : t('附一句说明（可选）', 'Add a note (optional)')}
        value={answer} disabled={execution.busy} onChange={event => execution.setAnswer(key, event.target.value)} />
      <div className="awwo-assistant-composer-actions">
        <button type="button" className="awwo-assistant-cancel" disabled={execution.busy} onClick={() => execution.respond(approval, 'deny')}>{t('拒绝', 'Deny')}</button>
        <button type="button" className="awwo-assistant-send" disabled={execution.busy || (question && !answer.trim())} onClick={() => execution.respond(approval, 'allow')}>
          <Check size={14} aria-hidden="true" /><span>{question ? t('发送回复', 'Send answer') : t('允许一次', 'Allow once')}</span></button>
      </div>
    </div>}
    {canRespond && uncertain && <div className="awwo-execution-warning" role="status">
      <p>{t('这条回应已发出，结果还没确认，没有自动重发。', 'This response was sent; its outcome is not confirmed and it was not resent.')}</p>
      <div className="awwo-assistant-composer-actions">
        <button type="button" disabled={execution.busy} onClick={execution.refreshDetail}>{t('读取回应状态', 'Read the response status')}</button>
        {approval.status === 'pending' && <button type="button" disabled={execution.busy} onClick={() => execution.respond(approval, uncertain.behavior, uncertain)}>{t('核对这条回应', 'Reconcile this response')}</button>}
      </div>
    </div>}
  </article>;
}

function Files({ execution, run }: { execution: ManagedExecution; run: ExecutionRun }) {
  const { t } = useSaaSPreferences();
  return <section className="awwo-execution-files" aria-label={t('交付的文件', 'Delivered files')}>
    <h3>{t(`交付的文件（${run.artifacts.length}）`, `Delivered files (${run.artifacts.length})`)}</h3>
    <ul>{run.artifacts.map(artifact => {
      const opened = execution.preview?.run === run.id && execution.preview.artifact === artifact.id;
      const name = executionFileName(artifact.name);
      const importing = execution.pendingImport?.id === artifact.id;
      return <li key={artifact.id}>
        <div className="awwo-execution-file">
          <FileText size={16} aria-hidden="true" />
          <span><strong>{name}</strong><small>{formatSize(artifact.size)}</small></span>
          <button type="button" className="awwo-assistant-icon-button" aria-expanded={opened} aria-label={opened ? t(`收起预览：${name}`, `Hide preview: ${name}`) : t(`预览：${name}`, `Preview: ${name}`)}
            onClick={() => execution.togglePreview(run.id, artifact.id)}>{opened ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}</button>
          <DownloadLink execution={execution} artifactId={artifact.id} name={name} />
          {!execution.readOnly && <button type="button" className="awwo-execution-save" disabled={execution.busy || artifact.size > KNOWLEDGE_CONTENT_BYTES}
            title={artifact.size > KNOWLEDGE_CONTENT_BYTES ? t('超过 256 KiB 的文件不能存入知识库。', 'Files over 256 KiB cannot be saved to knowledge.') : undefined}
            onClick={() => execution.startImport(artifact)}>{t('存入知识库', 'Save to knowledge')}</button>}
        </div>
        {opened && <div className="awwo-execution-preview"><StoredArtifactPreview reference={ARTIFACT_REF_PREFIX + artifact.id} title={name} identity={`${run.id}:${artifact.id}`} renderMarkdown={renderInertMarkdown} /></div>}
        {importing && !execution.readOnly && <form className="awwo-execution-import" onSubmit={event => { event.preventDefault(); execution.importArtifact(); }}>
          <label>{t('存入知识库的标题', 'Title in knowledge')}<input maxLength={500} value={execution.importTitle} required onChange={event => execution.setImportTitle(event.target.value)} /></label>
          <p>{t('保存服务器上的文本原件，并记下它来自哪个任务。', 'Saves the server-held text and records which task it came from.')}</p>
          <div className="awwo-assistant-composer-actions">
            <button type="button" className="awwo-assistant-cancel" onClick={execution.cancelImport}>{t('取消', 'Cancel')}</button>
            <button type="submit" className="awwo-assistant-send" disabled={execution.busy || !execution.importTitle.trim()}><span>{t('存入', 'Save')}</span></button>
          </div>
        </form>}
      </li>;
    })}</ul>
  </section>;
}

function DownloadLink({ execution, artifactId, name }: { execution: ManagedExecution; artifactId: string; name: string }) {
  const { t } = useSaaSPreferences();
  return <a className="awwo-assistant-icon-button" href={execution.artifactURL(artifactId)} download={name} aria-label={t(`下载：${name}`, `Download: ${name}`)}><Download size={15} aria-hidden="true" /></a>;
}

/** Above the composer: what keeps a task from starting or needs an answer, and where messages go meanwhile. */
function ExecutionNotices({ execution, planAvailable }: { execution: ManagedExecution; planAvailable: boolean }) {
  const { t, locale } = useSaaSPreferences();
  if (execution.readOnly) return null;
  // A start blocked for a reason of its own (not the service, which explains itself below): the chosen model, the
  // knowledge selection. An unconfirmed submission has its own reconcile box.
  const blockedHere = execution.activated && !execution.loading && execution.ready && !execution.pendingSubmission ? execution.startBlockedReason : undefined;
  const elsewhere = planAvailable ? t('消息会用来调整画布。', 'Messages go to the canvas meanwhile.') : '';
  return <div className="awwo-execution-notices">
    {execution.error !== null && <p className="awwo-assistant-error" role="alert">{saasErrorMessage(execution.error, locale)}
      <button type="button" className="awwo-assistant-icon-button" aria-label={t('关闭提示', 'Dismiss')} onClick={execution.clearError}><X size={13} aria-hidden="true" /></button></p>}
    {execution.notice && <p className={execution.noticeWarning ? 'awwo-execution-warning' : 'awwo-execution-notice'} role="status">{execution.notice}</p>}
    {execution.historyFailed && <HistoryFailed execution={execution} />}
    {execution.pendingSubmission && <div className="awwo-execution-warning" role="status">
      <p>{t('上一次提交的任务结果还没确认。核对会用原来的提交标识，不会多建一个任务；确定它没有开始时，也可以放弃这次提交。', 'The last task submission is unconfirmed. Reconciling reuses its original identity and never creates a second task; if you are sure it did not start, you can give it up.')}</p>
      <div className="awwo-assistant-composer-actions">
        <button type="button" disabled={execution.busy} onClick={execution.reconcile}>{t('核对上次提交', 'Reconcile the last submission')}</button>
        <button type="button" className="awwo-execution-discard" disabled={execution.busy} onClick={execution.discardPending}>{t('放弃这次提交', 'Give this submission up')}</button>
      </div>
    </div>}
    {execution.activated && !execution.loading && !execution.ready && <div className="awwo-execution-unavailable" role="status">
      <p>{t('暂时不能直接执行任务。', 'Direct tasks are unavailable for now.')}{elsewhere ? ` ${elsewhere}` : ''} <span>{execution.serviceReason || t('执行服务尚未就绪。', 'The execution service is not ready.')}</span></p>
      <div className="awwo-assistant-composer-actions">
        {(execution.needsModel || (execution.runtime && !execution.runtime.models.length)) && <a href={accountURL('engines')}>{t('管理我的引擎', 'Manage my engines')}</a>}
        <button type="button" disabled={execution.loading} onClick={execution.refreshAll}>{t('重新检查执行服务', 'Check the task service again')}</button>
      </div>
    </div>}
    {blockedHere && <p className="awwo-execution-warning" role="status">{t(`暂时不能直接执行任务：${blockedHere}`, `Direct tasks are paused: ${blockedHere}`)}{elsewhere ? ` ${elsewhere}` : ''}</p>}
  </div>;
}

/** Under the composer: the model and effort a direct task uses, one quiet line until opened, and the knowledge it takes. */
function ExecutionSettings({ execution }: { execution: ManagedExecution }) {
  const { t } = useSaaSPreferences();
  const models = execution.runtime?.models ?? [];
  const labelCounts = models.reduce<Record<string, number>>((counts, model) => ({ ...counts, [model.label || model.id]: (counts[model.label || model.id] ?? 0) + 1 }), {});
  const optionLabel = (model: typeof models[number]) => labelCounts[model.label || model.id] > 1 ? `${model.label || model.id} · ${model.runtime}` : (model.label || model.id);
  const chosen = execution.choice.model;
  const settingsSummary = execution.choice.unavailableLabel ? t(`直接执行用：${execution.choice.unavailableLabel}（已不可用）`, `Direct tasks use: ${execution.choice.unavailableLabel} (unavailable)`)
    : chosen ? `${t('直接执行用', 'Direct tasks use')}：${optionLabel(chosen)}${execution.effort ? ` · ${execution.effort}` : ''}` : t('选择直接执行的模型', 'Choose a model for direct tasks');
  if (execution.readOnly || (!models.length && !execution.choice.unavailableLabel && execution.knowledgeCount === 0)) return null;
  return <div className="awwo-execution-setup">
    {(models.length > 0 || execution.choice.unavailableLabel) && <details className="awwo-execution-settings">
      <summary>{settingsSummary}</summary>
      <label>{t('直接执行的模型', 'Model for direct tasks')}
        <select value={execution.choice.key} disabled={execution.busy || !!execution.pendingSubmission} onChange={event => execution.chooseModel(event.target.value)}>
          {execution.choice.unavailableLabel && <option value={execution.choice.key} disabled>{t(`${execution.choice.unavailableLabel}（已不可用）`, `${execution.choice.unavailableLabel} (unavailable)`)}</option>}
          {!execution.choice.key && <option value="">{t('选择模型', 'Choose a model')}</option>}
          {models.map(model => <option key={executionModelKey(model.runtime, model.id)} value={executionModelKey(model.runtime, model.id)}>{optionLabel(model)}</option>)}
        </select>
      </label>
      {!!chosen?.efforts?.length && <label>{t('思考强度', 'Reasoning effort')}
        <select value={execution.effort} disabled={execution.busy || !!execution.pendingSubmission} onChange={event => execution.setEffort(event.target.value)}>
          <option value="">{t('模型默认', 'Model default')}</option>
          {chosen.efforts.map(level => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>}
      {/* Engines are managed in the account; a change there shows here once the list is read again. */}
      <div className="awwo-execution-settings-actions">
        <a href={accountURL('engines')}>{t('管理我的引擎', 'Manage my engines')}</a>
        <button type="button" disabled={execution.loading || execution.busy} onClick={execution.refreshAll}>{execution.loading ? t('正在读取…', 'Reading…') : t('刷新模型列表', 'Refresh the model list')}</button>
      </div>
    </details>}
    {execution.knowledgeCount > 0 && <p className="awwo-execution-knowledge">{t(`将带上 ${execution.knowledgeCount} 份已选知识`, `Takes ${execution.knowledgeCount} selected knowledge items`)}</p>}
  </div>;
}
