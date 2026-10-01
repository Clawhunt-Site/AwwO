/// <reference path="./preview-assets.d.ts" />
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import pdfLicenseUrl from 'pdfjs-dist/LICENSE?url';
import cmapLicenseUrl from 'pdfjs-dist/cmaps/LICENSE?url';
import foxitLicenseUrl from 'pdfjs-dist/standard_fonts/LICENSE_FOXIT?url';
import liberationLicenseUrl from 'pdfjs-dist/standard_fonts/LICENSE_LIBERATION?url';
import { PREVIEW_LIMITS, type PreviewFile } from './previewData';

export function PdfPreview({ file }: { file: PreviewFile }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let cancelled = false; let destroy = () => undefined;
    const resources = new AbortController();
    const timeout = setTimeout(() => { if (!cancelled) { setError('PDF 读取超时，请下载查看'); setBusy(false); cancelled = true; destroy(); } }, 15000);
    setDocument(null); setPage(1); setError(''); setBusy(true);
    void (async () => {
      try {
        if (file.bytes.length > PREVIEW_LIMITS.pdf || new TextDecoder().decode(file.bytes.subarray(0, 5)) !== '%PDF-') throw new Error('PDF 文件头无效或超过 20 MiB');
        const [pdfjs, { pdfResourceFactory }] = await Promise.all([import('pdfjs-dist'), import('./pdfPreviewResources')]);
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        // Canvas-only rendering does not instantiate the scripting/annotation layer.
        // All PDF bytes are local; no remote fonts, CMaps, or decoder downloads.
        const task = pdfjs.getDocument({ data: file.bytes.slice(), useSystemFonts: true, useWorkerFetch: false, useWasm: false,
          BinaryDataFactory: pdfResourceFactory(resources.signal), cMapPacked: true,
          enableXfa: false, disableAutoFetch: true, disableStream: true, maxImageSize: 16_000_000, canvasMaxAreaInBytes: 32 * 1024 * 1024, stopAtErrors: true });
        destroy = () => { resources.abort(); void task.destroy().catch(() => undefined); };
        task.onPassword = () => { if (!cancelled) { setError('加密 PDF 暂不支持预览，请下载查看'); setBusy(false); } destroy(); };
        const loaded = await task.promise;
        if (cancelled) { destroy(); return; }
        if (loaded.numPages > 500) { destroy(); throw new Error('PDF 超过 500 页预览上限'); }
        setDocument(loaded);
      } catch (reason) { if (!cancelled) { setError(reason instanceof Error ? reason.message : 'PDF 读取失败'); setBusy(false); } }
      finally { clearTimeout(timeout); }
    })();
    return () => { cancelled = true; clearTimeout(timeout); resources.abort(); destroy(); };
  }, [file]);
  useEffect(() => {
    if (!document) return;
    let cancelled = false; let task: RenderTask | undefined;
    const timeout = setTimeout(() => { if (!cancelled) { setError('PDF 页面渲染超时，请下载查看'); setBusy(false); cancelled = true; task?.cancel(); } }, 15000);
    setBusy(true); setError('');
    void (async () => {
      try {
        const currentPage = await document.getPage(page);
        if (cancelled || !canvas.current) return;
        const element = canvas.current; const context = element.getContext('2d');
        if (!context) throw new Error('浏览器无法创建 PDF 画布');
        const base = currentPage.getViewport({ scale: 1 });
        const scale = Math.min(1.6 * zoom, 1800 / Math.max(base.width, base.height));
        const viewport = currentPage.getViewport({ scale });
        if (![viewport.width, viewport.height].every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) throw new Error('PDF 页面尺寸无效');
        element.width = Math.ceil(viewport.width); element.height = Math.ceil(viewport.height);
        task = currentPage.render({ canvas: element, canvasContext: context, viewport });
        await task.promise;
        if (!cancelled) setBusy(false);
      } catch (reason) { if (!cancelled) { setError(reason instanceof Error ? reason.message : 'PDF 页面渲染失败'); setBusy(false); } }
      finally { clearTimeout(timeout); }
    })();
    return () => { cancelled = true; clearTimeout(timeout); task?.cancel(); };
  }, [document, page, zoom]);
  return <div className="awwo-pdf-preview">
    <div className="awwo-preview-controls">
      <button type="button" disabled={!document || page <= 1 || busy} onClick={() => setPage(value => value - 1)} aria-label="上一页">←</button>
      <span aria-live="polite">{document ? `${page} / ${document.numPages}` : 'PDF'}</span>
      <button type="button" disabled={!document || page >= document.numPages || busy} onClick={() => setPage(value => value + 1)} aria-label="下一页">→</button>
      <label>缩放 <select aria-label="PDF 缩放" value={zoom} onChange={event => setZoom(Number(event.target.value))}><option value={0.75}>75%</option><option value={1}>100%</option><option value={1.5}>150%</option></select></label>
    </div>
    {error ? <p role="alert" className="awwo-artifact-status">{error}</p> : <div className="awwo-pdf-page"><canvas ref={canvas} aria-label={`${file.name} 第 ${page} 页`} role="img" />{busy && <p role="status">正在渲染 PDF…</p>}</div>}
    <p className="awwo-artifact-note awwo-pdf-licenses">PDF.js · <a href={pdfLicenseUrl} target="_blank" rel="noreferrer">许可</a> / <a href={cmapLicenseUrl} target="_blank" rel="noreferrer">Adobe CMap</a> / <a href={foxitLicenseUrl} target="_blank" rel="noreferrer">Foxit</a> / <a href={liberationLicenseUrl} target="_blank" rel="noreferrer">Liberation</a></p>
  </div>;
}
