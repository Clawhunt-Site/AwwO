import { useEffect, useState } from 'react';
import { api, saasErrorMessage } from './api';
import { graphPath, graphIsActive, validGraphCollaboration, type GraphRunSnapshot, type GraphCollaborationPhase } from './graphRuns';
import { TeamRunDetails } from './TeamRunDetails';
import { useSaaSPreferences } from './preferences';
import './graph-runs.css';

type GraphRunPanelProps = { tenantId: string; canvasId: string; readOnly?: boolean };
export function GraphRunPanel(props: GraphRunPanelProps) {
  return <GraphRunPanelView key={JSON.stringify([props.tenantId, props.canvasId])} {...props} />;
}
function GraphRunPanelView({ tenantId, canvasId, readOnly = false }: GraphRunPanelProps) {
  const { locale, t } = useSaaSPreferences();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<GraphRunSnapshot[]>([]);
  const [selected, setSelected] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const current = items.find(item => item.id === selected) || items[0];
  const node = current?.nodes.find(item => item.nodeId === nodeId) || current?.nodes.find(item => item.runId) || current?.nodes[0];
  const active = items.some(graphIsActive);
  const phase = (value: GraphCollaborationPhase) => ({ proposal: t('提案与修订', 'Proposal / revision'), review: t('交叉评议', 'Peer review'), synthesis: t('最终汇总', 'Final synthesis') }[value]);
  const nodeTitle = (id: string) => current?.document?.nodes.find(item => item.id === id)?.title || id;
  const status = (value: string) => ({ queued: t('排队中', 'Queued'), waiting: t('等待上游', 'Waiting'), running: t('运行中', 'Running'),
    completed: t('完成', 'Completed'), done: t('完成', 'Completed'), failed: t('失败', 'Failed'), cancelled: t('已停止', 'Cancelled'),
    interrupted: t('已中断', 'Interrupted'), blocked: t('上游阻断', 'Blocked'), cached: t('沿用已有结果', 'Cached'), 'Graph cancelled': t('已停止', 'Cancelled') }[value] || value);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api<{ items: GraphRunSnapshot[] }>(graphPath(tenantId, canvasId), { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!Array.isArray(result.items) || result.items.some(item => !item || typeof item.id !== 'string' || !Array.isArray(item.nodes)
          || (item.collaboration != null && !validGraphCollaboration(item.collaboration, item.scope)))) throw new Error('Invalid graph run response');
        setItems(result.items); setError(null);
      } catch (error) { if (!controller.signal.aborted) setError(error); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), open ? 2000 : 5000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tenantId, canvasId, open, refresh]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [open]);
  return <div className="saas-graph-control">
    <button onClick={() => setOpen(!open)} aria-expanded={open}>{active ? '● ' : ''}{t('后台运行与协作记录', 'Background runs & collaboration')}</button>
    {open && <section className="saas-graph-panel" role="dialog" aria-label={t('后台运行与协作记录', 'Background runs & collaboration')}>
      <header><h2>{t('后台运行与协作记录', 'Background runs & collaboration')}</h2><button aria-label={t('关闭运行记录', 'Close run history')} onClick={() => setOpen(false)}>×</button></header>
      <p>{t('任务提交后由后台继续调度。离开或关闭页面不会停止任务。', 'Accepted tasks keep running in the background when you leave or close this page.')}</p>
      {error !== null && <p role="alert">{saasErrorMessage(error, locale)} <button onClick={() => setRefresh(refresh + 1)}>{t('重试', 'Retry')}</button></p>}
      {!items.length && error === null && <p role="status">{t('还没有后台整图运行记录。', 'No background graph runs yet.')}</p>}
      {current && <>
        <label>{t('选择运行', 'Select run')}<select value={current.id} onChange={event => { setSelected(event.target.value); setNodeId(''); }}>
          {items.map(item => <option value={item.id} key={item.id}>{new Date(item.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')} · {status(item.status)}</option>)}
        </select></label>
        <div className="saas-graph-summary"><strong role="status">{status(current.status)}</strong><span>{current.nodes.filter(item => item.state === 'done').length}/{current.scope?.length || current.nodes.filter(item => item.state !== 'cached').length} {t('节点完成', 'nodes completed')}</span>
          {!readOnly && graphIsActive(current) && <button disabled={busy} onClick={async () => {
            setBusy(true);
            try { await api(`${graphPath(tenantId, canvasId)}/${encodeURIComponent(current.id)}/cancel`, { method: 'POST', body: '{}' }); setRefresh(refresh + 1); }
            catch (error) { setError(error); } finally { setBusy(false); }
          }}>{t('停止整个任务', 'Stop entire task')}</button>}
        </div>
        {current.error && <p role="alert">{status(current.error)}</p>}
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
              {turn.error && <p>{turn.error}</p>}
            </details>
          </li>)}</ol>
        </section>}
        <nav aria-label={t('运行节点', 'Run nodes')}>{current.nodes.map(item => <button key={item.nodeId} aria-pressed={node?.nodeId === item.nodeId} onClick={() => setNodeId(item.nodeId)}>
          {current.document?.nodes.find(n => n.id === item.nodeId)?.title || item.nodeId} · {status(item.state)}
        </button>)}</nav>
        {node && <><p>{node.detail && status(node.detail)}</p>{node.output && <details open><summary>{node.partial || (current.collaboration && (current.status !== 'completed' || node.nodeId !== current.collaboration.synthesizerNodeId)) ? t('节点候选结果', 'Node candidate result') : t('节点最终结果', 'Node result')}</summary><pre>{node.output}</pre></details>}</>}
        {!current.collaboration && (node?.runId ? <TeamRunDetails tenantId={tenantId} runId={node.runId} runStatus={node.state} defaultOpen />
          : <p>{t('此节点还没有实际调用记录。', 'This node has no model call record yet.')}</p>)}
      </>}
    </section>}
  </div>;
}
