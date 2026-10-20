import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { ContractFields } from '../src/canvas/ContractFields';
import { canvasText, LocaleProvider } from '../src/canvas/i18n';
import { mediaMissingText } from '../src/canvas/mediaOutput';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import { parseContractOutput } from '../src/canvas/nodeContracts';
import { nextSteps, type NextStep } from '../src/canvas/nextSteps';
import { prepareNodeConversation } from '../src/canvas/nodeConversation';
import { isSoftMediaFeed } from '../src/canvas/ports';
import { prepareRunDocument } from '../src/canvas/runRecoveryDocument';
import { resetAllSessions } from '../src/canvas/sessions';
import { SessionTile } from '../src/canvas/SessionTile';
import { createOfficialDocument } from '../src/saas/examples/officialWorkflows';
import { canonicalCanvasText } from '../src/saas/productionCanvasText';
import { createProductionCopyDocument } from '../src/saas/productionCopy';
import { invalidateOutputs } from '../src/canvas/invalidateOutputs';
import { loadProductionRun, type ProductionRunRecord } from '../src/saas/productionRuns';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { WorkspaceHome } from '../src/saas/WorkspaceHome';
import type { Identity, Tenant } from '../src/saas/api';

vi.mock('../src/saas/productionRuns', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/saas/productionRuns')>();
  return { ...actual, loadProductionRun: vi.fn(actual.loadProductionRun) };
});

// Every published case: every canvas is compiled from tasks, the knowledge base's too.
const WORKFLOWS = PRODUCTION_WORKFLOWS;
const CASES = Object.keys(WORKFLOWS);
// A media case's image and video nodes generate afresh in a copy, and the page they feed is made on its first run.
const RECORDED = CASES.filter(id => !WORKFLOWS[id].media?.length);
const records = new Map<string, ProductionRunRecord>();
// The film case: a recorded canvas, stored beside its record rather than compiled from a workflow.
const FILM = 'the-long-chord', FILM_TITLE = 'THE LONG CHORD · Episode I, Act I';
const copyOf = (id: string) => createProductionCopyDocument(WORKFLOWS[id], records.get(id)!, null);
const tenant: Tenant = { id: 'copy-workspace', name: 'Copy workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const identity: Identity = { user: { id: 'copy-user', name: 'Copy user', email: 'copy@example.invalid', platformRole: 'user' }, tenants: [tenant] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeAll(async () => {
  for (const id of CASES) records.set(id, (await loadProductionRun(id))!);
  await import('../src/saas/ProductionShowcase');
  // A film case's dialog and its record (recordedCanvas.ts), loaded once here rather than inside a test's wait.
  await Promise.all([import('../src/saas/ProductionFilm'), loadProductionRun(FILM)]);
}, 300_000);
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('carries every agent’s recorded delivery into its copy, as the case’s, on the very canvas that ran', () => {
  expect(CASES).toHaveLength(22);
  expect(RECORDED).toHaveLength(16);
  for (const id of RECORDED) {
    const workflow = WORKFLOWS[id], record = records.get(id)!, copy = copyOf(id);
    // Only results are added: the tasks, contracts and wires are the pinned canvas the case ran on.
    expect(canonicalCanvasText(copy)).toBe(canonicalCanvasText(createOfficialDocument(workflow)));
    copy.nodes.forEach((node, index) => {
      const recorded = record.nodes.find(value => value.id === workflow.nodes[index].id)!;
      const session = node as SessionNode;
      // A flagship's assembly makes its page file again on the copy's first run, with no model, and an agent that hands
      // a file on (a team's turn) runs again then: its file is in the case's workspace.
      if (node.kind === 'assemble' || workflow.nodes[index].handoff) { expect(session.lastOutput, `${id}/${recorded.id}`).toBeUndefined(); return; }
      // A node with a report beside its result (a flagship's tester) carries both, as one object.
      const text = recorded.report === undefined ? recorded.output : JSON.stringify({ result: recorded.output, report: recorded.report });
      expect(session.lastOutput, `${id}/${recorded.id}`).toEqual({ text,
        at: Date.parse(`${record.capturedOn}T00:00:00Z`), source: 'case', model: record.model });
      expect(session.deliverablesOpen).toBe(true);
      const parsed = parseContractOutput(session.contract!, session.lastOutput!.text);
      expect(parsed.errors).toEqual([]);
      if (recorded.outputType === 'markdown') expect(parsed.values.result).toBe(recorded.output);
      else expect(parsed.values.result).toMatch(/^<!doctype html>/i);
      if (recorded.report !== undefined) expect(parsed.values.report).toBe(recorded.report);
    });
  }
});

it('shows every agent what it received: each wired input resolves to its upstream recording, marked as one', () => {
  for (const id of RECORDED) {
    const copy = copyOf(id), byId = new Map(copy.nodes.map(node => [node.id, node as SessionNode]));
    // What an assembly makes again on the copy's first run reaches the node it feeds then, and so does what a team's turn
    // makes again then (it hands a file on).
    const remade = new Set(copy.nodes.filter((node, index) => node.kind === 'assemble' || WORKFLOWS[id].nodes[index]?.handoff).map(node => node.id));
    for (const node of copy.nodes as SessionNode[]) {
      const incoming = copy.edges.filter(edge => edge.toNode === node.id);
      if (incoming.some(edge => remade.has(edge.fromNode))) continue;
      const context = prepareNodeConversation(node, copy.nodes, copy.edges);
      expect(context.error, `${id}/${node.title}`).toBeUndefined();
      for (const edge of incoming) {
        const field = edge.toPort.slice('in:'.length), upstream = byId.get(edge.fromNode)!;
        // The wire carries the one output field it starts from, not the whole delivery.
        expect(context.inputs!.find(input => input.id === field)!.value).toBe(parseContractOutput(upstream.contract!, upstream.lastOutput!.text).values[edge.fromPort.slice('out:'.length)]);
        expect(context.recorded?.[field]).toBe(true);
      }
    }
  }
});

it('copies a media case on the very canvas that ran: agents with their recordings, media nodes fresh, the page they feed made on the first run', () => {
  const media = CASES.filter(id => WORKFLOWS[id].media?.length);
  expect(media.sort()).toEqual(['aurora-gt', 'car-plant', 'neon-circuit', 'neon-city', 'pallward', 'shanhai-vn']);
  for (const id of media) {
    const workflow = WORKFLOWS[id], record = records.get(id)!, copy = copyOf(id);
    expect(canonicalCanvasText(copy)).toBe(canonicalCanvasText(createOfficialDocument(workflow)));
    const fed = new Set(workflow.media!.flatMap(item => item.feeds ?? []));
    const files = record.media!.flatMap(item => item.files);
    expect(copy.nodes).toHaveLength(workflow.nodes.length + workflow.media!.length);
    copy.nodes.forEach((node, index) => {
      const spec = workflow.nodes[index], session = node as SessionNode;
      const recorded = spec && record.nodes.find(value => value.id === spec.id)!;
      // A 3D model reaches the page through a module the page pastes, so that page names the run's files as well.
      const names = spec?.outputType === 'html' && files.some(file => recorded!.output?.includes(file));
      // An assembly that delivers a file (PALLWARD's page and its first pass's page) makes it again on the first run.
      const file = node.kind === 'assemble' && node.contract.outputs.some(field => field.type === 'file');
      if (!spec || fed.has(spec.id) || names || file) { expect(session.lastOutput, `${id}/${session.title}`).toBeUndefined(); return; }
      expect(session.lastOutput?.source, `${id}/${spec.id}`).toBe('case');
      expect(parseContractOutput(session.contract!, session.lastOutput!.text).values.result, `${id}/${spec.id}`).toBe(recorded!.output);
    });
  }
  // The rebuilt 3D cases: the module that loads the model and the page that pastes it are made on the first run.
  for (const [id, nodes] of [['neon-circuit', ['cars', 'build']], ['car-plant', ['vehicles', 'page']]] as const) {
    const copy = copyOf(id), workflow = WORKFLOWS[id];
    for (const target of nodes) expect((copy.nodes[workflow.nodes.findIndex(node => node.id === target)] as SessionNode).lastOutput, `${id}/${target}`).toBeUndefined();
  }
});

it('has the assistant count everything a case’s copy still has to make, and run all of it', () => {
  const advice = (id: string) => { const copy = copyOf(id); return { copy, next: nextSteps({ nodes: copy.nodes, edges: copy.edges, runs: {}, running: false,
    canRun: true, resultsAvailable: true, upgradeAvailable: true, isPremiumRefusal: () => false, reworkAvailable: true, canPlan: true, cloudRuns: true })! }; };
  for (const id of CASES) {
    const { copy, next } = advice(id);
    // Every node without a result: a media case's media nodes and the steps that read their files, an assembly that
    // makes a file (a flagship's page, Roost's turn recorder) and a turn that hands a file on.
    const left = copy.nodes.filter(node => node.kind !== 'form' && !node.lastOutput).map(node => node.id);
    const media = WORKFLOWS[id].media?.length ?? 0;
    if (!left.length) { expect(next.situation, id).toMatchObject({ kind: 'complete' }); continue; }
    expect(next.situation, id).toEqual({ kind: 'partial', count: left.length, ...(media ? { media } : {}) });
    expect(next.steps[0], id).toMatchObject({ kind: 'run-rest', nodeIds: left, ...(media ? { generations: media } : {}) });
  }
  // The flagships' copies, whose assemblies make their files on the first run: the card called the first three done, and
  // counted four of Roost's six.
  expect(['umber-photo', 'backprop-lab', 'errand-agent', 'roost-team'].map(id => advice(id).next.situation)).toEqual([
    { kind: 'partial', count: 1 }, { kind: 'partial', count: 1 }, { kind: 'partial', count: 2 }, { kind: 'partial', count: 6 }]);
  // PALLWARD's copy, seen live on 2026-10-20: the card said 3 nodes (its text Agents) had no result yet and offered to run
  // them alone, for at least 3 calls, though their upstream pictures and models did not exist.
  const { copy, next } = advice('pallward');
  const nodes = new Map(copy.nodes.map(node => [node.id, node]));
  const generates = (nodeId: string) => { const node = nodes.get(nodeId)!; return node.kind === 'session' ? node.agentKind : node.kind; };
  const left = (next.steps[0] as Extract<NextStep, { kind: 'run-rest' }>).nodeIds;
  expect(next.situation).toEqual({ kind: 'partial', count: 48, media: 43 });
  expect([left.filter(nodeId => generates(nodeId) === 'image').length, left.filter(nodeId => generates(nodeId) === 'model3d').length]).toEqual([10, 33]);
  expect(left.filter(nodeId => !['image', 'model3d'].includes(generates(nodeId))).map(nodeId => nodes.get(nodeId)!.title))
    .toEqual(['Asset manifest and stand-ins', 'Assembly', 'Test and fix', 'First pass page', 'Second fix pass']);
  // The run goes from those 48 through the review they feed: four Agents' calls at the least, and a paid generation for
  // every picture and model.
  expect(next.steps).toEqual([{ kind: 'run-rest', nodeIds: left, calls: 4, generations: 43 }, { kind: 'results' }]);
});

it('keeps a case recording and its model through a save and reload, and grants no model to other outputs', () => {
  const copy = copyOf('pixel-platformer');
  const reloaded = sanitizeDocument(JSON.parse(JSON.stringify(copy)));
  expect(reloaded.nodes.map(node => (node as SessionNode).lastOutput)).toEqual(copy.nodes.map(node => (node as SessionNode).lastOutput));
  const raw = JSON.parse(JSON.stringify(copy));
  raw.nodes[0].lastOutput = { ...raw.nodes[0].lastOutput, source: 'run' };
  raw.nodes[1].lastOutput = { ...raw.nodes[1].lastOutput, source: 'sample' };
  const [run, unknown] = sanitizeDocument(raw).nodes as SessionNode[];
  expect(run.lastOutput).toEqual({ text: raw.nodes[0].lastOutput.text, at: raw.nodes[0].lastOutput.at, source: 'run' });
  expect(unknown.lastOutput?.source).toBe('run');
  expect(unknown.lastOutput?.model).toBeUndefined();
});

it('replaces every recording when the whole graph runs, and reuses the upstream recordings when one node reruns', () => {
  const copy = copyOf('pixel-platformer');
  const build = copy.nodes[PRODUCTION_WORKFLOWS['pixel-platformer'].nodes.findIndex(node => node.id === 'build')];
  const whole = prepareRunDocument(copy, copy.nodes.map(node => node.id), false);
  expect(whole.nodes.every(node => (node as SessionNode).lastOutput == null)).toBe(true);
  const single = prepareRunDocument(copy, [build.id], false);
  for (const node of single.nodes as SessionNode[]) {
    if (node.id === build.id) expect(node.lastOutput).toBeNull();
    else if (copy.edges.some(edge => edge.fromNode === node.id && edge.toNode === build.id)) expect(node.lastOutput?.source).toBe('case');
  }
});

it('refuses a recording of another canvas instead of pinning results to the wrong agents', () => {
  const workflow = PRODUCTION_WORKFLOWS['pixel-platformer'], record = records.get('pixel-platformer')!;
  expect(() => createProductionCopyDocument(workflow, { ...record, edges: record.edges.slice(1) }, null)).toThrow(/does not match/);
  expect(() => createProductionCopyDocument(workflow, { ...record, nodes: record.nodes.map((node, index) => index ? node : { ...node, id: 'renamed' }) }, null)).toThrow(/does not match/);
  expect(() => createProductionCopyDocument(PRODUCTION_WORKFLOWS['party-game'], record, null)).toThrow(/does not match/);
});

it('wraps a recorded text that reads as JSON naming its field, so downstream receives exactly what was delivered', () => {
  const workflow = PRODUCTION_WORKFLOWS['pixel-platformer'], record = records.get('pixel-platformer')!;
  const odd = JSON.stringify({ result: 'nested' });
  const copy = createProductionCopyDocument(workflow, { ...record, nodes: record.nodes.map(node => node.id === 'design' ? { ...node, output: odd } : node) }, null);
  const design = copy.nodes[workflow.nodes.findIndex(node => node.id === 'design')] as SessionNode;
  expect(design.lastOutput?.text).toBe(JSON.stringify({ result: odd }));
  expect(parseContractOutput(design.contract!, design.lastOutput!.text).values.result).toBe(odd);
});

it('keeps the recordings through settings, task and wire edits and undo, and clears them only below a replaced output', () => {
  const copy = copyOf('pixel-platformer'), workflow = PRODUCTION_WORKFLOWS['pixel-platformer'];
  const at = (id: string, doc = copy) => doc.nodes[workflow.nodes.findIndex(node => node.id === id)] as SessionNode;
  const recordings = (doc: typeof copy) => doc.nodes.filter(node => (node as SessionNode).lastOutput?.source === 'case').length;
  const edit = (id: string, change: Partial<SessionNode>) => ({ ...copy, nodes: copy.nodes.map(node => node.id === at(id).id ? { ...node, ...change } : node) });
  // Choosing a model or rewording a task: the recordings are references, not this configuration's results.
  expect(recordings(invalidateOutputs(copy, edit('design', { runtime: 'openai-agents', model: 'qwen3.8-27b-p6' })))).toBe(6);
  const reworded = invalidateOutputs(copy, edit('design', { persona: `${at('design').persona}\n多一条要求。` }));
  expect(recordings(reworded)).toBe(6);
  expect(recordings(invalidateOutputs(reworded, copy))).toBe(6);
  expect(recordings(invalidateOutputs(copy, { ...copy, edges: copy.edges.slice(1) }))).toBe(6);
  // The build delivers its own result: the review stood on the case's build, so it is cleared; the upstream stays.
  const built = invalidateOutputs(copy, edit('build', { lastOutput: { text: at('build').lastOutput!.text, at: Date.now(), source: 'run' } }));
  expect(at('review', built).lastOutput).toBeNull();
  expect(['design', 'art', 'levels', 'sound'].every(id => at(id, built).lastOutput?.source === 'case')).toBe(true);
  expect(at('build', built).lastOutput?.source).toBe('run');
});

it('names a case recording for what it is, with its model and day, and never as a run of this workspace', () => {
  const node = copyOf('pixel-platformer').nodes[0] as SessionNode;
  render(<NodeDeliverables node={node} readOnly onUpdateNode={() => {}} />);
  expect(screen.getByText('案例实录 · Claude Opus 5.5 · 2026-10-13 真实运行')).toBeVisible();
  expect(screen.getByText('没有在你的工作区运行；运行整张图会换成你自己的结果')).toBeVisible();
  expect(screen.queryByText(/来自运行|交付$/)).toBeNull();
  cleanup();
  const field = { id: 'from_design', label: '玩法与数值', type: 'markdown' as const, required: true, value: '' };
  render(<ContractFields fields={[field]} resolvedFields={[{ ...field, value: '交付内容' }]} sources={{ from_design: '玩法与数值' }} recorded={{ from_design: true }} label="输入" onChange={() => {}} readOnly />);
  expect(screen.getByText('收到“玩法与数值”的案例实录：真实运行的内容，没有在你的工作区执行；断开连线后可手动填写。')).toBeVisible();
});

it('opens a team turn whose recorder is made on the first run with its input waiting, not missing, in English', () => {
  resetAllSessions();
  // Roost's turn recorder is an assembly that delivers a file, so a copy makes it again on its first run; until then each
  // bot turn's recorder input has nothing to show.
  const copy = copyOf('roost-team');
  const wren = copy.nodes.find(node => node.title === 'Turn 1: Wren gathers the facts') as SessionNode;
  expect(copy.nodes.find(node => node.title === 'Turn recorder')?.lastOutput).toBeUndefined();
  const context = prepareNodeConversation(wren, copy.nodes, copy.edges);
  expect(context.inputs).toBeUndefined();
  render(<LocaleProvider locale="en"><SessionTile node={wren} scale={1} focused onToggleFocus={vi.fn()} conversationContext={context} /></LocaleProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Input' }));
  const form = screen.getByRole('region', { name: 'Input form' });
  expect(within(form).getByText(canvasText('en', 'contract.sourceWaiting', { source: 'Turn recorder' }))).toBeVisible();
  expect(within(form).queryByRole('alert')).toBeNull();
  expect(form.textContent).not.toMatch(/\p{Script=Han}/u);
});

it('opens a media case’s page before its media are made with a note on each media input in the page’s language, while its agent still reads its own', () => {
  // Every media case: each node a fresh media node feeds takes the agent's note (mediaMissingText), marked by kind, as the
  // canvas prepares it (session nodes, without feedback wires).
  for (const id of CASES.filter(id => WORKFLOWS[id].media?.length)) {
    const copy = copyOf(id), byId = new Map(copy.nodes.map(node => [node.id, node]));
    const edges = copy.edges.filter(edge => edge.kind !== 'feedback');
    const fed = copy.nodes.filter(node => node.kind === 'session' && edges.some(edge => edge.toNode === node.id && isSoftMediaFeed(byId.get(edge.fromNode)!, node, edge)));
    expect(fed.length, id).toBeGreaterThan(0);
    for (const page of fed as SessionNode[]) {
      const wires = edges.filter(edge => edge.toNode === page.id && isSoftMediaFeed(byId.get(edge.fromNode)!, page, edge));
      const context = prepareNodeConversation(page, copy.nodes, edges);
      expect(context.error, `${id}/${page.title}`).toBeUndefined();
      expect(context.mediaMissing, `${id}/${page.title}`).toEqual(Object.fromEntries(wires.map(edge =>
        [edge.toPort.slice('in:'.length), (byId.get(edge.fromNode) as SessionNode).agentKind])));
      for (const edge of wires) expect(context.messagePrefix).toContain(mediaMissingText(byId.get(edge.fromNode)!));
    }
  }
  resetAllSessions();
  const copy = copyOf('neon-city');
  const page = copy.nodes.find(node => node.title === 'Full-screen brand page') as SessionNode;
  const media = copy.nodes.filter(node => copy.edges.some(edge => edge.fromNode === node.id && edge.toNode === page.id)) as SessionNode[];
  expect(media.map(node => [node.title, node.agentKind, node.lastOutput])).toEqual([['Opening shot', 'video', undefined],
    ['Rooftop garden', 'image', undefined], ['Underground night market', 'image', undefined], ['Dawn', 'image', undefined]]);
  const context = prepareNodeConversation(page, copy.nodes, copy.edges);
  for (const locale of ['en', 'zh'] as const) {
    render(<LocaleProvider locale={locale}><SessionTile node={page} scale={1} focused onToggleFocus={vi.fn()} conversationContext={context} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: canvasText(locale, 'tile.input') }));
    const form = screen.getByRole('region', { name: canvasText(locale, 'tile.inputForm') });
    for (const node of media) {
      const kind = canvasText(locale, node.agentKind === 'video' ? 'media.kindVideo' : 'media.kindImage');
      expect(within(form).getByText(canvasText(locale, 'contract.sourceMediaMissing', { source: node.title, kind }))).toBeVisible();
      expect(within(form).getByLabelText(canvasText(locale, 'contract.value', { name: `${node.title} (generated files)` }))).toHaveValue('');
    }
    expect(within(form).queryByRole('alert')).toBeNull();
    expect(form.textContent).not.toContain('没有可以引用的路径');
    if (locale === 'en') expect(form.textContent).not.toMatch(/\p{Script=Han}/u);
    cleanup();
  }
});

it('marks a recording on the collapsed card and opens a node on what it was asked, received and delivered', () => {
  resetAllSessions();
  const art = copyOf('pixel-platformer').nodes[1] as SessionNode;
  const { unmount } = render(<SessionTile node={art} compact scale={1} focused={false} onToggleFocus={vi.fn()} />);
  expect(screen.getByRole('button', { name: `打开 ${art.title}` })).toHaveTextContent(/^.*案例实录 · \/\/ 24 colours \(0–9, a–n\)\. Warm highlights; shadows lean purple\./);
  unmount();
  const { container, rerender } = render(<SessionTile node={art} scale={1} focused onToggleFocus={vi.fn()} />);
  expect(container.querySelector('.awwo-node-workbench')).toHaveClass('is-case-intro');
  expect(screen.getByRole('region', { name: '输入表单' })).toBeVisible();
  expect(within(screen.getByRole('region', { name: '交付物' })).getByText('案例实录 · Claude Opus 5.5 · 2026-10-13 真实运行')).toBeVisible();
  // The member's own result is not a recording: the node lays out as any other.
  rerender(<SessionTile node={{ ...art, lastOutput: { text: art.lastOutput!.text, at: Date.now(), source: 'run' } }} scale={1} focused onToggleFocus={vi.fn()} />);
  expect(container.querySelector('.awwo-node-workbench')).not.toHaveClass('is-case-intro');
  cleanup();
  // Once set up (it may have a conversation), the node no longer opens on its inputs.
  render(<SessionTile node={{ ...art, binding: { companyId: 'c1', agentId: 'a1', agentName: 'Agent' } }} scale={1} focused onToggleFocus={vi.fn()} />);
  expect(screen.queryByRole('region', { name: '输入表单' })).toBeNull();
});

function server() {
  const posts: { url: string; body: any }[] = [];
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/runtime')) return json({ available: true, configured: true, plannerAvailable: true, runtimes: [], models: [] });
    if (url.endsWith('/canvases') && init.method === 'POST') { const body = JSON.parse(init.body as string); posts.push({ url, body }); return json({ id: 'new-copy', document: body.document }, 201); }
    if (url.includes('/canvases?')) return json({ items: [], nextCursor: null });
    throw new Error(`Unexpected endpoint: ${url}`);
  }));
  return posts;
}
async function openCopy(name = 'Pixel platformer') {
  // The first row shows three cases; the others are one click away. The cases and the copy dialog read in English in
  // both interface languages.
  if (!screen.queryByRole('button', { name })) fireEvent.click(screen.getByRole('button', { name: /^See all \d+ cases$/ }));
  fireEvent.click(screen.getByRole('button', { name }));
  fireEvent.click(await within(screen.getByRole('dialog', { name })).findByRole('button', { name: 'Copy this canvas' }));
  return screen.getByRole('dialog', { name: 'Copy example to my canvases' });
}

it('copies a case from the workspace home with every agent’s recording, and says so in English before it does', async () => {
  const posts = server(), onOpen = vi.fn();
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  const setup = await openCopy();
  expect(setup).toHaveAttribute('lang', 'en');
  expect(within(setup).getByText(/with what every agent received and delivered in the real run on 2026-10-13 \(6\/6 nodes, marked “case recording”\)/)).toBeVisible();
  expect(within(setup).getByText(/The case recordings were made by Claude Opus 5\.5, not run in your workspace; running the graph replaces them with your own results\./)).toBeVisible();
  fireEvent.click(within(setup).getByRole('button', { name: 'Create draft' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledExactlyOnceWith('new-copy'));
  expect(posts).toHaveLength(1);
  expect(posts[0].body.name).toBe(PRODUCTION_WORKFLOWS['pixel-platformer'].title);
  const sent = posts[0].body.document.nodes;
  expect(sent).toHaveLength(6);
  expect(sent.every((node: any) => node.lastOutput?.source === 'case' && node.lastOutput.model === 'Claude Opus 5.5' && node.lastOutput.text)).toBe(true);
});

it('says the same to an English member, with no note on the language the agents worked in', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  server();
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  const setup = await openCopy();
  expect(within(setup).getByText(/with what every agent received and delivered in the real run on 2026-10-13 \(6\/6 nodes, marked “case recording”\)/)).toBeVisible();
  // A case compiled in English is copied as it is: nothing about a language follows the note on the recordings.
  expect(within(setup).getByText(/^This only creates a canvas; .* The case recordings were made by Claude Opus 5\.5, not run in your workspace; running the graph replaces them with your own results\.$/)).toBeVisible();
  expect(within(setup).queryByText(/worked in Chinese|copied in English|in Chinese, as they ran/)).toBeNull();
});

it('creates nothing when a case has no published recording, rather than an empty copy', async () => {
  const posts = server(), onOpen = vi.fn(), load = vi.mocked(loadProductionRun), actual = load.getMockImplementation()!;
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  const setup = await openCopy();
  load.mockResolvedValue(undefined);
  try {
    fireEvent.click(within(setup).getByRole('button', { name: 'Create draft' }));
    expect(await within(setup).findByText('Could not load this case’s run recording, so no canvas was created. Refresh and try again.')).toBeVisible();
    expect(posts).toHaveLength(0);
  } finally { load.mockImplementation(actual); }
});

it('creates nothing when the recording cannot be read, rather than an empty copy', async () => {
  const posts = server(), onOpen = vi.fn(), load = vi.mocked(loadProductionRun), actual = load.getMockImplementation()!;
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  const setup = await openCopy();
  load.mockRejectedValue(new Error('chunk failed'));
  try {
    fireEvent.click(within(setup).getByRole('button', { name: 'Create draft' }));
    expect(await within(setup).findByText('Could not load this case’s run recording, so no canvas was created. Refresh and try again.')).toBeVisible();
    expect(posts).toHaveLength(0);
    expect(onOpen).not.toHaveBeenCalled();
  } finally { load.mockImplementation(actual); }
});

it('copies the knowledge base from the workspace home like any case, with every agent’s recording', async () => {
  const posts = server(), onOpen = vi.fn();
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  const setup = await openCopy('Team knowledge-base SaaS');
  expect(within(setup).getByText(/^Keep all 7 nodes, dependencies and deliverable requirements, with what every agent received and delivered in the real run on 2026-10-13 \(7\/7 nodes, marked “case recording”\)\. Optionally choose one execution model for every new node\.$/)).toBeVisible();
  expect(within(setup).getByText(/^This only creates a canvas; .* The case recordings were made by Claude Opus 5\.5, not run in your workspace; running the graph replaces them with your own results\.$/)).toBeVisible();
  expect(within(setup).queryByText(/Codex|in Chinese|2026-09-04/)).toBeNull();
  fireEvent.click(within(setup).getByRole('button', { name: 'Create draft' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledExactlyOnceWith('new-copy'));
  expect(posts).toHaveLength(1);
  expect(posts[0].body.name).toBe('Team knowledge-base SaaS');
  const sent = posts[0].body.document;
  expect([sent.nodes.length, sent.edges.length]).toEqual([7, 12]);
  expect(sent.nodes.every((node: any) => node.lastOutput?.source === 'case' && node.lastOutput.model === 'Claude Opus 5.5' && node.lastOutput.text)).toBe(true);
});

it('stops the copy when a delivered node has no recording its canvas can hold, rather than copying it blank under a 6/6 claim', () => {
  const record = records.get('pixel-platformer')!, workflow = WORKFLOWS['pixel-platformer'];
  const build = workflow.nodes.find(node => node.outputType === 'html')!;
  const blank = { ...record, nodes: record.nodes.map(node => node.id === build.id ? { ...node, output: '' } : node) };
  expect(() => createProductionCopyDocument(workflow, blank, null)).toThrow(new RegExp(`${build.id} its canvas cannot hold`));
  // A delivery its contract rejects stops it too: here the page, cut off before it ends.
  const cut = { ...record, nodes: record.nodes.map(node => node.id === build.id ? { ...node, output: node.output!.slice(0, 2000) } : node) };
  expect(() => createProductionCopyDocument(workflow, cut, null)).toThrow(new RegExp(`${build.id} its canvas cannot hold`));
});


it('copies a film case from the workspace home as the canvas that ran, with nothing pre-filled, and says what its first run makes again', async () => {
  const posts = server(), onOpen = vi.fn();
  const canvas = (await import('../src/saas/production-canvases/the-long-chord')).default;
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  const setup = await openCopy(FILM_TITLE);
  expect(setup).toHaveAttribute('lang', 'en');
  expect(within(setup).getByText(/^Keep all 109 nodes and their wires with the texts and settings the real run on 2026-10-20 used: .* so its first run makes all 104 pictures, clips and sounds again before any editor runs, .* the sync sheets in the editors’ briefs and the act’s own timeline were measured on the case run’s clips, so measure and edit them again before cutting\. Optionally choose one execution model for the editor agents\.$/)).toBeVisible();
  fireEvent.click(within(setup).getByRole('button', { name: 'Create draft' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledExactlyOnceWith('new-copy'));
  expect(posts).toHaveLength(1);
  expect(posts[0].body.name).toBe(FILM_TITLE);
  const sent = posts[0].body.document;
  expect(sent.nodes.map((node: any) => node.id).sort()).toEqual(canvas.nodes.map(node => node.id).sort());
  expect(sent.edges.map((edge: any) => `${edge.fromNode}>${edge.toNode}`).sort()).toEqual(canvas.edges.map(edge => `${edge.fromNode}>${edge.toNode}`).sort());
  expect(sent.nodes.every((node: any) => node.lastOutput === null)).toBe(true);
});

it('creates nothing from a film case whose stored canvas is not the one its record pins', async () => {
  const posts = server(), onOpen = vi.fn(), load = vi.mocked(loadProductionRun), actual = load.getMockImplementation()!;
  const record = (await actual(FILM))!;
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  const setup = await openCopy(FILM_TITLE);
  load.mockResolvedValue({ ...record, canvasSHA256: '0'.repeat(64) });
  try {
    fireEvent.click(within(setup).getByRole('button', { name: 'Create draft' }));
    expect(await within(setup).findByText('Could not load this case’s run recording, so no canvas was created. Refresh and try again.')).toBeVisible();
    expect(posts).toHaveLength(0);
    expect(onOpen).not.toHaveBeenCalled();
  } finally { load.mockImplementation(actual); }
});

it('tells a media case’s copier which deliveries its first run makes again', async () => {
  server();
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  const setup = await openCopy('Neon Circuit racer');
  expect(within(setup).getByText(/^Keep all 10 nodes, dependencies and deliverable requirements, with what every agent received and delivered in the real run on 2026-10-15 \(10\/10 nodes, marked “case recording”\); the media nodes, and the steps that use the files they made, make theirs again on the first run\. Optionally choose one execution model for every new node\.$/)).toBeVisible();
});
