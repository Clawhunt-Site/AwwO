import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type CanvasDocument, type CanvasEdge,
  type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { canvasText, LocaleProvider, type CanvasTextKey } from '../src/canvas/i18n';
import type { ContractField } from '../src/canvas/nodeContracts';
import { loadRunJournal } from '../src/canvas/runJournal';
import { resetAllSessions } from '../src/canvas/sessions';
import { runErrorText } from '../src/saas/canvasErrors';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

// The Next card on a hosted canvas whose free trial is over (free_plan_ended): the node it stopped is said so in plain
// words, the plans are offered as for today's allowance, and never the default model, which runs no more than any other
// until the workspace's owner subscribes. A cloud run's node records the refusal's code; a node's own Send its copy, in
// the language of the page that sent it (canvasBridge.ts): both are known.
type Locale = 'zh' | 'en';
const text = (locale: Locale, key: CanvasTextKey, values?: Record<string, string | number>) => canvasText(locale, key, values);
const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const reader = async (path: string) => path === '/api/agents' ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] } : { models: ['profile-main'] };
let detail = 'free_plan_ended';
let posted = 0;
const graph = (status: string) => ({ id: 'graph', operationId: loadRunJournal()?.id, status, canvasId: 'canvas', documentVersion: 9,
  nodes: ['brief', 'draft'].map(nodeId => ({ nodeId, threadId: 'default', agentId: `agent-${nodeId}`, sessionId: `session-${nodeId}`,
    ...(status === 'running' ? { state: 'waiting' } : nodeId === 'brief' ? { state: 'failed', detail } : { state: 'blocked', detail: 'Upstream did not complete' }) })) });

const field = (id: string, patch: Partial<ContractField> = {}): ContractField => ({ id, label: id, type: 'markdown', required: true, value: '', ...patch });
const agent = (id: string, x: number, inputs: string[]): SessionNode => ({ ...createSessionNode('llm', { x, y: 40 }), id, title: id, runtime: 'pi', model: 'profile-main',
  binding: { companyId: tenant.id, agentId: `agent-${id}`, agentName: id }, issueId: `session-${id}`,
  contract: { version: 1, inputs: [field('brief', { value: 'Do it' }), ...inputs.map(name => field(name))], outputs: [field('result')] } });
const wire: CanvasEdge = { id: 'brief->draft.in:spec', fromNode: 'brief', fromPort: 'out:result', toNode: 'draft', toPort: 'in:spec', dataType: 'text' };
function seed() {
  const doc: CanvasDocument = { ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, nodes: [agent('brief', 40, []), agent('draft', 640, ['spec'])], edges: [wire] };
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
}

function open(locale: Locale) {
  render(<LocaleProvider locale={locale}><CanvasSurface storageMode="cloud" runtimeReadJson={reader} /></LocaleProvider>);
  fireEvent.click(within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: text(locale, 'workspace.assistant'), exact: true }));
  const sidebar = within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);
  const next = () => within(sidebar.getByRole('group', { name: text(locale, 'assistant.nextTitle') }));
  // The canvas has not run: its card runs it, and the run comes back refused.
  fireEvent.click(next().getByRole('button', { name: new RegExp(`^${text(locale, 'assistant.nextRunAll')}`) }));
  return next;
}

beforeEach(() => {
  cleanup(); localStorage.clear(); configureCanvasStorage('user', 'workspace', 'canvas'); resetAllSessions(); detail = 'free_plan_ended'; posted = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'owned' })) } });
  configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 9);
  configureSaaSCanvasInitialize(async () => loadDocumentWithStatus().doc);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/graph-runs') && init.method === 'POST') { posted += 1; return new Response(JSON.stringify(graph('running')), { status: 202 }); }
    if (url.includes('/graph-runs/graph')) return new Response(JSON.stringify(graph('failed')));
    if (url.endsWith('/runtime')) return new Response(JSON.stringify({ available: true, plannerAvailable: true, plannerRuntime: 'pi' }));
    if (url.endsWith('/upgrade-interest')) return new Response(JSON.stringify({ recorded: true, clicks: 1 }));
    return new Response(JSON.stringify({ items: [], models: [] }));
  }));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); configureCanvasStorage('user', 'workspace', 'canvas'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the Next card after the free trial’s end', () => {
  it.each([
    ['en', () => 'free_plan_ended', '“brief” did not run: the free trial has ended. Once the workspace owner subscribes to Pro, Max or Ultra, planning and runs work again; your canvases and results are all still here.'],
    // A node's own Send records the refusal's copy, here in the other language from the reader's.
    ['zh', () => runErrorText('free_plan_ended', 'en')!, '「brief」没能运行：免费试用已结束。工作区所有者订阅 Pro、Max 或 Ultra 后，就能继续规划和运行，画布和成果都还在。'],
  ] as const)('says the trial is over and offers the plans, never the default model (%s)', async (locale, recorded, lead) => {
    seed();
    detail = recorded();
    const next = open(locale);
    await waitFor(() => expect(next().getByText(lead)).toBeVisible());
    const upgrade = next().getByRole('link', { name: text(locale, 'assistant.nextUpgrade') });
    expect(upgrade).toHaveAttribute('href', '/?account=plans');
    expect(upgrade).toHaveClass('is-primary');
    expect(next().queryByRole('button', { name: text(locale, 'assistant.nextSwitchModel') })).toBeNull();
    // Not the day's allowance: the calls coming back tomorrow would not lift it.
    expect(next().queryByText(text(locale, 'assistant.nextLeadQuota', { node: 'brief' }))).toBeNull();
    expect(posted).toBe(1);
  });
});
