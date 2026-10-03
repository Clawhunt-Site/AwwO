// The images or videos an image or video node generated, shown in place inside its transcript.
// Files are served by the workspace API under the signed-in session; without an active workspace
// (a local canvas showing a cloud result) only the summary is shown, never a guessed URL.

import { useState } from 'react';
import { storedArtifactUrl, storedMediaUrl } from '../saas/canvasBridge';
import { useCanvasI18n } from './i18n';
import type { MediaOutput, MediaOutputItem } from './mediaOutput';
import './media.css';

export function mediaOutputSummaryKey(output: MediaOutput) {
  return output.kind === 'video' ? 'media.generatedVideos' as const : 'media.generatedImages' as const;
}

function MediaItem({ item, kind }: { item: MediaOutputItem; kind: MediaOutput['kind'] }) {
  const { t } = useCanvasI18n();
  const [broken, setBroken] = useState(false);
  const inline = storedMediaUrl(item.artifactId);
  const download = storedArtifactUrl(`awwo-file:${item.artifactId}`);
  if (!inline || broken) return <div className="canvas-media-missing" role="status">{broken ? t('media.unavailableFile') : item.name}</div>;
  return <figure className="canvas-media-item">
    {kind === 'video'
      // A media fragment makes the browser fetch and paint the first frame instead of a blank box.
      ? <video className="canvas-media-video" src={`${inline}#t=0.1`} controls preload="metadata" playsInline onError={() => setBroken(true)} aria-label={item.name} />
      : <a href={inline} target="_blank" rel="noopener noreferrer" title={t('media.open')}>
        <img className="canvas-media-image" src={inline} alt={item.name} loading="lazy" decoding="async" onError={() => setBroken(true)} />
      </a>}
    {download ? <figcaption><a href={download} download={item.name} rel="noreferrer">{t('media.download')}</a></figcaption> : null}
  </figure>;
}

export function MediaResult({ output }: { output: MediaOutput }) {
  const { t } = useCanvasI18n();
  return <div className="canvas-media-result" data-testid="media-result">
    <div className="canvas-media-summary">{t(mediaOutputSummaryKey(output), { count: output.items.length })}</div>
    <div className={`canvas-media-grid canvas-media-grid--${output.kind}`}>
      {output.items.map(item => <MediaItem key={item.artifactId} item={item} kind={output.kind} />)}
    </div>
  </div>;
}
