// The deliverable studio's pure parts: which file a published output becomes, how a delivered page is isolated when
// it runs, and what an archive may inflate to.
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { fileStem, formatBytes, isTextKind, kindOfName, kindOfType, nodeEntries, primaryEntry, studioGroups } from '../src/canvas/studio/studioModel';
import { buildLiveDocument, joinPath, LIVE_PAGE_CSP, LIVE_PAGE_SANDBOX, standaloneWrapper } from '../src/canvas/studio/liveDocument';
import { STUDIO_LIMITS, dataUrl, decodeText, mimeOfName, safeArchivePath, unzipMembers } from '../src/canvas/studio/studioData';

function node(output: string, outputs: SessionNode['contract'] = undefined, extra: Partial<SessionNode> = {}): SessionNode {
  return { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'n1', title: '落地页', ...(outputs ? { contract: outputs } : {}),
    lastOutput: { text: output, at: 1, source: 'run' as const }, ...extra };
}

describe('studio model', () => {
  it('names a viewer for files by extension or type', () => {
    expect(kindOfName('index.html')).toBe('page');
    expect(kindOfName('src/app.tsx')).toBe('code');
    expect(kindOfName('Dockerfile')).toBe('code');
    expect(kindOfName('scene.glb')).toBe('model');
    expect(kindOfName('report.pdf')).toBe('pdf');
    expect(kindOfName('data.csv')).toBe('table');
    expect(kindOfName('blob.bin')).toBe('file');
    expect(kindOfType('image/png; charset=binary')).toBe('image');
    expect(kindOfType('model/gltf-binary')).toBe('model');
    expect(kindOfType('application/octet-stream')).toBeNull();
    expect(isTextKind('code')).toBe(true);
    expect(isTextKind('image')).toBe(false);
  });

  it('keeps CJK in file names and drops path characters', () => {
    expect(fileStem('产品/介绍:页')).toBe('产品-介绍-页');
    expect(fileStem('...')).toBe('deliverable');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(undefined)).toBe('');
  });

  it('turns a contract output into files: a page first, prose as Markdown, scalars as JSON', () => {
    const contract = { version: 1 as const, inputs: [], outputs: [
      { id: 'page', label: '页面', type: 'html' as const, required: true, value: '' },
      { id: 'notes', label: '说明', type: 'markdown' as const, required: false, value: '' },
      { id: 'score', label: '评分', type: 'number' as const, required: false, value: '' },
    ] };
    const output = JSON.stringify({ page: '<!doctype html><html><head><title>Hi</title></head><body><h1>Hi</h1></body></html>', notes: '## 说明\n\n- 一', score: 9 });
    const entries = nodeEntries(node(output, contract), 'run');
    expect(entries.map(entry => [entry.name, entry.kind])).toEqual([
      ['页面.html', 'page'], ['说明.md', 'markdown'], ['落地页.json', 'data'],
    ]);
    expect(entries.find(entry => entry.primary)?.kind).toBe('page');
    expect(JSON.parse((entries[2].source as { text: string }).text)).toEqual({ 评分: '9' });
    expect(primaryEntry(node(output, contract))?.name).toBe('页面.html');
  });

  it('lists a file the node only named, without bytes, as missing rather than delivered', () => {
    const contract = { version: 1 as const, inputs: [], outputs: [{ id: 'zip', label: '源码包', type: 'file' as const, required: true, value: '' }] };
    const entries = nodeEntries(node(JSON.stringify({ zip: 'site.zip' }), contract), 'run');
    expect(entries.some(entry => entry.source.type === 'stored')).toBe(false);
  });

  it('keeps free text as a document and reads stored files by reference', () => {
    expect(nodeEntries(node('# 标题\n\n正文'), 'run')).toEqual([expect.objectContaining({ name: '落地页.md', kind: 'markdown', primary: true })]);
    const contract = { version: 1 as const, inputs: [], outputs: [{ id: 'file', label: '模型', type: 'file' as const, required: true, value: '' }] };
    expect(nodeEntries(node(JSON.stringify({ file: 'awwo-file:abc' }), contract), 'run')[0]).toMatchObject({ kind: 'file', source: { type: 'stored', reference: 'awwo-file:abc' } });
  });

  it('lists only nodes with published output, the canvas result first', () => {
    const first = node('第一步结果', undefined, { id: 'a', title: '第一步' });
    const second = node('最终结果', undefined, { id: 'b', title: '第二步' });
    const idle = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'c', title: '未运行' };
    const groups = studioGroups({ nodes: [first, second, idle], edges: [{ id: 'e', fromNode: 'a', fromPort: 'result', toNode: 'b', toPort: 'context', dataType: 'text' }] });
    expect(groups.map(group => group.nodeId)).toEqual(['b', 'a']);
    expect(groups[0].final).toBe(true);
    expect(studioGroups({ nodes: [first, second], edges: [] }, 'a').map(group => group.nodeId)).toEqual(['a']);
  });
});

describe('live page document', () => {
  it('runs in an opaque origin: no same-origin, no top navigation, no popups', () => {
    const flags = LIVE_PAGE_SANDBOX.split(' ');
    expect(flags).toContain('allow-scripts');
    for (const forbidden of ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-top-navigation-by-user-activation']) expect(flags).not.toContain(forbidden);
    expect(standaloneWrapper('页"<x>', '<p>a</p>')).toContain(`sandbox="${LIVE_PAGE_SANDBOX}"`);
    expect(standaloneWrapper('页"<x>', '<p>a</p>')).not.toContain('<x>');
  });

  it('injects the CSP before anything else and removes refresh and base redirections', async () => {
    const page = await buildLiveDocument('<html><head><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example"><script>window.x=1</script></head><body><a href="https://example.com">x</a></body></html>');
    const parsed = new DOMParser().parseFromString(page, 'text/html');
    const first = parsed.head.firstElementChild!;
    expect(first.getAttribute('charset')).toBe('utf-8');
    const csp = parsed.head.querySelector('meta[http-equiv="Content-Security-Policy"]')!;
    expect(csp.getAttribute('content')).toBe(LIVE_PAGE_CSP);
    // The policy is the first thing the page's own head can be affected by: nothing of the page precedes it.
    expect([...parsed.head.children].indexOf(csp)).toBe(1);
    expect(parsed.querySelector('base')).toBeNull();
    expect(parsed.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(page).toContain('window.x=1');
    expect(LIVE_PAGE_CSP).toContain("form-action 'none'");
    expect(LIVE_PAGE_CSP).toContain("base-uri 'none'");
    expect(LIVE_PAGE_CSP).not.toMatch(/connect-src[^;]*https:(?:\s|;|$)/);
  });

  it('inlines relative assets from the bytes the studio has, and never leaves the root', async () => {
    const files: Record<string, string> = {
      'site/style.css': 'body{background:url("img/bg.png")}',
      'site/img/bg.png': 'PNG',
      'site/app.js': 'import { v } from "./lib.js"; console.log(v);',
      'site/lib.js': 'export const v = 1;',
    };
    const resolve = async (path: string) => files[path] ? { bytes: strToU8(files[path]), name: path } : null;
    const page = await buildLiveDocument('<html><head><link rel="stylesheet" href="style.css"><script type="module" src="app.js"></script></head><body><img src="../../etc/passwd"></body></html>',
      { path: 'site/index.html', resolve });
    expect(page).not.toContain('href="style.css"');
    expect(page).toContain(dataUrl(strToU8('PNG'), 'image/png'));
    expect(page).toContain('data:text/javascript;base64,');
    expect(page).toContain('src="../../etc/passwd"');
    expect(joinPath('site/index.html', '../../etc/passwd')).toBeNull();
    expect(joinPath('site/index.html', './img/a%20b.png')).toBe('site/img/a b.png');
  });
});

describe('archive limits', () => {
  it('refuses unsafe member paths', () => {
    for (const bad of ['../x', '/abs', 'a/../b', 'a//b', 'C:\\x', 'a\u0000b']) expect(safeArchivePath(bad)).toBe(false);
    expect(safeArchivePath('src/main.ts')).toBe(true);
  });

  it('opens an archive, skips litter and refuses traversal', async () => {
    const zipped = zipSync({ 'index.html': strToU8('<p>hi</p>'), '__MACOSX/._index.html': strToU8('x'), 'a/b.txt': strToU8('b') });
    const files = await unzipMembers(zipped, new AbortController().signal);
    expect(files.map(file => file.path)).toEqual(['a/b.txt', 'index.html']);
    await expect(unzipMembers(zipSync({ '../evil.txt': strToU8('x') }), new AbortController().signal)).rejects.toThrow('studio_archive_paths');
    await expect(unzipMembers(strToU8('not a zip'), new AbortController().signal)).rejects.toThrow('studio_archive_invalid');
    expect(STUDIO_LIMITS.inflated).toBeGreaterThan(STUDIO_LIMITS.archive);
  });

  it('decodes only text and maps names to types', () => {
    expect(decodeText(strToU8('你好'))).toBe('你好');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(mimeOfName('a.glb')).toBe('model/gltf-binary');
    expect(mimeOfName('a.unknown', 'x/y')).toBe('x/y');
  });
});
