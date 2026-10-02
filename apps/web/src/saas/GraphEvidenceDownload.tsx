import { useEffect, useRef, useState } from 'react';
import { SaaSApiError, saasErrorMessage } from './api';
import { useSaaSPreferences } from './preferences';
import { collectGraphEvidence, downloadGraphEvidence, type GraphEvidenceScope } from './graphEvidenceExport';

export function GraphEvidenceDownload(props: GraphEvidenceScope) {
  return <GraphEvidenceDownloadView key={JSON.stringify(props)} {...props} />;
}
function GraphEvidenceDownloadView(scope: GraphEvidenceScope) {
  const { t, locale } = useSaaSPreferences();
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>(null);
  const errorText = error instanceof SaaSApiError && ['invalid_graph_evidence', 'inconsistent_graph_run_binding'].includes(error.code)
    ? t('返回的图或节点身份不匹配，未生成文件。请刷新运行记录后重试。', 'The graph or node identities did not match. No file was created. Refresh run history and retry.')
    : error instanceof SaaSApiError && error.code === 'graph_export_too_large'
      ? t('记录超过文件大小上限，未生成文件。请分别查看节点证据。', 'The records exceed the file size limit. No file was created. Inspect individual node evidence instead.')
      : error instanceof DOMException && error.name === 'AbortError'
        ? t('读取超过两分钟时限，请稍后重试。', 'The read exceeded the two-minute limit. Try again later.')
        : saasErrorMessage(error, locale);
  useEffect(() => () => { active.current?.abort(); }, []);
  const start = async () => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setNotice(''); setError(null);
    try {
      const bundle = await collectGraphEvidence(scope, controller.signal);
      if (controller.signal.aborted) return;
      downloadGraphEvidence(bundle);
      setNotice(bundle.completeness.complete
        ? t('已导出当前记录；记录齐全不代表任务通过人工验收。', 'Current records exported. Complete records do not confirm human acceptance.')
        : bundle.completeness.inProgress
          ? t('已导出运行中快照；结果尚未完整，请结束后重新导出。', 'In-progress snapshot exported. Export again after the run finishes.')
          : t('已导出部分记录；文件列出了读取失败、缺失或达到上限的部分。', 'Partial records exported. The file lists failed reads, missing data and reached limits.'));
    } catch (cause) { if (!controller.signal.aborted) setError(cause); }
    finally { if (!controller.signal.aborted) { active.current = null; setBusy(false); } }
  };
  return <section aria-label={t('整图证据导出', 'Graph evidence export')}>
    <p>{t('图运行 ID：', 'Graph run ID: ')}<code style={{ overflowWrap: 'anywhere' }}>{scope.graphId}</code></p>
    <button type="button" disabled={busy} aria-busy={busy} onClick={() => void start()}>{busy ? t('正在收集运行证据…', 'Collecting run evidence…') : t('导出本次整图证据', 'Export this graph’s evidence')}</button>
    <p className="saas-graph-output-notice">{t('包含冻结画布、节点运行、证据摘要与模型调用账本。最多 200 次运行、每次 10 页调用、共 5,000 条调用及 16 MiB；超限或失败会标记。原始事件仅附下载链接。文件包含任务内容，请自行检查后分享。', 'Includes the frozen canvas, node runs, summaries and model call ledger. Limits: 200 runs, 10 call pages per run, 5,000 calls and 16 MiB; limits and failures are marked. Raw events are linked only. Review task contents before sharing.')}</p>
    {notice && <p role="status">{notice}</p>}
    {error !== null && <p role="alert">{t('导出未完成：', 'Export did not finish: ')}{errorText}</p>}
  </section>;
}
