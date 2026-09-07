import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasPlanRevision, type CanvasPlan } from '../src/canvas/canvasPlan';
import { resetAllSessions } from '../src/canvas/sessions';

const execute = vi.fn(async (node: SessionNode) => ({ ok: true,
  output: JSON.stringify(Object.fromEntries((node.contract?.outputs ?? []).map(field => [field.id, `Result from ${node.title}`]))) }));
const hire = vi.fn();
vi.mock('../src/canvas/runTransport', () => ({ createGatewayExecutor: () => execute }));
vi.mock('../src/canvasHire', async original => ({
  ...await original<typeof import('../src/canvasHire')>(),
  hireAgentIntoCompany: (...args: unknown[]) => hire(...args),
}));

beforeEach(() => {
  cleanup(); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks(); execute.mockClear(); hire.mockReset();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => new Response(JSON.stringify(
    String(input).endsWith('/companies') ? [{ id: 'company', name: 'Test workspace' }] : {},
  ), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => { cleanup(); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const plan: CanvasPlan = { version: 1, summary: 'Two connected agents', operations: [
  { type: 'add_node', ref: 'a', templateId: 'general', title: 'A', persona: '', inputValues: { brief: 'Produce the upstream result' } },
  { type: 'add_node', ref: 'b', templateId: 'general', title: 'B', persona: '' },
  { type: 'connect', fromNode: 'a', fromField: 'result', toNode: 'b', toField: 'brief' },
] };
const runtimeReadJson = async (path: string) => path === '/api/agents'
  ? { agents: [{ name: 'pi', supports_model_selection: true }] }
  : { models: ['fixture-model'] };

async function bind(title: string) {
  fireEvent.click(screen.getByRole('button', { name: `打开 ${title}`, exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '配置', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Runtime', exact: true }));
  fireEvent.click(screen.getByRole('option', { name: 'pi', exact: true }));
  hire.mockResolvedValueOnce({ outcome: 'created', agentId: `agent-${title}`, status: 'idle' });
  fireEvent.click(await screen.findByRole('button', { name: '绑定并创建真实 Agent' }));
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes.find(node => node.title === title))
    .toMatchObject({ binding: { agentId: `agent-${title}` } }));
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
}

describe('canvas run entry document freshness', () => {
  it('runs a newly planned graph on the first click after binding and saving in the same page', async () => {
    render(<CanvasSurface runtimeReadJson={runtimeReadJson} planRequest={async () => plan} />);
    fireEvent.change(screen.getByRole('textbox', { name: '画布需求' }), { target: { value: 'Create A then B' } });
    fireEvent.click(screen.getByRole('button', { name: '生成画布', exact: true }));
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
    await bind('A');
    await bind('B');
    // The same-page save writes factory-created nodes without lastOutput, while loading the
    // exact same bytes supplies null. That representation change is not another tab's edit.
    const raw = JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!);
    expect(raw.nodes.every((node: SessionNode) => node.lastOutput === undefined)).toBe(true);
    expect(loadDocumentWithStatus().doc.nodes.every(node => node.lastOutput === null)).toBe(true);
    expect(loadDocumentWithStatus().doc.nodes).toEqual(raw.nodes.map((node: SessionNode) => ({ ...node, lastOutput: null })));
    expect(canvasPlanRevision(raw)).not.toBe(canvasPlanRevision(loadDocumentWithStatus().doc));
    fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/画布已在其他标签页更新/)).toBeNull();
    expect(execute.mock.calls.map(([node]) => node.title)).toEqual(['A', 'B']);
  });

  it('still stops before dispatch when another tab changes the persisted graph', async () => {
    const node = { ...createSessionNode('llm', { x: 0, y: 0 }), title: 'Original', runtime: 'pi',
      binding: { companyId: 'company', agentId: 'agent', agentName: 'Original' } };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node] }));
    render(<CanvasSurface />);
    const otherTab = loadDocumentWithStatus().doc;
    otherTab.nodes[0].title = 'Changed in another tab';
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(otherTab));
    fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('画布已在其他标签页更新');
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '打开 Changed in another tab', exact: true })).toBeTruthy();
  });
});
