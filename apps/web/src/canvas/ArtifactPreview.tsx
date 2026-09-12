import { useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Code2, Download, Eye, File, Maximize2, X } from 'lucide-react';
import { currentSaaSCanvas, storedArtifactUrl } from '../saas/canvasBridge';
import { useCanvasI18n } from './i18n';
import { downloadTextDeliverable, htmlDocumentSource, htmlPreviewDocument, MAX_ARTIFACT_PREVIEW_BYTES } from './htmlDeliverable';
import './artifactPreview.css';

// Kept together so the same preview can be used in both the native and cloud workbench.
const messages = {
  zh: {
    preview: '预览', source: '源码', html: 'HTML 预览', markdown: 'Markdown 源码',
    loading: '正在读取交付物…', unavailable: '暂时无法预览，请重试或下载文件。',
    unsupported: '此文件格式暂不支持预览，可以下载查看。',
    tooLarge: '文件超过 2 MiB 预览上限，请下载查看。', retry: '重试预览',
    static: '静态预览 · 脚本和外部资源已停用', expand: '放大预览', close: '关闭预览',
  },
  en: {
    preview: 'Preview', source: 'Source', html: 'HTML preview', markdown: 'Markdown source',
    loading: 'Loading deliverable…', unavailable: 'Preview unavailable. Retry or download the file.',
    unsupported: 'Preview is not available for this file format. Download it to view.',
    tooLarge: 'This file exceeds the 2 MiB preview limit. Download it to view.', retry: 'Retry preview',
    static: 'Static preview · scripts and external resources are disabled', expand: 'Expand preview', close: 'Close preview',
  },
};

type PreviewType = 'html' | 'markdown';
type MarkdownRenderer = (source: string) => ReactNode;
type DownloadProps = { downloadUrl?: string; canDownload?: boolean; onStoredDownload?: (event: MouseEvent<HTMLAnchorElement>) => void };

export interface ArtifactPreviewProps extends DownloadProps {
  source: string;
  type: PreviewType;
  title: string;
  renderMarkdown: MarkdownRenderer;
  allowExpand?: boolean;
}

/** Native modal isolation also contains focus inside an opaque-origin preview iframe. The
 * explicit key/focus handlers cover environments with incomplete dialog support. */
function ExpandedPreview({ title, closeLabel, onClose, children }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dismiss = useRef(onClose);
  dismiss.current = onClose;
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    closeRef.current?.focus();
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.closest('[hidden]'));
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss.current(); return; }
      if (event.key !== 'Tab') return;
      const controls = focusables();
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    };
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) closeRef.current?.focus();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin);
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialogRef} className="awwo-artifact-dialog" aria-modal="true" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); dismiss.current(); }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
    onMouseDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) dismiss.current(); }}>
    <header className="awwo-artifact-dialog-header"><h2 id={titleId}>{title}</h2>
      <button ref={closeRef} type="button" aria-label={closeLabel} onClick={onClose}><X size={19} aria-hidden="true" /></button>
    </header>
    <div className="awwo-artifact-dialog-content">{children}</div>
  </dialog>, document.body);
}

/** A rendition of published bytes. Switching presentation never republishes an output. */
export function ArtifactPreview({ source, type, title, renderMarkdown, downloadUrl, canDownload = true, onStoredDownload, allowExpand = true }: ArtifactPreviewProps) {
  const { locale, t } = useCanvasI18n();
  const text = messages[locale];
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [downloadError, setDownloadError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const documentSource = type === 'html' ? htmlDocumentSource(source) : source;
  const tooLarge = new TextEncoder().encode(documentSource).byteLength > MAX_ARTIFACT_PREVIEW_BYTES;
  const html = useMemo(() => type === 'html' && !tooLarge ? htmlPreviewDocument(documentSource) : '', [documentSource, type, tooLarge]);
  const download = () => {
    try { downloadTextDeliverable(source, title, type); setDownloadError(false); }
    catch { setDownloadError(true); }
  };
  return <div className="awwo-artifact-preview">
    <div className="awwo-artifact-toolbar" role="group" aria-label={title}>
      <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}><Eye size={13} aria-hidden="true" />{text.preview}</button>
      <button type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')}><Code2 size={13} aria-hidden="true" />{text.source}</button>
      {allowExpand && !tooLarge && <button type="button" aria-label={text.expand} title={text.expand} onClick={() => setExpanded(true)}><Maximize2 size={13} aria-hidden="true" /><span>{text.expand}</span></button>}
      {canDownload && (downloadUrl
        ? <a className="awwo-artifact-download" href={downloadUrl} download rel="noreferrer" onClick={onStoredDownload}><Download size={13} aria-hidden="true" />{t('deliverable.downloadFile')}</a>
        : <button className="awwo-artifact-download" type="button" onClick={download}><Download size={13} aria-hidden="true" />{t('deliverable.downloadFormat', { format: type === 'html' ? 'html' : 'md' })}</button>)}
    </div>
    {tooLarge ? <p className="awwo-artifact-status" role="status">{text.tooLarge}</p>
      : mode === 'source' ? <pre className="awwo-artifact-source" aria-label={type === 'html' ? t('deliverable.htmlSource') : text.markdown}><code>{documentSource}</code></pre>
        : type === 'html' ? <>
          <iframe className="awwo-artifact-frame" title={`${title} · ${text.html}`} sandbox="" referrerPolicy="no-referrer" srcDoc={html} />
          <p className="awwo-artifact-note">{text.static}</p>
        </> : <div className="awwo-artifact-markdown awwo-markdown-preview">{renderMarkdown(source)}</div>}
    {downloadError && <p className="awwo-artifact-status" role="alert">{t('deliverable.downloadFailed')}</p>}
    {expanded && <ExpandedPreview title={title} closeLabel={text.close} onClose={() => setExpanded(false)}>
      <ArtifactPreview source={source} type={type} title={title} renderMarkdown={renderMarkdown} downloadUrl={downloadUrl}
        canDownload={canDownload} onStoredDownload={onStoredDownload} allowExpand={false} />
    </ExpandedPreview>}
  </div>;
}

type StoredContent = { type: PreviewType; source: string; name: string };

/** RFC 5987 takes precedence over the ASCII fallback used by the artifact endpoint. */
export function artifactFilename(disposition: string): string | null {
  if (!/^attachment(?:\s*;|\s*$)/i.test(disposition)) return null;
  const extended = disposition.match(/(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]*)/i);
  const plain = disposition.match(/(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i);
  let name: string | undefined;
  try { name = extended ? decodeURIComponent(extended[1].trim()) : plain?.[1]?.replace(/\\(.)/g, '$1') ?? plain?.[2]?.trim(); }
  catch { return null; }
  return name && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

/** Read a bounded stream, including when the server omits or understates Content-Length. */
export async function readArtifactPreview(response: Response, signal: AbortSignal): Promise<StoredContent | 'unsupported'> {
  const name = artifactFilename(response.headers.get('Content-Disposition') || '');
  if (!name) { await response.body?.cancel(); throw new Error('preview_unavailable'); }
  const type = /\.html?$/i.test(name) ? 'html' : /\.(?:md|markdown)$/i.test(name) ? 'markdown' : null;
  if (!type) { await response.body?.cancel(); return 'unsupported'; }
  const length = response.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_ARTIFACT_PREVIEW_BYTES)) {
    await response.body?.cancel(); throw new Error('preview_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('preview_unavailable');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let source = '';
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('preview_aborted');
      const chunk = await reader.read();
      if (signal.aborted) throw new Error('preview_aborted');
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_ARTIFACT_PREVIEW_BYTES) throw new Error('preview_too_large');
      source += decoder.decode(chunk.value, { stream: true });
    }
    source += decoder.decode();
    if (source.includes('\u0000')) throw new Error('preview_unavailable');
    return { type, source, name };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export interface StoredArtifactPreviewProps {
  reference: string;
  title: string;
  identity: string;
  renderMarkdown: MarkdownRenderer;
}

export function StoredArtifactPreview({ reference, title, identity, renderMarkdown }: StoredArtifactPreviewProps) {
  const { locale, t } = useCanvasI18n();
  const text = messages[locale];
  const scope = currentSaaSCanvas();
  const url = storedArtifactUrl(reference);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ identity: string; url: string; scope: typeof scope; content?: StoredContent; state: 'ready' | 'unsupported' | 'unavailable' | 'tooLarge' } | null>(null);
  const current = result?.identity === identity && result.url === url && result.scope === scope ? result : null;

  useEffect(() => {
    setResult(null);
    if (!url || !scope) return;
    const controller = new AbortController();
    const stillCurrent = () => !controller.signal.aborted && currentSaaSCanvas() === scope && storedArtifactUrl(reference) === url;
    const timeout = setTimeout(() => {
      if (stillCurrent()) setResult({ identity, url, scope, state: 'unavailable' });
      controller.abort();
    }, 15_000);
    void (async () => {
      try {
        const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/octet-stream' } });
        if (!stillCurrent()) { await response.body?.cancel(); return; }
        const expected = new URL(url, window.location.origin).href;
        if (!response.ok || response.redirected || (response.url && response.url !== expected)) {
          await response.body?.cancel(); throw new Error('preview_unavailable');
        }
        const content = await readArtifactPreview(response, controller.signal);
        if (stillCurrent()) setResult({ identity, url, scope, ...(content === 'unsupported' ? { state: 'unsupported' } : { state: 'ready', content }) });
      } catch (error) {
        if (stillCurrent()) setResult({ identity, url, scope, state: error instanceof Error && error.message === 'preview_too_large' ? 'tooLarge' : 'unavailable' });
      } finally { clearTimeout(timeout); }
    })();
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [identity, url, reference, scope, attempt]);

  if (!url) return <span>{reference}</span>;
  const onStoredDownload = (event: MouseEvent<HTMLAnchorElement>) => {
    if (currentSaaSCanvas() !== scope || storedArtifactUrl(reference) !== url) event.preventDefault();
  };
  if (current?.content) return <ArtifactPreview key={`${identity}:${url}`} source={current.content.source} type={current.content.type}
    title={title} renderMarkdown={renderMarkdown} downloadUrl={url} onStoredDownload={onStoredDownload} />;
  return <div className="awwo-artifact-preview">
    <div className="awwo-artifact-toolbar"><File size={15} aria-hidden="true" />
      <a className="awwo-artifact-download" href={url} download rel="noreferrer" onClick={onStoredDownload}><Download size={13} aria-hidden="true" />{t('deliverable.downloadFile')}</a>
    </div>
    <p className="awwo-artifact-status" role={current?.state === 'unavailable' ? 'alert' : 'status'}>{text[current?.state === 'unavailable' ? 'unavailable' : current?.state === 'tooLarge' ? 'tooLarge' : current?.state === 'unsupported' ? 'unsupported' : 'loading']}</p>
    {current?.state === 'unavailable' && <button type="button" onClick={() => setAttempt(previous => previous + 1)}>{text.retry}</button>}
  </div>;
}
