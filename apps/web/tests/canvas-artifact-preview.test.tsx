import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPreview, artifactFilename, readArtifactPreview, StoredArtifactPreview } from '../src/canvas/ArtifactPreview';
import { htmlPreviewDocument, MAX_ARTIFACT_PREVIEW_BYTES } from '../src/canvas/htmlDeliverable';
import { ARTIFACT_REF_PREFIX, clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import { createSessionNode } from '../src/canvas/canvasDoc';
import { LocaleProvider } from '../src/canvas/i18n';
import { useCanvasKeys } from '../src/canvas/useCanvasKeys';
import { artifactImageType } from '../src/canvas/artifactImage';

const tenant = { id: 'tenant-a', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const reference = `${ARTIFACT_REF_PREFIX}a${'B'.repeat(32)}`;
const artifactUrl = `/api/v1/tenants/tenant-a/artifacts/a${'B'.repeat(32)}`;
const markdown = (text: string) => <p>{text}</p>;
const html = '<!doctype html><html lang="zh" style="background:#abc"><head><style>h1{color:rgb(10,20,30)}</style></head><body class="page" style="padding:24px"><h1>交付页面</h1><p>已保存的内容</p></body></html>';
const response = (text: string, name = 'page.html', headers: Record<string, string> = {}) => new Response(text, {
  headers: { 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Type': 'application/octet-stream', ...headers },
});
function stored(identity = 'node:session:1') {
  return <StoredArtifactPreview reference={reference} identity={identity} title="网页" renderMarkdown={markdown} />;
}
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('isolated HTML rendition', () => {
  it('runs inline interactions only after explicit opt-in, resets with a new frame, and stops on source view', () => {
    const game = '<html><head></head><body><canvas id="board"></canvas><button id="score" onclick="this.textContent=Number(this.textContent)+1">0</button><script>document.body.dataset.ready="yes"</script></body></html>';
    const { rerender } = render(<ArtifactPreview source={game} type="html" title="游戏" renderMarkdown={markdown} />);
    const initial = screen.getByTitle('游戏 · HTML 预览');
    expect(initial).toHaveAttribute('sandbox', '');
    expect(initial.getAttribute('srcdoc')).not.toContain('dataset.ready');
    fireEvent.click(screen.getByRole('button', { name: '运行交互' }));
    const running = screen.getByTitle('游戏 · HTML 预览');
    expect(running).not.toBe(initial);
    expect(running).toHaveAttribute('sandbox', 'allow-scripts');
    expect(running.getAttribute('srcdoc')).toContain('dataset.ready');
    expect(running.getAttribute('srcdoc')).toContain('<canvas id="board">');
    expect(running.getAttribute('srcdoc')).toContain('onclick=');
    expect(screen.getByText(/不等同于网络隔离/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新开始' }));
    expect(screen.getByTitle('游戏 · HTML 预览')).not.toBe(running);
    fireEvent.click(screen.getByRole('button', { name: '停止交互' }));
    expect(screen.getByTitle('游戏 · HTML 预览')).toHaveAttribute('sandbox', '');
    fireEvent.click(screen.getByRole('button', { name: '运行交互' }));
    fireEvent.click(screen.getByRole('button', { name: '源码', exact: true }));
    expect(screen.queryByTitle('游戏 · HTML 预览')).toBeNull();
    expect(screen.getByLabelText('HTML 源码').textContent).toBe(game);
    fireEvent.click(screen.getByRole('button', { name: '预览', exact: true }));
    expect(screen.getByTitle('游戏 · HTML 预览')).toHaveAttribute('sandbox', '');
    fireEvent.click(screen.getByRole('button', { name: '运行交互' }));
    rerender(<ArtifactPreview source={html} type="html" title="游戏" renderMarkdown={markdown} />);
    expect(screen.getByTitle('游戏 · HTML 预览')).toHaveAttribute('sandbox', '');
  });

  it('retains inline scripts and data attributes but strips external scripts, navigation and embeds in interactive mode', () => {
    const source = `<html><head><base href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test"><script src="https://evil.test/remote.js"></script></head><body>
      <canvas data-level="2"></canvas><button data-action="play" onclick="play()">play</button><script>function play(){document.querySelector('canvas').dataset.played='1'}</script>
      <iframe srcdoc="nested"></iframe><object data="https://evil.test"></object><a href="https://evil.test" target="_top" ping="https://evil.test">go</a>
      <form action="/api/private"><input formaction="/api/private"><button formaction="/api/private">submit</button></form><img src="/api/private">
      <svg><script href="https://evil.test/remote.js"></script></svg></body></html>`;
    const doc = new DOMParser().parseFromString(htmlPreviewDocument(source, true), 'text/html');
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelector('script')!.textContent).toContain('function play()');
    expect(doc.querySelector('canvas')!.getAttribute('data-level')).toBe('2');
    expect(doc.querySelector('button')!.getAttribute('onclick')).toBe('play()');
    expect(doc.querySelector('base,iframe,object,embed,meta[http-equiv="refresh"],a[href],[src],[action],[formaction],[target],[ping]')).toBeNull();
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
    for (const rule of ["default-src 'none'", "script-src 'unsafe-inline'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'"]) expect(csp).toContain(rule);
    expect(csp).not.toContain('unsafe-eval');
    expect(doc.head.firstElementChild?.tagName).toBe('META');
  });

  it('stops the compact interactive frame when opening a separately opted-in expanded preview', () => {
    render(<ArtifactPreview source={html} type="html" title="作品" renderMarkdown={markdown} />);
    fireEvent.click(screen.getByRole('button', { name: '运行交互' }));
    fireEvent.click(screen.getByRole('button', { name: '放大预览' }));
    const frames = screen.getAllByTitle('作品 · HTML 预览');
    expect(frames).toHaveLength(2);
    expect(frames.every(frame => frame.getAttribute('sandbox') === '')).toBe(true);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '运行交互' }));
    expect(within(screen.getByRole('dialog')).getByTitle('作品 · HTML 预览')).toHaveAttribute('sandbox', 'allow-scripts');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTitle('作品 · HTML 预览')).toHaveAttribute('sandbox', '');
  });

  it('retains body initialization and keyboard handlers only after interactive opt-in', () => {
    const source = '<html onmouseover="early()"><body onload="startGame()" onkeydown="move(event)" data-level="3" tabindex="0"><canvas></canvas><script>function startGame(){document.body.dataset.ready="yes"}</script></body></html>';
    const enabled = new DOMParser().parseFromString(htmlPreviewDocument(source, true), 'text/html');
    expect(enabled.body.getAttribute('onload')).toBe('startGame()');
    expect(enabled.body.getAttribute('onkeydown')).toBe('move(event)');
    expect(enabled.body.getAttribute('data-level')).toBe('3');
    expect(enabled.body.getAttribute('tabindex')).toBe('0');
    expect(enabled.documentElement.hasAttribute('onmouseover')).toBe(false);
    const staticPreview = new DOMParser().parseFromString(htmlPreviewDocument(source), 'text/html');
    expect(staticPreview.querySelector('[onload],[onkeydown],[data-level],[tabindex],script')).toBeNull();
  });
  it('preserves embedded CSS, inline styling and SVG while adding independent isolation controls', () => {
    const source = html.replace('</body>', '<svg viewBox="0 0 20 20"><path d="M1 1L10 10" stroke="red" /></svg></body>');
    render(<ArtifactPreview source={source} type="html" title="作品" renderMarkdown={markdown} />);
    const frame = screen.getByTitle('作品 · HTML 预览');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    const document = new DOMParser().parseFromString(frame.getAttribute('srcdoc')!, 'text/html');
    expect(document.body.getAttribute('class')).toBe('page');
    expect(document.body.getAttribute('style')).toBe('padding:24px');
    expect(document.documentElement.hasAttribute('style')).toBe(false);
    expect(document.querySelector('style')?.textContent).toContain('html{background:#abc}');
    expect(document.querySelector('h1')?.textContent).toBe('交付页面');
    expect(document.querySelector('svg path')?.getAttribute('stroke')).toBe('red');
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("script-src 'none'");
    expect(document.documentElement.outerHTML).toContain('h1{color:rgb(10,20,30)}');
  });

  it('removes active markup, navigations, refreshes, form targets and resource URLs', () => {
    const source = `<html><head><base href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test"><link rel="stylesheet" href="https://evil.test/x.css"></head><body onload="steal()">
      <script>steal()</script><iframe src="https://evil.test"></iframe><object data="https://evil.test"></object>
      <a href="javascript:steal()" target="_top" ping="https://evil.test">run</a><a href="https://evil.test">go</a>
      <img src="/api/v1/private" srcset="https://evil.test/x 2x" onerror="steal()"><img src="data:image/png;base64,YQ==" alt="local">
      <form action="/api/v1/private"><button formaction="https://evil.test">submit</button><input type="image" src="/private"></form>
      <svg><foreignObject><iframe srcdoc="oops"></iframe></foreignObject><a href="https://evil.test">go</a><use href="https://evil.test/x.svg#x"/></svg>
      <template><script>steal()</script></template></body></html>`;
    const document = new DOMParser().parseFromString(htmlPreviewDocument(source), 'text/html');
    expect(document.querySelector('script,iframe,object,embed,link,base,foreignObject,template')).toBeNull();
    expect(document.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(document.querySelector('[onload],[onerror],[target],[ping],[srcset],[action],[formaction]')).toBeNull();
    expect(document.querySelector('a[href],use[href]')).toBeNull();
    expect(document.querySelector('img[src]')?.getAttribute('src')).toBe('data:image/png;base64,YQ==');
    expect(document.querySelector('button')?.getAttribute('type')).toBe('button');
    expect(document.querySelector('input')?.getAttribute('type')).toBe('button');
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
    for (const value of ["default-src 'none'", "frame-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"]) expect(csp).toContain(value);
  });

  it('does not let angle brackets or quotes in root attributes escape the trusted envelope', () => {
    const source = '<html title="a > b &quot; c"><head></head><body title="x > y" style="color:red" onload="bad()"><h1>Good</h1></body></html>';
    const doc = new DOMParser().parseFromString(htmlPreviewDocument(source), 'text/html');
    expect(doc.documentElement.getAttribute('title')).toBe('a > b " c');
    expect(doc.body.getAttribute('title')).toBe('x > y');
    expect(doc.body.hasAttribute('onload')).toBe(false);
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')).toBeTruthy();
  });

  it('retains original source byte for byte when switching away from the rendition', () => {
    render(<ArtifactPreview source={html} type="html" title="作品" renderMarkdown={markdown} />);
    fireEvent.click(screen.getByRole('button', { name: '源码', exact: true }));
    expect(screen.getByLabelText('HTML 源码').textContent).toBe(html);
    expect(screen.queryByTitle('作品 · HTML 预览')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '预览', exact: true }));
    expect(screen.getByTitle('作品 · HTML 预览')).toBeTruthy();
  });

  it('keeps compact expand and download controls named for keyboard and screen-reader access', () => {
    render(<ArtifactPreview source={html} type="html" title="作品" renderMarkdown={markdown} />);
    const expand = screen.getByRole('button', { name: '放大预览' });
    const download = screen.getByRole('button', { name: '下载 .html' });
    expect(expand).toHaveAttribute('title', '放大预览');
    expect(download).toHaveAttribute('title', '下载 .html');
    expect(expand.textContent).toBe('');
    expect(download.textContent).toBe('');
    expect(screen.getByRole('button', { name: '预览', exact: true })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '源码', exact: true }));
    expect(screen.getByRole('button', { name: '源码', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('HTML 源码').textContent).toBe(html);
  });

  it('keeps partial historical HTML visible without publishing it or offering a final download', () => {
    const node = { ...createSessionNode('coding', { x: 0, y: 0 }), id: 'owner', lastOutput: null,
      contract: { version: 1 as const, inputs: [], outputs: [{ id: 'result', label: '作品', type: 'html' as const, required: true, value: '' }] },
      threads: [{ id: 'default', title: 'Session 1', issueId: 'issue', preview: '', draft: '', createdAt: 1, lastOutput: { text: html, at: 1, partial: true } }] };
    const update = vi.fn();
    render(<NodeDeliverables node={node} readOnly={false} onUpdateNode={update} />);
    expect(screen.getByText('历史交付 · 未传递给下游')).toBeTruthy();
    expect(screen.getByText('部分结果 · 未完成')).toBeTruthy();
    expect(screen.getByTitle('作品 · HTML 预览')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '下载 .html' })).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('renders Markdown structure and makes its exact source available', () => {
    const source = '# 产品方案\n\n**重点**\n\n| 名称 | 数值 |\n|---|---|\n| A | 1 |';
    const node = { ...createSessionNode('coding', { x: 0, y: 0 }),
      contract: { version: 1 as const, inputs: [], outputs: [{ id: 'result', label: '方案', type: 'markdown' as const, required: true, value: '' }] },
      lastOutput: { text: source, at: 1 } };
    render(<NodeDeliverables node={node} readOnly />);
    expect(screen.getByRole('heading', { name: '产品方案' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('重点').tagName).toBe('STRONG');
    fireEvent.click(screen.getByRole('button', { name: '源码', exact: true }));
    expect(screen.getByLabelText('Markdown 源码').textContent).toBe(source);
  });

  it('keeps translated preview controls and does not render excessively large inline HTML', () => {
    render(<LocaleProvider locale="en"><ArtifactPreview source={'a'.repeat(MAX_ARTIFACT_PREVIEW_BYTES + 1)} type="html" title="Page" renderMarkdown={markdown} /></LocaleProvider>);
    expect(screen.getByRole('button', { name: 'Preview', exact: true })).toBeTruthy();
    expect(screen.getByRole('status')).toHaveTextContent('2 MiB');
    expect(screen.queryByTitle('Page · HTML preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Download .html' })).toBeTruthy();
  });

  it.each(['html', 'markdown'] as const)('expands %s outside the transformed canvas and closes with restored focus', type => {
    const { container } = render(<div style={{ transform: 'scale(0.5)' }}><ArtifactPreview source={type === 'html' ? html : '# Report'} type={type} title="完整作品" renderMarkdown={markdown} /></div>);
    const trigger = screen.getByRole('button', { name: '放大预览', exact: true });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '完整作品' });
    expect(dialog.parentElement).toBe(document.body);
    expect(container.contains(dialog)).toBe(false);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const close = within(dialog).getByRole('button', { name: '关闭预览' });
    expect(close).toHaveFocus();
    expect(within(dialog).queryByRole('button', { name: '放大预览' })).toBeNull();
    if (type === 'html') {
      const frame = within(dialog).getByTitle('完整作品 · HTML 预览');
      expect(frame).toHaveAttribute('sandbox', '');
      expect(frame.getAttribute('srcdoc')).toContain('交付页面');
    } else expect(within(dialog).getByText('# Report')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('keeps tab focus in the expanded preview and does not leak pointer or keyboard events to the canvas', () => {
    const canvasPointer = vi.fn();
    const canvasKey = vi.fn();
    render(<div onPointerDown={canvasPointer} onKeyDown={canvasKey}><ArtifactPreview source={html} type="html" title="作品" renderMarkdown={markdown} /></div>);
    fireEvent.click(screen.getByRole('button', { name: '放大预览' }));
    const dialog = screen.getByRole('dialog', { name: '作品' });
    const close = within(dialog).getByRole('button', { name: '关闭预览' });
    const download = within(dialog).getByRole('button', { name: '下载 .html' });
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(download).toHaveFocus();
    fireEvent.keyDown(download, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.pointerDown(within(dialog).getByRole('button', { name: '源码', exact: true }));
    fireEvent.keyDown(close, { key: 'Delete' });
    expect(canvasPointer).not.toHaveBeenCalled();
    expect(canvasKey).not.toHaveBeenCalled();
    fireEvent.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('removes an expanded preview and its event listeners when its owner unmounts', () => {
    const { unmount } = render(<ArtifactPreview source={html} type="html" title="作品" renderMarkdown={markdown} />);
    fireEvent.click(screen.getByRole('button', { name: '放大预览' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    unmount();
    expect(screen.queryByRole('dialog')).toBeNull();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it('prevents the real window canvas shortcut layer from deleting, undoing or changing focus behind the modal', () => {
    const action = vi.fn();
    function Harness() {
      useCanvasKeys({ onDeleteSelection: action, onUndo: action, onPalette: action, onFocusToggle: action, onEscape: action });
      return <ArtifactPreview source={html} type="html" title="作品" renderMarkdown={markdown} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '放大预览' }));
    const close = within(screen.getByRole('dialog')).getByRole('button', { name: '关闭预览' });
    fireEvent.keyDown(close, { key: 'Delete' });
    for (const key of ['z', 'p', 'e']) fireEvent.keyDown(close, { key, ctrlKey: true });
    expect(action).not.toHaveBeenCalled();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(action).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(action).toHaveBeenCalledOnce();
  });
});

describe('stored byte preview', () => {
  const png = () => {
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0); bytes.set(new TextEncoder().encode('IHDR'), 12);
    const view = new DataView(bytes.buffer); view.setUint32(16, 2); view.setUint32(20, 2);
    return bytes;
  };
  it('previews only authenticated raster bytes through a revocable blob and preserves the download endpoint', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const create = vi.fn(() => 'blob:awwo-image'); const revoke = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = create; static revokeObjectURL = revoke; });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(png(), { headers: { 'Content-Disposition': 'attachment; filename="render.png"' } })));
    const { unmount } = render(stored());
    const image = await screen.findByRole('img', { name: '网页' });
    expect(image).toHaveAttribute('src', 'blob:awwo-image');
    expect(create.mock.calls[0][0].type).toBe('image/png');
    expect(screen.getByRole('link', { name: '下载文件' })).toHaveAttribute('href', artifactUrl);
    fireEvent.click(screen.getByRole('button', { name: '放大预览' }));
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', 'blob:awwo-image');
    unmount();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:awwo-image');
  });

  it('rejects HTML disguised as an image, extension mismatches and oversized raster dimensions', async () => {
    await expect(readArtifactPreview(response('<svg onload="bad()"></svg>', 'render.png'), new AbortController().signal)).rejects.toThrow('preview_unavailable');
    expect(artifactImageType('render.jpg', png())).toBeNull();
    const huge = png(); new DataView(huge.buffer).setUint32(16, 20000);
    expect(artifactImageType('render.png', huge)).toBeNull();
    expect(artifactImageType('render.png', png())).toBe('image/png');
  });

  it('does not leave an image from the previous Session visible or retain its blob URL', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const revoke = vi.fn(); const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = vi.fn(() => 'blob:previous'); static revokeObjectURL = revoke; });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(png(), { headers: { 'Content-Disposition': 'attachment; filename=render.png' } }))
      .mockResolvedValueOnce(response('# Next delivery', 'report.md'));
    vi.stubGlobal('fetch', fetch);
    const { rerender } = render(stored('first'));
    expect(await screen.findByRole('img')).toBeTruthy();
    rerender(stored('second'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:previous');
    expect(await screen.findByText('# Next delivery')).toBeTruthy();
  });
  it('uses only the scoped artifact endpoint and previews the actual returned HTML bytes', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const fetch = vi.fn().mockResolvedValue(response(html, 'fallback.html', { 'Content-Disposition': "attachment; filename=_.html; filename*=UTF-8''%E4%BD%9C%E5%93%81.html" }));
    vi.stubGlobal('fetch', fetch);
    render(stored());
    const frame = await screen.findByTitle('网页 · HTML 预览');
    expect(frame.getAttribute('srcdoc')).toContain('已保存的内容');
    expect(fetch).toHaveBeenCalledWith(artifactUrl, expect.objectContaining({ credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal) }));
    expect(screen.getByRole('link', { name: '下载文件' })).toHaveAttribute('href', artifactUrl);
    fireEvent.click(screen.getByRole('button', { name: '源码', exact: true }));
    expect(screen.getByLabelText('HTML 源码').textContent).toBe(html);
  });

  it('previews stored Markdown and rejects guesses based only on a response content type', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('# Saved', 'report.md')));
    const { unmount } = render(stored());
    expect(await screen.findByText('# Saved')).toBeTruthy();
    unmount();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })));
    render(stored());
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法预览');
    expect(screen.queryByTitle('网页 · HTML 预览')).toBeNull();
  });

  it.each(['tickets.ts', 'Component.TSX', 'app.js', 'module.mjs', 'settings.json', 'styles.css', 'notes.txt'])('reads bounded UTF-8 source from %s as plain text', async name => {
    const source = 'export const value = "<script>window.untrusted = true</script>";\n// 中文';
    await expect(readArtifactPreview(response(source, name), new AbortController().signal))
      .resolves.toEqual({ name, source, type: 'text' });
  });

  it('opens a stored TypeScript deliverable as exact inert source, with download and expanded preview', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const source = 'export const view = <img src="/api/v1/private" onerror="steal()" />;\n<script>steal()</script>';
    const renderMarkdown = vi.fn(markdown);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(source, 'tickets.ts')));
    render(<StoredArtifactPreview reference={reference} identity="typescript" title="源码交付物" renderMarkdown={renderMarkdown} />);
    expect((await screen.findByLabelText('文件源码')).textContent).toBe(source);
    expect(screen.queryByRole('button', { name: '预览', exact: true })).toBeNull();
    expect(screen.getByRole('button', { name: '源码', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: '下载文件' })).toHaveAttribute('href', artifactUrl);
    expect(document.querySelector('.awwo-artifact-preview iframe, .awwo-artifact-preview img, .awwo-artifact-preview script')).toBeNull();
    expect(renderMarkdown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '放大预览' }));
    const dialog = screen.getByRole('dialog', { name: 'tickets.ts' });
    expect(within(dialog).getByLabelText('文件源码').textContent).toBe(source);
    expect(within(dialog).getByRole('link', { name: '下载文件' })).toHaveAttribute('href', artifactUrl);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([new Uint8Array([0xff, 0xfe]), new TextEncoder().encode('valid\0binary'), new TextEncoder().encode('valid\u0007binary')])('refuses binary bytes with a source-code extension', async bytes => {
    const reply = new Response(bytes, { headers: { 'Content-Disposition': 'attachment; filename=payload.ts' } });
    await expect(readArtifactPreview(reply, new AbortController().signal)).rejects.toThrow();
  });

  it('does not read or claim to preview unsupported binary file formats', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Disposition': 'attachment; filename=report.pdf' } })));
    render(stored());
    expect(await screen.findByText('此文件格式暂不支持预览，可以下载查看。')).toBeTruthy();
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: '下载文件' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '预览', exact: true })).toBeNull();
  });

  it.each(['header', 'stream'])('enforces the byte limit using %s evidence', async mode => {
    const cancel = vi.fn();
    const content = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_ARTIFACT_PREVIEW_BYTES + 1)); }, cancel });
    const reply = new Response(content, { headers: { 'Content-Disposition': 'attachment; filename=report.md', 'Content-Length': mode === 'header' ? String(MAX_ARTIFACT_PREVIEW_BYTES + 1) : '1' } });
    await expect(readArtifactPreview(reply, new AbortController().signal)).rejects.toThrow('preview_too_large');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('decodes multibyte UTF-8 across chunks and refuses binary data masquerading as text', async () => {
    const bytes = new TextEncoder().encode('正文');
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 2)); controller.enqueue(bytes.slice(2)); controller.close(); } });
    const value = await readArtifactPreview(new Response(stream, { headers: { 'Content-Disposition': 'attachment; filename=report.md' } }), new AbortController().signal);
    expect(value).toEqual({ name: 'report.md', source: '正文', type: 'markdown' });
    await expect(readArtifactPreview(response('hello\0world', 'report.md'), new AbortController().signal)).rejects.toThrow('preview_unavailable');
  });

  it('refuses an unexpected response URL without displaying its content or error details', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const reply = response('private error details');
    Object.defineProperty(reply, 'url', { value: 'https://foreign.test/artifact.html' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply));
    render(stored());
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法预览');
    expect(screen.queryByText('private error details')).toBeNull();
    expect(screen.getByRole('button', { name: '重试预览' })).toBeTruthy();
  });

  it('aborts on unmount and never updates the next Session with an older response', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    let firstResolve!: (value: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { firstResolve = resolve; })).mockResolvedValueOnce(response('# New Session', 'report.md'));
    vi.stubGlobal('fetch', fetch);
    const { rerender, unmount } = render(stored('session-1'));
    const firstSignal = fetch.mock.calls[0][1].signal as AbortSignal;
    rerender(stored('session-2'));
    expect(firstSignal.aborted).toBe(true);
    expect(await screen.findByText('# New Session')).toBeTruthy();
    await act(async () => { firstResolve(response('# Previous Session', 'report.md')); });
    expect(screen.queryByText('# Previous Session')).toBeNull();
    const lastSignal = fetch.mock.calls[1][1].signal as AbortSignal;
    unmount();
    expect(lastSignal.aborted).toBe(true);
  });

  it('rejects late bytes when the workspace changes without a component rerender', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(done => { resolve = done; })));
    render(stored());
    configureSaaSCanvas({ tenant: { ...tenant, id: 'tenant-b' }, canvasId: 'other' });
    await act(async () => { resolve(response('# Old workspace', 'report.md')); });
    expect(screen.queryByText('# Old workspace')).toBeNull();
    expect(screen.queryByTitle('网页 · HTML 预览')).toBeNull();
  });

  it('does not fetch malformed references, local paths, or external URLs', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const value of ['awwo-file:../../private', 'C:/report.html', 'https://foreign.test/report.html']) {
      const { unmount } = render(<StoredArtifactPreview reference={value} identity="id" title="File" renderMarkdown={markdown} />);
      expect(screen.queryByRole('link')).toBeNull();
      unmount();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('parses safe extended filenames and requires an attachment response', () => {
    expect(artifactFilename("attachment; filename=_.md; filename*=UTF-8''%E6%96%87%E6%A1%A3.md")).toBe('文档.md');
    expect(artifactFilename('attachment; filename="report.md"')).toBe('report.md');
    expect(artifactFilename('inline; filename="report.html"')).toBeNull();
    expect(artifactFilename("attachment; filename*=UTF-8''bad%00.html")).toBeNull();
    expect(artifactFilename("attachment; filename*=UTF-8''bad%FF.html")).toBeNull();
  });
});
