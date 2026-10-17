import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { ContractFields } from '../src/canvas/ContractFields';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import { parseContractOutput } from '../src/canvas/nodeContracts';
import { prepareNodeConversation } from '../src/canvas/nodeConversation';
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
const copyOf = (id: string) => createProductionCopyDocument(WORKFLOWS[id], records.get(id)!, null);
const tenant: Tenant = { id: 'copy-workspace', name: 'Copy workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const identity: Identity = { user: { id: 'copy-user', name: 'Copy user', email: 'copy@example.invalid', platformRole: 'user' }, tenants: [tenant] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeAll(async () => {
  for (const id of CASES) records.set(id, (await loadProductionRun(id))!);
  await import('../src/saas/ProductionShowcase');
}, 300_000);
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('carries every agent’s recorded delivery into its copy, as the case’s, on the very canvas that ran', () => {
  expect(CASES).toHaveLength(18);
  expect(RECORDED).toHaveLength(13);
  for (const id of RECORDED) {
    const workflow = WORKFLOWS[id], record = records.get(id)!, copy = copyOf(id);
    // Only results are added: the tasks, contracts and wires are the pinned canvas the case ran on.
    expect(canonicalCanvasText(copy)).toBe(canonicalCanvasText(createOfficialDocument(workflow)));
    copy.nodes.forEach((node, index) => {
      const recorded = record.nodes.find(value => value.id === workflow.nodes[index].id)!;
      const session = node as SessionNode;
      // A flagship's assembly makes its page file again on the copy's first run, with no model.
      if (node.kind === 'assemble') { expect(session.lastOutput, `${id}/${recorded.id}`).toBeUndefined(); return; }
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
    // What an assembly makes again on the copy's first run reaches the node it feeds then.
    const remade = new Set(copy.nodes.filter(node => node.kind === 'assemble').map(node => node.id));
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
  expect(media.sort()).toEqual(['aurora-gt', 'car-plant', 'neon-circuit', 'neon-city', 'shanhai-vn']);
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
      if (!spec || fed.has(spec.id) || names) { expect(session.lastOutput, `${id}/${session.title}`).toBeUndefined(); return; }
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


it('tells a media case’s copier which deliveries its first run makes again', async () => {
  server();
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  const setup = await openCopy('Neon Circuit racer');
  expect(within(setup).getByText(/^Keep all 10 nodes, dependencies and deliverable requirements, with what every agent received and delivered in the real run on 2026-10-15 \(10\/10 nodes, marked “case recording”\); the media nodes, and the steps that use the files they made, make theirs again on the first run\. Optionally choose one execution model for every new node\.$/)).toBeVisible();
});
