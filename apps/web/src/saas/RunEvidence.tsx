import { useEffect, useRef, useState } from 'react';
import { isTaskFrame } from '../canvas/taskFrame';
import { SaaSApiError, saasErrorMessage } from './api';
import { readRunEvidence, readRunInvocations, downloadRunArchive, type RunEvidenceSummary, type RunInvocation } from './runEvidenceApi';
import { useSaaSPreferences } from './preferences';
import './run-evidence.css';

type Props = { tenantId: string; runId: string; runStatus?: string };
export function RunEvidence(props: Props) {
  return <RunEvidenceView key={JSON.stringify([props.tenantId, props.runId])} {...props} />;
}

function RunEvidenceView({ tenantId, runId, runStatus }: Props) {
  const { locale, t } = useSaaSPreferences();
  const [open, setOpen] = useState(false);
  const [callsOpen, setCallsOpen] = useState(false);
  const [summary, setSummary] = useState<RunEvidenceSummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const download = useRef<AbortController | null>(null);
  useEffect(() => () => { download.current?.abort(); }, []);
  useEffect(() => {
    if (!open || !tenantId || !runId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    setSummary(null); setError(null);
    const observe = async () => {
      try {
        const next = await readRunEvidence(tenantId, runId, controller.signal);
        if (controller.signal.aborted) return;
        setSummary(next); setError(null);
        if (next.status === 'queued' || next.status === 'running') timer = setTimeout(() => void observe(), 2000);
      } catch (error) { if (!controller.signal.aborted) { setSummary(null); setError(error); } }
    };
    void observe();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tenantId, runId, open, runStatus, refresh]);
  const frame = isTaskFrame(summary?.taskFrame) ? summary.taskFrame : null;
  const sourceName = (source: string) => ({ model_output: t('模型输出', 'Model output'), contract_validated: t('交付格式检查', 'Delivery format check'), artifact_stored: t('已保存附件', 'Stored artifact') }[source] || source);
  return <section className="saas-run-evidence" aria-label={t('运行证据', 'Run evidence')}>
    <div className="saas-evidence-actions">
      <button type="button" className="saas-evidence-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t('证据摘要', 'Evidence summary')}</button>
      <button type="button" className="saas-evidence-toggle" aria-expanded={callsOpen} onClick={() => setCallsOpen(value => !value)}>{t('模型调用', 'Model calls')}</button>
    </div>
    {callsOpen && <ModelInvocationEvidence tenantId={tenantId} runId={runId} runStatus={runStatus} />}
    {open && <div className="saas-evidence-body">
      {error !== null && <p role="alert">{saasErrorMessage(error, locale)} <button type="button" onClick={() => setRefresh(value => value + 1)}>{t('重试', 'Retry')}</button></p>}
      {!summary && error === null && <p role="status">{t('正在读取证据…', 'Loading evidence…')}</p>}
      {summary && <>
        <p className="saas-evidence-acceptance"><strong>{t('人工验收尚未确认', 'Human acceptance has not been confirmed')}</strong></p>
        <p>{t('这里展示本次运行保存的记录，运行完成或格式通过不代表人工验收通过。', 'These are saved observations from this run. Completion or a valid output format does not confirm human acceptance.')}</p>
        <dl>
          <dt>{t('输出', 'Output')}</dt><dd>{summary.outputPresent ? `${summary.outputBytes} ${t('字节', 'bytes')}` : t('未记录输出', 'No output recorded')}</dd>
          <dt>{t('附件', 'Artifacts')}</dt><dd>{summary.artifactCount}</dd>
        </dl>
        <p>{summary.contract.declared ? summary.contract.validated ? t('交付格式：已通过检查', 'Delivery format: validated') : t('交付格式：尚未通过检查', 'Delivery format: not validated') : t('交付格式：未声明', 'Delivery format: not declared')}</p>
        <p>{t('证据来源：', 'Evidence sources: ')}{summary.evidenceSources.length ? summary.evidenceSources.map(sourceName).join(' · ') : t('暂无已记录来源', 'No sources recorded')}</p>
        {frame && <div className="saas-evidence-task-frame"><strong>{t('本次任务要求（人工填写）', 'Requirements for this run (human-authored)')}</strong>
          {(['constraints', 'acceptanceCriteria'] as const).map(field => <div key={field}><p>{field === 'constraints' ? t('约束', 'Constraints') : t('验收标准', 'Acceptance criteria')}</p>
            {frame[field].length ? <ul>{frame[field].map((entry, index) => <li key={index}>{entry}</li>)}</ul> : <p>{t('未填写', 'Not specified')}</p>}</div>)}
        </div>}
        {summary.taskFrame !== undefined && !frame && <p>{t('此记录的任务要求版本暂不支持展示。', 'This requirement version cannot be displayed here.')}</p>}
        {summary.preview && <details><summary>{t('查看输出预览', 'View output preview')}</summary><pre>{summary.preview}</pre></details>}
        {summary.previewTruncated && <p>{t('预览已截取；可下载脱敏记录继续核对。', 'The preview is truncated. Download the redacted record for further review.')}</p>}
        <button type="button" disabled={downloading} onClick={async () => {
          if (download.current) return;
          const controller = new AbortController(); download.current = controller; setDownloading(true);
          try { await downloadRunArchive(tenantId, runId, controller.signal); }
          catch (error) { if (!controller.signal.aborted) setError(error); }
          finally { if (!controller.signal.aborted) { download.current = null; setDownloading(false); } }
        }}>{downloading ? t('正在下载…', 'Downloading…') : t('下载脱敏记录', 'Download redacted record')}</button>
      </>}
    </div>}
  </section>;
}

function ModelInvocationEvidence({ tenantId, runId, runStatus }: Props) {
  const { locale, t } = useSaaSPreferences();
  const [items, setItems] = useState<RunInvocation[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!tenantId || !runId) return;
    const request = new AbortController();
    controller.current = request;
    setItems(null); setCursor(null); setError(null); setLoadingMore(false);
    void readRunInvocations(tenantId, runId, request.signal).then(page => {
      if (request.signal.aborted) return;
      setItems(page.items); setCursor(page.page.nextCursor);
    }).catch(error => {
      if (request.signal.aborted) return;
      setItems(null); setCursor(null); setError(error);
    });
    return () => { request.abort(); if (controller.current === request) controller.current = null; };
  }, [tenantId, runId, runStatus, refresh]);

  const loadMore = async () => {
    const request = controller.current;
    if (!request || !cursor || loadingMore) return;
    setLoadingMore(true); setError(null);
    try {
      const page = await readRunInvocations(tenantId, runId, request.signal, cursor);
      if (request.signal.aborted) return;
      setItems(previous => {
        const seen = new Set(previous?.map(item => item.id) || []);
        return [...(previous || []), ...page.items.filter(item => !seen.has(item.id))];
      });
      setCursor(page.page.nextCursor);
    } catch (error) {
      if (!request.signal.aborted) {
        if (error instanceof SaaSApiError && [401, 403, 404].includes(error.status)) { setItems(null); setCursor(null); }
        setError(error);
      }
    } finally { if (!request.signal.aborted) setLoadingMore(false); }
  };
  const message = error instanceof SaaSApiError && error.code === 'invalid_run_invocations'
    ? t('模型调用记录响应无效，请重试。', 'Invalid model call record. Please retry.') : saasErrorMessage(error, locale);
  const states: Record<string, string> = { running: t('运行中', 'Running'), completed: t('完成', 'Completed'), failed: t('失败', 'Failed'), cancelled: t('已停止', 'Cancelled'), interrupted: t('已中断', 'Interrupted') };
  const runState = (status: string) => states[status] || status;
  const usageText = (item: RunInvocation) => {
    const { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, reasoningTokens, providerTotalTokens, computedTotalTokens } = item.usage;
    const supplementary = [
      cachedInputTokens === null ? '' : `${t('缓存输入', 'Cached input')} ${cachedInputTokens}`,
      cacheWriteTokens === null ? '' : `${t('写入缓存', 'Cache write')} ${cacheWriteTokens}`,
      reasoningTokens === null ? '' : `${t('推理', 'Reasoning')} ${reasoningTokens}`,
      providerTotalTokens === null || computedTotalTokens !== null ? '' : `${t('服务商总量', 'Provider total')} ${providerTotalTokens}`,
    ].filter(Boolean);
    const extra = supplementary.length ? ` · ${supplementary.join(' · ')}` : '';
    if (item.usageStatus === 'reported') return `${t('输入', 'Input')} ${inputTokens} · ${t('输出', 'Output')} ${outputTokens}${computedTotalTokens !== null ? ` · ${t('合计', 'Total')} ${computedTotalTokens}` : ''}${extra} tokens`;
    if (item.usageStatus === 'partial') return `${t('部分用量：', 'Partial usage: ')}${t('输入', 'Input')} ${inputTokens ?? t('未提供', 'unavailable')} · ${t('输出', 'Output')} ${outputTokens ?? t('未提供', 'unavailable')}${extra} tokens`;
    if (item.usageStatus === 'unknown') return t('用量待确认', 'Usage is unknown');
    if (item.usageStatus === 'invalid') return t('服务商用量数据无效', 'Provider usage data is invalid');
    return t('服务商未提供用量', 'Provider did not report usage');
  };

  return <div className="saas-invocations" aria-label={t('本次模型调用', 'Model calls for this run')}>
    {error !== null && <p role="alert">{message} <button type="button" onClick={() => setRefresh(value => value + 1)}>{t('重试', 'Retry')}</button></p>}
    {items === null && error === null && <p role="status">{t('正在读取模型调用…', 'Loading model calls…')}</p>}
    {items?.length === 0 && <p>{t('本次运行尚无模型调用记录。', 'No model calls have been recorded for this run.')}</p>}
    {items && items.length > 0 && <ol>{items.map(item => {
      const canvasModel = /^byok_/i.test(item.modelId) ? '' : item.modelId;
      const providerModel = /^byok_/i.test(item.providerModel) ? '' : item.providerModel;
      return <li key={item.id}>
        <div className="saas-invocation-heading"><strong>{item.provider || t('服务商未记录', 'Provider unavailable')} · {providerModel || canvasModel || t('模型未记录', 'Model unavailable')}</strong><span>{runState(item.status)}</span></div>
        {providerModel && canvasModel && canvasModel !== providerModel && <p>{t('画布模型：', 'Canvas model: ')}{canvasModel}</p>}
        <p>{usageText(item)}</p>
      </li>;
    })}</ol>}
    {items && cursor && <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t('正在读取…', 'Loading…') : t('加载更多调用', 'Load more calls')}</button>}
  </div>;
}
