// A delivered page that fails when it runs goes back to its node once, with the error (pageErrors.ts, pageRepair.ts).
// Round 2 of the explainer-figure tests (2026-10-12) is the case: two one-shot pages never ran, one for a bracket typo,
// one for a name declared twice, and the reader saw only an error card.
import vm from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { ArtifactPreview } from '../src/canvas/ArtifactPreview';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { summaryNote } from '../src/canvas/RunControls';
import * as Tiles from '../src/canvas/SessionTile';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { CANVAS_STORAGE_KEY, createSessionNode, loadDocumentWithStatus, type CanvasDocument, type CanvasEdge, type NodeOutput, type SessionNode } from '../src/canvas/canvasDoc';
import { canFeed, portsFor } from '../src/canvas/ports';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { htmlPreviewDocument, PREVIEW_HOST_SCRIPT, PREVIEW_STORAGE_SCRIPT, PREVIEW_VIEWPORT_SCRIPT } from '../src/canvas/htmlDeliverable';
import { activeThreadId, getNodeThreads, sessionStoreKey, updateNodeDraft } from '../src/canvas/nodeThreads';
import { PAGE_ERROR_MESSAGE, PAGE_ERROR_SCRIPT, pageErrorScript, readPageErrorMessage, reportPageError, subscribePageErrors, type PageErrorReport } from '../src/canvas/pageErrors';
import { deferPageRepair, isPageRepairMessage, loadPageRepairRecords, MAX_REPAIR_PAGE_CHARS, PAGE_REPAIR_STORAGE_KEY, pageRepairDecision, pageRepairDelivery, pageRepairDisplayText, pageRepairMessage,
  pageRepairMessageKey, pageRepairRecordKey, pageRepairRetryAfter, pageRepairTarget, REPAIR_RESULT_WINDOW_MS, REPAIR_RETRY_SOON_MS, savePageRepairRecord } from '../src/canvas/pageRepair';
import { applyRecoveredDocument, hasManualRecoveryCapacity, mergePersistedManualConversations, mergeRecoveredManualConversation, persistRecoveredManualConversation,
  runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { CANVAS_RUN_JOURNAL_KEY, type CanvasRunJournal } from '../src/canvas/runJournal';
import { SaaSApiError, saasErrorMessage } from '../src/saas/api';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { canvasErrorMessage } from '../src/saas/canvasErrors';
import { appendTurn, getSnapshot, resetAllSessions } from '../src/canvas/sessions';
import { forgetNode, restoreHistory } from '../src/canvas/sessionTransport';
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

  it('leaves the sandbox’s own refusals alone, and what follows one', () => {
    // 2026-10-25: four of one account's pages were sent back for repair, each a paid run, for the first message alone.
    const refusals = [
      "Uncaught SecurityError: Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.",
      "Uncaught SecurityError: Failed to execute 'pushState' on 'History': A history state object with URL 'about:/coach' cannot be created in a document with origin 'null' and URL 'about:srcdoc'.",
      "Uncaught SecurityError: Failed to read a named property 'document' from 'Window': Blocked a frame with origin \"null\" from accessing a cross-origin frame.",
      "Uncaught SecurityError: Failed to execute 'open' on 'IDBFactory': access to the Indexed Database API is denied in this context.",
    ];
    for (const message of refusals) {
      const page = reporter();
      page.fire('error', new page.Event(message, 412, 22));
      // What follows a refusal may be its consequence: it is not sent back either.
      page.fire('error', new page.Event('Uncaught TypeError: Cannot read properties of null (reading \'token\')', 413, 5));
      expect(page.posted).toEqual([]);
    }
    const rejected = reporter();
    rejected.fire('unhandledrejection', { reason: Object.assign(new Error("Failed to read the 'cookie' property from 'Document': The document is sandboxed and lacks the 'allow-same-origin' flag."), { name: 'SecurityError' }) });
    expect(rejected.posted).toEqual([]);
    // Review: a history entry's URL comes first, and a long one pushed the words that tell the refusal past the 600
    // characters a report keeps; the message is read whole.
    const long = reporter();
    long.fire('error', new long.Event(`Uncaught SecurityError: Failed to execute 'pushState' on 'History': A history state object with URL 'about:/${'coach/'.repeat(90)}' cannot be created in a document with origin 'null' and URL 'about:srcdoc'.`, 7, 1));
    expect(long.posted).toEqual([]);
  });

  // Review 2026-10-25: matching every SecurityError hid a page's own mistakes, which fail where it is deployed too.
  it('still reports a SecurityError the page would meet anywhere, and an error that only names one', () => {
    for (const message of ["Uncaught SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.",
      'Uncaught ReferenceError: SecurityError is not defined']) {
      const page = reporter();
      page.fire('error', new page.Event(message, 9, 1));
      expect(page.posted).toEqual([{ type: PAGE_ERROR_MESSAGE, message, line: 9, column: 1, stack: '' }]);
    }
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
    // The report takes a turn of each page's event loop (its mutation observer, then postMessage); wait for it, not a fixed
    // 50 ms, which a busy machine overruns. By then the other page has had the same turns to post anything.
    await waitFor(() => expect(kit.posted).toHaveLength(1));
    expect(kit.posted).toEqual([{ type: PAGE_ERROR_MESSAGE, message: "ReferenceError: Cannot access 'crank' before initialization", line: 0, column: 0,
      stack: expect.stringContaining('ReferenceError') }]);
    expect(logged.posted).toEqual([]);
    kit.dom.window.close(); logged.dom.window.close();
  });

  it('runs ahead of every running page, and in no static one', async () => {
    const running = new DOMParser().parseFromString(htmlPreviewDocument(PAGE, true), 'text/html');
    expect([...running.head.querySelectorAll('script')].map(script => script.textContent)).toEqual([PREVIEW_HOST_SCRIPT]);
    expect(PREVIEW_HOST_SCRIPT).toBe(PREVIEW_STORAGE_SCRIPT + PREVIEW_VIEWPORT_SCRIPT + PAGE_ERROR_SCRIPT);
    const still = new DOMParser().parseFromString(htmlPreviewDocument(PAGE, false), 'text/html');
    expect(still.querySelectorAll('script')).toHaveLength(0);
    const live = new DOMParser().parseFromString(await buildLiveDocument(PAGE), 'text/html');
    const first = live.head.querySelector('script')!;
    expect(first.textContent).toContain(PAGE_ERROR_SCRIPT);
    expect(first.textContent!.endsWith(PREVIEW_HOST_SCRIPT)).toBe(true);
  });
});

// The repaired first production figure (2026-10-12) ran without an error and never moved: its loop never called draw(),
// and draw() wrote setAttribute("innerHTML", …). The watch runs here with short timings (0.2 s idle, 40 ms a step).
describe('the figure watch', () => {
  const MOUNTED = '<figure class="iso-figure"><div class="iso-plate"><span data-readout>进气 0°</span><div class="iso-stage" tabindex="0" role="slider">'
    + '<svg><g data-part="piston" transform="translate(0,0)"><path d="M0 0"/></g></svg></div></div></figure>';
  const run = (script: string, { kit = true, mounted = MOUNTED } = {}) => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
    const posted: Array<Record<string, unknown>> = [];
    dom.window.addEventListener('message', event => posted.push(event.data));
    dom.window.eval(pageErrorScript(200, 40));
    if (kit) dom.window.eval('window.Anatomy = {};');
    // What Anatomy.mount does: the plate, with its stage, drawing and readout, inside main.iso-page; then the page's code.
    dom.window.eval(`{ const main = document.createElement('main'); main.className = 'iso-page'; main.innerHTML = ${JSON.stringify(mounted)};
      document.body.appendChild(main);
      window.inputs = { key: 0, pointer: 0 };
      const stage = document.querySelector('.iso-stage'), piston = document.querySelector('[data-part="piston"]'), readout = document.querySelector('[data-readout]');
      stage.addEventListener('keydown', () => { window.inputs.key += 1; });
      stage.addEventListener('pointermove', () => { window.inputs.pointer += 1; });
      ${script} }`);
    return { posted, inputs: () => (dom.window as unknown as { inputs: { key: number; pointer: number } }).inputs, close: () => dom.window.close() };
  };

  it('reports a figure that never moves, with what it saw, and nothing for one that moves on a key, by itself, or is no figure', async () => {
    const still = run(`stage.addEventListener('keydown', () => { piston.setAttribute('innerHTML', '<path d="M1 1"/>'); });`);
    const readoutOnly = run(`stage.addEventListener('keydown', () => { readout.textContent = '压缩 90°'; });`);
    const keyed = run(`stage.addEventListener('keydown', e => { if (e.key === 'ArrowRight') piston.setAttribute('transform', 'translate(4,0)'); });`);
    const touring = run(`let x = 0; setInterval(() => piston.setAttribute('transform', 'translate(' + (x += 1) + ',0)'), 30);`);
    const spaceOnly = run(`stage.addEventListener('keydown', e => { if (e.keyCode === 32) piston.setAttribute('transform', 'translate(0,2)'); });`);
    const page = run('', { kit: false });
    const canvas = run('', { mounted: MOUNTED.replace('<svg>', '<canvas></canvas><svg>') });
    // Every watch started together with the same timings: once the two still ones have reported, the others are done too.
    await waitFor(() => { expect(still.posted).toHaveLength(1); expect(readoutOnly.posted).toHaveLength(1); }, { timeout: 8_000 });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(still.posted).toEqual([{ type: PAGE_ERROR_MESSAGE, kind: 'still', line: 0, column: 0, stack: '',
      message: 'The drawing never moved: in 0.2 s on screen nothing in it changed by itself, and hovering across it and pressing →, ←, Space, Enter, End and Home moved nothing either. The readout stayed "进气 0°".',
      notes: [expect.stringContaining('The page sets an attribute named "innerHTML" on <g data-part="piston">: setAttribute("innerHTML", …) draws nothing.'),
        expect.stringContaining('Almost no animation frame ran during the test (0)')] }]);
    expect(still.inputs().key).toBe(6);
    expect(readoutOnly.posted).toHaveLength(1);
    expect(readoutOnly.posted[0].message).toContain('Only the readout changed, from "进气 0°" to "压缩 90°".');
    // The first key that moves a part ends the watch: nothing is pressed after it.
    expect(keyed.posted).toEqual([]);
    expect(keyed.inputs().key).toBe(1);
    expect(spaceOnly.posted).toEqual([]);
    expect(spaceOnly.inputs().key).toBe(3);
    // A figure that moves by itself is never tried.
    expect(touring.posted).toEqual([]);
    expect(touring.inputs()).toEqual({ key: 0, pointer: 0 });
    for (const other of [page, canvas]) {
      expect(other.posted).toEqual([]);
      expect(other.inputs()).toEqual({ key: 0, pointer: 0 });
    }
    for (const item of [still, readoutOnly, keyed, touring, spaceOnly, page, canvas]) item.close();
  });

  // Review 2026-10-25: a figure the sandbox stopped at its start never moves either, and its 'still' report would send it
  // back for the paid repair the refusal itself is spared.
  it('reports no figure the sandbox stopped as one that never moves', async () => {
    const blocked = run(`dispatchEvent(new ErrorEvent('error', { message: "Uncaught SecurityError: Failed to execute 'pushState' on 'History': A history state object with URL 'about:/coach' cannot be created in a document with origin 'null' and URL 'about:srcdoc'.", lineno: 3, colno: 1 }));`);
    const control = run('');
    await waitFor(() => expect(control.posted).toHaveLength(1), { timeout: 8_000 });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(blocked.posted).toEqual([]);
    expect(blocked.inputs()).toEqual({ key: 0, pointer: 0 });
    blocked.close(); control.close();
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

  it('gives a figure that never moves what AwwO saw instead, four notes at most', () => {
    const notes = ['  The page sets an attribute named "innerHTML" on <g data-part="gas">.  ', 7, '', 'b', 'c', 'd', 'e'];
    expect(readPageErrorMessage({ type: PAGE_ERROR_MESSAGE, kind: 'still', message: ' The drawing never moved. ', line: 2, notes }, 'a\nb', PAGE))
      .toEqual({ page: PAGE, kind: 'still', message: 'The drawing never moved.', lines: ['The page sets an attribute named "innerHTML" on <g data-part="gas">.', 'b', 'c', 'd'] });
    expect(readPageErrorMessage({ type: PAGE_ERROR_MESSAGE, kind: 'still', message: 'still', notes: 'not a list' }, '', PAGE)?.lines).toEqual([]);
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

/** Every run journal written from now on (in this browser's storage, under any namespace), as written. */
function journalWrites(): string[] {
  const written: string[] = [];
  const setItem = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key.includes(CANVAS_RUN_JOURNAL_KEY)) written.push(value);
    setItem(key, value);
  });
  return written;
}

/** The tiles' props as the canvas last rendered them. */
function watchTiles(): Record<string, Tiles.SessionTileProps> {
  const OriginalTile = Tiles.SessionTile;
  const tiles: Record<string, Tiles.SessionTileProps> = {};
  vi.spyOn(Tiles, 'SessionTile').mockImplementation(props => { tiles[props.node.id] = props; return <OriginalTile {...props} />; });
  return tiles;
}

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

  it('is nobody for a market Agent’s page: each of its runs may cost its price, which only its caller decides to pay', () => {
    expect(pageRepairTarget([{ ...figure(), agentRef: { source: 'market', agentId: 'agent-1', version: 2 } }], PAGE)).toBeNull();
  });

  it('is nobody for a field whose id holds a line break, which would end the repair’s first line early', () => {
    const base = figure();
    for (const id of ['a\nb', 'a"\nb']) {
      const contract = { ...base.contract!, outputs: base.contract!.outputs.map(field => field.id === 'figure' ? { ...field, id } : field) };
      const node: SessionNode = { ...base, contract, lastOutput: { ...base.lastOutput!, text: JSON.stringify({ [id]: PAGE }) } };
      expect(pageRepairTarget([node], PAGE)).toBeNull();
    }
    // The same field under an id without one is the node's to repair: what stops it is the line break alone.
    const contract = { ...base.contract!, outputs: base.contract!.outputs.map(field => field.id === 'figure' ? { ...field, id: 'a"b' } : field) };
    expect(pageRepairTarget([{ ...base, contract, lastOutput: { ...base.lastOutput!, text: JSON.stringify({ 'a"b': PAGE }) } }], PAGE)?.fieldId).toBe('a"b');
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
    // A repair of a repair, which the service never runs (page_repair.go), is not asked again either.
    expect(pageRepairRetryAfter('page_repair_chained', at)).toBeNull();
    expect(isPageRepairMessage('AwwO page repair · field "figure"\nAwwO ran the page')).toBe(true);
    expect(isPageRepairMessage('this page fails, fix it')).toBe(false);
  });

  it('keeps a figure that never moves apart: it has its own once, beside a failing page’s', () => {
    expect(pageRepairRecordKey('fig')).toBe('fig');
    expect(pageRepairRecordKey('fig', 'still')).toBe('fig · still');
    expect(isPageRepairMessage('AwwO page repair · field "figure" · still\nAwwO ran the figure')).toBe(true);
    expect(pageRepairMessageKey('fig', 'AwwO page repair · field "figure" · still\nAwwO ran the figure')).toBe('fig · still');
    expect(pageRepairMessageKey('fig', 'AwwO page repair · field "figure"\nAwwO ran the page')).toBe('fig');
    expect(pageRepairMessageKey('fig', undefined)).toBe('fig');
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
    // The preview gives storage a stand-in, so the model hears what it has rather than being asked to guard it.
    expect(message).toContain('localStorage, sessionStorage and cookies work there, kept only while the page is open');
    expect(message).not.toContain('guard any use of localStorage');
    expect(message.endsWith('Reply with only the whole fixed HTML document, from <!doctype html> to </html>: no JSON, no Markdown fence, no other words. AwwO puts it back in "交互原理图".')).toBe(true);
    const more = { ...node, contract: { ...node.contract!, outputs: [...node.contract!.outputs, { id: 'notes', label: '说明', type: 'markdown' as const, required: false, value: '' }] } };
    expect(pageRepairMessage({ node: more, output: node.lastOutput!, fieldId: 'figure', values: { figure: PAGE, notes: 'n' } }, report))
      .toContain('AwwO puts it back in "交互原理图" and keeps the delivery\'s other fields as they are.');
  });

  it('shows the reader a short line in the component’s chat', () => {
    expect(pageRepairDisplayText(report, 'zh')).toBe("页面运行出错，AwwO 自动修复一次：SyntaxError: Identifier 'tokens' has already been declared");
    expect(pageRepairDisplayText({ ...report, message: 'x'.repeat(300) }, 'en')).toBe(`The page failed to run, so AwwO is fixing it once: ${'x'.repeat(160)}…`);
  });

  it('says in both languages why the service did not repair a page again, and what the reader can do', () => {
    const refused = new SaaSApiError(409, 'page_repair_chained', 'refused');
    // Said as what AwwO did, so it stays true when that repair failed or was stopped before a fixed page came back.
    expect(saasErrorMessage(refused, 'zh')).toMatch(/^AwwO 已经把这个组件的页面自动送回修复过，不会再自动送回。.*告诉它哪里不对。$/);
    expect(saasErrorMessage(refused, 'en')).toMatch(/^AwwO already sent this component’s page back for an automatic repair, and does not send it back again by itself\..*tell the component in its chat what is wrong\.$/);
  });

  it('tells the model of a figure that never moves what AwwO tried and saw, and asks for a moving page alone', () => {
    const node = figure();
    const still: PageErrorReport = { page: PAGE, kind: 'still', message: 'The drawing never moved: … The readout stayed "进气 0°".',
      lines: ['The page sets an attribute named "innerHTML" on <g data-part="gas"> and on 3 more elements: setAttribute("innerHTML", …) draws nothing.'] };
    const message = pageRepairMessage({ node, output: node.lastOutput!, fieldId: 'figure', values: { figure: PAGE } }, still);
    expect(message.startsWith('AwwO page repair · field "figure" · still\nAwwO ran the figure you delivered in "交互原理图", and it never moves')).toBe(true);
    expect(message).toContain(`${still.message}\n\nWhat AwwO saw:\n  ${still.lines[0]}`);
    expect(message).toContain('the loop\'s tick calls draw() and returns true while anything still moves');
    expect(message).not.toContain('Where it happened');
    expect(message).toContain(`-----BEGIN PAGE-----\n${PAGE}\n-----END PAGE-----`);
    expect(message.endsWith('AwwO puts it back in "交互原理图".')).toBe(true);
    expect(pageRepairMessageKey('fig', message)).toBe('fig · still');
    const fixed = PAGE.replace('let tokens = 9;', 'tokens = 9;');
    expect(JSON.parse(pageRepairDelivery(node, message, fixed)!)).toEqual({ figure: fixed });
    expect(pageRepairDisplayText(still, 'zh')).toBe('原理图解不会动，AwwO 自动修复一次：悬停、按键后，图里的零件都没有动');
    expect(pageRepairDisplayText(still, 'en')).toBe('The figure never moves, so AwwO is fixing it once: hovering and keys moved none of its parts');
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

  it('reads a field whose id holds a quote, which a plan may give a field, as the service does', () => {
    const base = figure();
    const id = 'page"2';
    const contract = { ...base.contract!, outputs: base.contract!.outputs.map(field => field.id === 'figure' ? { ...field, id } : field) };
    const node: SessionNode = { ...base, contract, lastOutput: { ...base.lastOutput!, text: JSON.stringify({ [id]: PAGE }) } };
    const target = { node, output: node.lastOutput!, fieldId: id, values: { [id]: PAGE } };
    const message = pageRepairMessage(target, report);
    expect(message.split('\n')[0]).toBe('AwwO page repair · field "page"2"');
    expect(isPageRepairMessage(message)).toBe(true);
    expect(pageRepairMessageKey('fig', message)).toBe('fig');
    expect(JSON.parse(pageRepairDelivery(node, message, FIXED)!)).toEqual({ [id]: FIXED });
    const still = pageRepairMessage(target, { ...report, kind: 'still' });
    expect(still.split('\n')[0]).toBe('AwwO page repair · field "page"2" · still');
    expect(pageRepairMessageKey('fig', still)).toBe('fig · still');
    expect(JSON.parse(pageRepairDelivery(node, still, FIXED)!)).toEqual({ [id]: FIXED });
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
  /** The node's chat store, as the canvas it is saved in names it. */
  const keyOf = (id: string) => {
    const node = (JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).nodes.find(item => item.id === id) as SessionNode;
    return sessionStoreKey({ ...node, activeThreadId: activeThreadId(node) });
  };
  /** The node's chat as its store holds it. */
  const turnsOf = (id: string) => getSnapshot(keyOf(id)).turns;
  /** Every key and value this canvas keeps in the browser. */
  const stored = () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
    .map(key => [key, localStorage.getItem(key) ?? ''] as const);
  /** A refusal the service gives before any run, to every message (`repairsOnly`: to AwwO's own repairs, while a person's
   *  message runs until it is stopped), and a history that holds nothing new. */
  const refuseWith = (status: number, refusal: object, repairsOnly = false) => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (!String(input).includes('/messages')
        || (repairsOnly && init?.method === 'POST' && !String(init.body).includes('AwwO page repair'))) return original(input, init);
      return Promise.resolve((init?.method === 'POST'
        ? { ok: false, status, json: async () => refusal }
        : { ok: true, status: 200, json: async () => ({ complete: true, messages: [] }) }) as unknown as Response);
    });
  };
  /** The run controls' note: the last run's summary, or the run going on. */
  const runNote = () => document.querySelector('.canvas-run-ctl .canvas-run-note')?.textContent ?? null;
  /** The run controls show a run going on (their Stop button). */
  const showsRunning = () => document.querySelector('.canvas-run-btn--stop') !== null;

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
    // The service refuses the repair before any run (the workspace is out of calls); the history holds nothing new.
    // The page reads in Chinese, as the line says what did not run.
    localStorage.setItem('superclaw_locale', 'zh');
    refuseWith(429, { code: 'quota_exceeded', error: '工作区运行额度已满', admissionRejected: true });
    render(<CanvasSurface />);
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    await waitFor(() => expect(loadPageRepairRecords(canvasStorage()).fig?.retryAfter).toBeGreaterThan(Date.now() + 25 * 60_000));
    // It was no run: the request leaves the chat, one quiet line says what did not run, why, and that it goes back
    // later, and nothing of it is kept.
    const notice = expect.objectContaining({ role: 'system', tone: 'info', notice: true,
      text: '页面的自动修复没有运行。工作区运行额度已满页面之后再出错时，AwwO 会再送回一次。' });
    await waitFor(() => expect(turnsOf('fig')).toEqual([notice]));
    expect(stored().some(([key]) => key.startsWith('awwo.canvas.manual-recovery.v1'))).toBe(false);
    // Until then the same page asks nothing more.
    act(() => { reportPageError(report); });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(repairs()).toHaveLength(1);
    // Once that time has passed, the same delivery goes back again (the refused run freed its lane at once).
    savePageRepairRecord(canvasStorage(), 'fig', { ...loadPageRepairRecords(canvasStorage()).fig!, retryAfter: Date.now() - 1 });
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(2), { timeout: 8_000 });
    // Refused again: deferred again, and the chat, which ends with that line already, does not say it twice.
    await waitFor(() => expect(loadPageRepairRecords(canvasStorage()).fig?.retryAfter).toBeGreaterThan(Date.now() + 25 * 60_000));
    await waitFor(() => expect(showsRunning()).toBe(false));
    expect(turnsOf('fig')).toEqual([notice]);
  }, 20_000);

  it('ends a repair the service refused before it ran as no run: nothing failed, nothing kept, one quiet line why', async () => {
    // Another browser of this canvas sent the page back first: the service refuses this one before any run.
    const copy = saasErrorMessage(new SaaSApiError(409, 'page_repair_chained', 'refused'), 'zh');
    refuseWith(409, { code: 'page_repair_chained', error: copy, admissionRejected: true });
    const tiles = watchTiles();
    const settled = vi.fn();
    const journals = journalWrites();
    render(<CanvasSurface onWorkSettled={settled} />);
    // The node's conversation so far: the exchange that delivered the page, and one this page sent and keeps itself.
    act(() => {
      appendTurn(keyOf('fig'), { role: 'user', text: '做一张令牌桶原理图' });
      appendTurn(keyOf('fig'), { role: 'agent', text: '做好了：令牌桶原理图。' });
      appendTurn(keyOf('fig'), { role: 'user', text: '标题再大一点', recoveryOperationId: 'operation-earlier' });
      appendTurn(keyOf('fig'), { role: 'agent', text: '已经改大了。', recoveryOperationId: 'operation-earlier' });
    });
    const before = turnsOf('fig');
    expect(before).toHaveLength(4);
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    // The request's own turns go, and one notice says why after the rest of the conversation, which stays as it was:
    // no 出错, no request.
    await waitFor(() => expect(turnsOf('fig')).toEqual([...before, expect.objectContaining({ role: 'system', tone: 'info', text: copy, notice: true })]));
    before.forEach((turn, index) => expect(turnsOf('fig')[index]).toBe(turn));
    expect(turnsOf('fig').some(turn => turn.text.includes('出错') || isPageRepairMessage(turn.text))).toBe(false);
    // Nothing is marked failed, in this tab or in any journal another tab could read, or summed up, and the canvas is
    // not left running (undo, redo and the assistant wait while it is).
    await waitFor(() => expect(tiles.fig.run ?? null).toBeNull());
    await waitFor(() => expect(showsRunning()).toBe(false));
    expect(screen.queryByText(/运行结束/)).toBeNull();
    expect(journals.length).toBeGreaterThan(0);
    for (const value of journals) expect((JSON.parse(value) as CanvasRunJournal).nodes.fig?.state).not.toBe('failed');
    expect(stored().filter(([key]) => key.startsWith(CANVAS_RUN_JOURNAL_KEY))).toEqual([]);
    // Nothing of it is kept: no manual record, and no display record holding the request.
    for (const [key, value] of stored()) {
      expect(key.startsWith('awwo.canvas.manual-recovery.v1'), key).toBe(false);
      expect(value.includes('AwwO page repair'), key).toBe(false);
    }
    // The record stays an asked one, with no time to send it again: the same delivery asks nothing more.
    expect(loadPageRepairRecords(canvasStorage()).fig).toMatchObject({ from: 1_000 });
    expect(loadPageRepairRecords(canvasStorage()).fig?.retryAfter).toBeUndefined();
    act(() => { reportPageError(report); });
    await new Promise(resolve => setTimeout(resolve, 3_500));
    expect(repairs()).toHaveLength(1);
    // It was no run: the host hears of none.
    expect(settled).not.toHaveBeenCalled();
  }, 20_000);

  it('leaves what the canvas showed of its last run as the refused repair found it, and tells the host of no run', async () => {
    // A person's own message runs first, and they stop it: its badge, the run's note and its end reach the host.
    const copy = saasErrorMessage(new SaaSApiError(409, 'page_repair_chained', 'refused'), 'zh');
    refuseWith(409, { code: 'page_repair_chained', error: copy, admissionRejected: true }, true);
    const tiles = watchTiles();
    const settled = vi.fn();
    render(<CanvasSurface onWorkSettled={settled} />);
    await waitFor(() => expect(tiles.fig?.onSend).toBeTruthy());
    act(() => { tiles.fig.onSend!(tiles.fig.node as SessionNode, '把按钮改成红色'); });
    await waitFor(() => expect(sent()).toHaveLength(1));
    await waitFor(() => expect(showsRunning()).toBe(true));
    act(() => { tiles.fig.onStopNode!('fig'); });
    await waitFor(() => expect(tiles.fig.run?.state).toBe('cancelled'));
    await waitFor(() => expect(showsRunning()).toBe(false));
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runNote()).toBeTruthy());
    const shown = { note: runNote(), badge: tiles.fig.run, turns: turnsOf('fig') };
    // Then the page fails, it goes back for its repair, and the service refuses that before it runs.
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    await waitFor(() => expect(turnsOf('fig')).toEqual([...shown.turns, expect.objectContaining({ notice: true, text: copy })]));
    await waitFor(() => expect(showsRunning()).toBe(false));
    // The node's badge, the run's note (and the stop it reports) and the person's own turns are as they were.
    expect(tiles.fig.run).toBe(shown.badge);
    expect(runNote()).toBe(shown.note);
    shown.turns.forEach((turn, index) => expect(turnsOf('fig')[index]).toBe(turn));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(settled).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('leaves a run that ended while the service weighed the repair as that run left it, not as the one before it', async () => {
    const copy = saasErrorMessage(new SaaSApiError(409, 'page_repair_chained', 'refused'), 'zh');
    const original = vi.mocked(fetch).getMockImplementation()!;
    let answer!: () => void;
    const weighed = new Promise<void>(resolve => { answer = resolve; });
    const refused = (status: number, refusal: object) => ({ ok: false, status, json: async () => refusal }) as unknown as Response;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes('/messages')) return original(input, init);
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => ({ complete: true, messages: [] }) } as unknown as Response;
      // The repair waits for the service's answer; a message to the other component is refused at once; fig's own
      // message runs until it is stopped.
      if (String(init.body).includes('AwwO page repair')) { await weighed; return refused(409, { code: 'page_repair_chained', error: copy, admissionRejected: true }); }
      if (url.includes('/agents/a1/')) return refused(429, { code: 'quota_exceeded', error: '工作区运行额度已满', admissionRejected: true });
      return original(input, init);
    });
    const tiles = watchTiles();
    render(<CanvasSurface />);
    // A run they stopped, on fig: its note says so.
    await waitFor(() => expect(tiles.fig?.onSend).toBeTruthy());
    act(() => { tiles.fig.onSend!(tiles.fig.node as SessionNode, '把按钮改成红色'); });
    await waitFor(() => expect(showsRunning()).toBe(true));
    act(() => { tiles.fig.onStopNode!('fig'); });
    await waitFor(() => expect(tiles.fig.run?.state).toBe('cancelled'));
    await waitFor(() => expect(runNote()).toContain(summaryNote({ ok: false, done: 0, failed: 0, blocked: 0, cancelled: 1, cached: 0, total: 1 }, true, 'zh')));
    // fig's page fails; while the service weighs its repair, the other component's message runs (in a lane of its own)
    // and is refused: that is the canvas's last run now, and nothing in it was stopped.
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    act(() => { tiles.s1.onSend!(tiles.s1.node as SessionNode, '你好'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('failed'));
    answer();
    await waitFor(() => expect(turnsOf('fig').at(-1)).toMatchObject({ notice: true, text: copy }));
    await waitFor(() => expect(showsRunning()).toBe(false));
    // The note is the other component's run, with no stop from the run before it; fig's own badge is back.
    const failed = { ok: false, done: 0, failed: 1, blocked: 0, cancelled: 0, cached: 0, total: 1 };
    expect(runNote()).toContain(summaryNote(failed, false, 'zh'));
    expect(runNote()).not.toContain(summaryNote(failed, true, 'zh'));
    expect(tiles.s1.run?.state).toBe('failed');
    expect(tiles.fig.run?.state).toBe('cancelled');
  }, 20_000);

  it('shows the repair running over a badge another lane left on its node, and gives that badge back when refused', async () => {
    const copy = saasErrorMessage(new SaaSApiError(409, 'page_repair_chained', 'refused'), 'zh');
    const original = vi.mocked(fetch).getMockImplementation()!;
    let answer!: () => void;
    const weighed = new Promise<void>(resolve => { answer = resolve; });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes('/messages')) return original(input, init);
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => ({ complete: true, messages: [] }) } as unknown as Response;
      if (String(init.body).includes('AwwO page repair')) {
        await weighed;
        return { ok: false, status: 409, json: async () => ({ code: 'page_repair_chained', error: copy, admissionRejected: true }) } as unknown as Response;
      }
      return original(input, init);
    });
    const tiles = watchTiles();
    render(<CanvasSurface />);
    await waitFor(() => expect(Boolean(tiles.s1?.onSend && tiles.fig?.onSend)).toBe(true));
    // The other component runs in the first lane; fig's own message runs beside it, in the second, and both are stopped.
    act(() => { tiles.s1.onSend!(tiles.s1.node as SessionNode, '你好'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('running'));
    act(() => { tiles.fig.onSend!(tiles.fig.node as SessionNode, '把按钮改成红色'); });
    await waitFor(() => expect(tiles.fig.run?.state).toBe('running'));
    act(() => { tiles.fig.onStopNode!('fig'); });
    await waitFor(() => expect(tiles.fig.run?.state).toBe('cancelled'));
    act(() => { tiles.s1.onStopNode!('s1'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('cancelled'));
    await waitFor(() => expect(showsRunning()).toBe(false));
    const shown = tiles.fig.run;
    // fig's page fails: its repair takes the first lane, and fig shows it running, not the badge the second lane left.
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    await waitFor(() => expect(tiles.fig.run?.state).toBe('running'));
    answer();
    await waitFor(() => expect(turnsOf('fig').at(-1)).toMatchObject({ notice: true, text: copy }));
    await waitFor(() => expect(showsRunning()).toBe(false));
    expect(tiles.fig.run).toBe(shown);
    expect(tiles.s1.run?.state).toBe('cancelled');
    // Its badge is back in the lane that showed it: the next run, which takes the first lane, leaves it.
    act(() => { tiles.s1.onSend!(tiles.s1.node as SessionNode, '再来一次'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('running'));
    expect(tiles.fig.run).toBe(shown);
  }, 20_000);

  it('gives the badge back to its lane when another run started meanwhile in a lane of its own', async () => {
    const copy = saasErrorMessage(new SaaSApiError(409, 'page_repair_chained', 'refused'), 'zh');
    const original = vi.mocked(fetch).getMockImplementation()!;
    let answer!: () => void;
    const weighed = new Promise<void>(resolve => { answer = resolve; });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes('/messages')) return original(input, init);
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => ({ complete: true, messages: [] }) } as unknown as Response;
      if (String(init.body).includes('AwwO page repair')) {
        await weighed;
        return { ok: false, status: 409, json: async () => ({ code: 'page_repair_chained', error: copy, admissionRejected: true }) } as unknown as Response;
      }
      return original(input, init);
    });
    // A third component beside the other two.
    const doc = JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;
    const third = { ...other(), id: 's2', title: '第三个组件', binding: { companyId: 'c1', agentId: 'a2', agentName: 's2' }, issueId: 'iss-s2' };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...doc, nodes: [...doc.nodes, third] }));
    const tiles = watchTiles();
    render(<CanvasSurface />);
    await waitFor(() => expect(Boolean(tiles.s1?.onSend && tiles.s2?.onSend && tiles.fig?.onSend)).toBe(true));
    // The other component runs in the first lane, the third in the second, fig's own message in the third; all stopped.
    for (const id of ['s1', 's2', 'fig']) {
      act(() => { tiles[id].onSend!(tiles[id].node as SessionNode, '你好'); });
      await waitFor(() => expect(tiles[id].run?.state).toBe('running'));
    }
    for (const id of ['fig', 's2', 's1']) {
      act(() => { tiles[id].onStopNode!(id); });
      await waitFor(() => expect(tiles[id].run?.state).toBe('cancelled'));
    }
    await waitFor(() => expect(showsRunning()).toBe(false));
    const shown = tiles.fig.run;
    // fig's page fails: its repair takes the first lane. While the service weighs it, the other component runs again,
    // in the second lane: that start takes the third component's badge, and leaves fig's lane, the third, as it was.
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    await waitFor(() => expect(tiles.fig.run?.state).toBe('running'));
    act(() => { tiles.s1.onSend!(tiles.s1.node as SessionNode, '再来一次'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('running'));
    expect(tiles.s2.run ?? null).toBeNull();
    answer();
    await waitFor(() => expect(turnsOf('fig').at(-1)).toMatchObject({ notice: true, text: copy }));
    expect(tiles.fig.run).toBe(shown);
    expect(tiles.s1.run?.state).toBe('running');
  }, 20_000);

  it('gives the node back no badge from a lane another run took while the service weighed its repair', async () => {
    const copy = saasErrorMessage(new SaaSApiError(409, 'page_repair_chained', 'refused'), 'zh');
    const original = vi.mocked(fetch).getMockImplementation()!;
    let answer!: () => void;
    const weighed = new Promise<void>(resolve => { answer = resolve; });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes('/messages')) return original(input, init);
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => ({ complete: true, messages: [] }) } as unknown as Response;
      if (String(init.body).includes('AwwO page repair')) {
        await weighed;
        return { ok: false, status: 409, json: async () => ({ code: 'page_repair_chained', error: copy, admissionRejected: true }) } as unknown as Response;
      }
      return original(input, init);
    });
    const tiles = watchTiles();
    render(<CanvasSurface />);
    await waitFor(() => expect(Boolean(tiles.s1?.onSend && tiles.fig?.onSend)).toBe(true));
    // As above: the other component's run in the first lane, fig's in the second, both stopped.
    act(() => { tiles.s1.onSend!(tiles.s1.node as SessionNode, '你好'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('running'));
    act(() => { tiles.fig.onSend!(tiles.fig.node as SessionNode, '把按钮改成红色'); });
    await waitFor(() => expect(tiles.fig.run?.state).toBe('running'));
    act(() => { tiles.fig.onStopNode!('fig'); });
    await waitFor(() => expect(tiles.fig.run?.state).toBe('cancelled'));
    act(() => { tiles.s1.onStopNode!('s1'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('cancelled'));
    await waitFor(() => expect(showsRunning()).toBe(false));
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    await waitFor(() => expect(tiles.fig.run?.state).toBe('running'));
    // While the service weighs it, the other component runs again, in the second lane (the repair holds the first):
    // that lane's start takes what it showed, fig's badge with it.
    act(() => { tiles.s1.onSend!(tiles.s1.node as SessionNode, '再来一次'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('running'));
    answer();
    await waitFor(() => expect(turnsOf('fig').at(-1)).toMatchObject({ notice: true, text: copy }));
    expect(tiles.fig.run ?? null).toBeNull();
    expect(tiles.s1.run?.state).toBe('running');
  }, 20_000);

  it('tells the host, when other work ends, of no failure a refused repair gave back to its node', async () => {
    const copy = saasErrorMessage(new SaaSApiError(409, 'page_repair_chained', 'refused'), 'zh');
    const original = vi.mocked(fetch).getMockImplementation()!;
    let answer!: () => void;
    const weighed = new Promise<void>(resolve => { answer = resolve; });
    const refused = (status: number, refusal: object) => ({ ok: false, status, json: async () => refusal }) as unknown as Response;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes('/messages')) return original(input, init);
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => ({ complete: true, messages: [] }) } as unknown as Response;
      if (String(init.body).includes('AwwO page repair')) { await weighed; return refused(409, { code: 'page_repair_chained', error: copy, admissionRejected: true }); }
      // fig's own message is refused after a moment (the canvas shows it running first); the other component's runs.
      if (url.includes('/agents/a-fig/')) {
        await new Promise(resolve => setTimeout(resolve, 60));
        return refused(429, { code: 'quota_exceeded', error: '工作区运行额度已满', admissionRejected: true });
      }
      return original(input, init);
    });
    const tiles = watchTiles();
    const settled = vi.fn();
    render(<CanvasSurface onWorkSettled={settled} />);
    // fig's own message fails: fig shows it, and the host heard so when that run ended.
    await waitFor(() => expect(tiles.fig?.onSend).toBeTruthy());
    act(() => { tiles.fig.onSend!(tiles.fig.node as SessionNode, '把按钮改成红色'); });
    await waitFor(() => expect(tiles.fig.run?.state).toBe('failed'));
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(settled).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'run', failed: true }));
    // fig's page fails; while the service weighs its repair, the other component runs.
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    act(() => { tiles.s1.onSend!(tiles.s1.node as SessionNode, '你好'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('running'));
    // The repair is refused: fig shows its failure again, as it was (its card does not play a failure just now).
    answer();
    await waitFor(() => expect(turnsOf('fig').at(-1)).toMatchObject({ notice: true, text: copy }));
    await waitFor(() => expect(tiles.fig.run?.state).toBe('failed'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.getByTestId('canvas-tile-fig').className).not.toContain('is-just-failed');
    // The other component's run ends (stopped): nothing in it failed, and that is what the host hears.
    act(() => { tiles.s1.onStopNode!('s1'); });
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(2));
    expect(settled).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'run', failed: false }));
  }, 20_000);

  it('keeps the run note a person put away put away, when a repair is refused before it runs', async () => {
    const copy = saasErrorMessage(new SaaSApiError(409, 'page_repair_chained', 'refused'), 'zh');
    refuseWith(409, { code: 'page_repair_chained', error: copy, admissionRejected: true }, true);
    const tiles = watchTiles();
    render(<CanvasSurface />);
    await waitFor(() => expect(tiles.fig?.onSend).toBeTruthy());
    act(() => { tiles.fig.onSend!(tiles.fig.node as SessionNode, '把按钮改成红色'); });
    await waitFor(() => expect(showsRunning()).toBe(true));
    act(() => { tiles.fig.onStopNode!('fig'); });
    await waitFor(() => expect(showsRunning()).toBe(false));
    await waitFor(() => expect(runNote()).toBeTruthy());
    // They put the run's note away.
    act(() => { (document.querySelector('.canvas-run-ctl .canvas-run-note-dismiss') as HTMLButtonElement).click(); });
    await waitFor(() => expect(runNote()).toBeNull());
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    await waitFor(() => expect(turnsOf('fig').at(-1)).toMatchObject({ notice: true, text: copy }));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(runNote()).toBeNull();
    expect(showsRunning()).toBe(false);
  }, 20_000);

  it('gives the node back no badge that an edit upstream took away while the service weighed its repair', async () => {
    // The other component feeds fig, through ports the two really have.
    const doc = JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;
    const fig = doc.nodes.find(node => node.id === 'fig') as SessionNode;
    const upstream = doc.nodes.find(node => node.id === 's1') as SessionNode;
    const out = portsFor(upstream).find(port => port.side === 'output')!;
    const into = portsFor(fig).find(port => port.side === 'input' && canFeed(upstream, out, port))!;
    const wire: CanvasEdge = { id: 's1-fig', fromNode: 's1', fromPort: out.id, toNode: 'fig', toPort: into.id, dataType: out.dataType };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...doc, edges: [wire] }));
    const copy = saasErrorMessage(new SaaSApiError(409, 'page_repair_chained', 'refused'), 'zh');
    const original = vi.mocked(fetch).getMockImplementation()!;
    let answer!: () => void;
    const weighed = new Promise<void>(resolve => { answer = resolve; });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes('/messages')) return original(input, init);
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => ({ complete: true, messages: [] }) } as unknown as Response;
      if (String(init.body).includes('AwwO page repair')) {
        await weighed;
        return { ok: false, status: 409, json: async () => ({ code: 'page_repair_chained', error: copy, admissionRejected: true }) } as unknown as Response;
      }
      return original(input, init);
    });
    const tiles = watchTiles();
    render(<CanvasSurface />);
    // A run they stopped, on fig: its badge is the one a refused repair would give back.
    await waitFor(() => expect(tiles.fig?.onSend).toBeTruthy());
    act(() => { tiles.fig.onSend!(tiles.fig.node as SessionNode, '把按钮改成红色'); });
    await waitFor(() => expect(showsRunning()).toBe(true));
    act(() => { tiles.fig.onStopNode!('fig'); });
    await waitFor(() => expect(tiles.fig.run?.state).toBe('cancelled'));
    await waitFor(() => expect(showsRunning()).toBe(false));
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    await waitFor(() => expect(tiles.fig.run?.state).toBe('running'));
    // While the service weighs it, they change what the upstream component is asked to do: what fig showed is gone.
    act(() => { tiles.s1.onPatchNode!('s1', node => ({ ...node, taskFrame: { version: 1, source: 'manual', constraints: ['标题要大'], acceptanceCriteria: [] } })); });
    await waitFor(() => expect(tiles.fig.run ?? null).toBeNull());
    answer();
    await waitFor(() => expect(turnsOf('fig').at(-1)).toMatchObject({ notice: true, text: copy }));
    await waitFor(() => expect(showsRunning()).toBe(false));
    expect(tiles.fig.run ?? null).toBeNull();
  }, 20_000);

  it('gives the node back its badge when an edit elsewhere on the canvas cleared other badges meanwhile', async () => {
    const copy = saasErrorMessage(new SaaSApiError(409, 'page_repair_chained', 'refused'), 'zh');
    const original = vi.mocked(fetch).getMockImplementation()!;
    let answer!: () => void;
    const weighed = new Promise<void>(resolve => { answer = resolve; });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes('/messages')) return original(input, init);
      if (init?.method !== 'POST') return { ok: true, status: 200, json: async () => ({ complete: true, messages: [] }) } as unknown as Response;
      if (String(init.body).includes('AwwO page repair')) {
        await weighed;
        return { ok: false, status: 409, json: async () => ({ code: 'page_repair_chained', error: copy, admissionRejected: true }) } as unknown as Response;
      }
      return original(input, init);
    });
    const tiles = watchTiles();
    render(<CanvasSurface />);
    await waitFor(() => expect(Boolean(tiles.s1?.onSend && tiles.fig?.onSend)).toBe(true));
    // The other component (wired to nothing) runs in the first lane, fig's own message in the second; both stopped.
    act(() => { tiles.s1.onSend!(tiles.s1.node as SessionNode, '你好'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('running'));
    act(() => { tiles.fig.onSend!(tiles.fig.node as SessionNode, '把按钮改成红色'); });
    await waitFor(() => expect(tiles.fig.run?.state).toBe('running'));
    act(() => { tiles.fig.onStopNode!('fig'); });
    await waitFor(() => expect(tiles.fig.run?.state).toBe('cancelled'));
    act(() => { tiles.s1.onStopNode!('s1'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('cancelled'));
    await waitFor(() => expect(showsRunning()).toBe(false));
    const shown = tiles.fig.run;
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    await waitFor(() => expect(tiles.fig.run?.state).toBe('running'));
    // While the service weighs it, they change what the other component is asked to do: its own badge goes, fig's
    // lane is as it was.
    act(() => { tiles.s1.onPatchNode!('s1', node => ({ ...node, taskFrame: { version: 1, source: 'manual', constraints: ['标题要大'], acceptanceCriteria: [] } })); });
    await waitFor(() => expect(tiles.s1.run ?? null).toBeNull());
    answer();
    await waitFor(() => expect(turnsOf('fig').at(-1)).toMatchObject({ notice: true, text: copy }));
    await waitFor(() => expect(showsRunning()).toBe(false));
    expect(tiles.fig.run).toBe(shown);
  }, 20_000);

  it('keeps a person’s own message the service refused before it ran as their failed message', async () => {
    refuseWith(429, { code: 'quota_exceeded', error: '工作区运行额度已满', admissionRejected: true });
    const tiles = watchTiles();
    render(<CanvasSurface />);
    await waitFor(() => expect(tiles.fig?.onSend).toBeTruthy());
    act(() => { tiles.fig.onSend!(tiles.fig.node as SessionNode, '把按钮改成红色'); });
    // Their words have no other copy, and the failure is what offers them the next step.
    await waitFor(() => expect(tiles.fig.run?.state).toBe('failed'));
    expect(turnsOf('fig').some(turn => turn.role === 'user' && turn.text === '把按钮改成红色')).toBe(true);
    expect(turnsOf('fig').some(turn => turn.notice)).toBe(false);
    await waitFor(() => expect(stored().some(([key, value]) => key.startsWith('awwo.canvas.manual-recovery.v1') && value.includes('把按钮改成红色'))).toBe(true));
  }, 20_000);

  it('leaves what a person left unsent in the node’s chat as it was, whether the repair is refused or runs', async () => {
    // They typed into the node's chat and have not sent it; the page they are looking at fails.
    const draftOf = (node: SessionNode) => getNodeThreads(node).find(thread => thread.id === activeThreadId(node))?.draft;
    const saved = () => (JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).nodes.find(item => item.id === 'fig') as SessionNode;
    const doc = JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...doc,
      nodes: doc.nodes.map(node => node.id === 'fig' ? updateNodeDraft(node as SessionNode, '把标题改大') : node) }));
    const runs = vi.mocked(fetch).getMockImplementation()!;
    refuseWith(429, { code: 'quota_exceeded', error: '工作区运行额度已满', admissionRejected: true });
    const tiles = watchTiles();
    render(<CanvasSurface />);
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    // Refused before it ran: the draft is as they left it, in the canvas and in the node's tile.
    await waitFor(() => expect(loadPageRepairRecords(canvasStorage()).fig?.retryAfter).toBeGreaterThan(Date.now()));
    await waitFor(() => expect(showsRunning()).toBe(false));
    expect(draftOf(saved())).toBe('把标题改大');
    expect(draftOf(tiles.fig.node as SessionNode)).toBe('把标题改大');
    // Sent again later, and this time it runs: the draft was never its message either.
    vi.mocked(fetch).mockImplementation(runs);
    savePageRepairRecord(canvasStorage(), 'fig', { ...loadPageRepairRecords(canvasStorage()).fig!, retryAfter: Date.now() - 1 });
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(2), { timeout: 8_000 });
    await waitFor(() => expect(tiles.fig.run?.state).toBe('running'));
    expect(draftOf(saved())).toBe('把标题改大');
    expect(draftOf(tiles.fig.node as SessionNode)).toBe('把标题改大');
  }, 20_000);

  it('sends a figure that never moves back once of its own, even after the page’s error was repaired', async () => {
    const still: PageErrorReport = { page: PAGE, kind: 'still', message: 'The drawing never moved: … The readout stayed "进气 0°".', lines: [] };
    render(<CanvasSurface />);
    // This delivery is the result of an error repair asked for just before it: no second error repair.
    savePageRepairRecord(canvasStorage(), 'fig', { from: 500, at: 900 });
    act(() => { reportPageError(report); });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(repairs()).toHaveLength(0);
    act(() => { reportPageError(still); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    expect(String(repairs()[0][1]?.body)).toContain('AwwO page repair · field \\"figure\\" · still');
    expect(loadPageRepairRecords(canvasStorage())['fig · still']).toMatchObject({ from: 1_000 });
    // Reported again (another view of it, a remount): nothing more.
    act(() => { reportPageError(still); });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(repairs()).toHaveLength(1);
  });

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

describe('a repair no run answered', () => {
  const report: PageErrorReport = { page: PAGE, message: 'Uncaught SyntaxError: x', lines: [] };
  const fig = () => figure();
  const repairMessage = () => pageRepairMessage({ node: fig(), output: fig().lastOutput!, fieldId: 'figure', values: { figure: PAGE } }, report);
  const journalOf = (manualMessage: string, entry: Partial<CanvasRunJournal['nodes'][string]> = {}): CanvasRunJournal => ({
    version: 1, id: 'journal-1', startedAt: 5_000, scope: ['fig'], manual: true, manualMessage,
    nodes: { fig: { nodeId: 'fig', threadId: activeThreadId(fig()), companyId: 'c1', agentId: 'a-fig', issueId: 'iss-fig',
      operationId: 'operation-1', runId: null, state: 'failed', output: '', ...entry } },
  });
  const manualKey = () => ['awwo.canvas.manual-recovery.v1', 'c1', 'a-fig', 'fig', activeThreadId(fig())].map(encodeURIComponent).join(':');
  const store = () => {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  };
  const proof = { complete: true, turns: [] };

  it('keeps nothing of AwwO’s own repair request, refused, never sent or stopped first, and holds no run open for it', () => {
    for (const state of ['failed', 'cancelled', 'blocked'] as const) {
      const cache = store();
      expect(persistRecoveredManualConversation(fig(), journalOf(repairMessage(), { state }), cache, proof)).toBe(true);
      expect(cache.values.size).toBe(0);
    }
    // Recovery cannot tell a refusal from a request never sent: it shows the request as it ended, beside the node's
    // failure, until the page loads again.
    expect(mergeRecoveredManualConversation([], journalOf(repairMessage()), 'fig'))
      .toEqual([expect.objectContaining({ role: 'user', text: repairMessage() })]);
  });

  it('still keeps a repair a run answered, and a person’s own message no run answered', () => {
    const answered = store();
    expect(persistRecoveredManualConversation(fig(), journalOf(repairMessage(), { runId: 'run-1' }), answered, proof)).toBe(true);
    expect(answered.values.get(manualKey())).toContain('run-1');
    // One whose run identity was never learnt but which answered something is kept too.
    const replied = store();
    expect(persistRecoveredManualConversation(fig(), journalOf(repairMessage(), { output: '修到一半。' }), replied, proof)).toBe(true);
    expect(replied.values.get(manualKey())).toContain('修到一半。');
    const own = store();
    expect(persistRecoveredManualConversation(fig(), journalOf('把按钮改成红色'), own, proof)).toBe(true);
    expect(own.values.get(manualKey())).toContain('把按钮改成红色');
    expect(mergeRecoveredManualConversation([], journalOf('把按钮改成红色'), 'fig')).toEqual([expect.objectContaining({ role: 'user', text: '把按钮改成红色' })]);
  });

  it('neither shows nor counts the refused repairs an earlier release kept, and drops them at the next write', () => {
    const cache = store();
    const kept = Array.from({ length: 50 }, (_, index) => ({ operationId: `old-${index}`, runId: null, userText: repairMessage(),
      agentText: '', state: 'failed', startedAt: 1_000 + index }));
    cache.values.set(manualKey(), JSON.stringify({ version: 1, records: kept }));
    // The thread's store was full of them: a person could send nothing more there.
    expect(hasManualRecoveryCapacity(fig(), '下一句', cache)).toBe(true);
    expect(mergePersistedManualConversations(fig(), [], cache)).toEqual([]);
    expect(persistRecoveredManualConversation(fig(), journalOf('把按钮改成红色'), cache, proof)).toBe(true);
    const records = (JSON.parse(cache.values.get(manualKey())!) as { records: Array<{ userText: string }> }).records;
    expect(records.map(record => record.userText)).toEqual(['把按钮改成红色']);
  });
});

// A hosted canvas, as production runs it: the refusal comes from the service through the bridge (canvasBridge.ts), and
// the canvas keeps its records under its own namespace. Last in this file: nothing here clears that namespace again.
describe('in a cloud workspace', () => {
  const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
  const api = `/api/v1/tenants/${tenant.id}`;
  const reader = async (path: string) => path === '/api/agents' ? { agents: [{ name: 'pi', supports_model_selection: true }] } : { models: ['profile-main'] };
  const report: PageErrorReport = { page: PAGE, message: "Uncaught SyntaxError: Identifier 'tokens' has already been declared", lines: ['let tokens = 9;'] };
  class SilentResizeObserver { observe() {} unobserve() {} disconnect() {} }
  let refusal: { status: number; code: string };
  /** The service's answer to fig's run waits for this; with `admit`, it then admits the run instead of refusing it
   *  ('lost': and its events cannot be read, so the page never hears it was admitted). */
  let admitted: Promise<void>;
  let admit: false | 'yes' | 'lost';
  /** The other component's runs are admitted, and go on until they are stopped (otherwise refused at once). */
  let otherRuns: boolean;
  /** fig's runs asked of the service. */
  let runPosts: number;
  /** The node as the hosted canvas's own document holds it. */
  const nodeOf = (id: string) => loadDocumentWithStatus().doc.nodes.find(item => item.id === id) as SessionNode;
  /** The node's chat as its store holds it. */
  const turnsOf = (id: string) => getSnapshot(sessionStoreKey({ ...nodeOf(id), activeThreadId: activeThreadId(nodeOf(id)) })).turns;
  /** The node's history read into its chat through the bridge, afresh, as its tile reads it when it opens. */
  const loadHistory = async (id: string) => {
    forgetNode(sessionStoreKey({ ...nodeOf(id), activeThreadId: activeThreadId(nodeOf(id)) }));
    await act(async () => { await restoreHistory({ gatewayBase: '/gateway-api', node: nodeOf(id) }); });
  };
  /** Every key and value one hosted canvas keeps, wherever the browser keeps them. */
  const kept = (storage = canvasStorage()) => storage.keys().map(key => [key, storage.getItem(key) ?? ''] as const);

  beforeEach(() => {
    cleanup(); resetAllSessions(); localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
    configureCanvasStorage('user', tenant.id, 'canvas');
    configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 9);
    configureSaaSCanvasInitialize(async () => loadDocumentWithStatus().doc);
    vi.stubGlobal('ResizeObserver', SilentResizeObserver);
    refusal = { status: 409, code: 'page_repair_chained' }; admitted = Promise.resolve(); admit = false; otherRuns = false; runPosts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      // The node's conversation on the service: the request that delivered the page, and its answer.
      if (url.startsWith(`${api}/sessions/iss-fig/messages`)) return new Response(JSON.stringify({ items: [
        { role: 'user', content: '做一张令牌桶原理图', runId: 'run-0' }, { role: 'assistant', content: '做好了：令牌桶原理图。', runId: 'run-0' }] }));
      if (url.startsWith(`${api}/runs?operationId=`)) return new Response(JSON.stringify({ items: [] }));
      // The other component's run, admitted, until it is stopped (the bridge finds the session's active run to stop).
      if (url.startsWith(`${api}/runs?sessionId=iss-s1`)) return new Response(JSON.stringify({ items: otherRuns ? [{ id: 'run-s1', sessionId: 'iss-s1', terminal: false }] : [] }));
      if (url === `${api}/runs/run-s1` && (init.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ id: 'run-s1', sessionId: 'iss-s1', status: 'running', terminal: false }));
      if (url === `${api}/runs/run-s1/cancel` && init.method === 'POST') return new Response(JSON.stringify({ id: 'run-s1', sessionId: 'iss-s1', status: 'cancelled', terminal: true }));
      if (url.startsWith(`${api}/runs/run-s1/events`)) return new Response(new ReadableStream({ start(controller) {
        // Read until the page lets go of the run (it was stopped), as a real request's body is.
        init.signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      } }));
      if (url === `${api}/runs` && init.method === 'POST') {
        // The other component's messages are refused at once (today's calls used up), or run (otherRuns); fig's run
        // waits for the answer.
        if ((JSON.parse(String(init.body)) as { sessionId?: string }).sessionId === 'iss-s1') {
          return otherRuns ? new Response(JSON.stringify({ id: 'run-s1', sessionId: 'iss-s1', status: 'queued' }), { status: 201 })
            : new Response(JSON.stringify({ error: { code: 'quota_exceeded', message: 'refused' } }), { status: 429 });
        }
        runPosts += 1;
        await admitted;
        if (admit) return new Response(JSON.stringify({ id: admit === 'yes' ? 'run-1' : 'run-2', sessionId: 'iss-fig', status: 'queued' }), { status: 201 });
        return new Response(JSON.stringify({ error: { code: refusal.code, message: 'refused' } }), { status: refusal.status });
      }
      // An admitted run's events: it goes on running; or, for run-2, they cannot be read.
      if (url.startsWith(`${api}/runs/run-1/events`)) return new Response(new ReadableStream({ start() {} }));
      if (url.startsWith(`${api}/runs/run-2/events`)) return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'lost' } }), { status: 502 });
      return new Response(JSON.stringify({ items: [], models: [] }));
    }));
    const node: SessionNode = { ...figure(), runtime: 'pi', model: 'profile-main', binding: { companyId: tenant.id, agentId: 'a-fig', agentName: 'fig' } };
    const other: SessionNode = { ...createSessionNode('llm', { x: 700, y: 40 }), id: 's1', title: '另一个组件', runtime: 'pi', model: 'profile-main',
      binding: { companyId: tenant.id, agentId: 'a1', agentName: 's1' }, issueId: 'iss-s1' };
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ version: 2, updatedAt: 1, nodes: [node, other], edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } }));
  });
  afterEach(() => { clearSaaSCanvas(); configureSaaSCanvasInitialize(null); });

  it('ends a repair the service refused before it ran as no run, and keeps nothing of it in the canvas it was asked in', async () => {
    const settled = vi.fn();
    const journals = journalWrites();
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} onWorkSettled={settled} />);
    await loadHistory('fig');
    await waitFor(() => expect(turnsOf('fig').map(turn => turn.text)).toEqual(['做一张令牌桶原理图', '做好了：令牌桶原理图。']));
    const before = turnsOf('fig');
    act(() => { reportPageError(report); });
    await waitFor(() => expect(runPosts).toBe(1));
    // The service's own answer, in the bridge's words, after the conversation as it was.
    const copy = canvasErrorMessage(new SaaSApiError(409, 'page_repair_chained', 'refused'));
    await waitFor(() => expect(turnsOf('fig')).toEqual([...before, expect.objectContaining({ role: 'system', tone: 'info', text: copy, notice: true })]));
    before.forEach((turn, index) => expect(turnsOf('fig')[index]).toBe(turn));
    await waitFor(() => expect(document.querySelector('.canvas-run-btn--stop')).toBeNull());
    expect(screen.queryByText(/运行结束/)).toBeNull();
    expect(journals.length).toBeGreaterThan(0);
    for (const value of journals) expect((JSON.parse(value) as CanvasRunJournal).nodes.fig?.state).not.toBe('failed');
    // Nothing of it is kept in the canvas's own storage: no journal, no manual record, no display record.
    for (const [key, value] of kept()) {
      expect(key.startsWith(CANVAS_RUN_JOURNAL_KEY), key).toBe(false);
      expect(key.startsWith('awwo.canvas.manual-recovery.v1'), key).toBe(false);
      expect(value.includes('AwwO page repair'), key).toBe(false);
    }
    expect(loadPageRepairRecords(canvasStorage()).fig).toMatchObject({ from: 1_000 });
    expect(loadPageRepairRecords(canvasStorage()).fig?.retryAfter).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(settled).not.toHaveBeenCalled();
    expect(runPosts).toBe(1);
  }, 20_000);

  it('clears its journal and keeps its deferral in the canvas it was asked in, when another canvas opened meanwhile', async () => {
    refusal = { status: 429, code: 'quota_exceeded' };
    let answer!: () => void;
    admitted = new Promise(resolve => { answer = resolve; });
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    await loadHistory('fig');
    await waitFor(() => expect(turnsOf('fig')).toHaveLength(2));
    const asked = canvasStorage();
    act(() => { reportPageError(report); });
    await waitFor(() => expect(runPosts).toBe(1));
    // Another canvas opens while the service answers: the page shows it in place of this one.
    cleanup();
    configureCanvasStorage('user', tenant.id, 'other');
    configureSaaSCanvas({ tenant, canvasId: 'other' });
    answer();
    await waitFor(() => expect(loadPageRepairRecords(asked).fig?.retryAfter).toBeGreaterThan(Date.now() + 25 * 60_000));
    expect(kept(asked).filter(([key]) => key.startsWith(CANVAS_RUN_JOURNAL_KEY))).toEqual([]);
    expect(loadPageRepairRecords(canvasStorage()).fig).toBeUndefined();
    expect(kept().filter(([key]) => key.startsWith(CANVAS_RUN_JOURNAL_KEY))).toEqual([]);
    // Its display record left the canvas it was asked in, and nothing of it reached the one opened meanwhile.
    for (const [key, value] of [...kept(asked), ...kept()]) expect(value.includes('AwwO page repair'), key).toBe(false);
  }, 20_000);

  it('says what did not run and why in one language, the one the page is in when the service answers', async () => {
    refusal = { status: 429, code: 'quota_exceeded' };
    let answer!: () => void;
    admitted = new Promise(resolve => { answer = resolve; });
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    act(() => { reportPageError(report); });
    await waitFor(() => expect(runPosts).toBe(1));
    // The page, in Chinese when the repair went, is in English when the service answers.
    document.documentElement.lang = 'en';
    try {
      answer();
      const reason = canvasErrorMessage(new SaaSApiError(429, 'quota_exceeded', 'refused'));
      expect(reason).not.toMatch(/[一-鿿]/);
      await waitFor(() => expect(turnsOf('fig').at(-1)).toMatchObject({ notice: true,
        text: `The page’s automatic repair did not run. ${reason} When the page fails again later, AwwO sends it back once more.` }));
    } finally { document.documentElement.lang = ''; }
  }, 20_000);

  it('recovers a repair whose admission was lost on the way as a run of its own, not as the stop before it', async () => {
    otherRuns = true;
    admit = 'lost';
    let answer!: () => void;
    admitted = new Promise(resolve => { answer = resolve; });
    const tiles = watchTiles();
    const settled = vi.fn();
    const showsRunning = () => document.querySelector('.canvas-run-btn--stop') !== null;
    const runNote = () => document.querySelector('.canvas-run-ctl .canvas-run-note')?.textContent ?? null;
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} onWorkSettled={settled} />);
    // The canvas's last run: a message to the other component, which they stop. Its note says so.
    await waitFor(() => expect(tiles.s1?.onSend).toBeTruthy());
    act(() => { tiles.s1.onSend!(tiles.s1.node as SessionNode, '你好'); });
    await waitFor(() => expect(showsRunning()).toBe(true));
    act(() => { tiles.s1.onStopNode!('s1'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('cancelled'));
    await waitFor(() => expect(showsRunning()).toBe(false));
    await waitFor(() => expect(runNote()).toContain(summaryNote({ ok: false, done: 0, failed: 0, blocked: 0, cancelled: 1, cached: 0, total: 1 }, true, 'zh')));
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    // fig's page fails and goes back. The service admits the run, but the page never hears it (the run's events cannot
    // be read): that is no refusal, so the repair takes the last run off show, and recovery finds out how it went.
    act(() => { reportPageError(report); });
    await waitFor(() => expect(runPosts).toBe(1));
    answer();
    await waitFor(() => expect(tiles.s1.run ?? null).toBeNull());
    // However recovery ends it, its note is its own (no stop from the run before it), and the host hears it ended.
    await waitFor(() => expect(showsRunning()).toBe(false), { timeout: 10_000 });
    const recovered = { ok: false, done: 0, failed: 1, blocked: 0, cancelled: 0, cached: 0, total: 1 };
    await waitFor(() => expect(runNote()).toContain(summaryNote(recovered, false, 'zh')));
    expect(runNote()).not.toContain(summaryNote(recovered, true, 'zh'));
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(2));
    expect(settled).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'run', failed: true }));
  }, 20_000);

  // Last here: its run goes on running.
  it('takes the canvas’s last run off show once the service admits the repair, as a run’s start does, not before', async () => {
    admit = 'yes';
    let answer!: () => void;
    admitted = new Promise(resolve => { answer = resolve; });
    const tiles = watchTiles();
    const showsRunning = () => document.querySelector('.canvas-run-btn--stop') !== null;
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    // The canvas's last run: a message to the other component, refused (a person's own: it shows as failed).
    await waitFor(() => expect(tiles.s1?.onSend).toBeTruthy());
    act(() => { tiles.s1.onSend!(tiles.s1.node as SessionNode, '你好'); });
    await waitFor(() => expect(tiles.s1.run?.state).toBe('failed'));
    await waitFor(() => expect(showsRunning()).toBe(false));
    // fig's page fails and goes back: while the service weighs it, the canvas runs it (its Stop is there), and the last
    // run stays on show beside fig's running badge.
    act(() => { reportPageError(report); });
    await waitFor(() => expect(runPosts).toBe(1));
    await waitFor(() => expect(tiles.fig.run?.state).toBe('running'));
    await waitFor(() => expect(showsRunning()).toBe(true));
    expect(tiles.s1.run?.state).toBe('failed');
    // Admitted: now it takes the last run off show, as a run's start does; its own badge stays.
    answer();
    await waitFor(() => expect(tiles.s1.run ?? null).toBeNull());
    expect(tiles.fig.run?.state).toBe('running');
    expect(showsRunning()).toBe(true);
  }, 20_000);
});
