import type { PendingFileDelivery as FileMetadata } from './fileDeliveryPresentation';
import { useCanvasI18n } from './i18n';

export function PendingFileDelivery({ file }: { file: FileMetadata }) {
  const { locale } = useCanvasI18n();
  return <div className="awwo-artifact-status">
    <span>{file.name}{file.byteLength === undefined ? '' : ` · ${file.byteLength.toLocaleString()} B`}</span>
    <p role="status">{locale === 'zh'
      ? '文件内容已返回，下载引用尚不可用。刷新后查看已保存的交付物。'
      : 'File content was returned; its saved download reference is not available yet. Refresh to check saved deliverables.'}</p>
  </div>;
}
