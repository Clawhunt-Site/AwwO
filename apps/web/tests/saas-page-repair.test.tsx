// A delivered page that fails when it runs goes back to its node once, with the error (pageErrors.ts, pageRepair.ts).
// Round 2 of the explainer-figure tests (2026-10-12) is the case: two one-shot pages never ran, one for a bracket typo,
// one for a name declared twice, and the reader saw only an error card.
import vm from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { ArtifactPreview } from '../src/canvas/ArtifactPreview';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import * as Tiles from '../src/canvas/SessionTile';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { CANVAS_STORAGE_KEY, createSessionNode, type CanvasDocument, type NodeOutput, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage } from '../src/canvas/canvasStorage';
import { htmlPreviewDocument, PREVIEW_HOST_SCRIPT, PREVIEW_VIEWPORT_SCRIPT } from '../src/canvas/htmlDeliverable';
import { activeThreadId, sessionStoreKey } from '../src/canvas/nodeThreads';
import { PAGE_ERROR_MESSAGE, PAGE_ERROR_SCRIPT, readPageErrorMessage, reportPageError, subscribePageErrors, type PageErrorReport } from '../src/canvas/pageErrors';
import { deferPageRepair, isPageRepairMessage, loadPageRepairRecords, MAX_REPAIR_PAGE_CHARS, PAGE_REPAIR_STORAGE_KEY, pageRepairDecision, pageRepairDelivery, pageRepairDisplayText, pageRepairMessage,
  pageRepairRetryAfter, pageRepairTarget, REPAIR_RESULT_WINDOW_MS, REPAIR_RETRY_SOON_MS, savePageRepairRecord } from '../src/canvas/pageRepair';
import { applyRecoveredDocument, runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { getSnapshot, resetAllSessions } from '../src/canvas/sessions';
import { buildLiveDocument } from '../src/canvas/studio/liveDocument';

vi.mock('../src/canvas/SessionTile', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/canvas/SessionTile')>();
  return { ...original, SessionTile: (props: Tiles.SessionTileProps) => <original.SessionTile {...props} /> };
});

const PAGE = '<!doctype html>\n<html><head><title>令牌桶</title></head><body><svg></svg>\n<script>\nlet tokens = 10;\nlet tokens = 9;\n</script></body></html>';

/** The reporter as a page runs it, in its own realm: what it posts to the host, and the events it listens to. */
function reporter() {
  class FakeErrorEvent {
    constructor(public message: string, public lineno = 0, public colno = 0, public error?: { message: string; stack?: string }) {}
  }
  const handlers: Record<string, Array<(event: unknown) => void>> = {};
  const posted: unknown[] = [];
  const context = vm.createContext({
    ErrorEvent: FakeErrorEvent,
    addEventListener: (type: string, handler: (event: unknown) => void) => { (handlers[type] ??= []).push(handler); },
    parent: { postMessage: (data: unknown, origin: string) => { expect(origin).toBe('*'); posted.push(data); } },
  });
  vm.runInContext(PAGE_ERROR_SCRIPT, context);
  return { posted, Event: FakeErrorEvent, fire: (type: string, event: unknown) => handlers[type]?.forEach(handler => handler(event)) };
}

describe('the page error reporter', () => {
  it('posts the first error the page makes, once, and leaves what is not the page’s mistake alone', () => {
    const page = reporter();
    page.fire('error', {});
    page.fire('error', new page.Event('Script error.'));
    page.fire('error', new page.Event('ResizeObserver loop completed with undelivered notifications.'));
    page.fire('error', new page.Event('Uncaught Error: Error creating WebGL context.'));
    expect(page.posted).toEqual([]);
    page.fire('error', new page.Event("Uncaught SyntaxError: Identifier 'tokens' has already been declared", 177, 9));
    page.fire('error', new page.Event('Uncaught ReferenceError: later is not defined', 300, 1));
    expect(page.posted).toEqual([{ type: PAGE_ERROR_MESSAGE, message: "Uncaught SyntaxError: Identifier 'tokens' has already been declared", line: 177, column: 9, stack: '' }]);
  });

  it('reports an unhandled rejection, but not a request the preview blocks', () => {
    const page = reporter();
    page.fire('unhandledrejection', { reason: Object.assign(new Error('Failed to fetch'), { name: 'TypeError' }) });
    expect(page.posted).toEqual([]);
    const reason = Object.assign(new Error("Cannot read properties of undefined (reading 'x')"), { name: 'TypeError', stack: 'TypeError: …\n    at draw (about:srcdoc:42:7)' });
    page.fire('unhandledrejection', { reason });
    expect(page.posted).toEqual([{ type: PAGE_ERROR_MESSAGE, message: "Unhandled promise rejection: TypeError: Cannot read properties of undefined (reading 'x')",
      line: 0, column: 0, stack: 'TypeError: …\n    at draw (about:srcdoc:42:7)' }]);
  });

  it('reports a figure script error the figure kit caught and showed as its card, and nothing for a logged Error alone', async () => {
    const page = (script: string) => {
      const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
      const posted: unknown[] = [];
      dom.window.addEventListener('message', event => posted.push(event.data));
      dom.window.eval(PAGE_ERROR_SCRIPT);
      dom.window.eval(script);
      return { dom, posted };
    };
    // What the kit's report() does when Anatomy.run's callback throws: log the Error, then show its card.
    const kit = page(`console.error(new ReferenceError("Cannot access 'crank' before initialization"));
      const note = document.createElement('div'); note.className = 'anatomy-error'; document.body.appendChild(note);
      const again = document.createElement('div'); again.className = 'anatomy-error'; document.body.appendChild(again);`);
    const logged = page(`console.error(new Error('a library logged this and carried on'));`);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(kit.posted).toEqual([{ type: PAGE_ERROR_MESSAGE, message: "ReferenceError: Cannot access 'crank' before initialization", line: 0, column: 0,
      stack: expect.stringContaining('ReferenceError') }]);
    expect(logged.posted).toEqual([]);
    kit.dom.window.close(); logged.dom.window.close();
  });

  it('runs ahead of every running page, and in no static one', async () => {
    const running = new DOMParser().parseFromString(htmlPreviewDocument(PAGE, true), 'text/html');
    expect([...running.head.querySelectorAll('script')].map(script => script.textContent)).toEqual([PREVIEW_HOST_SCRIPT]);
    expect(PREVIEW_HOST_SCRIPT).toBe(PREVIEW_VIEWPORT_SCRIPT + PAGE_ERROR_SCRIPT);
    const still = new DOMParser().parseFromString(htmlPreviewDocument(PAGE, false), 'text/html');
    expect(still.querySelectorAll('script')).toHaveLength(0);
    const live = new DOMParser().parseFromString(await buildLiveDocument(PAGE), 'text/html');
    const first = live.head.querySelector('script')!;
    expect(first.textContent).toContain(PAGE_ERROR_SCRIPT);
    expect(first.textContent!.endsWith(PREVIEW_HOST_SCRIPT)).toBe(true);
  });
});

describe('reading a report', () => {
  it('gives the page’s own lines where it happened: the reported one, then the stack’s, each once', () => {
    const document = ['<!doctype html>', '  let tokens = 10;', 'draw();', `${'x'.repeat(400)}ERROR${'y'.repeat(400)}`].join('\n');
    const report = readPageErrorMessage({ type: PAGE_ERROR_MESSAGE, message: ' Uncaught SyntaxError: boom ', line: 2, column: 7,
      stack: 'at draw (about:srcdoc:3:1)\n at about:srcdoc:2:5\n at about:srcdoc:4:401' }, document, PAGE);
    expect(report).toEqual({ page: PAGE, message: 'Uncaught SyntaxError: boom', lines: ['let tokens = 10;', 'draw();', `…${'x'.repeat(120)}ERROR${'y'.repeat(115)}…`] });
    expect(readPageErrorMessage({ type: 'awwo-live-link', href: 'https://example.com' }, document, PAGE)).toBeNull();
    expect(readPageErrorMessage({ type: PAGE_ERROR_MESSAGE, message: '   ' }, document, PAGE)).toBeNull();
    expect(readPageErrorMessage({ type: PAGE_ERROR_MESSAGE, message: 'x', line: 99 }, document, PAGE)?.lines).toEqual([]);
  });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a running preview', () => {
  it('passes on its own frame’s report, with the page it was given, and ignores every other window', async () => {
    const reports: PageErrorReport[] = [];
    const stop = subscribePageErrors(report => reports.push(report));
    try {
      render(<ArtifactPreview source={`\`\`\`html\n${PAGE}\n\`\`\``} type="html" title="令牌桶" renderMarkdown={source => source} />);
      const frame = document.querySelector('iframe') as HTMLIFrameElement;
      const data = { type: PAGE_ERROR_MESSAGE, message: "Uncaught SyntaxError: Identifier 'tokens' has already been declared", line: 1, column: 1 };
      act(() => { window.dispatchEvent(new MessageEvent('message', { data, source: window })); });
      expect(reports).toEqual([]);
      act(() => { window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow })); });
      expect(reports).toHaveLength(1);
      expect(reports[0].page).toBe(PAGE);
      expect(reports[0].message).toBe(data.message);
    } finally { stop(); }
  });
});

const figure = (output?: Partial<NodeOutput>, page = PAGE): SessionNode => {
  const node = createAgentTemplate('figure', { x: 40, y: 40 });
  return { ...node, id: 'fig', title: '令牌桶原理图', runtime: 'claude_local',
    // As the canvas assistant plans it: the idea is filled in, so the node could run before.
    contract: { ...node.contract!, inputs: node.contract!.inputs.map(field => ({ ...field, value: field.value || '解释令牌桶限流' })) },
    binding: { companyId: 'c1', agentId: 'a-fig', agentName: 'fig' }, issueId: 'iss-fig',
    lastOutput: { text: JSON.stringify({ figure: page }), at: 1_000, source: 'run', ...output } };
};

describe('finding the node behind a page', () => {
  it('is the node whose current run result published that page', () => {
    const target = pageRepairTarget([createSessionNode('llm', { x: 0, y: 0 }), figure()], `\`\`\`html\n${PAGE}\n\`\`\``);
    expect(target).toMatchObject({ fieldId: 'figure', output: { at: 1_000 }, values: { figure: PAGE } });
    expect(target?.node.id).toBe('fig');
  });

  it('is nobody for a case recording, a hand-published value, a failed run, another page or a page too large to send', () => {
    for (const output of [{ source: 'case' as const }, { source: 'manual' as const }, { partial: true }]) expect(pageRepairTarget([figure(output)], PAGE)).toBeNull();
    expect(pageRepairTarget([figure()], PAGE.replace('9', '8'))).toBeNull();
    const huge = `<!doctype html><html><body>${'x'.repeat(MAX_REPAIR_PAGE_CHARS)}</body></html>`;
    expect(pageRepairTarget([figure({}, huge)], huge)).toBeNull();
  });
});

describe('once per delivery', () => {
  it('asks for a page once, never again for the repair’s own result, and again for a later delivery', () => {
    const output = (at: number): NodeOutput => ({ text: '{}', at, source: 'run' });
    expect(pageRepairDecision(undefined, output(1_000))).toBe('repair');
    const record = { from: 1_000, at: 2_000 };
    expect(pageRepairDecision(record, output(1_000))).toBe('asked');
    expect(pageRepairDecision(record, output(2_000))).toBe('asked');
    expect(pageRepairDecision(record, output(2_000 + 5 * 60_000))).toBe('repaired');
    expect(pageRepairDecision(record, output(2_000 + REPAIR_RESULT_WINDOW_MS + 1))).toBe('repair');
  });

  it('sends a request the service refused before it ran again once its wait is over, and takes a later delivery as new', () => {
    const output = (at: number): NodeOutput => ({ text: '{}', at, source: 'run' });
    const refused = { from: 1_000, at: 2_000, retryAfter: 9_000 };
    expect(pageRepairDecision(refused, output(1_000), 8_999)).toBe('asked');
    expect(pageRepairDecision(refused, output(1_000), 9_000)).toBe('repair');
    expect(pageRepairDecision(refused, output(2_000 + 5 * 60_000), 3_000)).toBe('repair');
    const at = Date.UTC(2026, 9, 12, 9, 25);
    expect(pageRepairRetryAfter('quota_exceeded', at)).toBe(at + REPAIR_RETRY_SOON_MS);
    expect(pageRepairRetryAfter('plan_busy', at)).toBe(at + REPAIR_RETRY_SOON_MS);
    expect(pageRepairRetryAfter('premium_quota_exceeded', at)).toBe(Date.UTC(2026, 9, 13));
    expect(pageRepairRetryAfter('credits_exhausted', Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1));
    expect(pageRepairRetryAfter('model_unpriced', at)).toBeNull();
    expect(isPageRepairMessage('AwwO page repair · field "figure"\nAwwO ran the page')).toBe(true);
    expect(isPageRepairMessage('this page fails, fix it')).toBe(false);
  });

  it('keeps the newest records in the canvas’s storage and survives a damaged one', () => {
    const storage = new Map<string, string>();
    const store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } };
    storage.set(PAGE_REPAIR_STORAGE_KEY, 'not json');
    expect(loadPageRepairRecords(store)).toEqual({});
    for (let index = 0; index < 60; index += 1) expect(savePageRepairRecord(store, `n${index}`, { from: index, at: 10_000 + index })).toBe(true);
    const records = loadPageRepairRecords(store);
    expect(Object.keys(records)).toHaveLength(50);
    expect(records.n59).toEqual({ from: 59, at: 10_059 });
    expect(records.n9).toBeUndefined();
    storage.set(PAGE_REPAIR_STORAGE_KEY, JSON.stringify({ a: { from: 1, at: 2, retryAfter: 'soon' }, b: { from: 1, at: 2, retryAfter: 9 } }));
    expect(loadPageRepairRecords(store)).toEqual({ a: { from: 1, at: 2 }, b: { from: 1, at: 2, retryAfter: 9 } });
    expect(deferPageRepair(store, 'a', 20)).toBe(true);
    expect(loadPageRepairRecords(store).a).toEqual({ from: 1, at: 2, retryAfter: 20 });
    expect(deferPageRepair(store, 'missing', 20)).toBe(false);
  });
});

describe('the repair request', () => {
  const report: PageErrorReport = { page: PAGE, message: "Uncaught SyntaxError: Identifier 'tokens' has already been declared", lines: ['let tokens = 9;'] };

  it('gives the model the error, where it happened and the page as delivered, and asks for the fixed page alone', () => {
    const node = figure();
    const message = pageRepairMessage({ node, output: node.lastOutput!, fieldId: 'figure', values: { figure: PAGE } }, report);
    expect(message.startsWith('AwwO page repair · field "figure"\nAwwO ran the page you delivered in "交互原理图"')).toBe(true);
    expect(message).toContain(report.message);
    expect(message).toContain('Where it happened, as AwwO ran the page:\n  let tokens = 9;');
    expect(message).toContain(`-----BEGIN PAGE-----\n${PAGE}\n-----END PAGE-----`);
    expect(message).toContain('guard any use of localStorage');
    expect(message.endsWith('Reply with only the whole fixed HTML document, from <!doctype html> to </html>: no JSON, no Markdown fence, no other words. AwwO puts it back in "交互原理图".')).toBe(true);
    const more = { ...node, contract: { ...node.contract!, outputs: [...node.contract!.outputs, { id: 'notes', label: '说明', type: 'markdown' as const, required: false, value: '' }] } };
    expect(pageRepairMessage({ node: more, output: node.lastOutput!, fieldId: 'figure', values: { figure: PAGE, notes: 'n' } }, report))
      .toContain('AwwO puts it back in "交互原理图" and keeps the delivery\'s other fields as they are.');
  });

  it('shows the reader a short line in the component’s chat', () => {
    expect(pageRepairDisplayText(report, 'zh')).toBe("页面运行出错，AwwO 自动修复一次：SyntaxError: Identifier 'tokens' has already been declared");
    expect(pageRepairDisplayText({ ...report, message: 'x'.repeat(300) }, 'en')).toBe(`The page failed to run, so AwwO is fixing it once: ${'x'.repeat(160)}…`);
  });
});

describe('the repair’s reply', () => {
  const FIXED = PAGE.replace('let tokens = 9;', 'tokens = 9;');
  const report: PageErrorReport = { page: PAGE, message: 'Uncaught SyntaxError: x', lines: [] };
  const request = (node: SessionNode) => pageRepairMessage({ node, output: node.lastOutput!, fieldId: 'figure', values: { figure: PAGE } }, report);

  it('puts the fixed page back in its field, fenced or with words around it, and keeps the other fields', () => {
    const node = figure();
    for (const reply of [FIXED, `\`\`\`html\n${FIXED}\n\`\`\``, `Here is the fixed page:\n\n${FIXED}\n\nI renamed the second declaration.`]) {
      expect(JSON.parse(pageRepairDelivery(node, request(node), reply)!)).toEqual({ figure: FIXED });
    }
    const contract = { ...node.contract!, outputs: [...node.contract!.outputs,
      { id: 'notes', label: '说明', type: 'markdown' as const, required: false, value: '' },
      { id: 'parts', label: '零件数', type: 'number' as const, required: false, value: '' }] };
    const more = { ...node, contract, lastOutput: { ...node.lastOutput!, text: JSON.stringify({ figure: PAGE, notes: '桶里最多 10 个 "令牌"', parts: 36 }) } };
    expect(JSON.parse(pageRepairDelivery(more, request(more), FIXED)!)).toEqual({ figure: FIXED, notes: '桶里最多 10 个 "令牌"', parts: 36 });
  });

  it('is nothing for an ordinary message, a fragment, or a field that is not a page', () => {
    const node = figure();
    expect(pageRepairDelivery(node, '把按钮改成红色', FIXED)).toBeNull();
    expect(pageRepairDelivery(node, undefined, FIXED)).toBeNull();
    expect(pageRepairDelivery(node, request(node), '<div>only a part</div>')).toBeNull();
    expect(pageRepairDelivery(node, request(node).replace('field "figure"', 'field "idea"'), FIXED)).toBeNull();
  });

  it('is published when the run’s journal comes back, as the node’s new delivery', () => {
    const node = figure();
    const doc: CanvasDocument = { version: 2, updatedAt: 1, nodes: [node], edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } };
    const journal = { version: 1 as const, id: 'repair', startedAt: 5_000, scope: ['fig'], manual: true, manualMessage: request(node),
      inputFingerprint: runInputFingerprint(doc, ['fig']),
      nodes: { fig: { nodeId: 'fig', threadId: activeThreadId(node), operationId: 'op', companyId: 'c1', agentId: 'a-fig', issueId: 'iss-fig', runId: 'r', state: 'done' as const, output: FIXED } } };
    const published = applyRecoveredDocument(doc, journal).nodes[0] as SessionNode;
    expect(published.lastOutput).toMatchObject({ at: 5_000, source: 'run' });
    expect(JSON.parse(published.lastOutput!.text)).toEqual({ figure: FIXED });
    // A reply that is no page leaves the delivery as it was.
    const kept = applyRecoveredDocument(doc, { ...journal, nodes: { fig: { ...journal.nodes.fig, output: 'Sorry, I cannot.' } } }).nodes[0] as SessionNode;
    expect(kept.lastOutput).toEqual(node.lastOutput);
  });
});

describe('on the canvas', () => {
  class SilentResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const other = () => ({ ...createSessionNode('llm', { x: 700, y: 40 }), id: 's1', title: '另一个组件', runtime: 'claude_local',
    binding: { companyId: 'c1', agentId: 'a1', agentName: 's1' }, issueId: 'iss-s1' });
  const sent = () => vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).includes('/messages') && init?.method === 'POST');
  const repairs = () => sent().filter(([, init]) => String(init?.body).includes('AwwO page repair'));
  const report: PageErrorReport = { page: PAGE, message: "Uncaught SyntaxError: Identifier 'tokens' has already been declared", lines: ['let tokens = 9;'] };

  beforeEach(() => {
    cleanup(); resetAllSessions(); localStorage.clear();
    vi.stubGlobal('ResizeObserver', SilentResizeObserver);
    // A conversation POST stays open until its run is stopped, then rejects like a real aborted fetch.
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
      if (String(input).endsWith('/prepare')) return Promise.resolve({ ok: true, status: 200 });
      if (String(input).includes('/cancel')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ confirmed: true, cancelled: true, status: 'cancelled' }) });
      if (!String(input).includes('/messages')) return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
      });
    }));
    const doc: CanvasDocument = { version: 2, updatedAt: 1, nodes: [figure(), other()], edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  });

  it('sends the failing page back to its node once, in the node’s own chat', async () => {
    render(<CanvasSurface />);
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    const body = String(repairs()[0][1]?.body);
    expect(String(repairs()[0][0])).toContain('/agents/a-fig/messages');
    expect(body).toContain('Identifier');
    expect(body).toContain('-----BEGIN PAGE-----');
    expect(loadPageRepairRecords(canvasStorage()).fig).toMatchObject({ from: 1_000 });
    const node = (JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).nodes.find(item => item.id === 'fig') as SessionNode;
    const user = getSnapshot(sessionStoreKey({ ...node, activeThreadId: activeThreadId(node) })).turns.find(turn => turn.role === 'user');
    expect(user?.presentation?.displayText).toBe(pageRepairDisplayText(report, 'zh'));
    // The same page reported again (another view of it, a remount) asks nothing more.
    act(() => { reportPageError(report); reportPageError(report); });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(repairs()).toHaveLength(1);
  });

  it('sends the same page again later, not at once, when the service refused the repair before it ran', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    const refusal = { code: 'quota_exceeded', error: '工作区运行额度已满', admissionRejected: true };
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (!String(input).includes('/messages')) return original(input, init);
      // The service refuses the repair before any run (the workspace is out of calls); the history holds nothing new.
      return Promise.resolve((init?.method === 'POST'
        ? { ok: false, status: 429, json: async () => refusal }
        : { ok: true, status: 200, json: async () => ({ complete: true, messages: [] }) }) as unknown as Response);
    });
    render(<CanvasSurface />);
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    await waitFor(() => expect(loadPageRepairRecords(canvasStorage()).fig?.retryAfter).toBeGreaterThan(Date.now() + 25 * 60_000));
    // Until then the same page asks nothing more.
    act(() => { reportPageError(report); });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(repairs()).toHaveLength(1);
    // Once that time has passed, the same delivery goes back again (once the refused run has ended).
    savePageRepairRecord(canvasStorage(), 'fig', { ...loadPageRepairRecords(canvasStorage()).fig!, retryAfter: Date.now() - 1 });
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(2), { timeout: 8_000 });
  }, 20_000);

  it('waits while another component runs and asks once the canvas is idle', async () => {
    const OriginalTile = Tiles.SessionTile;
    const tiles: Record<string, Tiles.SessionTileProps> = {};
    vi.spyOn(Tiles, 'SessionTile').mockImplementation(props => { tiles[props.node.id] = props; return <OriginalTile {...props} />; });
    render(<CanvasSurface />);
    act(() => { tiles.s1.onRunNode!('s1'); });
    await waitFor(() => expect(sent()).toHaveLength(1));
    act(() => { reportPageError(report); });
    await new Promise(resolve => setTimeout(resolve, 3_500));
    expect(repairs()).toHaveLength(0);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '停下这个组件' }).length).toBeGreaterThan(0));
    act(() => { tiles.s1.onStopNode!('s1'); });
    await waitFor(() => expect(repairs()).toHaveLength(1), { timeout: 8_000 });
  }, 20_000);

  it('asks nothing in a canvas opened to read', async () => {
    render(<CanvasSurface readOnly />);
    act(() => { reportPageError(report); });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(repairs()).toHaveLength(0);
    expect(localStorage.getItem(PAGE_REPAIR_STORAGE_KEY)).toBeNull();
  });
});
