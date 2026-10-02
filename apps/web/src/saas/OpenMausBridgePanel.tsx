import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Download, RefreshCw, Send, X } from 'lucide-react';
import { SaaSApiError, saasErrorMessage } from './api';
import { useSaaSPreferences } from './preferences';
import { importOpenMausMessage, readOpenMausBots, readOpenMausMessages, readOpenMausStatus, readOpenMausTask, sendOpenMausTask,
  type OpenMausBot, type OpenMausMessage, type OpenMausStatus, type OpenMausTaskResult } from './openMausApi';
import type { KnowledgeDocument } from './knowledgeApi';
import './openmaus-bridge.css';

export interface OpenMausBridgePanelProps { tenantId: string; readOnly?: boolean; onClose?: () => void; onImported?: (document: KnowledgeDocument) => void | Promise<void> }
export function OpenMausBridgePanel(props: OpenMausBridgePanelProps) { return <OpenMausBridgeView key={props.tenantId} {...props} />; }

function OpenMausBridgeView({ tenantId, readOnly = false, onClose, onImported }: OpenMausBridgePanelProps) {
  const { t, locale } = useSaaSPreferences();
  const [status, setStatus] = useState<OpenMausStatus | null>(null);
  const [bots, setBots] = useState<OpenMausBot[]>([]);
  const [botId, setBotId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [messages, setMessages] = useState<OpenMausMessage[]>([]);
  const [readKey, setReadKey] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState('');
  const [result, setResult] = useState<OpenMausTaskResult | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [pendingImport, setPendingImport] = useState<OpenMausMessage | null>(null);
  const [importTitle, setImportTitle] = useState('');
  const alive = useRef(true);
  const lock = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const readGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const uncertain = useRef(new Map<string, { fingerprint: string; operationId: string; botId: string; taskId: string }>());
  const importOperations = useRef(new Map<string, string>());
  const selectedBot = bots.find(item => item.id === botId);
  const currentKey = JSON.stringify([botId, taskId]);
  const fingerprint = JSON.stringify([botId, taskId, text.trim()]);
  const sendBlocked = uncertain.current.has(fingerprint);
  const shownMessages = readKey === currentKey ? messages : [];
  const handleError = useCallback((value: unknown) => {
    setError(value);
    if (value instanceof SaaSApiError && [401, 403, 404].includes(value.status)) { setStatus(null); setBots([]); setBotId(''); setTaskId(''); setMessages([]); setReadKey(''); setPendingImport(null); }
  }, []);
  const request = useCallback(async <T,>(fn: (signal: AbortSignal) => Promise<T>) => {
    const controller = new AbortController(); controllers.current.add(controller);
    try { const value = await fn(controller.signal); return controller.signal.aborted || !alive.current ? undefined : value; }
    catch (error) { if (controller.signal.aborted) return undefined; throw error; }
    finally { controllers.current.delete(controller); }
  }, []);
  const refresh = useCallback(async () => {
    if (lock.current) return;
    const generation = ++refreshGeneration.current;
    lock.current = true; setBusy(true); setError(null);
    try {
      const value = await request(signal => readOpenMausStatus(tenantId, signal));
      if (!value) return; setStatus(value);
      if (!value.available) { setBots([]); setBotId(''); setTaskId(''); setMessages([]); setReadKey(''); return; }
      const nextBots = await request(signal => readOpenMausBots(tenantId, signal));
      if (nextBots) setBots(nextBots);
    } catch (value) { if (alive.current && generation === refreshGeneration.current) handleError(value); }
    finally { if (generation === refreshGeneration.current) { lock.current = false; if (alive.current) setBusy(false); } }
  }, [tenantId, request, handleError]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; lock.current = false; refreshGeneration.current++; controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); }; }, [refresh]);
  const run = async (fn: (signal: AbortSignal) => Promise<void>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null); setNotice('');
    try { await request(fn); } catch (value) { if (alive.current) handleError(value); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const changeSelection = (nextBot: string, nextTask: string) => {
    const pending = [...uncertain.current.values()].find(item => item.botId === nextBot && item.taskId === nextTask);
    readGeneration.current++; setBotId(nextBot); setTaskId(nextTask); setMessages([]); setReadKey(''); setPendingImport(null); setResult(pending ? { ...pending, status: 'unknown', message: t('此前发送结果尚未确认，请查看状态。', 'A previous send is unconfirmed. Read its status.') } : null); setError(null); setNotice('');
  };
  const readMessages = () => {
    const generation = ++readGeneration.current;
    void run(async signal => {
      const value = await readOpenMausMessages(tenantId, botId, taskId, signal);
      if (signal.aborted || generation !== readGeneration.current) return;
      setMessages(value.messages); setHasMore(value.hasMore); setReadKey(currentKey);
    });
  };
  const send = () => void run(async signal => {
    if (readOnly || sendBlocked) return;
    const operationId = `openmaus-task-${crypto.randomUUID()}`;
    const pending = { fingerprint, operationId, botId, taskId };
    uncertain.current.set(fingerprint, pending);
    setResult({ operationId, botId, taskId, status: 'sending', message: t('发送请求已发出，等待确认。', 'The send request is awaiting confirmation.') });
    try {
      const value = await sendOpenMausTask(tenantId, { botId, taskId, text: text.trim(), operationId }, signal);
      if (signal.aborted) return;
      setResult(value);
      if (value.status === 'sent') { uncertain.current.delete(fingerprint); setText(''); }
      if (value.status === 'rejected') uncertain.current.delete(fingerprint);
    } catch (value) {
      if (!signal.aborted) setResult({ operationId, botId, taskId, status: 'unknown', message: t('发送结果尚不确定。先查看发送状态和任务消息，不要重复提交。', 'The send outcome is unknown. Read its status and task messages before submitting again.') });
      throw value;
    }
  });
  const readSendStatus = () => void run(async signal => {
    if (!result) return;
    const value = await readOpenMausTask(tenantId, result.operationId, signal);
    if (signal.aborted) return;
    setResult(value);
    if (value.status === 'sent' || value.status === 'rejected') {
      for (const [key, pending] of uncertain.current) if (pending.operationId === value.operationId) uncertain.current.delete(key);
      if (value.status === 'sent') setText('');
    }
  });
  const importMessage = () => void run(async signal => {
    if (!pendingImport || readOnly) return;
    const key = JSON.stringify([botId, taskId, pendingImport.id, importTitle.trim()]);
    const operationId = importOperations.current.get(key) ?? `openmaus-import-${crypto.randomUUID()}`;
    importOperations.current.set(key, operationId);
    const value = await importOpenMausMessage(tenantId, { botId, taskId, messageId: pendingImport.id, title: importTitle.trim(), operationId }, signal);
    if (signal.aborted) return;
    setPendingImport(null); setNotice(t('消息已保存为原始资料。回到知识库可创建并审核知识提案。', 'Message saved as a source. Create and review a knowledge proposal in the workbench.'));
    await onImported?.(value);
  });
  const resultLabel = (value: OpenMausTaskResult['status']) => ({ sent: t('已发送，执行结果待核实', 'Sent; execution is not yet verified'), unknown: t('发送结果未知', 'Send outcome unknown'), rejected: t('请求已拒绝', 'Request rejected'), sending: t('正在确认发送', 'Confirming send') })[value];

  return <section className="openmaus-panel" aria-label={t('OpenMaus 桥接', 'OpenMaus bridge')}>
    <header><div><Bot size={22} /><div><h2>OpenMaus</h2><p>{t('连接已有 Bot，将结果带回知识库', 'Connect existing bots and return evidence to your knowledge base')}</p></div></div><div><button type="button" disabled={busy} onClick={() => void refresh()} aria-label={t('刷新 OpenMaus 状态', 'Refresh OpenMaus status')}><RefreshCw size={16} /></button>{onClose && <button type="button" onClick={onClose} aria-label={t('关闭 OpenMaus 桥接', 'Close OpenMaus bridge')}><X size={18} /></button>}</div></header>
    {error !== null && <p role="alert" className="openmaus-error">{saasErrorMessage(error, locale)}</p>}
    {notice && <p role="status" className="openmaus-notice">{notice}</p>}
    {!status && busy && <p role="status">{t('正在读取连接状态…', 'Reading connection status…')}</p>}
    {status && <div className={`openmaus-status status-${status.status}`}><strong>{status.status === 'disabled' ? t('尚未配置桥接', 'Bridge is not configured') : status.status === 'connected' ? t('桥接已连接', 'Bridge connected') : t('桥接暂时不可用', 'Bridge unavailable')}</strong><p>{status.message}</p>{!status.configured && <p>{t('管理员配置服务端连接并绑定当前工作区后，这里会显示已有 Bot。', 'An administrator can configure a server connection bound to this workspace to show existing bots here.')}</p>}</div>}
    {status?.available && <>
      <div className="openmaus-selection"><label>Bot<select value={botId} onChange={event => changeSelection(event.target.value, '')} disabled={busy}><option value="">{t('选择 Bot', 'Choose bot')}</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.title || bot.name || bot.id}{bot.busy ? ` · ${t('忙碌', 'Busy')}` : ''}</option>)}</select></label><label>{t('任务会话', 'Task session')}<select value={taskId} disabled={!selectedBot || busy} onChange={event => changeSelection(botId, event.target.value)}><option value="">{t('选择已有任务', 'Choose existing task')}</option>{selectedBot?.tasks.map(task => <option key={task.id} value={task.id}>{task.title || task.id}{task.busy ? ` · ${t('运行中', 'Running')}` : ''}</option>)}</select></label><button type="button" disabled={!botId || !taskId || busy} onClick={readMessages}>{t('读取任务消息', 'Read task messages')}</button></div>
      {bots.length === 0 && <p className="openmaus-empty">{t('连接可用，但尚无 Bot。请在 OpenMaus 中配置。', 'The bridge is connected but no bots are available. Configure one in OpenMaus.')}</p>}
      {selectedBot && <p className="openmaus-description">{selectedBot.description}{selectedBot.activity ? ` · ${selectedBot.activity}` : ''}</p>}
      {!readOnly && <form className="openmaus-task-form" onSubmit={event => { event.preventDefault(); send(); }}><label>{t('发送给此任务的内容', 'Message for this task')}<textarea rows={4} maxLength={12000} value={text} onChange={event => setText(event.target.value)} placeholder={t('写明本次任务及边界，点击后发送到所选 Bot。', 'Describe the task and scope. Send explicitly to the selected bot.')} /></label><div><p>{t('发送操作可能触发 Bot 执行。审批或需要输入的步骤请回到 OpenMaus 处理。', 'Sending can start bot execution. Handle approvals or input requests in OpenMaus.')}</p><button className="openmaus-primary" type="submit" disabled={!botId || !taskId || !text.trim() || busy || sendBlocked}><Send size={15} />{t('发送任务', 'Send task')}</button></div></form>}
      {result && <div className={`openmaus-send-result result-${result.status}`} role="status"><strong>{resultLabel(result.status)}</strong><p>{result.message}</p><code>{result.operationId}</code><button type="button" disabled={busy} onClick={readSendStatus}>{t('查看发送状态', 'Read send status')}</button></div>}
      <div className="openmaus-messages"><h3>{t('任务消息', 'Task messages')}</h3>{readKey !== currentKey ? <p className="openmaus-empty">{t('选择 Bot 和任务后，点击读取任务消息。', 'Choose a bot and task, then read its messages.')}</p> : shownMessages.length === 0 ? <p className="openmaus-empty">{t('此任务暂无可读取的消息。', 'No messages are available for this task.')}</p> : shownMessages.map(message => <article key={message.id}><div className="openmaus-message-meta"><strong>{message.role}</strong><span>{message.kind}</span><time dateTime={message.at}>{message.at}</time></div><pre>{message.text}</pre>{message.queued && <p className="openmaus-tag">{t('消息排队中', 'Message queued')}</p>}{message.needsInput && <p className="openmaus-tag">{t('需要输入或审批，请在 OpenMaus 中处理', 'Input or approval required; handle it in OpenMaus')}</p>}{message.hasImage && <p className="openmaus-tag">{t('消息含图片，请到 OpenMaus 查看', 'Message includes an image; view it in OpenMaus')}</p>}{message.truncated && <p className="openmaus-tag">{t('此处仅显示部分文本', 'Only part of the text is shown')}</p>}{!readOnly && message.text.trim() && !message.truncated && <button type="button" disabled={busy} onClick={() => { setPendingImport(message); setImportTitle(`${selectedBot?.title || selectedBot?.name || botId} · ${t('任务记录', 'Task record')}`); }}><Download size={14} />{t('将此消息存为原始资料', 'Save this message as a source')}</button>}</article>)}{readKey === currentKey && hasMore && <p className="openmaus-description">{t('还有更多消息。完整历史请在 OpenMaus 中查看。', 'More messages exist. View the full history in OpenMaus.')}</p>}</div>
      {pendingImport && <form className="openmaus-import-review" onSubmit={event => { event.preventDefault(); importMessage(); }}><h3>{t('确认入库内容', 'Review source import')}</h3><pre>{pendingImport.text}</pre><label>{t('资料标题', 'Source title')}<input required maxLength={500} value={importTitle} onChange={event => setImportTitle(event.target.value)} /></label><div><button type="button" onClick={() => setPendingImport(null)}>{t('取消', 'Cancel')}</button><button type="submit" className="openmaus-primary" disabled={busy || !importTitle.trim()}>{t('确认保存原始资料', 'Save original source')}</button></div></form>}
    </>}
  </section>;
}
