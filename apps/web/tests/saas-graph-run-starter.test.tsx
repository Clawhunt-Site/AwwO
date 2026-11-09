// Who started a canvas run, in the run history (GraphRunPanel.tsx): its starter is named, and Stop is offered as the server
// allows it (runs.go stopsOthersRuns): to its starter and to the workspace's owners and admins; to anyone else it is
// held, saying who may stop it. Every id and name here is made up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, getDefaultNormalizer, render, screen, waitFor } from '@testing-library/react';
import { createSessionNode, emptyDocument } from '../src/canvas/canvasDoc';
import { GraphRunPanel, mayStopRun } from '../src/saas/GraphRunPanel';
import type { GraphRunSnapshot } from '../src/saas/graphRuns';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { graphRunSummary } from './saas-graph-run-summary-fixture';

const base = '/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const run = (startedBy: GraphRunSnapshot['startedBy']): GraphRunSnapshot => ({
  id: 'graph-a', operationId: 'operation-a', canvasId: 'canvas-a', documentVersion: 3, scope: ['a'], status: 'running', createdAt: '2026-11-08T03:04:05Z',
  document: { ...emptyDocument(), nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'a', title: 'Research' }] },
  nodes: [{ nodeId: 'a', state: 'running', runId: 'run-a', output: '' }], startedBy,
});

function serve(graph: GraphRunSnapshot, viewer: { id: string; role: string }) {
  const fetch = vi.fn(async (url: string) => {
    if (url === base) return json({ items: [graphRunSummary(graph)] });
    if (url.startsWith(`${base}/${graph.id}`)) return json(graph);
    if (url.endsWith('/auth/me')) return json({ user: { id: viewer.id, name: 'Viewer', email: 'viewer@example.test', platformRole: 'user' },
      tenants: [{ id: 'tenant-a', name: 'Team', role: viewer.role, status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }] });
    return json({ items: [] });
  });
  vi.stubGlobal('fetch', fetch);
  render(<SaaSPreferencesProvider><GraphRunPanel tenantId="tenant-a" canvasId="canvas-a" /></SaaSPreferencesProvider>);
  return fetch;
}
const open = async (name: RegExp) => { fireEvent.click(await screen.findByRole('button', { name })); };

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('who started a canvas run', () => {
  it('names the starter, and holds Stop for another member, saying who may stop it', async () => {
    serve(run({ id: 'user-bea', name: 'Bea' }), { id: 'user-cy', role: 'member' });
    await open(/运行记录/);
    expect(await screen.findByText('由 Bea 启动')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '停止整个任务' })).toBeDisabled());
    expect(screen.getByText('只有 Bea 或工作区的所有者、管理员能停止它。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止整个任务' })).toHaveAccessibleDescription('只有 Bea 或工作区的所有者、管理员能停止它。');
  });

  it('judges as the server does who may stop a run', () => {
    const bea = { startedBy: { id: 'user-bea', name: 'Bea' } };
    expect(mayStopRun(bea, { id: 'user-bea', role: 'member' })).toBe(true);
    expect(mayStopRun(bea, { id: 'user-cy', role: 'admin' })).toBe(true);
    expect(mayStopRun(bea, { id: 'user-cy', role: 'owner' })).toBe(true);
    expect(mayStopRun(bea, { id: 'user-cy', role: 'member' })).toBe(false);
    expect(mayStopRun({ startedBy: null }, { id: 'user-cy', role: 'member' })).toBe(false);
    expect(mayStopRun({ startedBy: null }, { id: 'user-cy', role: 'admin' })).toBe(true);
  });

  it('offers Stop to the starter and to an owner or admin once it knows who is looking', async () => {
    // Another member is in the same list: their Stop is held once the account is read, so the wait below is long
    // enough for the others' to be judged too, not merely still unjudged.
    for (const [viewer, offered] of [[{ id: 'user-bea', role: 'member' }, true], [{ id: 'user-cy', role: 'admin' }, true],
      [{ id: 'user-cy', role: 'owner' }, true], [{ id: 'user-cy', role: 'member' }, false]] as const) {
      const fetch = serve(run({ id: 'user-bea', name: 'Bea' }), viewer);
      await open(/运行记录/);
      await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/auth/me'))).toBe(true));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
      const stop = screen.getByRole('button', { name: '停止整个任务' });
      if (offered) expect(stop).toBeEnabled(); else expect(stop).toBeDisabled();
      expect(screen.queryByText(/只有 Bea 或工作区的所有者、管理员能停止它/) === null).toBe(offered);
      cleanup(); vi.unstubAllGlobals();
    }
  });

  it('says who may stop a run whose starter has no name', async () => {
    serve(run({ id: 'user-bea', name: '' }), { id: 'user-cy', role: 'member' });
    await open(/运行记录/);
    expect(await screen.findByText('由工作区里的一个人启动')).toBeInTheDocument();
    expect(await screen.findByText('只有启动它的人或工作区的所有者、管理员能停止它。')).toBeInTheDocument();
  });

  // The server names by nothing a starter whose account is linked to ClawHunt with no name kept yet; a name is taken as
  // the canvas's people list takes one, trimmed.
  it('trims the starter\'s name, and takes one of only spaces for none', async () => {
    serve(run({ id: 'user-bea', name: ' Bea ' }), { id: 'user-cy', role: 'member' });
    await open(/运行记录/);
    // Matched exactly: the default matcher trims and collapses spaces, so an untrimmed name would pass it.
    const exact = { normalizer: getDefaultNormalizer({ trim: false, collapseWhitespace: false }) };
    expect(await screen.findByText('由 Bea 启动', exact)).toBeInTheDocument();
    expect(await screen.findByText('只有 Bea 或工作区的所有者、管理员能停止它。', exact)).toBeInTheDocument();
    cleanup(); vi.unstubAllGlobals();
    serve(run({ id: 'user-bea', name: '   ' }), { id: 'user-cy', role: 'member' });
    await open(/运行记录/);
    expect(await screen.findByText('由工作区里的一个人启动')).toBeInTheDocument();
    expect(await screen.findByText('只有启动它的人或工作区的所有者、管理员能停止它。')).toBeInTheDocument();
  });

  it('keeps a run with no starter recorded to owners and admins', async () => {
    serve(run(null), { id: 'user-cy', role: 'member' });
    await open(/运行记录/);
    expect(await screen.findByText('只有工作区的所有者或管理员能停止这次运行。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止整个任务' })).toBeDisabled();
  });

  it('leaves Stop to the server for a run from a server that names no starter', async () => {
    serve(run(undefined), { id: 'user-cy', role: 'member' });
    await open(/运行记录/);
    expect(await screen.findByRole('button', { name: '停止整个任务' })).toBeEnabled();
    expect(mayStopRun({ startedBy: undefined }, { id: 'user-cy', role: 'member' })).toBe(true);
    expect(mayStopRun({ startedBy: { id: 'user-bea', name: 'Bea' } }, null)).toBe(true);
  });

  it('renders in English', async () => {
    localStorage.setItem('superclaw_locale', 'en');
    serve(run({ id: 'user-bea', name: 'Bea' }), { id: 'user-cy', role: 'member' });
    await open(/Run history/);
    expect(await screen.findByText('Started by Bea')).toBeInTheDocument();
    expect(await screen.findByText('Only Bea or a workspace owner or admin can stop it.')).toBeInTheDocument();
  });
});
