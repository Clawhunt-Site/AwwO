import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Box, Code2, FileText, Globe, Maximize2, Upload, X } from 'lucide-react';
import { currentSaaSCanvas, storedArtifactUrl } from '../saas/canvasBridge';
import { ArtifactPreview, ExpandedPreview, readArtifactPreview } from './ArtifactPreview';
import { ModelPreview } from './ModelPreview';
import { PdfPreview } from './PdfPreview';
import { SourcePreview } from './SourcePreview';
import { PREVIEW_LIMITS, previewKind, previewText, readPreviewBlob, SOURCE_COUNT_LIMIT, SOURCE_TOTAL_LIMIT, type PreviewFile, type PreviewKind } from './previewData';
import { previewSample } from './previewSamples';
import './canvasPreviewDesk.css';

export interface CanvasPreviewArtifact { reference: string; title?: string; name?: string; identity?: string }
export interface CanvasPreviewDeskProps { artifacts?: readonly CanvasPreviewArtifact[]; scopeKey?: string }

const PANES = [
  { kind: 'html', title: 'HTML', detail: '网页与交互作品', accept: '.html,.htm', icon: Globe, hint: '选择任务交付物，或上传 HTML 文件。' },
  { kind: 'model', title: '3D', detail: '模型与空间', accept: '.glb,.gltf,.obj', icon: Box, hint: '上传 GLB、资源内嵌的 glTF，或无外部材质的 OBJ。' },
  { kind: 'pdf', title: 'PDF', detail: '文档与报告', accept: '.pdf', icon: FileText, hint: '选择或上传 PDF，逐页检查实际文档。' },
  { kind: 'ide', title: 'IDE', detail: '项目源码', accept: '.zip,.ts,.tsx,.js,.jsx,.json,.md,.html,.css,.py,.rs,.go,.txt,.yaml,.yml,.toml,.sh,.sql,.java,.c,.cpp,.h,.svg', icon: Code2, hint: '上传 workspace.zip 或多个源码文件，浏览目录并搜索。' },
] as const;
const artifactKind = (artifact: CanvasPreviewArtifact) => previewKind(artifact.name ?? '') ?? previewKind(artifact.title ?? '') ?? previewKind(artifact.reference);

function PreviewPane({ pane, artifacts }: { pane: typeof PANES[number]; artifacts: readonly CanvasPreviewArtifact[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [local, setLocal] = useState<readonly PreviewFile[] | null>(null);
  const [loaded, setLoaded] = useState<{ reference: string; files: readonly PreviewFile[] } | null>(null);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const upload = useRef<HTMLInputElement>(null); const uploadController = useRef<AbortController | null>(null);
  const id = useId(); const Icon = pane.icon;
  const available = useMemo(() => artifacts.filter(artifact => {
    const kind = artifactKind(artifact); return !kind || kind === pane.kind || pane.kind === 'ide' && kind === 'html';
  }), [artifacts, pane.kind]);
  const reference = selected ?? available.find(artifact => artifactKind(artifact) === pane.kind)?.reference ?? '';
  const artifact = available.find(item => item.reference === reference);
  const identity = artifact?.identity ?? reference;
  const scope = currentSaaSCanvas();
  useEffect(() => () => uploadController.current?.abort(), []);
  useEffect(() => {
    setLoaded(null); setError('');
    if (!reference || local) { setLoading(false); return; }
    const url = storedArtifactUrl(reference);
    if (!url || !scope) { setError('此交付物尚不可读取，请上传本地文件预览。'); setLoading(false); return; }
    const controller = new AbortController(); setLoading(true);
    const active = () => !controller.signal.aborted && currentSaaSCanvas() === scope && storedArtifactUrl(reference) === url;
    const timeout = setTimeout(() => { if (active()) { setError('读取超时，请重新选择文件。'); setLoading(false); } controller.abort(); }, 15000);
    void (async () => {
      try {
        const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
        if (!active()) { await response.body?.cancel(); return; }
        if (!response.ok || response.redirected || response.url && response.url !== new URL(url, window.location.origin).href) { await response.body?.cancel(); throw new Error('无法读取交付物'); }
        const content = await readArtifactPreview(response, controller.signal);
        if (!active()) return;
        if (content === 'unsupported' || content.type === 'image') throw new Error('此文件不适用于这个预览窗口');
        const file: PreviewFile = 'file' in content ? content.file : { name: content.name, bytes: new TextEncoder().encode(content.source) };
        const kind = previewKind(file.name);
        if (kind !== pane.kind && !(pane.kind === 'ide' && ['html', 'ide'].includes(kind ?? ''))) throw new Error('实际文件格式与预览窗口不符，请在对应窗口打开');
        setLoaded({ reference, files: [file] });
      } catch (reason) { if (active()) setError(reason instanceof Error ? reason.message : '交付物读取失败'); }
      finally { clearTimeout(timeout); if (active()) setLoading(false); }
    })();
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [reference, identity, local, scope, pane.kind]);
  const files = local ?? (loaded?.reference === reference ? loaded.files : null);
  const first = files?.[0];
  useEffect(() => setExpanded(false), [first]);
  const text = useMemo(() => {
    if (!first || pane.kind !== 'html') return '';
    try { return previewText(first.bytes); } catch { return null; }
  }, [first, pane.kind]);
  const chooseUpload = async (input: FileList | null) => {
    uploadController.current?.abort();
    const controller = new AbortController(); uploadController.current = controller;
    const picked = Array.from(input ?? []); if (!picked.length) return;
    setError(''); setLoading(true); setSelected(''); setLocal(null);
    try {
      if (picked.length > SOURCE_COUNT_LIMIT || pane.kind !== 'ide' && picked.length > 1 || picked.reduce((sum, file) => sum + file.size, 0) > (pane.kind === 'ide' ? SOURCE_TOTAL_LIMIT : PREVIEW_LIMITS[pane.kind])) throw new Error('上传文件数量或总量超过预览上限');
      const result: PreviewFile[] = [];
      for (const file of picked) {
        const kind = previewKind(file.name);
        if (kind !== pane.kind && !(pane.kind === 'ide' && ['html', 'ide'].includes(kind ?? ''))) throw new Error('文件格式与预览窗口不符');
        const bytes = await readPreviewBlob(file, controller.signal, PREVIEW_LIMITS[pane.kind]);
        result.push({ name: file.webkitRelativePath || file.name, bytes });
      }
      if (!controller.signal.aborted) setLocal(result);
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '文件读取失败'); }
    finally { if (!controller.signal.aborted) setLoading(false); if (upload.current) upload.current.value = ''; }
  };
  const clear = () => { uploadController.current?.abort(); setLocal(null); setSelected(''); setError(''); setLoading(false); };
  const rendition = () => first && (pane.kind === 'html' ? text === null ? <p role="alert" className="awwo-artifact-status">HTML 不是有效 UTF-8 文件或超过 2 MiB</p>
    : <ArtifactPreview source={text} type="html" title={first.name} renderMarkdown={source => source} canDownload={false} allowExpand={false} />
    : pane.kind === 'model' ? <ModelPreview file={first} /> : pane.kind === 'pdf' ? <PdfPreview file={first} /> : <SourcePreview files={files!} />);
  return <section className={`awwo-preview-window awwo-preview-${pane.kind}`} aria-labelledby={id}>
    <header className="awwo-preview-window-header"><Icon size={16} aria-hidden="true" /><h3 id={id}>{pane.title}</h3><span>{pane.detail}</span>{first && <><button type="button" aria-label={`放大 ${pane.title} 预览`} onClick={() => setExpanded(true)}><Maximize2 size={14} /></button><button type="button" aria-label={`清空 ${pane.title} 预览`} onClick={clear}><X size={14} /></button></>}</header>
    <div className="awwo-preview-filebar">
      <select aria-label={`${pane.title} 交付物`} value={local ? '' : reference} onChange={event => { uploadController.current?.abort(); setLocal(null); setSelected(event.target.value); }}><option value="">{local ? files?.map(file => file.name).join(', ') : '选择任务交付物'}</option>{available.map(item => <option key={item.reference} value={item.reference}>{item.name || item.title || item.reference}</option>)}</select>
      <button type="button" onClick={() => upload.current?.click()} aria-label={`上传 ${pane.title} 文件`}><Upload size={13} />上传</button>
      <input ref={upload} hidden type="file" accept={pane.accept} multiple={pane.kind === 'ide'} onChange={event => { void chooseUpload(event.target.files); }} aria-label={`${pane.title} 本地文件`} />
      <button type="button" onClick={() => { uploadController.current?.abort(); setSelected(''); setError(''); setLoading(false); setLocal([previewSample(pane.kind)]); }}>本地示例</button>
    </div>
    {first?.demo && <p className="awwo-preview-demo-label">本地演示文件 · 非任务交付物</p>}
    <div className="awwo-preview-window-body">
      {loading ? <p role="status" className="awwo-artifact-status">正在读取文件…</p> : error ? <p role="alert" className="awwo-artifact-status">{error}</p> : first ? expanded ? <p className="awwo-artifact-status">已在放大窗口中打开</p> : rendition()
        : <div className="awwo-preview-empty"><Icon size={32} strokeWidth={1.25} aria-hidden="true" /><p>{pane.hint}</p><small>{pane.kind === 'html' ? '默认静态沙盒，可显式开启内联交互' : pane.kind === 'model' ? '20 MiB · 不加载外链资源' : pane.kind === 'pdf' ? '20 MiB · 最多 500 页' : 'ZIP 8 MiB · UTF-8 源码 · 只读'}</small></div>}
    </div>
    {expanded && first && <ExpandedPreview title={`${pane.title} · ${first.name}${first.demo ? ' · 本地演示' : ''}`} closeLabel="关闭预览" onClose={() => setExpanded(false)}>{rendition()}</ExpandedPreview>}
  </section>;
}

export function CanvasPreviewDesk({ artifacts = [], scopeKey = '' }: CanvasPreviewDeskProps) {
  // Keying every pane makes workspace changes discard local bytes and cancel loaders.
  return <section className="awwo-canvas-preview-desk" aria-label="交付物预览工作台" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <header className="awwo-preview-desk-header"><div><h2>交付物工作台</h2><p>网页、模型、文档、源码，在同一画布检查。</p></div><span>本地文件仅用于本次预览</span></header>
    <div className="awwo-preview-desk-grid">{PANES.map(pane => <PreviewPane key={`${scopeKey}:${pane.kind}`} pane={pane} artifacts={artifacts} />)}</div>
  </section>;
}
