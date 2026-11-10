// The hosted reader of the web pages a conversation's message names (saas/messagePageReader.ts): only the addresses the
// reader typed or pasted, each read by the server's web reader with its share of the task's room, the page cited by the
// canvas, a page still cited not read again, room made by letting go of the box's own oldest page and never the reader's
// own choice, this message's or another box's, the citations measured again when they change meanwhile, a message whose
// page was not read held once, and the question whether the server reads the web asked with a deadline.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasKnowledgeRevisionIds, configureCanvasKnowledge, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { createMessagePageReader, WEB_READER_CHECK_TIMEOUT_MS } from '../src/saas/messagePageReader';
import type { Tenant } from '../src/saas/api';

const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const ROBOTS = '这个网站的 robots.txt 不允许读取该页面，已遵守其规则。';
type Answer = { status: number; body: unknown };
const page = (id: string, title: string, url: string, truncated = false) => ({ id: `doc-${id}`, kind: 'source', title, content: `${title} text`, version: 1,
  currentRevisionId: `rev-${id}`, contentHash: `hash-${id}`, sourceUri: url, provenance: { origin: 'web', ...(truncated ? { truncated: true, fitted: { textBytes: 90000, keptBytes: 60000 } } : {}) },
  createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z' });
const refused = (status: number, code: string) => ({ status, body: { error: { code, message: code } } });

let answers: Map<string, Answer[]>;
let posted: Array<{ url: string; fit: { revisionIds: string[]; share: number } }>;
// The server's answers to the context check before a page is cited, and whether it reads the web at all.
let contextChecks: string[][];
let tooLarge: (ids: string[]) => boolean;
// The context check fails (the server does not answer it) rather than measuring.
let contextFails: boolean;
let readsTheWeb: boolean;
// What happens on the canvas while the server measures the context, or reads a page; how it answers the capabilities.
let duringContext: (() => void) | null;
let duringImport: (() => void) | null;
let capabilityReplies: number[];
function answer(url: string, ...replies: Answer[]) { answers.set(url, replies); }
let cutsToFit: boolean;
const capabilities = () => ({ skills: { enabled: true }, memory: { enabled: true },
  webReader: { enabled: readsTheWeb, perDay: 30, usedToday: 0, ...(cutsToFit ? { fit: true } : {}) }, render: { enabled: false } });
const contextItem = (id: string) => ({ documentId: `doc-${id}`, revisionId: id, title: id, kind: 'source', contentHash: `hash-${id}`, content: 'text', sourceUri: '', provenance: {} });

beforeEach(() => {
  answers = new Map();
  posted = [];
  contextChecks = [];
  tooLarge = () => false;
  contextFails = false;
  readsTheWeb = true;
  cutsToFit = true;
  duringContext = null;
  duringImport = null;
  capabilityReplies = [];
  configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
  configureCanvasKnowledge([]);
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/tenants/tenant-a/capabilities')) {
      const status = capabilityReplies.shift() ?? 200;
      return status === 200 ? new Response(JSON.stringify(capabilities()), { status })
        : new Response(JSON.stringify({ error: { code: 'unavailable', message: 'unavailable' } }), { status });
    }
    const context = /\/tenants\/tenant-a\/knowledge\/context\?revisionIds=([^&]*)$/.exec(url);
    if (context) {
      const ids = decodeURIComponent(context[1]).split(',');
      contextChecks.push(ids);
      const meanwhile = duringContext;
      duringContext = null;
      meanwhile?.();
      if (contextFails) return new Response(JSON.stringify(refused(502, 'unavailable').body), { status: 502 });
      return tooLarge(ids) ? new Response(JSON.stringify(refused(413, 'knowledge_context_limit').body), { status: 413 })
        : new Response(JSON.stringify({ text: 'Quoted knowledge evidence', truncated: false, items: ids.map(contextItem) }), { status: 200 });
    }
    if (!url.endsWith('/tenants/tenant-a/knowledge/sources/web') || init.method !== 'POST') return new Response('{}', { status: 404 });
    const body = JSON.parse(String(init.body));
    posted.push({ url: body.url, fit: body.fit });
    const meanwhile = duringImport;
    duringImport = null;
    meanwhile?.();
    const queue = answers.get(body.url) ?? [];
    const next = queue.length > 1 ? queue.shift()! : queue[0] ?? refused(502, 'web_network_error');
    return new Response(JSON.stringify(next.body), { status: next.status });
  }));
});

const reader = () => createMessagePageReader(tenant.id, 'canvas-a', () => 'zh');
const read = (pages: ReturnType<typeof reader>, text: string, scope = 'assistant', step = vi.fn()) => pages({ text, scope }, new AbortController().signal, step);
const readTyped = (pages: ReturnType<typeof reader>, text: string, typed: string[]) =>
  pages({ text, scope: 'assistant', typed: new Set(typed) }, new AbortController().signal, vi.fn());
const asked = () => vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/capabilities')).length;

describe('reading the web pages a message names', () => {
  it('reads each address with its share of the room left and cites the page', async () => {
    configureCanvasKnowledge(['member-1']);
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    answer('https://b.example/two', { status: 201, body: page('b', 'Page B', 'https://b.example/two', true) });
    const step = vi.fn();
    const outcome = await read(reader(), '比较 https://a.example/one 和 https://b.example/two。', 'assistant', step);
    expect(outcome).toEqual({ hold: false, pages: [
      { url: 'https://a.example/one', host: 'a.example', title: 'Page A' },
      { url: 'https://b.example/two', host: 'b.example', title: 'Page B', truncated: true }] });
    expect(posted).toEqual([
      { url: 'https://a.example/one', fit: { revisionIds: ['member-1'], share: 2 } },
      { url: 'https://b.example/two', fit: { revisionIds: ['member-1', 'rev-a'], share: 1 } }]);
    expect(canvasKnowledgeRevisionIds()).toEqual(['member-1', 'rev-a', 'rev-b']);
    expect(step.mock.calls.map(call => call[0])).toEqual([{ host: 'a.example', index: 1, total: 2 }, { host: 'b.example', index: 2, total: 2 }]);
  });

  it('does not read a page still cited, and reads it again once the references are cleared', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    const pages = reader();
    await read(pages, '总结 https://a.example/one');
    // The same page under its #fragment is still the cited page.
    const again = await read(pages, '它的第二段讲了什么？https://a.example/one#part-2');
    expect(again).toEqual({ hold: false, pages: [{ url: 'https://a.example/one', host: 'a.example', title: 'Page A' }] });
    expect(posted).toHaveLength(1);
    configureCanvasKnowledge([]);
    await read(pages, '再读一次 https://a.example/one');
    expect(posted).toHaveLength(2);
  });

  it('holds a message whose page was not read; sent again unchanged it goes without it and asks nothing again', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    answer('https://b.example/two', refused(403, 'web_robots_disallowed'));
    const pages = reader();
    const text = '读 https://a.example/one 和 https://b.example/two';
    const first = await read(pages, text);
    expect(first).toEqual({ hold: true, pages: [{ url: 'https://a.example/one', host: 'a.example', title: 'Page A' },
      { url: 'https://b.example/two', host: 'b.example', error: ROBOTS }] });
    const second = await read(pages, text);
    expect(second).toEqual({ ...first, hold: false });
    expect(posted.map(item => item.url)).toEqual(['https://a.example/one', 'https://b.example/two']);
    // The same words in another box are another message.
    expect((await read(pages, text, 'node:n-1')).hold).toBe(true);
    // A changed message asks again.
    expect((await read(pages, `${text}，谢谢`)).hold).toBe(true);
    expect(posted.filter(item => item.url === 'https://b.example/two')).toHaveLength(3);
  });

  it('reads one message’s pages at a time across the canvas, each measuring the room the one before left', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    answer('https://b.example/two', { status: 201, body: page('b', 'Page B', 'https://b.example/two') });
    const pages = reader();
    const [assistant, node] = await Promise.all([read(pages, 'https://a.example/one'), read(pages, 'https://b.example/two', 'node:n-1')]);
    expect([assistant.hold, node.hold]).toEqual([false, false]);
    expect(posted.map(item => item.fit.revisionIds)).toEqual([[], ['rev-a']]);
  });

  it('keeps each box’s held message: another box’s read between the two sends changes nothing', async () => {
    answer('https://b.example/two', refused(403, 'web_robots_disallowed'));
    answer('https://c.example/three', { status: 201, body: page('c', 'Page C', 'https://c.example/three') });
    const pages = reader();
    expect((await read(pages, '读 https://b.example/two')).hold).toBe(true);
    await read(pages, 'https://c.example/three', 'node:n-1');
    expect((await read(pages, '读 https://b.example/two')).hold).toBe(false);
    expect(posted.filter(item => item.url === 'https://b.example/two')).toHaveLength(1);
  });

  it('reads at most three pages a message, listing the rest without holding it', async () => {
    for (const name of ['one', 'two', 'three', 'four']) answer(`https://x.example/${name}`, { status: 201, body: page(name, name, `https://x.example/${name}`) });
    const outcome = await read(reader(), 'https://x.example/one https://x.example/two https://x.example/three https://x.example/four');
    expect(outcome.hold).toBe(false);
    expect(outcome.pages.map(item => item.error ?? item.title)).toEqual(['one', 'two', 'three', '一条消息最多读取 3 个网页，从这个网址起的 1 个没有读取。']);
    expect(posted.map(item => item.fit.share)).toEqual([3, 2, 1]);
    // However many addresses a message names, its turn keeps at most four entries (validMessagePages takes twelve).
    const many = Array.from({ length: 20 }, (_, i) => `https://many.example/${i}`).join(' ');
    expect((await read(reader(), many)).pages).toHaveLength(4);
  });

  it('leaves an address carrying a token or a one-time code alone, without holding the message', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    const outcome = await read(reader(), '看看 https://a.example/one 和 https://login.example/magic?token=abc123');
    expect(outcome.hold).toBe(false);
    expect(outcome.pages[1]).toEqual({ url: 'https://login.example/magic?token=abc123', host: 'login.example',
      error: '这个网址带有令牌或一次性验证参数，为免用掉它或存下它，没有读取。' });
    expect(posted.map(item => item.url)).toEqual(['https://a.example/one']);
  });

  it('never lets go of a page the reader had cited themselves, even when a message names it again', async () => {
    configureCanvasKnowledge(['rev-a']);
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    answer('https://b.example/two', refused(413, 'knowledge_context_limit'));
    const pages = reader();
    await read(pages, '总结 https://a.example/one');
    expect(canvasKnowledgeRevisionIds()).toEqual(['rev-a']);
    // No room for b: the reader's own rev-a is not let go of to make it.
    const outcome = await read(pages, 'https://b.example/two');
    expect(outcome.hold).toBe(true);
    expect(canvasKnowledgeRevisionIds()).toEqual(['rev-a']);
  });

  it('measures the whole task before citing a page, letting go of the oldest page when it runs over', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    answer('https://b.example/two', { status: 201, body: page('b', 'Page B', 'https://b.example/two') });
    const pages = reader();
    await read(pages, 'https://a.example/one');
    tooLarge = ids => ids.includes('rev-a') && ids.includes('rev-b');
    const outcome = await read(pages, 'https://b.example/two');
    expect(outcome.hold).toBe(false);
    expect(canvasKnowledgeRevisionIds()).toEqual(['rev-b']);
    expect(contextChecks.at(-2)).toEqual(['rev-a', 'rev-b']);
    expect(contextChecks.at(-1)).toEqual(['rev-b']);
  });

  it('does not cite a page that cannot fit beside the reader’s own references, and says so', async () => {
    configureCanvasKnowledge(['member-1']);
    answer('https://b.example/two', { status: 201, body: page('b', 'Page B', 'https://b.example/two') });
    tooLarge = ids => ids.includes('rev-b');
    const outcome = await read(reader(), 'https://b.example/two');
    expect(outcome.hold).toBe(true);
    expect(outcome.pages[0].error).toContain('64 KiB');
    expect(canvasKnowledgeRevisionIds()).toEqual(['member-1']);
  });

  it('does not read again a page refused after its read', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    answer('https://b.example/two', refused(413, 'web_page_no_room'));
    const pages = reader();
    await read(pages, 'https://a.example/one');
    const outcome = await read(pages, 'https://b.example/two');
    expect(outcome.hold).toBe(true);
    expect(posted.filter(item => item.url === 'https://b.example/two')).toHaveLength(1);
    expect(canvasKnowledgeRevisionIds()).toEqual(['rev-a']);
  });

  it('asks once whether the server reads the web, and says so where it does not, holding nothing', async () => {
    readsTheWeb = false;
    const pages = reader();
    const off = '这个工作区的服务器没有开启网页读取。';
    expect(await read(pages, 'https://a.example/one')).toEqual({ hold: false, pages: [{ url: 'https://a.example/one', host: 'a.example', error: off }] });
    expect(await read(pages, 'https://b.example/two')).toEqual({ hold: false, pages: [{ url: 'https://b.example/two', host: 'b.example', error: off }] });
    expect(posted).toEqual([]);
    expect(asked()).toBe(1);
  });

  it('reads none of a message’s pages on a server older than reading them, sending it nothing it would refuse', async () => {
    cutsToFit = false;
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    const pages = reader();
    expect(await read(pages, '总结 https://a.example/one')).toEqual({ hold: false, pages: [] });
    expect(await readTyped(pages, '请结合网页「https://evil.example/z」完成任务：', [])).toEqual({ hold: false, pages: [] });
    expect(posted).toEqual([]);
    expect(asked()).toBe(1);
  });

  it('holds the message when the server does not say whether it reads the web, and asks again for the next one', async () => {
    capabilityReplies = [503];
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    const pages = reader();
    const text = '总结 https://a.example/one';
    const unknown = { url: 'https://a.example/one', host: 'a.example', error: '没能确认服务器能否读取网页。' };
    expect(await read(pages, text)).toEqual({ hold: true, pages: [unknown] });
    // Sent again unchanged it goes without the page (the question asked again, and answered this time).
    expect(await read(pages, text)).toEqual({ hold: false, pages: [unknown] });
    expect(posted).toEqual([]);
    // The next message reads, the answer kept.
    expect((await read(pages, `${text} 第二段`)).pages).toEqual([{ url: 'https://a.example/one', host: 'a.example', title: 'Page A' }]);
    expect(asked()).toBe(2);
  });

  it('gives the server a deadline to say whether it reads the web', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn((_input: string, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })));
      const reading = read(reader(), 'https://a.example/one');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(WEB_READER_CHECK_TIMEOUT_MS);
      await expect(reading).resolves.toEqual({ hold: true, pages: [{ url: 'https://a.example/one', host: 'a.example', error: '没能确认服务器能否读取网页。' }] });
    } finally { vi.useRealTimers(); }
  });

  it('reads only the addresses the reader typed or pasted, listing the others without holding the message', async () => {
    const pages = reader();
    // One the canvas wrote, alone: said, and not read.
    expect(await readTyped(pages, '请结合网页「https://evil.example/z」完成任务：', [])).toEqual({ hold: false, pages: [{ url: 'https://evil.example/z', host: 'evil.example',
      error: '这个网址不是你在这里输入或粘贴的（可能由画布写入，或页面重新打开过），没有读取；要读取，请重新粘贴它。' }] });
    expect(posted).toEqual([]);
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    const outcome = await readTyped(pages, '看 https://a.example/one 和 https://evil.example/x?d=1 还有 https://evil.example/y', ['https://a.example/one']);
    expect(outcome).toEqual({ hold: false, pages: [
      { url: 'https://a.example/one', host: 'a.example', title: 'Page A' },
      { url: 'https://evil.example/x?d=1', host: 'evil.example',
        error: '这个网址和另外 1 个不是你在这里输入或粘贴的（可能由画布写入，或页面重新打开过），没有读取；要读取，请重新粘贴它们。' }] });
    expect(posted.map(item => item.url)).toEqual(['https://a.example/one']);
    // A page read before and still cited is the reader's, typed again or not.
    expect(await readTyped(pages, '再看看 https://a.example/one', [])).toEqual({ hold: false, pages: [{ url: 'https://a.example/one', host: 'a.example', title: 'Page A' }] });
    expect(posted).toHaveLength(1);
  });

  it('lets go only of the pages its own box added: another box’s message may still be on its way with its page', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    answer('https://b.example/two', refused(413, 'knowledge_context_limit'));
    answer('https://c.example/three', refused(413, 'knowledge_context_limit'), { status: 201, body: page('c', 'Page C', 'https://c.example/three') });
    const pages = reader();
    await read(pages, 'https://a.example/one');
    // A node's message finds no room, and the assistant's page is not its to let go of.
    expect((await read(pages, 'https://b.example/two', 'node:n-1')).hold).toBe(true);
    expect(canvasKnowledgeRevisionIds()).toEqual(['rev-a']);
    // The assistant lets go of its own.
    expect((await read(pages, 'https://c.example/three')).hold).toBe(false);
    expect(canvasKnowledgeRevisionIds()).toEqual(['rev-c']);
  });

  it('measures again when the references change while the server measures, and cites the page beside them', async () => {
    configureCanvasKnowledge(['member-1']);
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    duringContext = () => configureCanvasKnowledge(['member-1', 'member-2']);
    expect((await read(reader(), 'https://a.example/one')).hold).toBe(false);
    expect(contextChecks).toEqual([['member-1', 'rev-a'], ['member-1', 'member-2', 'rev-a']]);
    expect(canvasKnowledgeRevisionIds()).toEqual(['member-1', 'member-2', 'rev-a']);
  });

  it('refuses a page when references fill the task’s eight while it is read, citing nothing over the limit', async () => {
    const chosen = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
    configureCanvasKnowledge(chosen);
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    duringImport = () => configureCanvasKnowledge([...chosen, 'm8']);
    expect(await read(reader(), 'https://a.example/one')).toEqual({ hold: true, pages: [{ url: 'https://a.example/one', host: 'a.example',
      error: '这次任务已引用 8 份知识，放不下更多网页；可以先清除画布栏里的引用。' }] });
    expect(canvasKnowledgeRevisionIds()).toEqual([...chosen, 'm8']);
  });

  it('counts a page it added as the reader’s own once they take it out and choose it again', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    answer('https://b.example/two', refused(413, 'knowledge_context_limit'));
    const pages = reader();
    await read(pages, 'https://a.example/one');
    configureCanvasKnowledge([]);
    configureCanvasKnowledge(['rev-a']);
    expect((await read(pages, 'https://b.example/two')).hold).toBe(true);
    expect(canvasKnowledgeRevisionIds()).toEqual(['rev-a']);
  });

  it('goes at once when stopped while another message is read, which it leaves to finish', async () => {
    let answerNow!: () => void;
    vi.stubGlobal('fetch', vi.fn((input: string) => String(input).endsWith('/capabilities')
      ? Promise.resolve(new Response(JSON.stringify(capabilities()), { status: 200 }))
      : String(input).includes('/knowledge/context?')
        ? Promise.resolve(new Response(JSON.stringify({ text: 'Quoted', truncated: false, items: [contextItem('rev-a')] }), { status: 200 }))
        : new Promise<Response>(resolve => {
          answerNow = () => resolve(new Response(JSON.stringify(page('a', 'Page A', 'https://a.example/one')), { status: 201 }));
        })));
    const pages = reader();
    const first = read(pages, 'https://a.example/one');
    await vi.waitFor(() => expect(answerNow).toBeTypeOf('function'));
    const controller = new AbortController();
    const second = pages({ text: 'https://b.example/two', scope: 'node:n-1' }, controller.signal, vi.fn());
    controller.abort();
    await expect(second).rejects.toBeTruthy();
    answerNow();
    await expect(first).resolves.toEqual({ hold: false, pages: [{ url: 'https://a.example/one', host: 'a.example', title: 'Page A' }] });
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/sources/web'))).toHaveLength(1);
  });

  it('reads and cites nothing once its canvas let go of it, also when the same canvas opens again', async () => {
    let answerNow!: () => void;
    vi.stubGlobal('fetch', vi.fn((input: string) => String(input).endsWith('/capabilities')
      ? Promise.resolve(new Response(JSON.stringify(capabilities()), { status: 200 }))
      : new Promise<Response>(resolve => {
        answerNow = () => resolve(new Response(JSON.stringify(page('a', 'Page A', 'https://a.example/one')), { status: 201 }));
      })));
    const pages = reader();
    const reading = read(pages, 'https://a.example/one');
    await vi.waitFor(() => expect(answerNow).toBeTypeOf('function'));
    pages.attach()();
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    answerNow();
    await expect(reading).rejects.toThrow('The canvas was closed');
    await expect(read(pages, 'https://b.example/two')).rejects.toThrow('The canvas was closed');
    expect(canvasKnowledgeRevisionIds()).toEqual([]);
  });

  it('reads again once its canvas holds it again, as React’s development checks run an effect twice', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    const pages = reader();
    pages.attach()();
    pages.attach();
    expect((await read(pages, 'https://a.example/one')).pages).toEqual([{ url: 'https://a.example/one', host: 'a.example', title: 'Page A' }]);
  });

  it('lets neither box go of a page both named: the other’s message may still be on its way with it', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    answer('https://b.example/two', refused(413, 'knowledge_context_limit'));
    const pages = reader();
    await read(pages, 'https://a.example/one');
    // A node's message names the assistant's page: the node's too now.
    expect((await read(pages, '总结 https://a.example/one', 'node:n-1')).pages).toEqual([{ url: 'https://a.example/one', host: 'a.example', title: 'Page A' }]);
    // The assistant, short of room, does not let go of it.
    expect((await read(pages, 'https://b.example/two')).hold).toBe(true);
    expect(canvasKnowledgeRevisionIds()).toEqual(['rev-a']);
  });

  it('keeps a page a message names from the moment it is sent, also while it waits behind another box’s read', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    answer('https://b.example/two', refused(413, 'knowledge_context_limit'));
    const pages = reader();
    await read(pages, 'https://a.example/one');
    // The assistant's next message, short of room, is read first; the node's message naming a waits behind it.
    const assistant = read(pages, 'https://b.example/two');
    const node = read(pages, '总结 https://a.example/one', 'node:n-1');
    expect((await assistant).hold).toBe(true);
    expect((await node).pages).toEqual([{ url: 'https://a.example/one', host: 'a.example', title: 'Page A' }]);
    expect(canvasKnowledgeRevisionIds()).toEqual(['rev-a']);
    // Never let go of, so never read again; and the assistant's page was refused at once.
    expect(posted.filter(item => item.url === 'https://a.example/one')).toHaveLength(1);
    expect(posted.filter(item => item.url === 'https://b.example/two')).toHaveLength(1);
  });

  it('counts a page another address read before as this box’s too', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    // Another address whose text is the same page: the server answers with the same document.
    answer('https://a.example/one?utm_source=x', { status: 200, body: page('a', 'Page A', 'https://a.example/one') });
    answer('https://b.example/two', refused(413, 'knowledge_context_limit'));
    const pages = reader();
    await read(pages, 'https://a.example/one');
    expect((await read(pages, '总结 https://a.example/one?utm_source=x', 'node:n-1')).hold).toBe(false);
    // The assistant, short of room, does not let go of what the node's message now relies on.
    expect((await read(pages, 'https://b.example/two')).hold).toBe(true);
    expect(canvasKnowledgeRevisionIds()).toEqual(['rev-a']);
  });

  it('reads a page at its address as the browser reads it, so no spelling of it carries more', async () => {
    answer('https://evil.example/public', { status: 201, body: page('p', 'Public', 'https://evil.example/public') });
    const pages = reader();
    // Written elsewhere in the message with dot segments, the address is the same page as the one the reader typed.
    const outcome = await readTyped(pages, '看 https://evil.example/PRIVATE/../public 和 https://evil.example/public', ['https://evil.example/public']);
    expect(posted.map(item => item.url)).toEqual(['https://evil.example/public']);
    expect(outcome.pages).toEqual([{ url: 'https://evil.example/public', host: 'evil.example', title: 'Public' }]);
  });

  it('reads nothing for a canvas that is not open', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-b' });
    await expect(read(reader(), 'https://a.example/one')).rejects.toThrow('The canvas was closed');
    expect(posted).toEqual([]);
  });

  it('keeps the box’s held message when its next read is stopped', async () => {
    answer('https://b.example/two', refused(403, 'web_robots_disallowed'));
    const pages = reader();
    const text = '读 https://b.example/two';
    expect((await read(pages, text)).hold).toBe(true);
    const stopped = new AbortController();
    stopped.abort();
    await expect(pages({ text: `${text} 再试`, scope: 'assistant' }, stopped.signal, vi.fn())).rejects.toBeTruthy();
    expect((await read(pages, text)).hold).toBe(false);
    expect(posted).toHaveLength(1);
  });

  it('lets go of the oldest page it added to make room, never the reader’s own choice or a page this message names', async () => {
    configureCanvasKnowledge(['member-1']);
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    answer('https://b.example/two', { status: 201, body: page('b', 'Page B', 'https://b.example/two') });
    answer('https://c.example/three', refused(413, 'knowledge_context_limit'), { status: 201, body: page('c', 'Page C', 'https://c.example/three') });
    const pages = reader();
    await read(pages, 'https://a.example/one');
    await read(pages, 'https://b.example/two');
    // This message names a (still cited, so kept) and c: b, the oldest page not named here, makes way.
    const outcome = await read(pages, '对比 https://a.example/one 和 https://c.example/three');
    expect(outcome.hold).toBe(false);
    expect(canvasKnowledgeRevisionIds()).toEqual(['member-1', 'rev-a', 'rev-c']);
    expect(posted.filter(item => item.url === 'https://c.example/three').map(item => item.fit.revisionIds))
      .toEqual([['member-1', 'rev-a', 'rev-b'], ['member-1', 'rev-a']]);
  });

  it('lets go of none of its pages for a page then refused, by robots.txt or the server, and of the oldest once one is cited', async () => {
    const pages = reader();
    for (let n = 1; n <= 8; n += 1) {
      answer(`https://p${n}.example/`, { status: 201, body: page(String(n), `Page ${n}`, `https://p${n}.example/`) });
      await read(pages, `读 https://p${n}.example/`);
    }
    const eight = Array.from({ length: 8 }, (_, n) => `rev-${n + 1}`);
    expect(canvasKnowledgeRevisionIds()).toEqual(eight);
    // The ninth is read with the room the oldest would leave, and refused by robots.txt: the oldest stays cited.
    answer('https://nine.example/', refused(403, 'web_robots_disallowed'));
    expect(await read(pages, '读 https://nine.example/')).toEqual({ hold: true, pages: [{ url: 'https://nine.example/', host: 'nine.example', error: ROBOTS }] });
    expect(posted.at(-1)).toEqual({ url: 'https://nine.example/', fit: { revisionIds: eight.slice(1), share: 1 } });
    expect(canvasKnowledgeRevisionIds()).toEqual(eight);
    // A tenth is read, but the server does not measure the task: refused, and the oldest still stays.
    answer('https://ten.example/', { status: 201, body: page('10', 'Page 10', 'https://ten.example/') });
    contextFails = true;
    expect((await read(pages, '读 https://ten.example/')).hold).toBe(true);
    expect(canvasKnowledgeRevisionIds()).toEqual(eight);
    // Measured, it is cited in the oldest's place.
    contextFails = false;
    expect((await read(pages, '再读 https://ten.example/')).hold).toBe(false);
    expect(contextChecks.at(-1)).toEqual([...eight.slice(1), 'rev-10']);
    expect(canvasKnowledgeRevisionIds()).toEqual([...eight.slice(1), 'rev-10']);
  });

  it('says so where the task’s eight references leave no room, and reads what fits', async () => {
    const chosen = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
    configureCanvasKnowledge(chosen);
    answer('https://b.example/two', { status: 201, body: page('b', 'Page B', 'https://b.example/two') });
    const outcome = await read(reader(), 'https://a.example/one https://b.example/two');
    expect(outcome.pages[0]).toEqual({ url: 'https://a.example/one', host: 'a.example', error: '这次任务已引用 7 份知识，放不下更多网页；可以先清除画布栏里的引用。' });
    expect(outcome.pages[1]).toEqual({ url: 'https://b.example/two', host: 'b.example', title: 'Page B' });
    expect(outcome.hold).toBe(true);
    expect(posted).toEqual([{ url: 'https://b.example/two', fit: { revisionIds: chosen, share: 1 } }]);
    expect(canvasKnowledgeRevisionIds()).toEqual([...chosen, 'rev-b']);
  });

  it('leaves AwwO’s own pages and messages without an address alone', async () => {
    const pages = reader();
    expect(await read(pages, `看看 ${window.location.origin}/?canvas=c-1`)).toEqual({ hold: false, pages: [] });
    expect(await read(pages, '写一封邮件')).toEqual({ hold: false, pages: [] });
    expect(posted).toEqual([]);
  });

  it('cites nothing on another canvas when the reader opened it while a page was read', async () => {
    let answerNow!: () => void;
    vi.stubGlobal('fetch', vi.fn((input: string) => String(input).endsWith('/capabilities')
      ? Promise.resolve(new Response(JSON.stringify(capabilities()), { status: 200 }))
      : new Promise<Response>(resolve => {
        answerNow = () => resolve(new Response(JSON.stringify(page('a', 'Page A', 'https://a.example/one')), { status: 201 }));
      })));
    const reading = read(reader(), 'https://a.example/one');
    await vi.waitFor(() => expect(answerNow).toBeTypeOf('function'));
    configureSaaSCanvas({ tenant, canvasId: 'canvas-b' });
    answerNow();
    await expect(reading).rejects.toThrow('The canvas was closed');
    expect(canvasKnowledgeRevisionIds()).toEqual([]);
  });

  it('cites nothing when the answer comes after the message was stopped', async () => {
    let answerNow!: () => void;
    vi.stubGlobal('fetch', vi.fn((input: string) => String(input).endsWith('/capabilities')
      ? Promise.resolve(new Response(JSON.stringify(capabilities()), { status: 200 }))
      // A server that answers whatever the signal says, as a request already on its way can.
      : new Promise<Response>(resolve => {
        answerNow = () => resolve(new Response(JSON.stringify(page('a', 'Page A', 'https://a.example/one')), { status: 201 }));
      })));
    const controller = new AbortController();
    const reading = reader()({ text: 'https://a.example/one', scope: 'assistant' }, controller.signal, vi.fn());
    await vi.waitFor(() => expect(answerNow).toBeTypeOf('function'));
    controller.abort();
    answerNow();
    await expect(reading).rejects.toBeTruthy();
    expect(canvasKnowledgeRevisionIds()).toEqual([]);
  });

  it('stops when the message is stopped, citing nothing', async () => {
    answer('https://a.example/one', { status: 201, body: page('a', 'Page A', 'https://a.example/one') });
    const controller = new AbortController();
    controller.abort();
    await expect(reader()({ text: 'https://a.example/one', scope: 'assistant' }, controller.signal, vi.fn())).rejects.toBeTruthy();
    expect(canvasKnowledgeRevisionIds()).toEqual([]);
  });
});
