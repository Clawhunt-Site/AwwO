// The 成果 view's run receipt: what the run records say about the result shown, and nothing they do not.
// It names the latest graph run that completed the result's step (a later single-node run or a manual
// publication may have replaced that step's output since, so it never claims more than "this run
// completed this step"). It reads the run panel's poll (graphRuns feed) instead of polling again, and the
// canvas the run it names froze at admission from that run's own read, which the list does not carry.
import { useEffect, useState } from 'react';
import { caseRunLabel, isMarketReference, type CanvasDocument, type CanvasNode } from '../canvas/canvasDoc';
import { nodeModelName, type ModelNameSources } from '../canvas/modelNames';
import { api } from './api';
import { graphPath, latestGraphRuns, publishGraphRuns, readGraphRun, subscribeGraphRuns, validGraphRunList, type GraphRunSummary } from './graphRuns';
import { useSaaSPreferences } from './preferences';
import { currentSaaSCanvas } from './canvasBridge';
import { MarketRunFee, useRunMarket } from './market/MarketRunFee';

type T = ReturnType<typeof useSaaSPreferences>['t'];
const statusLabel = (t: T, status: GraphRunSummary['status']) => ({ queued: t('排队中', 'Queued'), running: t('运行中', 'Running'),
  completed: t('完成', 'Completed'), failed: t('失败', 'Failed'), cancelled: t('已停止', 'Stopped'), interrupted: t('已中断', 'Interrupted') })[status] ?? status;
function duration(t: T, from: string, to?: string): string {
  const ms = to ? Date.parse(to) - Date.parse(from) : NaN;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t(`${seconds} 秒`, `${seconds}s`);
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? t(`${minutes} 分 ${seconds % 60} 秒`, `${minutes}m ${seconds % 60}s`) : t(`${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`, `${Math.floor(minutes / 60)}h ${minutes % 60}m`);
}

export function CanvasRunReceipt({ tenantId, canvasId, final, names }: { tenantId: string; canvasId: string; final: CanvasNode | null;
  /** What the canvas names models with (its chat models and media catalogue); without it a media model is named by its kind. */
  names?: ModelNameSources }) {
  const { locale, t } = useSaaSPreferences();
  const [runs, setRuns] = useState(() => latestGraphRuns(tenantId, canvasId));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setRuns(latestGraphRuns(tenantId, canvasId));
    const stop = subscribeGraphRuns(tenantId, canvasId, () => { setRuns(latestGraphRuns(tenantId, canvasId)); setFailed(false); });
    // Nobody has read them yet on this page: read once, for everyone.
    const controller = new AbortController();
    if (!latestGraphRuns(tenantId, canvasId)) {
      api<unknown>(graphPath(tenantId, canvasId), { signal: controller.signal }).then(value => {
        if (controller.signal.aborted) return;
        if (validGraphRunList(value)) publishGraphRuns(tenantId, canvasId, value.items); else setFailed(true);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    }
    return () => { stop(); controller.abort(); };
  }, [tenantId, canvasId]);

  const when = (value: string) => new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const output = final && final.kind !== 'form' ? final.lastOutput : null;
  // A partial result is what a step left when a run did not finish it: the receipt names that run instead.
  const partial = output?.partial === true;
  const matches = (state: string) => partial ? state === 'failed' || state === 'cancelled' || state === 'blocked' : state === 'done';
  const run = final && runs?.find(item => item.nodes.some(node => node.nodeId === final.id && matches(node.state)));
  const latest = runs?.[0];
  // The canvas the run froze names the models its steps ran on and tells whether it ran the whole canvas (a copied
  // case's recording names no run, so none is read for it).
  const frozen = useFrozenCanvas(tenantId, canvasId, run && output?.source !== 'case' ? run.id : '');
  // The step's own run, read for a market Agent's fee and rating where the step uses one (a run without one shows
  // nothing more).
  const step = final && run ? run.nodes.find(node => node.nodeId === final.id) : undefined;
  const marketStep = final?.kind === 'session' && isMarketReference(final.agentRef) && output?.source !== 'case';
  const stepRunId = useStepRunId(tenantId, canvasId, marketStep && run ? run.id : '', final?.id ?? '');
  const market = useRunMarket(tenantId, stepRunId);
  let body;
  // A copied case's recording ran in the case, not here: no run of this workspace is claimed for it.
  if (output?.source === 'case') body = <p className="awwo-results-receipt-note">{t(`这份交付是复制来的案例实录（${caseRunLabel(output)}），没有在这个工作区运行；运行整张图会换成你自己的结果。`,
    `This delivery is a copied case recording (${caseRunLabel(output)}), not run in this workspace; running the graph replaces it with your own result.`)}</p>;
  else if (!runs || (run && frozen === undefined)) body = <p className="awwo-results-receipt-note" role="status">{failed ? t('暂时读不到运行记录。', 'The run records cannot be read right now.') : t('正在读取运行记录…', 'Reading the run records…')}</p>;
  else if (run) {
    const counts = { done: 0, cached: 0, failed: 0 };
    for (const node of run.nodes) {
      if (node.state === 'done') counts.done++;
      else if (node.state === 'cached') counts.cached++;
      else if (node.state === 'failed' || node.state === 'blocked' || node.state === 'cancelled') counts.failed++;
    }
    // The models of the steps that actually ran in it, as the run recorded them, named as the canvas names them: a media
    // model only by its generic name (图片 · 高清), never by the id that says who generates it.
    const ran = new Set(run.nodes.filter(node => node.state === 'done' || node.state === 'failed').map(node => node.nodeId));
    const models = new Map<string, number>();
    for (const node of frozen?.nodes ?? []) {
      if (!node || node.kind !== 'session' || !ran.has(node.id) || typeof node.model !== 'string' || !node.model) continue;
      const name = nodeModelName(node, names ?? {}, locale);
      if (name) models.set(name, (models.get(name) ?? 0) + 1);
    }
    const scope = Array.isArray(run.scope) ? run.scope : [];
    const whole = Boolean(frozen?.nodes.length) && frozen!.nodes.every(node => node && scope.includes(node.id));
    const took = graphFinished(run) ? duration(t, run.createdAt, run.updatedAt) : '';
    body = <>
      <p className="awwo-results-receipt-lead">{partial ? t('最近一次没有完成这一步的运行', 'The latest run that did not finish this step')
        : t('最近一次完成这一步的运行', 'The latest run that completed this step')}</p>
      <dl>
        <div><dt>{t('状态', 'Status')}</dt><dd>{statusLabel(t, run.status)}</dd></div>
        <div><dt>{t('范围', 'Scope')}</dt><dd>{whole ? t('整张画布', 'The whole canvas') : t(`${scope.length} 步`, `${scope.length} ${scope.length === 1 ? 'step' : 'steps'}`)}</dd></div>
        <div><dt>{t('开始', 'Started')}</dt><dd><time dateTime={run.createdAt}>{when(run.createdAt)}</time></dd></div>
        {took && <div><dt>{t('用时', 'Took')}</dt><dd>{took}</dd></div>}
        <div><dt>{t('步骤', 'Steps')}</dt><dd>{[t(`${counts.done} 步完成`, `${counts.done} completed`),
          counts.cached ? t(`${counts.cached} 步沿用上次结果`, `${counts.cached} reused`) : '',
          counts.failed ? t(`${counts.failed} 步未完成`, `${counts.failed} not completed`) : ''].filter(Boolean).join(' · ')}</dd></div>
        {models.size > 0 && <div><dt>{t('模型', 'Models')}</dt><dd>{[...models].map(([model, count]) => t(`${model}（${count} 步）`, `${model} (${count})`)).join('，')}</dd></div>}
        {market && stepRunId && <div><dt>{t('市场 Agent', 'Market Agent')}</dt><dd><MarketRunFee tenantId={tenantId} runId={stepRunId} market={market}
          completed={step?.state === 'done'} canRate={currentSaaSCanvas()?.tenant.role !== 'reader'} /></dd></div>}
        <div><dt>{t('运行编号', 'Run')}</dt><dd>{run.id.slice(0, 10)}</dd></div>
      </dl>
      {output && output.at > 0 && Date.parse(run.updatedAt ?? run.createdAt) + 60_000 < output.at && <p className="awwo-results-receipt-note">
        {t('这一步在这次运行之后又更新过交付。', 'This step’s delivery was updated after this run.')}</p>}
      <p className="awwo-results-receipt-note">{partial ? t('显示的是这一步中断前留下的部分内容。完整过程见「运行记录」。', 'What is shown is what the step left before it stopped. The full record is in Run history.')
        : t('运行完成不等于人工验收通过。完整过程见「运行记录」。', 'A completed run is not a person’s acceptance. The full record is in Run history.')}</p>
    </>;
  } else body = <>
    {final && <p className="awwo-results-receipt-note">{output?.source === 'manual' ? t('这份交付是手动发布的，没有对应的运行记录。', 'This delivery was published by hand; no run produced it.')
      : runs.length ? t(`最近 ${runs.length} 次运行里没有${partial ? '中断' : '完成'}这一步的记录。`, `None of the latest ${runs.length} runs ${partial ? 'stopped' : 'completed'} this step.`)
        : t('没有找到这一步的运行记录。', 'No run record of this step was found.')}</p>}
    {latest ? <p className="awwo-results-receipt-note">{t(`最近一次运行：${statusLabel(t, latest.status)} · ${when(latest.createdAt)}`, `Latest run: ${statusLabel(t, latest.status)} · ${when(latest.createdAt)}`)}</p>
      : !final && <p className="awwo-results-receipt-note">{t('还没有运行记录。', 'No runs yet.')}</p>}
  </>;
  return <section className="awwo-results-receipt" aria-label={t('运行回执', 'Run receipt')}>
    <h3>{t('运行回执', 'Run receipt')}</h3>
    {body}
  </section>;
}

const graphFinished = (run: GraphRunSummary) => run.status !== 'queued' && run.status !== 'running';

/** The run a graph run's step made (the run list does not carry it), read only where it is asked for: a step whose node
 *  uses a market Agent, whose fee and rating are the run's. */
function useStepRunId(tenantId: string, canvasId: string, graphRunId: string, nodeId: string): string | undefined {
  const key = JSON.stringify([tenantId, canvasId, graphRunId, nodeId]);
  const [read, setRead] = useState<{ key: string; runId?: string } | null>(null);
  useEffect(() => {
    if (!graphRunId || !nodeId) return;
    const controller = new AbortController();
    readGraphRun(tenantId, canvasId, graphRunId, controller.signal).then(run => {
      if (!controller.signal.aborted) setRead({ key, runId: run.nodes.find(node => node.nodeId === nodeId)?.runId });
    }, () => undefined);
    return () => controller.abort();
  }, [tenantId, canvasId, graphRunId, nodeId, key]);
  return read?.key === key ? read.runId : undefined;
}

// The canvases runs froze at admission, as their own reads gave them, by tenant, canvas and run. A run's frozen canvas
// never changes, so a page reads it once; the few kept are the latest read (a film's is a megabyte).
const frozenCanvases = new Map<string, CanvasDocument | null>();
const FROZEN_CANVASES_KEPT = 4;
/** The canvas a run froze at admission (null when it cannot be read, or the run has none), or undefined while it is read. */
function useFrozenCanvas(tenantId: string, canvasId: string, runId: string): CanvasDocument | null | undefined {
  const key = JSON.stringify([tenantId, canvasId, runId]);
  const [read, setRead] = useState<{ key: string; canvas: CanvasDocument | null } | null>(null);
  useEffect(() => {
    if (!runId) return;
    // Held here too: another receipt's later read may push it out of the page's few.
    if (frozenCanvases.has(key)) { setRead({ key, canvas: frozenCanvases.get(key) ?? null }); return; }
    const controller = new AbortController();
    readGraphRun(tenantId, canvasId, runId, controller.signal).then(run => {
      const canvas = run.document ?? null;
      frozenCanvases.delete(key); frozenCanvases.set(key, canvas);
      for (const old of [...frozenCanvases.keys()].slice(0, -FROZEN_CANVASES_KEPT)) frozenCanvases.delete(old);
      if (!controller.signal.aborted) setRead({ key, canvas });
    }, () => {
      // Unread, the receipt says what the list says (the steps in the run's scope, no models); a later visit reads again.
      if (!controller.signal.aborted) setRead({ key, canvas: null });
    });
    return () => controller.abort();
  }, [tenantId, canvasId, runId, key]);
  if (!runId) return null;
  if (frozenCanvases.has(key)) return frozenCanvases.get(key) ?? null;
  return read?.key === key ? read.canvas : undefined;
}
