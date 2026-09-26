import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type CanvasDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { resetAllSessions } from '../src/canvas/sessions';
import { loadRunJournal } from '../src/canvas/runJournal';
import { ContractFields } from '../src/canvas/ContractFields';

const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
beforeEach(() => {
  localStorage.clear(); resetAllSessions(); configureCanvasStorage('online-user', tenant.id, 'online-canvas');
  configureSaaSCanvas({ tenant, canvasId: 'online-canvas' }); configureSaaSCanvasSave(async () => 1);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'owned' })) } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], models: [] }))));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function graph(): CanvasDocument {
  return { ...emptyDocument(), nodes: ['author', 'reviewer'].map((id, index) => ({
    ...createSessionNode('llm', { x: index * 500, y: 50 }), id, title: id,
  })) };
}

it.each(['review', 'feedback'] as const)('preserves imported native %s data and refuses SaaS dispatch before initialization', async kind => {
  const doc = graph();
  if (kind === 'review') doc.execution = { mode: 'review', maxRounds: 3, reviewerNodeId: 'reviewer', verdictFieldId: 'approved' };
  if (kind === 'feedback') doc.edges = [{ id: 'feedback', fromNode: 'reviewer', fromPort: 'result', toNode: 'author', toPort: 'context', dataType: 'text', kind: 'feedback' }];
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  const initialize = vi.fn(async () => doc); configureSaaSCanvasInitialize(initialize);
  render(<CanvasSurface storageMode="cloud" />);
  expect(screen.queryByRole('combobox', { name: '协作模式' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /运行图|开始互审/ }));
  await screen.findByText(/支持框选组件后互审优化/);
  expect(initialize).not.toHaveBeenCalled();
  expect(loadRunJournal()).toBeNull();
  expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  const saved = loadDocumentWithStatus().doc;
  expect(saved.execution).toEqual(doc.execution);
  expect(saved.edges).toEqual(doc.edges);
});

it('retains native review settings for readers while disabling mutations', async () => {
  clearSaaSCanvas(); const doc = graph();
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  render(<CanvasSurface readOnly />);
  await waitFor(() => expect(screen.getByRole('option', { name: '互审 Graph' }).closest('select')).toBeDisabled());
  expect(loadDocumentWithStatus().doc.execution).toBeUndefined();
});

it('ignores a hosted execution reason in a local canvas', () => {
  clearSaaSCanvas();
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(graph()));
  render(<CanvasSurface storageMode="local" executionUnavailableReason="Hosted engine unavailable" />);
  expect(screen.getByRole('button', { name: /运行图/ })).toBeEnabled();
  expect(screen.queryByText('Hosted engine unavailable')).toBeNull();
});

it('checks the canonical initialization response before recording or submitting a cloud graph', async () => {
  const doc = graph(); canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  const initialize = vi.fn(async () => ({ ...doc, execution: { mode: 'review' as const, maxRounds: 3, reviewerNodeId: 'reviewer', verdictFieldId: 'approved' } }));
  configureSaaSCanvasInitialize(initialize); render(<CanvasSurface storageMode="cloud" />);
  fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
  await screen.findByText(/支持框选组件后互审优化/);
  expect(initialize).toHaveBeenCalledOnce(); expect(loadRunJournal()).toBeNull();
  expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});

it('offers HTML output contracts in SaaS and preserves the existing source', () => {
  const text = { id: 'body', label: 'Body', type: 'text' as const, value: 'saved', required: false };
  const onChange = vi.fn(); const view = render(<ContractFields fields={[text]} onChange={onChange} label="Output" />);
  expect(screen.getByRole('option', { name: /HTML/ })).toBeEnabled();
  fireEvent.change(screen.getByRole('combobox', { name: /Body/ }), { target: { value: 'html' } });
  expect(onChange).toHaveBeenCalledWith([{ ...text, type: 'html' }]); onChange.mockClear();
  view.rerender(<ContractFields fields={[{ ...text, type: 'html', value: '<!doctype html><html><head></head><body>Saved</body></html>' }]} onChange={onChange} label="Output" />);
  expect(screen.getByRole('option', { name: /HTML/ })).toBeEnabled();
  expect(screen.getByDisplayValue(/<!doctype html>/)).toBeInTheDocument(); expect(onChange).not.toHaveBeenCalled();
});
