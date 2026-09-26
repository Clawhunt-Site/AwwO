import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import type { CanvasAssistantProps } from '../src/canvas/CanvasAssistant';
import type { requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { configureCanvasStorage } from '../src/canvas/canvasStorage';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

// Force onSend independently of the presentational button so the host's last guard is exercised.
vi.mock('../src/canvas/CanvasAssistant', () => ({
  CanvasAssistant: ({ draft, onDraftChange, onSend, submitDisabled, error }: CanvasAssistantProps) => <div>
    <textarea aria-label="Planner draft" value={draft} onChange={event => onDraftChange(event.target.value)} />
    <button type="button" disabled={submitDisabled} onClick={onSend}>Planner submit</button>
    <button type="button" onClick={onSend}>Bypass planner button</button>
    {error && <p role="alert">{error}</p>}
  </div>,
}));

const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  localStorage.clear();
  configureCanvasStorage('planner-user', tenant.id, 'planner-canvas');
  configureSaaSCanvas({ tenant, canvasId: 'planner-canvas' });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).endsWith('/runtime')
    ? reply({ available: true, plannerAvailable: true, plannerRuntime: 'pi' }) : reply({ items: [], models: [] })));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('refuses a hidden planner send without a personal engine and keeps the draft', () => {
  const planRequest = vi.fn<typeof requestCanvasPlan>();
  const reason = '先连接你的执行引擎。';
  render(<CanvasSurface storageMode="cloud" executionUnavailableReason={reason} planRequest={planRequest} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Planner draft' }), { target: { value: '保留这个编排草稿' } });
  expect(screen.getByRole('button', { name: 'Planner submit' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Bypass planner button' }));
  expect(screen.getByRole('textbox', { name: 'Planner draft' })).toHaveValue('保留这个编排草稿');
  expect(screen.getByRole('alert')).toHaveTextContent(reason);
  expect(planRequest).not.toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('also refuses a hidden Pi planner send after the cloud planner explicitly reports unavailable', async () => {
  vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/runtime')
    ? reply({ available: true, plannerAvailable: false, reason: 'Fixture planner unavailable' })
    : reply({ items: [], models: [] }));
  const planRequest = vi.fn<typeof requestCanvasPlan>();
  render(<CanvasSurface storageMode="cloud" planRequest={planRequest} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Planner draft' }), { target: { value: '稍后再执行的方案' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Planner submit' })).toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Bypass planner button' }));
  expect(screen.getByRole('textbox', { name: 'Planner draft' })).toHaveValue('稍后再执行的方案');
  expect(screen.getByRole('alert')).toHaveTextContent('Fixture planner unavailable');
  expect(planRequest).not.toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
