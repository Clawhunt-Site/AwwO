import { useMemo } from 'react';
import { ModelPreview } from './ModelPreview';
import { PdfPreview } from './PdfPreview';
import { SourcePreview } from './SourcePreview';
import type { PreviewFile } from './previewData';
import './artifactViewers.css';

export function BinaryArtifactPreview({ file, type }: { file: PreviewFile; type: 'model' | 'pdf' | 'ide' }) {
  const files = useMemo(() => [file], [file]);
  return type === 'model' ? <ModelPreview file={file} /> : type === 'pdf' ? <PdfPreview file={file} /> : <SourcePreview files={files} />;
}
