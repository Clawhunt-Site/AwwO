import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { RerunConfirm } from '../src/canvas/RerunConfirm';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { CANVAS_STORAGE_KEY, createFormNode, emptyDocument, loadDocumentWithStatus, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { resetAllSessions } from '../src/canvas/sessions';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

// A paying user's report, 2026-10-25: pressing 运行 on a canvas whose nodes had all finished but one ran every node again,
// each a paid call, each result replaced. A run of the whole canvas now asks first when it would do that.
const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const reader = async (path: string) => path === '/api/agents' ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] } : { models: ['profile-main'] };
const result = (text: string) => ({ text, at: 1, source: 'run' as const });
let posted: Array<{ scope?: string[] }>;

function bound(node: SessionNode): SessionNode {
  return { ...node, runtime: 'pi', model: 'profile-main', binding: { companyId: tenant.id, agentId: `agent-${node.id}`, agentName: node.title }, issueId: `session-${node.id}` };
}
/** The frontend feeds the review; each has its result where it is given one. */
function seed(results: { frontend?: string; review?: string }) {
  const frontend = createAgentTemplate('frontend', { x: 40, y: 40 });
  const review = createAgentTemplate('review', { x: 700, y: 40 });
  const filled = (node: SessionNode) => ({ ...node, contract: { ...node.contract!, inputs: node.contract!.inputs.map(field => ({ ...field, value: field.value || 'given' })) } });
  const doc: CanvasDocument = { ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [
    bound({ ...filled({ ...frontend, id: 'frontend', title: '3D游戏前端实现' }), ...(results.frontend ? { lastOutput: result(results.frontend) } : {}) }),
    bound({ ...filled({ ...review, id: 'review', title: '游戏验收' }), ...(results.review ? { lastOutput: result(results.review) } : {}) }),
  ], edges: [{ id: 'delivery', fromNode: 'frontend', fromPort: 'out:delivery', toNode: 'review', toPort: 'in:delivery', dataType: 'text' }] };
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
}
const graph = { id: 'graph', status: 'running', canvasId: 'canvas', documentVersion: 9, nodes: [] };

beforeEach(() => {
  cleanup(); localStorage.clear(); configureCanvasStorage('user', 'workspace', 'canvas'); resetAllSessions(); posted = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'owned' })) } });
  configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 9);
  configureSaaSCanvasInitialize(async () => loadDocumentWithStatus().doc);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/graph-runs') && init.method === 'POST') { posted.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(graph), { status: 202 }); }
    if (url.includes('/graph-runs/graph')) return new Response(JSON.stringify(graph));
    if (url.endsWith('/runtime')) return new Response(JSON.stringify({ available: true, plannerAvailable: true, plannerRuntime: 'pi' }));
    return new Response(JSON.stringify({ items: [], models: [] }));
  }));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); configureCanvasStorage('user', 'workspace', 'canvas'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const runButton = () => within(document.querySelector('.awwo-run-slot') as HTMLElement).getByRole('button', { name: /运行图/ });
const question = () => document.querySelector<HTMLDialogElement>('dialog.awwo-rerun-dialog');
const choice = (name: RegExp | string) => within(question()!).getByRole('button', { name });
async function pressRun() {
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  await waitFor(() => expect(runButton()).toBeEnabled());
  runButton().focus();
  fireEvent.click(runButton());
}

describe('a run of the whole canvas over nodes that have their result', () => {
  it('asks first, naming them, and runs only the node without a result when asked to', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    await pressRun();
    expect(question()).toHaveAttribute('open');
    expect(within(question()!).getByRole('heading')).toHaveTextContent('已经有结果的节点也要重新运行吗？');
    expect(question()!).toHaveTextContent('1 个节点已经有结果：「3D游戏前端实现」。运行整张画布会重新运行每个节点，替换现在的结果。');
    // What each choice spends is said in it, as the 接下来 card says a step's.
    expect(choice('只运行没有结果的 1 个节点（至少 1 次）')).toHaveFocus();
    expect(choice('全部重新运行（至少 2 次）')).toBeVisible();
    expect(posted).toEqual([]);
    fireEvent.click(choice(/^只运行没有结果的/));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].scope).toEqual(['review']);
    expect(question()).toBeNull();
    // The node left out keeps its result: the review is given it.
    expect(loadDocumentWithStatus().doc.nodes.find(node => node.id === 'frontend')!.lastOutput?.text).toBe('<!doctype html><title>game</title>');
  });

  it('asks when the command bar runs the canvas, and gives the focus to 运行图 after, the bar being gone', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    await waitFor(() => expect(runButton()).toBeEnabled());
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    fireEvent.click(await screen.findByTestId('cmdbar-row-run'));
    expect(question()).toHaveAttribute('open');
    expect(screen.queryByTestId('cmdbar-row-run')).toBeNull();
    fireEvent.click(choice('取消'));
    expect(runButton()).toHaveFocus();
    expect(posted).toEqual([]);
  });

  it('leaves a run of some nodes alone: 「运行剩下的」 in 接下来 starts at once', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    fireEvent.click(within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: '画布助手', exact: true }));
    const next = within(within(document.querySelector('.awwo-planner-sidebar') as HTMLElement).getByRole('group', { name: '接下来' }));
    fireEvent.click(next.getByRole('button', { name: /^运行剩下的 1 个节点/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(question()).toBeNull();
    expect(posted[0].scope).toEqual(['review']);
  });

  it('runs every node again when asked to', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    await pressRun();
    fireEvent.click(choice(/^全部重新运行/));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].scope).toEqual(['frontend', 'review']);
  });

  it('says that a node after the ones without a result runs again with them, as its input changes', async () => {
    seed({ review: '验收通过' });
    await pressRun();
    const rest = choice(/^只运行没有结果的 1 个节点/);
    expect(rest).toHaveAccessibleDescription('它们下游已有结果的 1 个节点也会一起重新运行，因为输入会变。');
    fireEvent.click(rest);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].scope).toEqual(['frontend', 'review']);
  });

  it('runs nothing when the reader cancels, by the button or Escape, and gives the focus back', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    await pressRun();
    fireEvent.click(choice('取消'));
    expect(question()).toBeNull();
    expect(runButton()).toHaveFocus();
    fireEvent.click(runButton());
    // The dialog's own cancel event is what Escape fires.
    fireEvent(question()!, new Event('cancel', { cancelable: true }));
    expect(question()).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(posted).toEqual([]);
  });

  it('offers only running it all again, the focus on not running, when every node has its result', async () => {
    seed({ frontend: '<!doctype html><title>game</title>', review: '验收通过' });
    await pressRun();
    expect(within(question()!).getByRole('heading')).toHaveTextContent('整张画布都重新运行吗？');
    expect(question()!).toHaveTextContent('所有节点都已经有结果。全部重新运行会替换这些结果；只想重做其中一个节点，可以单独运行那个节点。');
    expect(within(question()!).queryByRole('button', { name: /^只运行/ })).toBeNull();
    expect(choice('取消')).toHaveFocus();
    fireEvent.click(choice('全部重新运行（至少 2 次）'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].scope).toEqual(['frontend', 'review']);
  });

  it('asks nothing of a canvas that has not run yet', async () => {
    seed({});
    await pressRun();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(question()).toBeNull();
    expect(posted[0].scope).toEqual(['frontend', 'review']);
  });

  it('keeps the keys pressed in it from the board, and refuses an Enter still held from the press that opened it', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    await pressRun();
    const board = vi.fn();
    window.addEventListener('keydown', board);
    try {
      // A repeat of the Enter that pressed 运行 does not go on to the first choice (until another key is pressed).
      expect(fireEvent.keyDown(choice(/^只运行/), { key: 'Enter', repeat: true })).toBe(false);
      fireEvent.keyDown(choice(/^全部重新运行/), { key: 'Delete' });
      expect(board).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', board); }
    expect(loadDocumentWithStatus().doc.nodes.map(node => node.id)).toEqual(['frontend', 'review']);
    expect(posted).toEqual([]);
  });
});

// Review: a plan the assistant was making could apply while the question was open, and either answer then ran the
// canvas as it had become: more calls than it quoted.
describe('the canvas changing while the question is open', () => {
  it('asks again as things now stand, running nothing it did not quote', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    const plan = { version: 1, summary: '加一个页面', operations: [{ type: 'add_node', ref: 'page', templateId: 'general', title: '新页面',
      inputValues: { brief: '写一页说明' }, acceptanceCriteria: ['写完'] }] };
    const frames = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    let released = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith('/canvases/canvas/plan') && init.method === 'POST') return new Response(JSON.stringify({ id: 'plan-run' }), { status: 202 });
      if (url.endsWith('/runs/plan-run/events')) {
        const encoder = new TextEncoder();
        // The plan is answered only once the question is open.
        return new Response(new ReadableStream({ async start(controller) {
          controller.enqueue(encoder.encode(frames({ type: 'queued' }, { type: 'running' })));
          await held;
          controller.enqueue(encoder.encode(frames({ type: 'completed', text: JSON.stringify(plan) })));
          controller.close();
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.endsWith('/runs/plan-run')) return new Response(JSON.stringify(released
        ? { id: 'plan-run', status: 'completed', output: JSON.stringify(plan) } : { id: 'plan-run', status: 'running' }));
      return base(input as string, init);
    });
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    fireEvent.click(within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: '画布助手', exact: true }));
    const sidebar = within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);
    fireEvent.change(sidebar.getByRole('textbox', { name: '画布需求' }), { target: { value: '再加一个说明页面' } });
    await waitFor(() => expect(sidebar.getByRole('button', { name: '修改画布' })).toBeEnabled());
    fireEvent.click(sidebar.getByRole('button', { name: '修改画布' }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/runs/plan-run/events'))).toBe(true));
    await waitFor(() => expect(runButton()).toBeEnabled());
    fireEvent.click(runButton());
    expect(choice('全部重新运行（至少 2 次）')).toBeVisible();
    release();
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes.map(node => node.title)).toContain('新页面'));
    fireEvent.click(choice(/^全部重新运行/));
    expect(question()!).toHaveTextContent('画布在你确认时有了变化，下面是现在的情况。');
    expect(choice('全部重新运行（至少 3 次）')).toBeVisible();
    const rest = choice('只运行没有结果的 2 个节点（至少 2 次）');
    // Asked again, its choices take no press for a moment (RerunConfirm's pause): the reader reads the new numbers.
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(posted).toEqual([]);
    // Setting up the run binds the planned node to its Agent, as the service's initialization does.
    configureSaaSCanvasInitialize(async () => {
      const doc = loadDocumentWithStatus().doc;
      return { ...doc, nodes: doc.nodes.map(node => node.kind === 'session' && !node.binding ? bound(node) : node) };
    });
    fireEvent.click(rest);
    await waitFor(() => expect(posted).toHaveLength(1));
    const added = loadDocumentWithStatus().doc.nodes.find(node => node.title === '新页面')!.id;
    expect(posted[0].scope).toEqual(['review', added]);
  });
});

// Review: the canvas stays editable while an approved run waits for its ownership (a node added then touches none of
// the nodes the run holds), and that node ran with the canvas, unquoted.
describe('the canvas changing after the answer, while the run waits to start', () => {
  it('runs nothing it did not quote, and says to press run again', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    // The run's ownership is granted only once a node has been added.
    let grantRun!: () => void;
    const runHeld = new Promise<void>(resolve => { grantRun = resolve; });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (name: string, _options: unknown, callback: (lock: { name: string }) => unknown) => {
      if (String(name).includes('awwo.canvas.execution.v1')) await runHeld;
      return callback({ name: 'owned' });
    }) } });
    configureSaaSCanvasInitialize(async () => {
      const doc = loadDocumentWithStatus().doc;
      return { ...doc, nodes: doc.nodes.map(node => node.kind === 'session' && !node.binding ? bound(node) : node) };
    });
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    await waitFor(() => expect(runButton()).toBeEnabled());
    fireEvent.click(runButton());
    // Approved as quoted: every node again, 2 calls. The run waits for its ownership meanwhile.
    fireEvent.click(choice('全部重新运行（至少 2 次）'));
    expect(question()).toBeNull();
    // The check comes before the run's preflight, which would otherwise stop at this node's empty task (a node added
    // with its inputs filled in, from the agent library say, nothing else stops).
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    fireEvent.click(await screen.findByTestId('cmdbar-row-add-session-llm'));
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(3));
    grantRun();
    await waitFor(() => expect(document.querySelector('.awwo-handoff-note')).toHaveTextContent('画布在准备运行时有了变化，没有运行。请再按一次运行。'));
    expect(posted).toEqual([]);
  });

  // Review: the node to run got a result meanwhile (published by hand, say): same ids, same cost, yet running it would
  // have replaced a result the question never named.
  it('runs nothing that would replace a result that arrived while it was set up', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    await waitFor(() => expect(runButton()).toBeEnabled());
    fireEvent.click(runButton());
    // Setting the run up finds the review with a result now.
    configureSaaSCanvasInitialize(async () => {
      const doc = loadDocumentWithStatus().doc;
      return { ...doc, nodes: doc.nodes.map(node => node.id === 'review' ? { ...node, lastOutput: { text: '验收通过（手动发布）', at: 2, source: 'manual' as const } } : node) };
    });
    fireEvent.click(choice(/^只运行没有结果的 1 个节点/));
    // Asked again as it now stands: every node has its result.
    await waitFor(() => expect(question()).not.toBeNull());
    expect(within(question()!).getByRole('status')).toHaveTextContent('画布在你确认时有了变化，下面是现在的情况。');
    expect(within(question()!).getByRole('heading')).toHaveTextContent('整张画布都重新运行吗？');
    expect(posted).toEqual([]);
  });

  // Review: the setup itself clears a result of a node it sets up anew (moved to another runtime: node_setup.go); one
  // the whole run replaces anyway is no change, and the approved run goes on.
  it('runs on when the setup cleared a result the run replaces anyway', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    await waitFor(() => expect(runButton()).toBeEnabled());
    fireEvent.click(runButton());
    configureSaaSCanvasInitialize(async () => {
      const doc = loadDocumentWithStatus().doc;
      return { ...doc, nodes: doc.nodes.map(node => node.id === 'frontend' ? { ...node, lastOutput: null } : node) };
    });
    fireEvent.click(choice('全部重新运行（至少 2 次）'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].scope).toEqual(['frontend', 'review']);
  });

  // Review: a run that had nothing to ask held to nothing: a result published while it waited to start was cleared
  // unasked.
  it('asks after all when a result arrives while a run that had nothing to ask is set up', async () => {
    seed({});
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    await waitFor(() => expect(runButton()).toBeEnabled());
    // The review's result was published from another device while the run was set up: the setup brings it.
    configureSaaSCanvasInitialize(async () => {
      const doc = loadDocumentWithStatus().doc;
      return { ...doc, nodes: doc.nodes.map(node => node.id === 'review' ? { ...node, lastOutput: { text: '验收通过（手动发布）', at: 2, source: 'manual' as const } } : node) };
    });
    fireEvent.click(runButton());
    await waitFor(() => expect(question()).not.toBeNull());
    expect(question()!).toHaveTextContent('1 个节点已经有结果：「游戏验收」。');
    expect(posted).toEqual([]);
  });

  // Review: the setup ran (and could clear a result: a node moved to another runtime starts a new conversation) before
  // the preflight refused the run for an input nobody filled in.
  it('refuses a run its preflight refuses before setting anything up, the results left as they are', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    const doc = loadDocumentWithStatus().doc;
    const extra = { ...bound({ ...createAgentTemplate('general', { x: 40, y: 600 }), id: 'extra', title: '说明页' }) };
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...doc, nodes: [...doc.nodes, extra] }));
    const initialize = vi.fn(async () => loadDocumentWithStatus().doc);
    configureSaaSCanvasInitialize(initialize);
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    await waitFor(() => expect(runButton()).toBeEnabled());
    fireEvent.click(runButton());
    await waitFor(() => expect(document.querySelector('.awwo-handoff-note')).toHaveTextContent('说明页'));
    expect(initialize).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
    expect(loadDocumentWithStatus().doc.nodes.find(node => node.id === 'frontend')!.lastOutput?.text).toBe('<!doctype html><title>game</title>');
  });

  // Review: a node the setup would bind (no Agent yet) is taken as bound for that check, which would otherwise stop at
  // the binding and never reach its inputs.
  it('judges a node not set up yet by its inputs: refused before setup when one is missing, run when they are filled', async () => {
    for (const filled of [false, true]) {
      cleanup(); posted = [];
      seed({ frontend: '<!doctype html><title>game</title>' });
      const doc = loadDocumentWithStatus().doc;
      const template = createAgentTemplate('general', { x: 40, y: 600 });
      const extra = { ...template, id: 'extra', title: '说明页', contract: { ...template.contract!,
        inputs: template.contract!.inputs.map(field => ({ ...field, value: filled ? field.value || 'given' : '' })) } };
      canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...doc, nodes: [...doc.nodes, extra] }));
      const initialize = vi.fn(async () => {
        const current = loadDocumentWithStatus().doc;
        return { ...current, nodes: current.nodes.map(node => node.kind === 'session' && !node.binding ? bound(node) : node) };
      });
      configureSaaSCanvasInitialize(initialize);
      render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
      await waitFor(() => expect(runButton()).toBeEnabled());
      fireEvent.click(runButton());
      if (filled) {
        // The frontend has its result: asked first, then run as answered.
        fireEvent.click(choice('全部重新运行（至少 3 次）'));
        await waitFor(() => expect(posted).toHaveLength(1));
        expect(initialize).toHaveBeenCalled();
      } else {
        // Refused for its input, not for the Agent the setup would bind.
        await waitFor(() => expect(document.querySelector('.awwo-handoff-note')).toHaveTextContent('“说明页”输入未就绪'));
        expect(initialize).not.toHaveBeenCalled();
        expect(posted).toEqual([]);
      }
    }
  });

  // Review: with the media catalogue still loading the check could not judge a media node's settings; the run was
  // then refused after the setup, which can clear a result.
  it('waits for the media catalogue while it loads, for a run with a media node and a result its setup could take', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    // The workspace's media catalogue never arrives.
    vi.mocked(fetch).mockImplementation(async (input: unknown, init: RequestInit = {}) =>
      /\/media(?:\?|$)/.test(String(input)) ? new Promise<Response>(() => {}) : base(input as string, init));
    for (const { finished, input, form, outcome } of [
      { finished: true, input: 'given', form: false, outcome: 'waits' },
      // A run refused anyway says why first: that does not wait for the catalogue.
      { finished: true, input: '', form: false, outcome: 'refused' },
      // Nothing for the setup to take: it runs, and the service judges the settings.
      { finished: false, input: 'given', form: false, outcome: 'runs' },
      // A form keeps what it sent last, but is never set up: nothing for the setup to take there either.
      { finished: false, input: 'given', form: true, outcome: 'runs' },
    ] as const) {
      // As beforeEach: a case before may have left a run going.
      cleanup(); localStorage.clear(); configureCanvasStorage('user', 'workspace', 'canvas'); resetAllSessions(); posted = [];
      seed(finished ? { frontend: '<!doctype html><title>game</title>' } : {});
      const doc = loadDocumentWithStatus().doc;
      const template = createAgentTemplate('general', { x: 40, y: 600 });
      const image = { ...bound({ ...template, id: 'poster', title: '海报', contract: { ...template.contract!,
        inputs: template.contract!.inputs.map(field => ({ ...field, value: input && (field.value || input) })) } }), agentKind: 'image' as const };
      const brief = { ...createFormNode({ x: 700, y: 600 }), id: 'brief', fields: [{ id: 'f1', label: '目标', value: '一张海报' }], lastOutput: result('目标：一张海报') };
      canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...doc, nodes: [...doc.nodes, image, ...(form ? [brief] : [])] }));
      const initialize = vi.fn(async () => loadDocumentWithStatus().doc);
      configureSaaSCanvasInitialize(initialize);
      render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
      await waitFor(() => expect(runButton()).toBeEnabled());
      fireEvent.click(runButton());
      // Asked only where a result would be replaced and the run could start.
      if (outcome === 'waits') fireEvent.click(choice(/^全部重新运行/));
      else expect(question()).toBeNull();
      if (outcome === 'runs') {
        await waitFor(() => expect(posted).toHaveLength(1));
        continue;
      }
      await waitFor(() => expect(document.querySelector('.awwo-handoff-note')).toHaveTextContent(outcome === 'waits'
        ? '媒体模型还在载入，没有运行。请稍后再按一次运行。' : '“海报”输入未就绪'));
      expect(initialize).not.toHaveBeenCalled();
      expect(posted).toEqual([]);
    }
  });

  it('runs what it quoted when nothing changed meanwhile', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    let grantRun!: () => void;
    const runHeld = new Promise<void>(resolve => { grantRun = resolve; });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (name: string, _options: unknown, callback: (lock: { name: string }) => unknown) => {
      if (String(name).includes('awwo.canvas.execution.v1')) await runHeld;
      return callback({ name: 'owned' });
    }) } });
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    await waitFor(() => expect(runButton()).toBeEnabled());
    fireEvent.click(runButton());
    fireEvent.click(choice('全部重新运行（至少 2 次）'));
    grantRun();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].scope).toEqual(['frontend', 'review']);
  });
});

describe('the question itself', () => {
  const titles: Record<string, string> = { a: '需求分析', b: '页面设计', c: '前端开发', d: '验收', e: '发布' };
  const ask = (props: Partial<Parameters<typeof RerunConfirm>[0]> = {}) => render(<div className="awwo-workspace">
    <div className="awwo-run-slot"><button type="button" className="canvas-run-btn">▶ 运行图</button></div>
    <RerunConfirm choice={{ finished: ['a', 'b', 'c', 'd', 'e'], cleared: [], left: 1, whole: { scope: ['a', 'b', 'c', 'd', 'e', 'f'], calls: 6 } }} titleOf={id => titles[id]}
      withCost={(label, { calls }) => `${label}（至少 ${calls} 次）`} onRest={() => {}} onWhole={() => {}} onCancel={() => {}} {...props} />
  </div>);

  // Review: where running only what is left is not offered (a review loop, or a run this device cannot start), the
  // nodes left were said to have their result too.
  it('does not say every node has its result when one has none but only running it all is offered', () => {
    ask();
    expect(within(question()!).getByRole('heading')).toHaveTextContent('已经有结果的节点也要重新运行吗？');
    expect(question()!).toHaveTextContent('5 个节点已经有结果：「需求分析」、「页面设计」、「前端开发」，还有 2 个。运行整张画布会重新运行每个节点，替换现在的结果。');
    expect(within(question()!).queryByRole('button', { name: /^只运行/ })).toBeNull();
    expect(choice('取消')).toHaveFocus();
  });

  it('says so when the canvas changed under it', () => {
    ask({ changed: true });
    expect(within(question()!).getByRole('status')).toHaveTextContent('画布在你确认时有了变化，下面是现在的情况。');
  });

  // Review: on this device a whole run clears an edit or a file only a cloud run makes, and cannot make it again.
  it('says which results running it all here clears for good', () => {
    ask({ choice: { finished: ['a', 'e'], cleared: ['e'], left: 1, whole: { scope: ['a', 'b', 'e'], calls: 1 } } });
    expect(question()!).toHaveTextContent('其中「发布」只有云端运行才能重新生成：在这台设备上全部重新运行会清掉它们的结果。');
  });

  // Review: the Enter (held) or the press (doubled, or begun during the pause) that found the canvas changed went on to
  // accept the new question.
  it('takes a fresh answer each time it is asked again', async () => {
    const onWhole = vi.fn();
    const before = { finished: ['a'], cleared: [], left: 1, whole: { scope: ['a', 'b'], calls: 2 }, rest: { nodeIds: ['b'], scope: ['b'], after: 0, calls: 1 } };
    const now = { ...before, whole: { scope: ['a', 'b', 'c'], calls: 3 }, left: 2, rest: { nodeIds: ['b', 'c'], scope: ['b', 'c'], after: 0, calls: 2 } };
    const later = { ...now, whole: { scope: ['a', 'b', 'c', 'd'], calls: 4 }, left: 3, rest: { nodeIds: ['b', 'c', 'd'], scope: ['b', 'c', 'd'], after: 0, calls: 3 } };
    const props = { titleOf: (id: string) => titles[id] ?? id, withCost: (label: string, { calls }: { calls: number }) => `${label}（至少 ${calls} 次）`,
      onRest: () => {}, onWhole, onCancel: () => {} };
    const at = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(ms);
    // A key let go is let go after the click it ends.
    const letGo = async (key: string) => { fireEvent.keyUp(document.activeElement ?? document.body, { key }); await new Promise(resolve => setTimeout(resolve, 0)); };
    at(1_000);
    const { rerender } = render(<div className="awwo-workspace"><RerunConfirm choice={before} {...props} /></div>);
    // The Enter that opened it is let go of: its guard is off, so what follows proves the guard each re-ask arms.
    fireEvent.keyDown(choice(/^全部重新运行/), { key: 'a' });
    expect(fireEvent.keyDown(choice(/^全部重新运行/), { key: 'Enter', repeat: true })).toBe(true);
    await letGo('Enter');
    choice(/^全部重新运行/).focus();
    rerender(<div className="awwo-workspace"><RerunConfirm choice={now} changed {...props} /></div>);
    // Asked again: the focus on the safe choice, a held Enter refused, a press straight after no answer.
    expect(choice(/^只运行没有结果的 2 个节点/)).toHaveFocus();
    expect(fireEvent.keyDown(choice(/^只运行/), { key: 'Enter', repeat: true })).toBe(false);
    await letGo('Enter');
    fireEvent.click(choice('全部重新运行（至少 3 次）'));
    // A press begun in the pause and let go after it is none either; nor is a double click's second click.
    fireEvent.pointerDown(choice('全部重新运行（至少 3 次）'));
    at(2_000);
    fireEvent.click(choice('全部重新运行（至少 3 次）'));
    fireEvent.click(choice('全部重新运行（至少 3 次）'), { detail: 2 });
    expect(onWhole).not.toHaveBeenCalled();
    // A fresh press after the pause is an answer, and so is a screen reader's click, which no press comes before.
    fireEvent.pointerDown(choice('全部重新运行（至少 3 次）'));
    fireEvent.click(choice('全部重新运行（至少 3 次）'), { detail: 1 });
    fireEvent.click(choice('全部重新运行（至少 3 次）'));
    expect(onWhole).toHaveBeenCalledTimes(2);
    // Asked again while it already says the canvas changed: the same, once more.
    fireEvent.keyDown(choice(/^全部重新运行/), { key: 'a' });
    choice(/^全部重新运行/).focus();
    rerender(<div className="awwo-workspace"><RerunConfirm choice={later} changed {...props} /></div>);
    expect(choice(/^只运行没有结果的 3 个节点/)).toHaveFocus();
    expect(fireEvent.keyDown(choice(/^只运行/), { key: 'Enter', repeat: true })).toBe(false);
    await letGo('Enter');
    fireEvent.click(choice('全部重新运行（至少 4 次）'));
    expect(onWhole).toHaveBeenCalledTimes(2);
  });

  // Review: an Enter pressed in the pause and held through it went on, by its repeats, to accept the new question.
  it('takes no answer from an Enter pressed in the pause until it is let go', async () => {
    const onRest = vi.fn();
    const before = { finished: ['a'], cleared: [], left: 1, whole: { scope: ['a', 'b'], calls: 2 }, rest: { nodeIds: ['b'], scope: ['b'], after: 0, calls: 1 } };
    const now = { ...before, whole: { scope: ['a', 'b', 'c'], calls: 3 }, left: 2, rest: { nodeIds: ['b', 'c'], scope: ['b', 'c'], after: 0, calls: 2 } };
    const props = { titleOf: (id: string) => titles[id] ?? id, withCost: (label: string, { calls }: { calls: number }) => `${label}（至少 ${calls} 次）`,
      onRest, onWhole: () => {}, onCancel: () => {} };
    const at = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(ms);
    at(1_000);
    const { rerender } = render(<div className="awwo-workspace"><RerunConfirm choice={before} {...props} /></div>);
    rerender(<div className="awwo-workspace"><RerunConfirm choice={now} changed {...props} /></div>);
    const rest = () => choice(/^只运行没有结果的 2 个节点/);
    // Pressed in the pause: its click is none, and nor is a repeat's after the pause, while it is held.
    at(1_100);
    fireEvent.keyDown(rest(), { key: 'Enter' });
    fireEvent.click(rest());
    at(1_800);
    fireEvent.keyDown(rest(), { key: 'Enter', repeat: true });
    fireEvent.click(rest());
    expect(onRest).not.toHaveBeenCalled();
    // Let go, then pressed afresh: an answer.
    fireEvent.keyUp(rest(), { key: 'Enter' });
    await new Promise(resolve => setTimeout(resolve, 0));
    at(1_900);
    fireEvent.keyDown(rest(), { key: 'Enter' });
    fireEvent.click(rest());
    expect(onRest).toHaveBeenCalledTimes(1);
  });

  // Review: Enter and Space held in the pause, Space let go: the Enter still held went on to accept; and an Enter let go
  // in another window left its press standing, so no later press counted.
  it('holds each key apart, and lets every press go when the window loses the focus', async () => {
    const onRest = vi.fn();
    const before = { finished: ['a'], cleared: [], left: 1, whole: { scope: ['a', 'b'], calls: 2 }, rest: { nodeIds: ['b'], scope: ['b'], after: 0, calls: 1 } };
    const now = { ...before, whole: { scope: ['a', 'b', 'c'], calls: 3 }, left: 2, rest: { nodeIds: ['b', 'c'], scope: ['b', 'c'], after: 0, calls: 2 } };
    const props = { titleOf: (id: string) => titles[id] ?? id, withCost: (label: string, { calls }: { calls: number }) => `${label}（至少 ${calls} 次）`,
      onRest, onWhole: () => {}, onCancel: () => {} };
    const at = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(ms);
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    at(1_000);
    const { rerender } = render(<div className="awwo-workspace"><RerunConfirm choice={before} {...props} /></div>);
    rerender(<div className="awwo-workspace"><RerunConfirm choice={now} changed {...props} /></div>);
    const rest = () => choice(/^只运行没有结果的 2 个节点/);
    at(1_100);
    fireEvent.keyDown(rest(), { key: 'Enter' });
    fireEvent.keyDown(rest(), { key: ' ' });
    at(1_800);
    fireEvent.keyUp(rest(), { key: ' ' });
    await settle();
    fireEvent.click(rest());
    expect(onRest).not.toHaveBeenCalled();
    // Enter let go elsewhere: the window lost the focus first, so a fresh press counts.
    fireEvent.blur(window);
    fireEvent.pointerDown(rest());
    fireEvent.click(rest(), { detail: 1 });
    expect(onRest).toHaveBeenCalledTimes(1);
  });

  // Review: the focus goes back to 运行图 (■ 停止 once the run starts) as it closes; an Enter that answered or cancelled,
  // still held, pressed it there.
  it('refuses the repeats of the Enter that answered it or cancelled it, once the focus is back on 运行图', async () => {
    const choiceShown = { finished: ['a'], cleared: [], left: 1, whole: { scope: ['a', 'b'], calls: 2 }, rest: { nodeIds: ['b'], scope: ['b'], after: 0, calls: 1 } };
    // As the canvas hosts it: closed on an answer or a cancel, the focus going back to what opened it.
    function Host({ onRun }: { onRun: () => void }) {
      const [open, setOpen] = useState(false);
      return <div className="awwo-workspace">
        <div className="awwo-run-slot"><button type="button" className="canvas-run-btn" onClick={() => { if (open) return; onRun(); setOpen(true); }}>▶ 运行图</button></div>
        {open && <RerunConfirm choice={choiceShown} titleOf={id => titles[id] ?? id} withCost={label => label}
          onRest={() => setOpen(false)} onWhole={() => setOpen(false)} onCancel={() => setOpen(false)} />}
      </div>;
    }
    for (const pick of [/^只运行/, /^取消$/]) {
      cleanup();
      const onRun = vi.fn();
      render(<Host onRun={onRun} />);
      const run = screen.getByRole('button', { name: '▶ 运行图' });
      run.focus();
      fireEvent.click(run);
      // Released from the opening guard first, so what follows is the guard the answer arms.
      fireEvent.keyDown(choice(pick), { key: 'a' });
      fireEvent.keyDown(choice(pick), { key: 'Enter' });
      fireEvent.click(choice(pick), { detail: 0 });
      expect(question()).toBeNull();
      expect(run).toHaveFocus();
      expect(fireEvent.keyDown(run, { key: 'Enter', repeat: true })).toBe(false);
      fireEvent.keyUp(run, { key: 'Enter' });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(onRun).toHaveBeenCalledTimes(1);
    }
  });

  // The page's own guard stands aside for another dialog opened over it (a sign-in, say): its field keeps the focus
  // and its keys.
  it('leaves another open dialog its focus and its keys', () => {
    ask();
    const other = document.createElement('dialog');
    other.setAttribute('open', '');
    const field = document.createElement('input');
    const typed = vi.fn();
    field.addEventListener('keydown', typed);
    other.append(field);
    document.body.append(other);
    try {
      field.focus();
      expect(field).toHaveFocus();
      fireEvent.keyDown(field, { key: 'a' });
      expect(typed).toHaveBeenCalledTimes(1);
    } finally { other.remove(); }
  });

  // Chrome 155, checked against the local stack: Tab past the last choice handed the focus to the page's body, where
  // Delete reached the board's shortcuts behind the question.
  it('keeps Tab going round its choices, and a key aimed at the page from the board', () => {
    ask({ choice: { finished: ['a'], cleared: [], left: 1, whole: { scope: ['a', 'b'], calls: 2 }, rest: { nodeIds: ['b'], scope: ['b'], after: 0, calls: 1 } } });
    choice('取消').focus();
    fireEvent.keyDown(choice('取消'), { key: 'Tab' });
    expect(choice(/^只运行/)).toHaveFocus();
    fireEvent.keyDown(choice(/^只运行/), { key: 'Tab', shiftKey: true });
    expect(choice('取消')).toHaveFocus();
    const board = vi.fn();
    window.addEventListener('keydown', board);
    try { fireEvent.keyDown(document.body, { key: 'Delete' }); } finally { window.removeEventListener('keydown', board); }
    expect(board).not.toHaveBeenCalled();
  });

  // Review: the command bar closes as its command runs, so the control that opened the question is gone when it closes.
  it('gives the focus to the canvas’s run button when what opened it is gone', () => {
    const opener = document.createElement('input');
    document.body.append(opener);
    opener.focus();
    const { rerender } = ask();
    opener.remove();
    rerender(<div className="awwo-workspace"><div className="awwo-run-slot"><button type="button" className="canvas-run-btn">▶ 运行图</button></div></div>);
    expect(question()).toBeNull();
    expect(screen.getByRole('button', { name: '▶ 运行图' })).toHaveFocus();
  });
});

describe('「运行」 said to the assistant', () => {
  it('asks the same question, and its reply says so instead of saying the run started', async () => {
    seed({ frontend: '<!doctype html><title>game</title>' });
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
    fireEvent.click(within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: '画布助手', exact: true }));
    const sidebar = within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);
    fireEvent.change(sidebar.getByRole('textbox', { name: '画布需求' }), { target: { value: '运行' } });
    await waitFor(() => expect(sidebar.getByRole('button', { name: '修改画布' })).toBeEnabled());
    fireEvent.click(sidebar.getByRole('button', { name: '修改画布' }));
    const log = within(sidebar.getByRole('log', { name: '画布对话' }));
    await waitFor(() => expect(log.getByText('画布上 1 个节点已经有结果：请选择只运行没有结果的节点，还是全部重新运行。')).toBeVisible());
    expect(log.queryByText(/开始运行整张画布/)).toBeNull();
    expect(posted).toEqual([]);
    fireEvent.click(choice(/^只运行没有结果的/));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].scope).toEqual(['review']);
  });
});
