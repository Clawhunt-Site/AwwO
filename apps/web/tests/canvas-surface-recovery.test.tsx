import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument } from '../src/canvas/canvasDoc';
import { CANVAS_RUN_JOURNAL_KEY, type CanvasRunJournal } from '../src/canvas/runJournal';
import { runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { resetAllSessions } from '../src/canvas/sessions';

afterEach(() => { cleanup(); localStorage.clear(); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('does not let an older recovery response undo a confirmed Stop', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const nodes = ['a', 'b'].map(id => ({
    ...createSessionNode('llm', { x: 0, y: 0 }), id, title: id, runtime: 'codex_local',
    binding: { companyId: 'company', agentId: `agent-${id}`, agentName: id }, issueId: `issue-${id}`,
  }));
  const doc = { ...emptyDocument(), nodes };
  const journal: CanvasRunJournal = {
    version: 1, id: 'recovery-race', startedAt: Date.now(), scope: ['a', 'b'], inputFingerprint: runInputFingerprint(doc, ['a', 'b']),
    nodes: Object.fromEntries(nodes.map(n => [n.id, {
      nodeId: n.id, threadId: 'default', companyId: 'company', agentId: n.binding.agentId,
      issueId: n.issueId, runId: n.id === 'a' ? 'run-a' : null, state: 'running' as const,
    }])),
  };
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  localStorage.setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify(journal));
  let resolveRun!: (value: unknown) => void;
  const read = new Promise(resolve => { resolveRun = resolve; });
  const fetchMock = vi.fn((url: unknown) => {
    if (String(url).endsWith('/runs/run-a')) return read;
    if (String(url).endsWith('/cancel')) return Promise.resolve({ ok: true, json: async () => ({ confirmed: true, cancelled: true, status: 'cancelled' }) });
    return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<CanvasSurface />);
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/runs/run-a'))).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /停止/ }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(true));
  resolveRun({ ok: true, json: async () => ({ runId: 'run-a', status: 'running', terminal: false, output: '' }) });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(CANVAS_RUN_JOURNAL_KEY)!).nodes.b.state).toBe('cancelled'));
  expect(JSON.parse(localStorage.getItem(CANVAS_RUN_JOURNAL_KEY)!).nodes.b.state).toBe('cancelled');
});

it.each(['external-stop', 'new-run'] as const)('preserves %s written by another tab before its storage event arrives', async scenario => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const nodes = ['a', 'b'].map(id => ({
    ...createSessionNode('llm', { x: 0, y: 0 }), id, title: id, runtime: 'codex_local',
    binding: { companyId: 'company', agentId: `agent-${id}`, agentName: id }, issueId: `issue-${id}`,
  }));
  const doc = { ...emptyDocument(), nodes };
  const journal: CanvasRunJournal = {
    version: 1, id: 'j1', startedAt: Date.now(), scope: ['a', 'b'], inputFingerprint: runInputFingerprint(doc, ['a', 'b']),
    nodes: Object.fromEntries(nodes.map(n => [n.id, {
      nodeId: n.id, threadId: 'default', companyId: 'company', agentId: n.binding.agentId,
      issueId: n.issueId, runId: n.id === 'a' ? 'run-a' : null, state: 'running' as const,
    }])),
  };
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  localStorage.setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify(journal));
  let resolveRead!: (value: unknown) => void;
  let resolveStop!: (value: unknown) => void;
  const read = new Promise(resolve => { resolveRead = resolve; });
  const stop = new Promise(resolve => { resolveStop = resolve; });
  const fetchMock = vi.fn((url: unknown) => {
    if (String(url).endsWith('/runs/run-a')) return read;
    if (String(url).endsWith('/cancel')) return stop;
    return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<CanvasSurface />);
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/runs/run-a'))).toBe(true));
  if (scenario === 'new-run') fireEvent.click(screen.getByRole('button', { name: /停止/ }));
  const external = scenario === 'external-stop'
    ? { ...journal, nodes: { ...journal.nodes, b: { ...journal.nodes.b, state: 'cancelled', detail: 'cancelled' } } }
    : { ...journal, id: 'j2', nodes: { ...journal.nodes, b: { ...journal.nodes.b, operationId: 'new-operation', state: 'running' } } };
  const bytes = JSON.stringify(external);
  // Intentionally no StorageEvent: another tab's durable write is visible before delivery.
  localStorage.setItem(CANVAS_RUN_JOURNAL_KEY, bytes);
  resolveRead({ ok: true, json: async () => ({ runId: 'run-a', status: 'running', terminal: false, output: '' }) });
  resolveStop({ ok: true, json: async () => ({ confirmed: true, cancelled: true, status: 'cancelled' }) });
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(localStorage.getItem(CANVAS_RUN_JOURNAL_KEY)).toBe(bytes);
});
