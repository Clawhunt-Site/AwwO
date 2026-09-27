import { useEffect, useRef, useState } from 'react';
import { isTaskFrame } from '../canvas/taskFrame';
import { saasErrorMessage } from './api';
import { readRunEvidence, downloadRunArchive, type RunEvidenceSummary } from './runEvidenceApi';
import { useSaaSPreferences } from './preferences';
import './run-evidence.css';

type Props = { tenantId: string; runId: string; runStatus?: string };
export function RunEvidence(props: Props) {
  return <RunEvidenceView key={JSON.stringify([props.tenantId, props.runId])} {...props} />;
}

function RunEvidenceView({ tenantId, runId, runStatus }: Props) {
  const { locale, t } = useSaaSPreferences();
  const [open, setOpen] = useState(false);
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
    <button type="button" className="saas-evidence-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t('证据摘要', 'Evidence summary')}</button>
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
