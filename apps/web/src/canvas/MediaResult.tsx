// The images, videos or 3D models a media node generated, shown in place inside its transcript and in the 成果 view.
// Files are served by the workspace API under the signed-in session; without an active workspace (a local canvas
// showing a cloud result) only the summary is shown, never a guessed URL.

import { useEffect, useRef, useState } from 'react';
import { Box, Download } from 'lucide-react';
import { storedArtifactUrl, storedMediaUrl } from '../saas/canvasBridge';
import { sessionFetch } from '../saas/api';
import { useCanvasI18n } from './i18n';
import type { MediaOutput, MediaOutputItem } from './mediaOutput';
import { ModelPreview } from './ModelPreview';
import { PREVIEW_LIMITS, type PreviewFile } from './previewData';
import './media.css';

export function mediaOutputSummaryKey(output: MediaOutput) {
  return output.kind === 'video' ? 'media.generatedVideos' as const : output.kind === 'model3d' ? 'media.generatedModels' as const : 'media.generatedImages' as const;
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

/** A generated 3D model: the provider's rendered picture first, the model itself in the WebGL viewer on request
 *  (a textured model is megabytes, so it is fetched only when someone wants to turn it), and its download. */
function ModelItem({ item, poster }: { item: MediaOutputItem; poster?: MediaOutputItem }) {
  const { t } = useCanvasI18n();
  const download = storedArtifactUrl(`awwo-file:${item.artifactId}`);
  const posterUrl = poster ? storedMediaUrl(poster.artifactId) : null;
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'failed' | 'large'>('idle');
  const [file, setFile] = useState<PreviewFile | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const open = async () => {
    if (!download) return;
    if (item.size > PREVIEW_LIMITS.model) { setState('large'); return; }
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    setState('loading');
    try {
      const response = await sessionFetch(download, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/octet-stream' } });
      if (!response.ok) throw new Error('model_unavailable');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (controller.signal.aborted) return;
      if (bytes.byteLength > PREVIEW_LIMITS.model) { setState('large'); return; }
      setFile({ name: item.name.endsWith('.glb') ? item.name : `${item.name}.glb`, bytes });
      setState('ready');
    } catch {
      if (!controller.signal.aborted) setState('failed');
    }
  };
  if (!download) return <div className="canvas-media-missing" role="status">{item.name}</div>;
  return <figure className="canvas-media-item canvas-media-model">
    {state === 'ready' && file ? <ModelPreview file={file} />
      : <div className="canvas-media-model-poster">
        {posterUrl ? <img className="canvas-media-image" src={posterUrl} alt={t('media.modelPoster', { name: item.name })} loading="lazy" decoding="async" /> : <Box size={42} aria-hidden="true" />}
        <button type="button" className="canvas-media-model-open" disabled={state === 'loading'} onClick={() => { void open(); }}>
          <Box size={14} aria-hidden="true" />{t(state === 'loading' ? 'media.modelLoading' : 'media.modelOpen')}
        </button>
        {state === 'failed' ? <p role="alert">{t('media.unavailableFile')}</p> : state === 'large' ? <p role="status">{t('media.modelTooLarge')}</p> : null}
      </div>}
    <figcaption><a href={download} download={item.name} rel="noreferrer"><Download size={12} aria-hidden="true" />{t('media.downloadModel', { name: item.name })}</a></figcaption>
  </figure>;
}

export function MediaResult({ output }: { output: MediaOutput }) {
  const { t } = useCanvasI18n();
  if (output.kind === 'model3d') {
    const models = output.items.filter(item => item.contentType.startsWith('model/'));
    const pictures = output.items.filter(item => item.contentType.startsWith('image/'));
    return <div className="canvas-media-result" data-testid="media-result">
      <div className="canvas-media-summary">{t('media.generatedModels', { count: models.length })}</div>
      <div className="canvas-media-grid canvas-media-grid--model3d">
        {models.map((item, index) => <ModelItem key={item.artifactId} item={item} poster={pictures[index] ?? pictures[0]} />)}
      </div>
    </div>;
  }
  return <div className="canvas-media-result" data-testid="media-result">
    <div className="canvas-media-summary">{t(mediaOutputSummaryKey(output), { count: output.items.length })}</div>
    <div className={`canvas-media-grid canvas-media-grid--${output.kind}`}>
      {output.items.map(item => <MediaItem key={item.artifactId} item={item} kind={output.kind} />)}
    </div>
  </div>;
}
