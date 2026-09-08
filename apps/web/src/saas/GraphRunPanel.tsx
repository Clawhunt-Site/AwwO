import { useEffect, useState } from 'react';
import { api, tenantPath, saasErrorMessage } from './api';
import { graphPath, graphIsActive, type GraphRunSnapshot, type TeamTurn } from './graphRuns';
import { useSaaSPreferences } from './preferences';
import './graph-runs.css';

export function GraphRunPanel({ tenantId, canvasId, readOnly = false }: { tenantId: string; canvasId: string; readOnly?: boolean }) {
  const { locale, t } = useSaaSPreferences();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<GraphRunSnapshot[]>([]);
  const [selected, setSelected] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [turns, setTurns] = useState<TeamTurn[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [turnError, setTurnError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const current = items.find(item => item.id === selected) || items[0];
  const node = current?.nodes.find(item => item.nodeId === nodeId) || current?.nodes.find(item => item.runId) || current?.nodes[0];
  const active = items.some(graphIsActive);
  const status = (value: string) => ({ queued: t('排队中', 'Queued'), waiting: t('等待上游', 'Waiting'), running: t('运行中', 'Running'),
    completed: t('完成', 'Completed'), done: t('完成', 'Completed'), failed: t('失败', 'Failed'), cancelled: t('已停止', 'Cancelled'),
    interrupted: t('已中断', 'Interrupted'), blocked: t('上游阻断', 'Blocked'), cached: t('沿用已有结果', 'Cached'), 'Graph cancelled': t('已停止', 'Cancelled') }[value] || value);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api<{ items: GraphRunSnapshot[] }>(graphPath(tenantId, canvasId), { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!Array.isArray(result.items) || result.items.some(item => !item || typeof item.id !== 'string' || !Array.isArray(item.nodes))) throw new Error('Invalid graph run response');
        setItems(result.items); setError(null);
      } catch (error) { if (!controller.signal.aborted) setError(error); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), open ? 2000 : 5000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tenantId, canvasId, open, refresh]);
  useEffect(() => {
    setTurns([]); setTurnError(null);
    if (!open || !node?.runId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api<{ items: TeamTurn[] }>(tenantPath(tenantId, `/runs/${encodeURIComponent(node.runId!)}/turns`), { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!Array.isArray(result.items)) throw new Error('Invalid member turn response');
        setTurns(result.items); setTurnError(null);
      } catch (error) { if (!controller.signal.aborted) setTurnError(error); }
      if (!controller.signal.aborted && current && graphIsActive(current)) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tenantId, node?.runId, open, current?.status]);
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
        <nav aria-label={t('运行节点', 'Run nodes')}>{current.nodes.map(item => <button key={item.nodeId} aria-pressed={node?.nodeId === item.nodeId} onClick={() => setNodeId(item.nodeId)}>
          {current.document?.nodes.find(n => n.id === item.nodeId)?.title || item.nodeId} · {status(item.state)}
        </button>)}</nav>
        {node && <><p>{node.detail && status(node.detail)}</p>{node.output && <details open><summary>{t('节点最终结果', 'Node result')}</summary><pre>{node.output}</pre></details>}</>}
        <h3>{t('成员发言与审核', 'Member turns & review')}</h3>
        {turnError !== null && <p role="alert">{saasErrorMessage(turnError, locale)}</p>}
        {!turns.length && turnError === null && <p>{t('此节点暂无成员协作记录；单 Agent 的对话仍显示在节点中。', 'No team turns for this node yet. Single-agent conversations remain in the node.')}</p>}
        {turns.map(turn => <article className="saas-team-turn" key={turn.id}>
          <div><strong>{turn.memberName}</strong><span>{turn.role} · {t('第', 'Round ')}{turn.round}{t('轮', '')} · {status(turn.status)}</span></div>
          {turn.model && <small>{turn.model}</small>}
          {turn.output && <pre>{turn.output}</pre>}{turn.error && <p role="alert">{turn.error}</p>}
        </article>)}
      </>}
    </section>}
  </div>;
}
