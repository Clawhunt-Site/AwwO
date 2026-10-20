import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createAssembleNode, createSessionNode, emptyDocument, loadDocumentWithStatus, type AssembleNode, type CanvasDocument,
  type CanvasEdge, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { canvasText, LocaleProvider, type CanvasTextKey } from '../src/canvas/i18n';
import type { ContractField } from '../src/canvas/nodeContracts';
import { loadRunJournal } from '../src/canvas/runJournal';
import { resetAllSessions } from '../src/canvas/sessions';
import { runErrorText } from '../src/saas/canvasErrors';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

// A copied case on a hosted canvas, in English as it was seen live (PALLWARD, 2026-10-20): the copy carries its Agents'
// text deliveries, and none of its files. Its picture, its 3D model, the Agent that reads the model's files, the page it
// assembles and the test of it have no result, and the Next card says so and runs them all.
const en = (key: CanvasTextKey, values?: Record<string, string | number>) => canvasText('en', key, values);
const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const reader = async (path: string) => path === '/api/agents' ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] } : { models: ['profile-main'] };
const toggle = () => within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: en('workspace.assistant'), exact: true });
const sidebar = () => within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);
const next = () => within(sidebar().getByRole('group', { name: en('assistant.nextTitle') }));
const LEFT = ['concept', 'model', 'assets', 'page', 'test'];
let posted: Array<{ scope?: string[] }>;
// How the run the card started comes back: still going, or over with the picture refused by today's allowance (the code a
// cloud run's node records, graph_media.go) and what needed it blocked.
let outcome: 'running' | 'refused';
let refusal = 'media_quota_exceeded';
const graph = (status: string) => ({ id: 'graph', operationId: loadRunJournal()?.id, status, canvasId: 'canvas', documentVersion: 9,
  nodes: [...LEFT, 'publish'].map(nodeId => ({ nodeId, threadId: 'default', agentId: `agent-${nodeId}`, sessionId: `session-${nodeId}`,
    ...(status === 'running' ? { state: 'waiting' } : nodeId === 'concept' ? { state: 'failed', detail: refusal }
      : { state: 'blocked', detail: 'Upstream did not complete' }) })) });

const field = (id: string, patch: Partial<ContractField> = {}): ContractField => ({ id, label: id, type: 'markdown', required: true, value: '', ...patch });
const delivery = { text: '{"result":"case delivery"}', at: 1, source: 'case' as const };
function bound(node: SessionNode): SessionNode {
  return { ...node, runtime: 'pi', model: node.model || 'profile-main', binding: { companyId: tenant.id, agentId: `agent-${node.id}`, agentName: node.title }, issueId: `session-${node.id}` };
}
const agent = (id: string, x: number, inputs: string[], patch: Partial<SessionNode> = {}) => bound({ ...createSessionNode('llm', { x, y: 40 }), id, title: id,
  contract: { version: 1, inputs: [field('brief', { value: 'Do it' }), ...inputs.map(name => field(name))], outputs: [field('result')] }, ...patch });
const media = (kind: 'image' | 'model3d', id: string, x: number) => bound({ ...createSessionNode(kind, { x, y: 600 }), id, title: id, model: `${kind}-model` });
const wire = (from: string, fromPort: string, to: string, toPort: string): CanvasEdge =>
  ({ id: `${from}->${to}.${toPort}`, fromNode: from, fromPort, toNode: to, toPort, dataType: 'text' });
function seed() {
  const page: AssembleNode = { ...createAssembleNode({ x: 2400, y: 40 }), id: 'page', title: 'page', template: '{{in:code}}{{in:assets}}',
    contract: { version: 1, inputs: [field('code', { type: 'text' }), field('assets', { type: 'text' })], outputs: [field('result', { type: 'html' })] } };
  const doc: CanvasDocument = { ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [
    agent('spec', 40, [], { lastOutput: delivery }), agent('code', 640, ['spec'], { lastOutput: delivery }), media('image', 'concept', 40), media('model3d', 'model', 640),
    agent('assets', 1240, ['spec', 'models']), page, agent('test', 3000, ['page']), agent('publish', 3600, ['test'], { lastOutput: delivery }),
  ], edges: [wire('spec', 'out:result', 'code', 'in:spec'), wire('spec', 'out:result', 'assets', 'in:spec'), wire('concept', 'result', 'model', 'reference'),
    wire('model', 'result', 'assets', 'in:models'), wire('code', 'out:result', 'page', 'in:code'), wire('assets', 'out:result', 'page', 'in:assets'),
    wire('page', 'out:result', 'test', 'in:page'), wire('test', 'out:result', 'publish', 'in:test')] };
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
}

beforeEach(() => {
  cleanup(); localStorage.clear(); configureCanvasStorage('user', 'workspace', 'canvas'); resetAllSessions(); posted = []; outcome = 'running'; refusal = 'media_quota_exceeded';
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'owned' })) } });
  configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 9);
  configureSaaSCanvasInitialize(async () => loadDocumentWithStatus().doc);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/graph-runs') && init.method === 'POST') { posted.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(graph('running')), { status: 202 }); }
    if (url.includes('/graph-runs/graph')) return new Response(JSON.stringify(graph(outcome === 'refused' ? 'failed' : 'running')));
    if (url.endsWith('/runtime')) return new Response(JSON.stringify({ available: true, plannerAvailable: true, plannerRuntime: 'pi' }));
    return new Response(JSON.stringify({ items: [], models: [] }));
  }));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); configureCanvasStorage('user', 'workspace', 'canvas'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the Next card on a copied case, on a hosted canvas', () => {
  it('counts the media and assemble nodes left with the Agents, says what a run of them spends, and runs them all', async () => {
    seed();
    render(<LocaleProvider locale="en"><CanvasSurface storageMode="cloud" runtimeReadJson={reader} /></LocaleProvider>);
    fireEvent.click(toggle());
    // Five nodes, not the two Agents among them; two of them generate files.
    expect(next().getByText('5 node(s) have no result yet, 2 of them media node(s): a run generates their files, one generation each, '
      + 'from today’s allowance or the plan’s credits.')).toBeVisible();
    const run = next().getByRole('button', { name: 'Run the 5 node(s) left (2 generation(s), at least 3 call(s))' });
    expect(run).toHaveClass('is-primary');
    fireEvent.click(run);
    // The run starts from every node without a result, the picture and the model included, and runs the step they feed;
    // the spec and the code hand on the deliveries they came with.
    await waitFor(() => expect(posted.map(body => body.scope)).toEqual([[...LEFT, 'publish']]));
  });

  it('sends a picture refused by today’s allowance to the plans, and does not run it again when told it failed', async () => {
    seed();
    outcome = 'refused';
    render(<LocaleProvider locale="en"><CanvasSurface storageMode="cloud" runtimeReadJson={reader} /></LocaleProvider>);
    fireEvent.click(toggle());
    fireEvent.click(next().getByRole('button', { name: /^Run the 5 node\(s\) left/ }));
    // Why, in the refusal's own words, which say what lifts it.
    await waitFor(() => expect(next().getByText('“concept” did not run: This workspace has used today’s image and video generations. '
      + 'Try again after the next UTC day; for more, see the Pro and Max plans (account menu → Plans and credits).')).toBeVisible());
    expect(next().getByRole('link', { name: en('assistant.nextUpgrade') })).toBeVisible();
    // Running it again today would be refused the same way, while what it feeds spent its calls: a message about the
    // failure is answered, and nothing runs.
    const box = sidebar().getByRole('textbox', { name: en('assistant.input') });
    fireEvent.change(box, { target: { value: 'it failed, fix it' } });
    const send = () => sidebar().getByRole('button', { name: en('assistant.modify') });
    await waitFor(() => expect(send()).toBeEnabled());
    fireEvent.click(send());
    const log = within(sidebar().getByRole('log', { name: en('assistant.conversation') }));
    await waitFor(() => expect(log.getByText('it failed, fix it')).toBeVisible());
    expect(log.getByText(/^“concept” did not run: This workspace has used today’s image and video generations\..* Suggested next: Upgrade to Pro or Max\./)).toBeVisible();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(posted).toHaveLength(1);
  });

  it('says so when a paid plan’s credits ran out on the way, without the default model a picture cannot use', async () => {
    seed();
    outcome = 'refused'; refusal = 'credits_exhausted';
    render(<LocaleProvider locale="en"><CanvasSurface storageMode="cloud" runtimeReadJson={reader} /></LocaleProvider>);
    fireEvent.click(toggle());
    fireEvent.click(next().getByRole('button', { name: /^Run the 5 node\(s\) left/ }));
    // An Agent would be told to switch to the default model, which spends no credits (canvasErrors); a picture has none.
    await waitFor(() => expect(next().getByText(`“concept” did not run: ${en('assistant.creditsUsedUpMedia')}`)).toBeVisible());
    expect(runErrorText('credits_exhausted', 'en')).toMatch(/Switch the node to the default model/);
    expect(next().queryByText(/Switch the node to the default model/)).toBeNull();
    expect(next().getByRole('link', { name: en('assistant.nextUpgrade') })).toBeVisible();
    expect(next().queryByRole('button', { name: en('assistant.nextSwitchModel') })).toBeNull();
  });
});
