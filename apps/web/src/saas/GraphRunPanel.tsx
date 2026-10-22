import { useEffect, useRef, useState } from 'react';
import { api, saasErrorMessage } from './api';
import { runFailureText } from './canvasErrors';
import { graphPath, graphIsActive, publishGraphRuns, readGraphRun, validGraphRunList, type GraphRunSnapshot, type GraphRunSummary, type GraphCollaborationPhase } from './graphRuns';
import { TeamRunDetails } from './TeamRunDetails';
import { RunEvidence } from './RunEvidence';
import { GraphNodeOutput } from './GraphNodeOutput';
import { GraphEvidenceDownload } from './GraphEvidenceDownload';
import { useSaaSPreferences } from './preferences';
import { containDialogTab } from '../ui/Popover';
import './graph-runs.css';

type GraphRunPanelProps = { tenantId: string; canvasId: string; readOnly?: boolean };
export function GraphRunPanel(props: GraphRunPanelProps) {
  return <GraphRunPanelView key={JSON.stringify([props.tenantId, props.canvasId])} {...props} />;
}
function GraphRunPanelView({ tenantId, canvasId, readOnly = false }: GraphRunPanelProps) {
  const { locale, t } = useSaaSPreferences();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [items, setItems] = useState<GraphRunSummary[]>([]);
  // The run the panel shows as its own route last read it, whole: the canvas it froze and every node's output, which the
  // list leaves out. Only the open panel reads it; `read` holds the same for the poll that decides whether to read again.
  const [shown, setShown] = useState<GraphRunSnapshot | null>(null);
  const read = useRef<GraphRunSnapshot | null>(null);
  const [selected, setSelected] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const listed = items.find(item => item.id === selected) || items[0];
  const current = listed && shown?.id === listed.id ? shown : undefined;
  const node = current?.nodes.find(item => item.nodeId === nodeId) || current?.nodes.find(item => item.runId) || current?.nodes[0];
  const active = items.some(graphIsActive);
  const phase = (value: GraphCollaborationPhase) => ({ proposal: t('提案与修订', 'Proposal / revision'), review: t('交叉评议', 'Peer review'), synthesis: t('最终汇总', 'Final synthesis') }[value]);
  const nodeTitle = (id: string) => current?.document?.nodes.find(item => item.id === id)?.title || id;
  const status = (value: string) => ({ queued: t('排队中', 'Queued'), waiting: t('等待上游', 'Waiting'), running: t('运行中', 'Running'),
    completed: t('完成', 'Completed'), done: t('完成', 'Completed'), failed: t('失败', 'Failed'), cancelled: t('已停止', 'Cancelled'),
    interrupted: t('已中断', 'Interrupted'), blocked: t('上游阻断', 'Blocked'), cached: t('沿用已有结果', 'Cached'), 'Graph cancelled': t('已停止', 'Cancelled'),
    output_contract_invalid: t('输出不符合交付格式', 'Output did not match the delivery format'),
    model_refused: t('模型拒绝了请求', 'The model declined the request'), provider_auth_failed: t('模型服务拒绝了凭据', 'The provider rejected the credentials'),
    provider_rate_limited: t('模型服务限流', 'The provider is rate limited'), provider_unavailable: t('模型服务暂不可用', 'The provider is unavailable') }[value]
    // Any other failure a node records (its run's code, or its admission's) reads as it does on the node, with what to do.
    || runFailureText(value, locale) || value);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    // Whether this opening of the panel, or this pick of a run, has read the run it shows yet.
    let fresh = false;
    const poll = async () => {
      let failure: unknown = null;
      try {
        const result = await api<unknown>(graphPath(tenantId, canvasId), { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!validGraphRunList(result)) throw new Error('Invalid graph run response');
        setItems(result.items); publishGraphRuns(tenantId, canvasId, result.items);
        // The list holds no run's canvas or outputs (whole, a film canvas's last 50 runs came to 20-55 MB a poll). The open
        // panel reads the run it shows whole when it opens and when another run is picked, then again only when the list
        // says it changed, or on every poll while it is a collaboration going on (stale, below).
        const target = open ? result.items.find(item => item.id === selected) || result.items[0] : undefined;
        if (target && (!fresh || stale(read.current, target))) {
          const run = await readGraphRun(tenantId, canvasId, target.id, controller.signal);
          if (controller.signal.aborted) return;
          fresh = true; read.current = run; setShown(run);
        }
      } catch (error) { failure = error; }
      if (controller.signal.aborted) return;
      setError(failure);
      timer = setTimeout(() => void poll(), open ? 2000 : 5000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tenantId, canvasId, open, refresh, selected]);
  useEffect(() => {
    // Closed, the panel forgets its read: opened again, it shows what the list says until the run is read anew, never an
    // earlier opening's read as if it were current.
    if (!open) { read.current = null; setShown(null); return; }
    panel.current?.focus({ preventScroll: true });
  }, [open]);
  return <div className="saas-graph-control">
    <button ref={trigger} data-onboarding="run-history" onClick={() => setOpen(!open)} aria-expanded={open}>{active ? '● ' : ''}{t('运行记录', 'Run history')}</button>
    {open && <section ref={panel} tabIndex={-1} onKeyDown={event => { event.stopPropagation(); containDialogTab(event); if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); } }} className="saas-graph-panel" role="dialog" aria-label={t('运行记录', 'Run history')}>
      <header><h2>{t('运行记录', 'Run history')}</h2><button aria-label={t('关闭运行记录', 'Close run history')} onClick={() => { setOpen(false); trigger.current?.focus(); }}>×</button></header>
      <p>{t('任务提交后由后台继续调度。离开或关闭页面不会停止任务。', 'Accepted tasks keep running in the background when you leave or close this page.')}</p>
      {error !== null && <p role="alert">{saasErrorMessage(error, locale)} <button onClick={() => setRefresh(refresh + 1)}>{t('重试', 'Retry')}</button></p>}
      {!items.length && error === null && <p role="status">{t('还没有后台整图运行记录。', 'No background graph runs yet.')}</p>}
      {listed && <>
        <label>{t('选择运行', 'Select run')}<select value={listed.id} onChange={event => { setSelected(event.target.value); setNodeId(''); }}>
          {items.map(item => <option value={item.id} key={item.id}>{new Date(item.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')} · {status(item.status)}</option>)}
        </select></label>
        <div className="saas-graph-summary"><strong role="status">{status(listed.status)}</strong><span>{listed.nodes.filter(item => item.state === 'done').length}/{listed.scope?.length || listed.nodes.filter(item => item.state !== 'cached').length} {t('节点完成', 'nodes completed')}</span>
          {!readOnly && graphIsActive(listed) && <button disabled={busy} onClick={async () => {
            setBusy(true);
            try { await api(`${graphPath(tenantId, canvasId)}/${encodeURIComponent(listed.id)}/cancel`, { method: 'POST', body: '{}' }); setRefresh(refresh + 1); }
            catch (error) { setError(error); } finally { setBusy(false); }
          }}>{t('停止整个任务', 'Stop entire task')}</button>}
        </div>
        <GraphEvidenceDownload tenantId={tenantId} canvasId={canvasId} graphId={listed.id} />
        {listed.error && <p role="alert">{status(listed.error)}</p>}
        {!current ? error === null && <p aria-live="polite">{t('正在读取这次运行…', 'Reading this run…')}</p> : <>
          {current.collaboration && <section aria-label={t('选中节点互审过程', 'Selected-node collaboration')}>
            <h3>{t('互审与汇总', 'Peer review and synthesis')}</h3>
            <p>{current.collaboration.goal}</p>
            <p>{phase(current.collaboration.phase)} · {t('第', 'Round')} {current.collaboration.round}/{current.collaboration.rounds}</p>
            <p>{current.collaboration.turns.filter(turn => turn.runId).length}/{current.collaboration.maxModelCalls} {t('次调用已受理', 'calls admitted')} · {t('汇总节点：', 'Synthesizer: ')}{nodeTitle(current.collaboration.synthesizerNodeId)}</p>
            {current.status === 'completed' && <p>{t('交叉评议后的汇总已完成。汇总结果尚未经过额外一轮独立复核。', 'Synthesis after peer review is complete. The synthesis has not had an additional independent review.')}</p>}
            <ol>{[...current.collaboration.turns].sort((a, b) => a.ordinal - b.ordinal).map(turn => <li key={turn.ordinal}>
              <details open={turn.status === 'running' || turn.status === 'failed' || turn.status === 'interrupted'}>
                <summary>#{turn.ordinal} · {nodeTitle(turn.nodeId)} · {phase(turn.phase)} · {t('第', 'Round')} {turn.round} · {status(turn.status)}</summary>
                {turn.runId ? <><p>{t('运行：', 'Run: ')}<code>{turn.runId}</code></p><p>Session: <code>{turn.sessionId || t('身份尚未读回', 'Identity not yet observed')}</code></p></>
                  : <p>{t('此步骤尚未派发模型调用。', 'No model call has been dispatched for this step.')}</p>}
                {turn.output && <><p>{turn.phase === 'review' ? t('评议记录，不作为正式交付物', 'Review evidence; not a published deliverable')
                  : turn.phase === 'synthesis' && current.status === 'completed' ? t('汇总结果', 'Synthesis result') : t('候选结果', 'Candidate result')}</p><pre>{turn.output}</pre></>}
                {turn.error && <p>{runFailureText(turn.error, locale) ?? turn.error}</p>}
                {turn.runId && <RunEvidence tenantId={tenantId} runId={turn.runId} runStatus={turn.status} />}
              </details>
            </li>)}</ol>
          </section>}
          <nav aria-label={t('运行节点', 'Run nodes')}>{current.nodes.map(item => <button key={item.nodeId} aria-pressed={node?.nodeId === item.nodeId} onClick={() => setNodeId(item.nodeId)}>
            {current.document?.nodes.find(n => n.id === item.nodeId)?.title || item.nodeId} · {status(item.state)}
          </button>)}</nav>
          {node && <>{node.runId && <p>{t('节点运行 ID：', 'Node run ID: ')}<code style={{ overflowWrap: 'anywhere' }}>{node.runId}</code></p>}<p>{node.detail && status(node.detail)}</p><GraphNodeOutput key={`${current.id}:${node.nodeId}`} graph={current} node={node} /></>}
          {!current.collaboration && (node?.runId ? <TeamRunDetails tenantId={tenantId} runId={node.runId} runStatus={node.state} defaultOpen />
            : <p>{t('此节点还没有实际调用记录。', 'This node has no model call record yet.')}</p>)}
        </>}
      </>}
    </section>}
  </div>;
}

/** Whether the run the panel shows, as last read whole, may be behind what the list now says of it. A node's output, run
 *  and detail change only with its state or its attempts (graph_runs.go's setGraphNode, a cancellation's reconcile, a
 *  retry, which goes from running back to running with a new run after a wait no poll need see), so a run is read again
 *  when the list has another status, last update, or node's state or attempts than the read: a film's run of hours is
 *  read once a step, not once a poll, its frozen canvas being a megabyte. A collaboration's turns, which the list does not
 *  carry, go on with no node's state moving: it is read again on every poll while it goes on. */
function stale(shown: GraphRunSnapshot | null, listed: GraphRunSummary): boolean {
  return !shown || shown.id !== listed.id || (Boolean(shown.collaboration) && (graphIsActive(shown) || graphIsActive(listed)))
    || shown.status !== listed.status || shown.updatedAt !== listed.updatedAt || shown.nodes.length !== listed.nodes.length
    || shown.nodes.some((node, index) => node.nodeId !== listed.nodes[index]?.nodeId || node.state !== listed.nodes[index]?.state
      || (node.attempts ?? 0) !== (listed.nodes[index]?.attempts ?? 0));
}
