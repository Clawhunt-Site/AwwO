import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPreview, artifactFilename, readArtifactPreview, StoredArtifactPreview } from '../src/canvas/ArtifactPreview';
import { htmlPreviewDocument, MAX_ARTIFACT_PREVIEW_BYTES } from '../src/canvas/htmlDeliverable';
import { ARTIFACT_REF_PREFIX, clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import { createSessionNode } from '../src/canvas/canvasDoc';
import { LocaleProvider } from '../src/canvas/i18n';
import { useCanvasKeys } from '../src/canvas/useCanvasKeys';

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
