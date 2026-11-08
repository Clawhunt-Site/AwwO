// A session that declares no deliverables and returns a complete HTML document delivered a page (resultPage.ts): every
// view shows it as one, the page check runs it, and a failure goes back to the node once, as a declared page's does.
// On 2026-11-07 a multiplayer case's game, built by a session an agent had added over MCP, opened as text everywhere
// (the card said "HTML document · Open preview"), and its first build's error was caught only after a person gave the
// node a Game deliverable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasResults } from '../src/canvas/CanvasResults';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CardPreview } from '../src/canvas/CardPreview';
import { DisplayTile } from '../src/canvas/DisplayTile';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import { CANVAS_STORAGE_KEY, createAssembleNode, createEditNode, createFormNode, createSessionNode, type AgentKind, type CanvasDocument, type CanvasNode,
  type NodeOutput, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasResult, deliveredItems, stepDelivery } from '../src/canvas/canvasResultModel';
import { LocaleProvider } from '../src/canvas/i18n';
import { activeThreadId } from '../src/canvas/nodeThreads';
import type { NodeContract } from '../src/canvas/nodeContracts';
import { PAGE_ERROR_MESSAGE, reportPageError, subscribePageErrors, type PageErrorReport } from '../src/canvas/pageErrors';
import { loadPageRepairRecords, pageRepairDecision, pageRepairDelivery, pageRepairMessage, pageRepairTarget } from '../src/canvas/pageRepair';
import { canvasStorage } from '../src/canvas/canvasStorage';
import { portsFor } from '../src/canvas/ports';
import { displayContract, RESULT_PAGE_FIELD, resultPage, undeclaredSession } from '../src/canvas/resultPage';
import { applyRecoveredDocument, runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { resetAllSessions } from '../src/canvas/sessions';
import { DeliverableStudio } from '../src/canvas/studio/DeliverableStudio';
import { LIVE_PAGE_CSP } from '../src/canvas/studio/liveDocument';
import { nodeEntries, primaryEntry, studioGroups } from '../src/canvas/studio/studioModel';
import type { CanvasRecord, Tenant } from '../src/saas/api';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { ResultsGallery } from '../src/saas/ResultsGallery';

/** A game whose first frame throws, as the case's first build did. */
const PAGE = '<!doctype html>\n<html><head><title>Lantern Path</title></head><body><h1>Lantern Path</h1><canvas id="board"></canvas>\n<script>\n'
  + 'const g = document.getElementById("board").getContext("2d");\nconst glow = g.createRadialGradient(0, 0, 0, 0, 0, NaN);\n</script></body></html>';
const fence = (page: string) => '```html\n' + page + '\n```';
const FENCED = fence(PAGE);
const FIXED = PAGE.replace('0, 0, NaN', '0, 0, 24');
const ERROR = "Uncaught TypeError: Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.";

/** A session as an agent adds one over MCP: a title, a persona, no contract; `text` is what its run delivered. */
const session = (text: string | null, over: Partial<SessionNode> = {}, kind: AgentKind = 'coding'): SessionNode => ({
  ...createSessionNode(kind, { x: 0, y: 0 }), id: 'build', title: 'Build the game', persona: 'Write the whole game as one HTML page.',
  runtime: 'claude_local', binding: { companyId: 'c1', agentId: 'a-build', agentName: 'build' }, issueId: 'iss-build',
  lastOutput: text === null ? null : { text, at: 1_000, source: 'run' }, ...over,
});
const gameContract = (): NodeContract => ({ version: 1, inputs: [], outputs: [{ id: 'delivery_game', label: 'Game', type: 'html', required: true, value: '' }] });
const doc = (nodes: CanvasNode[]): CanvasDocument => ({ version: 2, updatedAt: 1, nodes, edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } });
const policyOf = (frame: Element | null) => new DOMParser().parseFromString(frame?.getAttribute('srcdoc') ?? '', 'text/html')
  .querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('which result is a page', () => {
  it('is a complete HTML document an undeclared session returned, whole or in one html fence, read through one field', () => {
    for (const text of [PAGE, FENCED, `\uFEFF  ${PAGE}\n`]) {
      expect(resultPage(session(text), text)).toEqual({ id: RESULT_PAGE_FIELD, label: 'Build the game', type: 'html', required: true, value: '' });
      expect(displayContract(session(text), text)).toEqual({ version: 1, inputs: [], outputs: [resultPage(session(text), text)] });
    }
    expect(RESULT_PAGE_FIELD).toBe('result');
    // A session with no title names its page by its id.
    expect(resultPage(session(PAGE, { title: '  ' }), PAGE)?.label).toBe('build');
  });

  it('is also the document in `{"result": …}` alone, the envelope the card reads as a document, and every view reads it out', () => {
    for (const text of [JSON.stringify({ result: PAGE }), JSON.stringify({ result: FENCED }), '```json\n' + JSON.stringify({ result: PAGE }) + '\n```']) {
      expect(resultPage(session(text), text)?.id).toBe(RESULT_PAGE_FIELD);
      expect(nodeEntries(session(text), 'run')).toEqual([expect.objectContaining({ name: 'Build the game.html', kind: 'page', source: { type: 'inline', text: PAGE } })]);
      expect(stepDelivery(session(text), 0)).toMatchObject({ kind: 'html', html: PAGE });
    }
    const wrapped = session(JSON.stringify({ result: PAGE }));
    expect(pageRepairTarget([wrapped], PAGE)).toMatchObject({ fieldId: 'result', values: { result: PAGE } });
    expect(pageRepairDelivery(wrapped, pageRepairMessage(pageRepairTarget([wrapped], PAGE)!, { page: PAGE, message: ERROR, lines: [] }), FIXED)).toBe(FIXED);
  });

  it('reads a node’s text again whenever it changes', () => {
    const node = session(PAGE);
    expect(resultPage(node, PAGE)).not.toBeNull();
    expect(resultPage(node, 'The game has three levels.')).toBeNull();
    expect(resultPage(node, PAGE)).not.toBeNull();
    expect(resultPage({ ...node, contract: gameContract() }, PAGE)).toBeNull();
  });

  it.each([
    ['a fragment', '<main><canvas></canvas><script>start()</script></main>'],
    ['an unclosed document', '<!doctype html><html><head></head><body><h1>Still streaming'],
    ['words before the document', `Here is the game:\n${PAGE}`],
    ['words after the fence', `${FENCED}\n\nOpen it in a browser.`],
    ['a document in a comment', `<!-- ${PAGE} -->`],
    ['plain text', 'The game has three levels and a restart key.'],
    ['Markdown', '## Levels\n\n- Lantern Path\n- Tide Gate'],
    ['JSON with more beside the page', JSON.stringify({ result: PAGE, notes: 'Three levels' })],
    ['JSON under another name', JSON.stringify({ output: PAGE })],
    ['JSON holding a fragment', JSON.stringify({ result: '<main>Only a part</main>' })],
    ['nothing', ''],
  ])('is not %s, which stays as it is', (_, text) => {
    expect(resultPage(session(text), text)).toBeNull();
    expect(displayContract(session(text), text)).toEqual({ version: 1, inputs: [], outputs: [] });
  });

  it('is never a declared form’s, a media session’s or another kind of node’s', () => {
    // A declared deliverable is the node's own form, whatever the result holds.
    const declared = session(PAGE, { contract: gameContract() });
    expect(undeclaredSession(declared)).toBe(false);
    expect(resultPage(declared, PAGE)).toBeNull();
    expect(displayContract(declared, PAGE)).toBe(declared.contract);
    // A form with inputs only declares no deliverable: its inputs stay, and its page is the one field shown.
    const inputs: NodeContract = { version: 1, inputs: [{ id: 'brief', label: 'Brief', type: 'text', required: false, value: '' }], outputs: [] };
    expect(displayContract(session(PAGE, { contract: inputs }), PAGE)).toEqual({ ...inputs, outputs: [resultPage(session(PAGE), PAGE)] });
    for (const kind of ['image', 'video', 'model3d', 'audio'] as const) {
      expect(undeclaredSession(session(PAGE, {}, kind))).toBe(false);
      expect(resultPage(session(PAGE, {}, kind), PAGE)).toBeNull();
    }
    const assemble = { ...createAssembleNode({ x: 0, y: 0 }), lastOutput: { text: PAGE, at: 1, source: 'run' as const } };
    expect(resultPage(assemble, PAGE)).toBeNull();
    expect(displayContract(assemble, PAGE)).toBe(assemble.contract);
    expect(resultPage(createFormNode({ x: 0, y: 0 }), PAGE)).toBeNull();
    expect(resultPage(createEditNode({ x: 0, y: 0 }), PAGE)).toBeNull();
    expect(resultPage(session(PAGE), undefined)).toBeNull();
  });

  it('declares nothing: the node keeps its ports, and nothing is written into it', () => {
    const node = session(PAGE);
    const before = JSON.stringify(node);
    displayContract(node, PAGE);
    expect(JSON.stringify(node)).toBe(before);
    expect(node.contract).toBeUndefined();
    expect(portsFor(node).map(port => port.id)).toEqual(['context', 'result']);
  });
});

describe('the deliverables panel', () => {
  it('runs the page under the run’s output, with its preview, source, restart and download', () => {
    const { container } = render(<NodeDeliverables node={session(PAGE)} readOnly />);
    expect(within(screen.getByRole('article', { name: '运行输出' })).getByRole('heading', { name: '运行输出' })).toBeVisible();
    const frame = screen.getByTitle('Build the game · HTML 预览');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
    expect(frame.getAttribute('srcdoc')).toContain('createRadialGradient');
    expect(container.querySelector('.awwo-markdown-preview')).toBeNull();
    expect(screen.getByRole('button', { name: '重新开始' })).toBeVisible();
    expect(screen.getByRole('button', { name: '下载 .html' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '源码' }));
    expect(screen.getByLabelText('HTML 源码').textContent).toBe(PAGE);
  });

  it('runs a fenced page alike, says so in English, and downloads the page alone under the node’s name', () => {
    let saved = '';
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:awwo-page', revokeObjectURL: () => undefined });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved = this.download; });
    render(<LocaleProvider locale="en"><NodeDeliverables node={session(FENCED)} readOnly /></LocaleProvider>);
    expect(screen.getByRole('heading', { name: 'Run output' })).toBeVisible();
    expect(screen.getByTitle('Build the game · HTML preview').getAttribute('srcdoc')).toContain('<h1>Lantern Path</h1>');
    fireEvent.click(screen.getByRole('button', { name: 'Download .html' }));
    expect(saved).toBe('Build the game.html');
  });

  it('keeps text, Markdown and a fragment as the run’s output they were', () => {
    for (const text of ['## Levels\n\n- Lantern Path', '<main>Only a part</main>']) {
      const { container } = render(<NodeDeliverables node={session(text)} readOnly />);
      expect(screen.getByRole('heading', { name: '运行输出' })).toBeVisible();
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('.awwo-markdown-preview')).not.toBeNull();
      cleanup();
    }
  });

  it('edits and publishes the declared form only: the page is no field of it', () => {
    const update = vi.fn();
    render(<NodeDeliverables node={session(PAGE)} readOnly={false} onUpdateNode={update} />);
    fireEvent.click(screen.getByText('编辑输出表单'));
    expect(screen.getByRole('button', { name: '发布输出' })).toBeDisabled();
    fireEvent.click(screen.getByText('添加交付要求'));
    fireEvent.change(screen.getByRole('combobox', { name: '交付形式' }), { target: { value: 'game' } });
    fireEvent.click(screen.getByRole('button', { name: '添加到交付' }));
    const changed = update.mock.calls[0][0] as SessionNode;
    expect(changed.contract!.outputs.map(field => field.id)).toEqual(['delivery_game']);
    expect(changed.lastOutput).toEqual(session(PAGE).lastOutput);
  });
});

describe('a page in every other view', () => {
  it('is the node’s page file, first, in the studio’s model; text stays a document', () => {
    expect(nodeEntries(session(PAGE), 'run')).toEqual([expect.objectContaining({ id: 'build:field:result', name: 'Build the game.html', label: 'Build the game',
      kind: 'page', source: { type: 'inline', text: PAGE }, primary: true })]);
    expect(primaryEntry(session(FENCED))).toMatchObject({ kind: 'page', source: { type: 'inline', text: PAGE } });
    expect(nodeEntries(session('The game has three levels.'), 'run')).toEqual([expect.objectContaining({ name: 'Build the game.txt', kind: 'text' })]);
    expect(nodeEntries(session('## Levels\n\n- one'), 'run')).toEqual([expect.objectContaining({ name: 'Build the game.md', kind: 'markdown' })]);
    // A node an agent titled after its file keeps that name, as the panel's download does; so does a declared page.
    expect(nodeEntries(session(PAGE, { title: 'index.html' }), 'run')[0].name).toBe('index.html');
    const game = { ...gameContract(), outputs: [{ ...gameContract().outputs[0], label: 'Game.HTM' }] };
    expect(nodeEntries(session(JSON.stringify({ delivery_game: PAGE }), { contract: game }), 'run')[0].name).toBe('Game.html');
  });

  it('runs on an enlarged card', async () => {
    const card = render(<CardPreview node={session(PAGE)} running={false} />);
    await waitFor(() => expect(policyOf(card.container.querySelector('iframe'))).toBe(LIVE_PAGE_CSP));
    expect(card.container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('createRadialGradient');
    expect(card.container.querySelector('.awwo-card-preview-text')).toBeNull();
    expect(card.container.querySelector('.awwo-card-preview-name')).toHaveTextContent('Build the game.html');
  });

  it('runs in the results studio', async () => {
    const { container } = render(<DeliverableStudio nodes={[session(PAGE)]} edges={[]} nodeId="build" title="Results" variant="embedded" />);
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(LIVE_PAGE_CSP));
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('<h1>Lantern Path</h1>');
    expect(screen.getAllByText('Build the game.html').length).toBeGreaterThan(0);
  });

  it('runs in a preview display', async () => {
    const nodes = [session(PAGE)];
    const groups = studioGroups({ nodes, edges: [] });
    const { container } = render(<DisplayTile display={{ id: 'dp-1', kind: 'display', x: 900, y: 0, w: 640, h: 480, title: '', source: { type: 'node', nodeId: 'build' } }}
      groups={groups} choices={[{ id: 'build', title: 'Build the game' }]} canvasEntries={groups.flatMap(group => group.entries)} running={new Set()} scale={1} />);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('<h1>Lantern Path</h1>'));
  });

  it('is the canvas’s result in the 成果 view, listed and running there', () => {
    const notes = session('## Levels\n\n- Lantern Path', { id: 'levels', title: 'Levels' });
    const build = session(PAGE);
    const edges = [{ id: 'w1', fromNode: 'levels', fromPort: 'result', toNode: 'build', toPort: 'context', dataType: 'text' as const }];
    expect(stepDelivery(build, 1)).toMatchObject({ state: 'run', kind: 'html', html: PAGE });
    expect(stepDelivery(notes, 0)).toMatchObject({ kind: 'text' });
    expect(canvasResult({ nodes: [notes, build], edges }).final?.node.id).toBe('build');
    // A page is what a canvas is for, as a declared page is: it is the result ahead of the notes written after it, which
    // a text result upstream would not be.
    const after = [{ id: 'w2', fromNode: 'build', fromPort: 'result', toNode: 'levels', toPort: 'context', dataType: 'text' as const }];
    expect(canvasResult({ nodes: [notes, build], edges: after }).final?.node.id).toBe('build');
    expect(canvasResult({ nodes: [notes, session('The game has three levels.')], edges: after }).final?.node.id).toBe('levels');
    expect(deliveredItems({ nodes: [notes, build], edges })).toEqual([{ key: 'build:result', nodeId: 'build', nodeTitle: 'Build the game', fieldId: 'result',
      label: 'Build the game', kind: 'page' }]);
    render(<CanvasResults nodes={[notes, build]} edges={edges} runs={{}} running={false} readOnly onOpenNode={vi.fn()} onBack={vi.fn()} />);
    const result = screen.getByRole('article', { name: 'Build the game' });
    expect(within(result).getByTitle('Build the game · HTML 预览')).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
    expect(screen.getByRole('button', { name: '打开「Build the game」的「Build the game」（网页 · 可运行）' })).toBeVisible();
  });

  it('is printed, still, as the canvas’s result in the workspace’s gallery', () => {
    localStorage.setItem('superclaw_locale', 'zh');
    const tenant: Tenant = { id: 'tenant-a', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
    const record: CanvasRecord = { id: 'c-game', tenantId: tenant.id, name: 'Lantern Path', version: 1, createdAt: '', updatedAt: '',
      document: { ...doc([session(PAGE, { lastOutput: { text: PAGE, at: Date.now() - 60_000, source: 'run' } })]), updatedAt: Date.now() } };
    const { container } = render(<SaaSPreferencesProvider><ResultsGallery tenant={tenant} canvases={[record]} /></SaaSPreferencesProvider>);
    const frame = container.querySelector('iframe')!;
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Lantern Path</h1>');
    expect(frame.getAttribute('srcdoc')).not.toContain('createRadialGradient');
    localStorage.clear();
  });
});

describe('the page check', () => {
  const report: PageErrorReport = { page: PAGE, message: ERROR, lines: ['const glow = g.createRadialGradient(0, 0, 0, 0, 0, NaN);'] };

  it('hears the panel’s running page, and finds the node that delivered it', () => {
    const reports: PageErrorReport[] = [];
    const stop = subscribePageErrors(item => reports.push(item));
    try {
      render(<NodeDeliverables node={session(FENCED)} readOnly />);
      const frame = screen.getByTitle('Build the game · HTML 预览') as HTMLIFrameElement;
      act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: PAGE_ERROR_MESSAGE, message: ERROR, line: 6, column: 22 }, source: frame.contentWindow })); });
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ page: PAGE, message: ERROR });
      expect(pageRepairTarget([session('notes', { id: 'levels' }), session(FENCED)], reports[0].page)).toMatchObject({ fieldId: 'result', output: { at: 1_000 }, values: { result: PAGE } });
    } finally { stop(); }
  });

  it('repairs nobody’s page but a complete run’s, and no market Agent’s, media session’s or text result’s', () => {
    expect(pageRepairTarget([session(PAGE)], PAGE)?.node.id).toBe('build');
    for (const output of [{ source: 'case' as const }, { source: 'manual' as const }, { partial: true }]) {
      expect(pageRepairTarget([session(PAGE, { lastOutput: { text: PAGE, at: 1_000, source: 'run', ...output } as NodeOutput })], PAGE)).toBeNull();
    }
    expect(pageRepairTarget([session(PAGE, { agentRef: { source: 'market', agentId: 'agent-1', version: 2 } })], PAGE)).toBeNull();
    expect(pageRepairTarget([session(PAGE, {}, 'image')], PAGE)).toBeNull();
    expect(pageRepairTarget([session(`Here it is:\n${PAGE}`)], PAGE)).toBeNull();
    expect(pageRepairTarget([session(PAGE)], FIXED)).toBeNull();
  });

  it('sends a page a declared form holds back to that node, whichever comes first, even when a session passed it on', () => {
    // A builder that declared nothing wired into a step whose Game deliverable returns the same page.
    const builder = session(PAGE, { id: 'draft', title: 'Draft the game' });
    const declared = session(JSON.stringify({ delivery_game: PAGE }), { id: 'final', title: 'Finish the game', contract: gameContract() });
    for (const nodes of [[builder, declared], [declared, builder]]) {
      expect(pageRepairTarget(nodes, PAGE)).toMatchObject({ node: { id: 'final' }, fieldId: 'delivery_game' });
    }
    expect(pageRepairTarget([builder, { ...declared, lastOutput: { text: JSON.stringify({ delivery_game: FIXED }), at: 1_000, source: 'run' } }], PAGE))
      .toMatchObject({ node: { id: 'draft' }, fieldId: 'result' });
  });

  it('asks the node’s model for the page itself, fixed, which takes the delivered page’s place', () => {
    const node = session(PAGE);
    const target = pageRepairTarget([node], PAGE)!;
    const message = pageRepairMessage(target, report);
    expect(message.startsWith(`AwwO page repair · field "result"\nAwwO ran the page you delivered, and it failed with this error, so the reader cannot use it:\n\n${ERROR}`)).toBe(true);
    expect(message).toContain(`-----BEGIN PAGE-----\n${PAGE}\n-----END PAGE-----`);
    expect(message.endsWith('no JSON, no Markdown fence, no other words. AwwO puts it in place of the page you delivered.')).toBe(true);
    expect(message).not.toContain('"Build the game"');
    const still = pageRepairMessage(target, { ...report, kind: 'still', message: 'The drawing never moved.' });
    expect(still.startsWith('AwwO page repair · field "result" · still\nAwwO ran the figure you delivered, and it never moves')).toBe(true);
  });

  it('publishes the fixed page alone as the node’s new result, and nothing for any other reply', () => {
    const node = session(PAGE);
    const message = pageRepairMessage(pageRepairTarget([node], PAGE)!, report);
    for (const reply of [FIXED, fence(FIXED), `Here is the fixed page:\n\n${FIXED}\n\nThe glow has a radius now.`]) {
      expect(pageRepairDelivery(node, message, reply)).toBe(FIXED);
    }
    expect(pageRepairDelivery(node, message, '<main>only a part</main>')).toBeNull();
    expect(pageRepairDelivery(node, 'Make the glow bigger', FIXED)).toBeNull();
    expect(pageRepairDelivery(node, message.replace('field "result"', 'field "page"'), FIXED)).toBeNull();
    // Once the node declares a Game deliverable, a repair names that field and is put back into it.
    const declared = session(JSON.stringify({ delivery_game: PAGE }), { contract: gameContract() });
    expect(pageRepairDelivery(declared, message, FIXED)).toBeNull();
    expect(JSON.parse(pageRepairDelivery(declared, message.replace('field "result"', 'field "delivery_game"'), FIXED)!)).toEqual({ delivery_game: FIXED });
  });

  it('decodes a reply the model gave in JSON all the same, and never publishes a page with its JSON escapes left in', () => {
    // Codex's round-2 case: a compact page whose script holds a quote. Cut out of the JSON as it stands, it kept
    // `textContent=\"fixed\"`, ran with a SyntaxError, and as the repair's own result never went back again.
    const compact = '<!doctype html><html><head><title>Lantern Path</title></head><body><h1>Lantern Path</h1><script>document.body.dataset.state="fixed";</script></body></html>';
    const node = session(compact);
    const message = pageRepairMessage(pageRepairTarget([node], compact)!, report);
    for (const reply of [JSON.stringify({ result: compact }), '```json\n' + JSON.stringify({ result: compact }) + '\n```', `Here is the fixed page: ${JSON.stringify({ result: compact })}`,
      JSON.stringify(compact), JSON.stringify({ result: fence(compact) }),
      // Codex's round-3 cases: a string that starts with a line break or a fence, after words; braces in the words; a
      // reply cut before its last brace; the field after another one holding braces.
      `Fixed: ${JSON.stringify({ result: `\n${compact}` })}`, `Fixed: ${JSON.stringify({ result: fence(compact) })}`,
      `Fixed {the glow}: ${JSON.stringify({ result: compact })}`, `Fixed: ${JSON.stringify({ result: compact }).slice(0, -1)}`,
      `Fixed: ${JSON.stringify({ notes: 'radius {24}', result: compact })}`,
      // Round 4 (Codex and the code review): words, a comment or other whitespace inside the string before the page; a
      // small object in the words before the one holding it; the object inside an array.
      `Fixed: ${JSON.stringify({ result: `Here is the fixed page:\n${compact}` })}`, `Sure! ${JSON.stringify({ result: `<!-- fixed -->\n${compact}` })}`,
      `Fixed: ${JSON.stringify({ result: `\f${compact}` })}`, 'Fixed: {"result":"\\u0020' + JSON.stringify(compact).slice(1) + '}',
      `Changed ${JSON.stringify({ radius: 24 })}: ${JSON.stringify({ result: compact })}`, `Fixed: [${JSON.stringify({ result: compact })}]`,
      // Round 5 (Codex): any number of small objects in the words first; JSON encoded twice.
      `Fixed: ${'{"n":0} '.repeat(20)}${JSON.stringify({ result: compact })}`, JSON.stringify({ result: JSON.stringify({ result: compact }) }),
      `Fixed: ${JSON.stringify({ result: JSON.stringify(compact) })}`]) {
      expect(pageRepairDelivery(node, message, reply)).toBe(compact);
    }
    for (const reply of [JSON.stringify({ page: compact }), JSON.stringify({ result: '<main>only a part</main>' }), JSON.stringify([compact]),
      `Fixed: ${JSON.stringify({ page: `\n${compact}` })}`, `Fixed: ${JSON.stringify({ page: `Notes:\n${compact}` })}`,
      // Cut inside the string, or a trailing comma: the object does not read, so nothing is cut out of it as it stands.
      `Fixed: ${JSON.stringify({ result: `\n${compact}` }).slice(0, -40)}`, `Fixed: ${JSON.stringify({ page: compact }).slice(0, -2)}`,
      `Fixed: ${JSON.stringify({ result: compact }).slice(0, -1)},}`,
      // Round 5 (Codex): the wrong key behind many small objects; another key inside a twice-encoded value; three deep.
      `Fixed: ${'{"n":0} '.repeat(20)}${JSON.stringify({ page: compact })}`, JSON.stringify({ result: JSON.stringify({ page: compact }) }),
      `Fixed: ${JSON.stringify({ result: JSON.stringify({ page: compact }) })}`,
      JSON.stringify({ result: JSON.stringify({ result: JSON.stringify({ result: compact }) }) })]) {
      expect(pageRepairDelivery(node, message, reply)).toBeNull();
    }
    // A page of its own is taken as it is, never decoded: a script holding JSON, braces and quotes, words around it, a
    // quote in the words just before it, a small object in them, the page itself in quotes.
    const scripted = '<!doctype html>\n<html lang="en"><head><title>Tide Gate</title></head><body><script>\nconst level = {"name": "Tide Gate", "keys": [1, 2]};\n'
      + 'const line = \'one\\ntwo\';\ndocument.title = level.name + " {" + level.keys.length + "} " + line;\n</script></body></html>';
    const scriptedMessage = pageRepairMessage(pageRepairTarget([session(scripted)], scripted)!, report);
    for (const reply of [scripted, fence(scripted), `Here is the fixed page:\n\n${scripted}\n\nThe level loads now.`,
      `Here is the fixed page for "Tide Gate"\n\n${scripted}`, `I changed the radius from NaN to "24"\n\n${fence(scripted)}`,
      `Changed ${JSON.stringify({ radius: 24 })}:\n\n${scripted}`, `The page: "${scripted}"`]) {
      expect(pageRepairDelivery(session(scripted), scriptedMessage, reply)).toBe(scripted);
    }
    expect(pageRepairDelivery(node, message, `The page: "${compact}"`)).toBe(compact);
    // A declared page's reply in JSON is decoded the same way, and merged into the node's delivery.
    const declared = session(JSON.stringify({ delivery_game: compact }), { contract: gameContract() });
    const declaredMessage = pageRepairMessage(pageRepairTarget([declared], compact)!, report);
    expect(JSON.parse(pageRepairDelivery(declared, declaredMessage, `Fixed: ${JSON.stringify({ delivery_game: compact })}`)!)).toEqual({ delivery_game: compact });
    expect(pageRepairDelivery(declared, declaredMessage, JSON.stringify({ result: compact }))).toBeNull();
  });

  it('takes the reply as the node’s delivery when the run’s journal comes back', () => {
    const node = session(PAGE);
    const document = doc([node]);
    const journal = { version: 1 as const, id: 'repair', startedAt: 5_000, scope: ['build'], manual: true,
      manualMessage: pageRepairMessage(pageRepairTarget([node], PAGE)!, report), inputFingerprint: runInputFingerprint(document, ['build']),
      nodes: { build: { nodeId: 'build', threadId: activeThreadId(node), operationId: 'op', companyId: 'c1', agentId: 'a-build', issueId: 'iss-build', runId: 'r', state: 'done' as const, output: FIXED } } };
    const published = applyRecoveredDocument(document, journal).nodes[0] as SessionNode;
    expect(published.lastOutput).toEqual({ text: FIXED, at: 5_000, source: 'run' });
    expect(published.contract).toBeUndefined();
    const kept = applyRecoveredDocument(document, { ...journal, nodes: { build: { ...journal.nodes.build, output: 'Sorry, I cannot.' } } }).nodes[0] as SessionNode;
    expect(kept.lastOutput).toEqual(node.lastOutput);
  });

  it('publishes nothing when the node gained or lost a contract while its repair was out', () => {
    const node = session(PAGE);
    const journal = { version: 1 as const, id: 'repair', startedAt: 5_000, scope: ['build'], manual: true,
      manualMessage: pageRepairMessage(pageRepairTarget([node], PAGE)!, report), inputFingerprint: runInputFingerprint(doc([node]), ['build']),
      nodes: { build: { nodeId: 'build', threadId: activeThreadId(node), operationId: 'op', companyId: 'c1', agentId: 'a-build', issueId: 'iss-build', runId: 'r', state: 'done' as const, output: FIXED } } };
    // A person gave it a Game deliverable meanwhile: the canvas is not the one the repair was asked in, and its form has
    // no `result` field for the reply either.
    const gained = { ...node, contract: gameContract() };
    expect((applyRecoveredDocument(doc([gained]), journal).nodes[0] as SessionNode).lastOutput).toEqual(node.lastOutput);
    expect(pageRepairDelivery(gained, journal.manualMessage, FIXED)).toBeNull();
    // A declared page's repair, when its node has lost its contract meanwhile, names a field the session no longer has.
    const declared = session(JSON.stringify({ delivery_game: PAGE }), { contract: gameContract() });
    const declaredMessage = pageRepairMessage(pageRepairTarget([declared], PAGE)!, report);
    expect(declaredMessage.split('\n')[0]).toBe('AwwO page repair · field "delivery_game"');
    expect(pageRepairDelivery({ ...declared, contract: undefined }, declaredMessage, FIXED)).toBeNull();
    const lostJournal = { ...journal, manualMessage: declaredMessage, inputFingerprint: runInputFingerprint(doc([declared]), ['build']) };
    const lost = { ...declared, contract: undefined };
    expect((applyRecoveredDocument(doc([lost]), lostJournal).nodes[0] as SessionNode).lastOutput).toEqual(declared.lastOutput);
  });
});

describe('on the canvas', () => {
  class SilentResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const report: PageErrorReport = { page: PAGE, message: ERROR, lines: [] };
  const repairs = () => vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).includes('/messages') && init?.method === 'POST'
    && String(init?.body).includes('AwwO page repair'));

  beforeEach(() => {
    cleanup(); resetAllSessions(); localStorage.clear();
    vi.stubGlobal('ResizeObserver', SilentResizeObserver);
    // A conversation POST stays open until its run is stopped, as in saas-page-repair.test.tsx.
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
      if (String(input).endsWith('/prepare')) return Promise.resolve({ ok: true, status: 200 });
      if (!String(input).includes('/messages')) return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
      });
    }));
  });

  it('sends the failing page of an undeclared session back to it once, naming its result', async () => {
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc([session(PAGE)])));
    render(<CanvasSurface />);
    act(() => { reportPageError(report); });
    await waitFor(() => expect(repairs()).toHaveLength(1));
    expect(String(repairs()[0][0])).toContain('/agents/a-build/messages');
    expect(String(repairs()[0][1]?.body)).toContain('AwwO page repair · field \\"result\\"');
    // Its once is recorded for this delivery, so the same page reported again (another view of it) asks nothing more,
    // whether or not the repair is still running.
    const record = loadPageRepairRecords(canvasStorage()).build;
    expect(record).toMatchObject({ from: 1_000 });
    expect(pageRepairDecision(record, session(PAGE).lastOutput!)).toBe('asked');
    act(() => { reportPageError(report); });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(repairs()).toHaveLength(1);
  });

  it('sends nothing for the same page published by hand', async () => {
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc([session(PAGE, { lastOutput: { text: PAGE, at: 1_000, source: 'manual' } })])));
    render(<CanvasSurface />);
    act(() => { reportPageError(report); });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(repairs()).toHaveLength(0);
  });
});
