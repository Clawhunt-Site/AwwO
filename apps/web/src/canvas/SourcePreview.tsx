import { useEffect, useId, useMemo, useState } from 'react';
import { previewText, safeSourcePath, SOURCE_COUNT_LIMIT, SOURCE_TOTAL_LIMIT, unzipPreview, type PreviewFile, type SourceFile } from './previewData';

export function SourceBrowser({ files }: { files: readonly SourceFile[] }) {
  const id = useId();
  const [selected, setSelected] = useState(''); const [query, setQuery] = useState(''); const [match, setMatch] = useState(0);
  const current = files.find(file => file.path === selected) ?? files[0];
  const lines = useMemo(() => current?.source.split('\n') ?? [], [current]);
  const hits = useMemo(() => query ? lines.flatMap((line, index) => line.toLowerCase().includes(query.toLowerCase()) ? [index + 1] : []) : [], [lines, query]);
  useEffect(() => { setMatch(0); }, [current, query]);
  const highlighted = hits[match % (hits.length || 1)];
  useEffect(() => {
    if (highlighted) globalThis.document.getElementById(`source-line-${id}-${highlighted}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted]);
  return <div className="awwo-source-browser">
    <nav className="awwo-source-tree" aria-label="源码文件树"><span>{files.length} 个文件</span>{files.map(file => <button type="button" key={file.path} title={file.path} aria-current={file === current ? 'page' : undefined} onClick={() => setSelected(file.path)} style={{ paddingLeft: `${8 + Math.min(file.path.split('/').length - 1, 5) * 10}px` }}>{file.path}</button>)}</nav>
    <div className="awwo-source-editor">
      <div className="awwo-preview-controls"><span title={current?.path}>{current?.path ?? '暂无源码'}</span><input aria-label="搜索当前文件" type="search" maxLength={200} placeholder="搜索源码" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" disabled={!hits.length} onClick={() => setMatch(value => value + 1)}>{query ? `${hits.length ? match % hits.length + 1 : 0}/${hits.length}` : '查找'}</button></div>
      <div className="awwo-source-lines" role="region" aria-label="带行号的源码" tabIndex={0}>{lines.slice(0, 20000).map((line, index) => <div key={index} id={`source-line-${id}-${index + 1}`} data-match={index + 1 === highlighted || undefined}><span aria-hidden="true">{index + 1}</span><code>{line || ' '}</code></div>)}{lines.length > 20000 && <p>预览限前 20,000 行，请下载查看完整源码。</p>}</div>
      <p className="awwo-artifact-note">只读源码预览 · 不执行项目命令</p>
    </div>
  </div>;
}

export function SourcePreview({ files }: { files: readonly PreviewFile[] }) {
  const [result, setResult] = useState<{ files: readonly PreviewFile[]; entries?: SourceFile[]; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setResult(null);
    void (async () => {
      try {
        if (files.length > SOURCE_COUNT_LIMIT || files.reduce((total, file) => total + file.bytes.length, 0) > SOURCE_TOTAL_LIMIT) throw new Error('源码总量超过预览上限');
        const entries: SourceFile[] = [];
        for (const file of files) {
          if (controller.signal.aborted) return;
          if (/\.zip$/i.test(file.name)) entries.push(...await unzipPreview(file.bytes, controller.signal));
          else { if (!safeSourcePath(file.name)) throw new Error('源码文件路径无效'); entries.push({ path: file.name, source: previewText(file.bytes) }); }
        }
        if (entries.length > SOURCE_COUNT_LIMIT || entries.reduce((total, file) => total + new TextEncoder().encode(file.source).length, 0) > SOURCE_TOTAL_LIMIT) throw new Error('源码解压总量超过预览上限');
        if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('存在重复源码路径，请分别选择文件');
        if (!controller.signal.aborted) setResult({ files, entries });
      } catch (reason) { if (!controller.signal.aborted) setResult({ files, error: reason instanceof Error ? reason.message : '源码读取失败' }); }
    })();
    return () => controller.abort();
  }, [files]);
  if (result?.files !== files) return <p role="status" className="awwo-artifact-status">正在读取源码…</p>;
  return result.error ? <p role="alert" className="awwo-artifact-status">{result.error}</p> : <SourceBrowser files={result.entries ?? []} />;
}
