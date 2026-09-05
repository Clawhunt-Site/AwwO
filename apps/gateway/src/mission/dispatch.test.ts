import { describe, expect, it, vi } from 'vitest';
import { pickAgentForRole, fetchAndPickAgent } from './agent-picker.js';
import { dispatchTrack, type DispatchTrackDeps } from './dispatch.js';

const roster = [
  { id: 'ag-eng', name: 'Milo', role: 'general', title: '主工程官', status: 'idle' }, // implement
  { id: 'ag-qa', name: 'Nova', role: 'general', title: '质检官', status: 'active' }, // verify
  { id: 'ag-paused', name: 'Zed', role: 'general', title: '验证官', status: 'paused' }, // verify but unavailable
];

describe('pickAgentForRole', () => {
  it('prefers an available agent whose mapped role matches', () => {
    expect(pickAgentForRole(roster, 'verify')).toMatchObject({ agentId: 'ag-qa', roleMatch: true });
    expect(pickAgentForRole(roster, 'implement')).toMatchObject({ agentId: 'ag-eng', roleMatch: true });
  });
  it('falls back to the first available agent (roleMatch=false) when no role fits', () => {
    expect(pickAgentForRole(roster, 'explore')).toMatchObject({ agentId: 'ag-eng', roleMatch: false });
  });
  it('skips paused/pending_approval/terminated; null when none staffable', () => {
    expect(pickAgentForRole([{ id: 'x', name: 'X', status: 'paused' }], 'verify')).toBeNull();
    expect(pickAgentForRole([{ id: 'y', name: 'Y', status: 'pending_approval' }], 'implement')).toBeNull();
    expect(pickAgentForRole([], 'implement')).toBeNull();
    expect(pickAgentForRole('nope', 'implement')).toBeNull();
  });
});

describe('fetchAndPickAgent', () => {
  it('reads /companies/:id/agents and picks', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).toBe('http://up/api/companies/co-B/agents');
      return { ok: true, status: 200, json: async () => roster } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await fetchAndPickAgent('http://up', 'co-B', 'verify', { fetchImpl })).toMatchObject({ kind: 'picked', agent: { agentId: 'ag-qa' } });
  });
  it('read OK but nobody staffable → empty_roster (a real fact, not unknown)', async () => {
    const emptyFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response) as unknown as typeof fetch;
    expect(await fetchAndPickAgent('http://up', 'co-B', 'verify', { fetchImpl: emptyFetch })).toEqual({ kind: 'empty_roster' });
  });
  it('non-2xx / throw / malformed → roster_unreadable (unknown, not "no agent")', async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch;
    expect(await fetchAndPickAgent('http://up', 'co-B', 'verify', { fetchImpl: bad })).toEqual({ kind: 'roster_unreadable' });
    const thrower = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await fetchAndPickAgent('http://up', 'co-B', 'verify', { fetchImpl: thrower })).toEqual({ kind: 'roster_unreadable' });
    const malformed = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ oops: true }) }) as unknown as Response) as unknown as typeof fetch;
    expect(await fetchAndPickAgent('http://up', 'co-B', 'verify', { fetchImpl: malformed })).toEqual({ kind: 'roster_unreadable' });
  });
});

function fakeDispatcher(result: any) {
  return { dispatch: vi.fn(async () => result) };
}

describe('dispatchTrack', () => {
  const base = 'http://up';
  const rosterFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => roster }) as unknown as Response) as unknown as typeof fetch;

  it('auto-picks the agent then dispatches → dispatched', async () => {
    const dispatcher = fakeDispatcher({ status: 'dispatched', issueId: 'iss-1', agentId: 'ag-qa', run: { runId: 'r-1' } });
    const deps: DispatchTrackDeps = { dispatcher, upstreamBaseUrl: base, fetchImpl: rosterFetch };
    const r = await dispatchTrack(deps, { companyId: 'co-B', role: 'verify', task: '验证登录流程' });
    expect(r).toMatchObject({ status: 'dispatched', companyId: 'co-B', agent: { id: 'ag-qa', name: 'Nova', roleMatch: true }, issueId: 'iss-1', runId: 'r-1' });
    // dispatched to the resolved agent with the task as the message
    expect(dispatcher.dispatch).toHaveBeenCalledWith({ companyId: 'co-B', agentId: 'ag-qa', message: '验证登录流程', title: undefined });
  });

  it('operator override skips the picker and dispatches to that agent', async () => {
    const dispatcher = fakeDispatcher({ status: 'queued', issueId: 'iss-2', agentId: 'ag-x', detail: 'delivered' });
    const spyFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => roster }) as unknown as Response) as unknown as typeof fetch;
    const r = await dispatchTrack({ dispatcher, upstreamBaseUrl: base, fetchImpl: spyFetch }, { companyId: 'co-B', role: 'verify', task: 'x', agentId: 'ag-x', agentName: 'Xander' });
    expect(r).toMatchObject({ status: 'queued', agent: { id: 'ag-x', name: 'Xander', roleMatch: false } });
    expect(spyFetch).not.toHaveBeenCalled(); // no roster read when overridden
  });

  it('empty roster → no_agent reason=empty_roster (fact about the company, nothing dispatched)', async () => {
    const emptyFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response) as unknown as typeof fetch;
    const dispatcher = fakeDispatcher({ status: 'dispatched', issueId: 'x', agentId: 'x', run: { runId: 'x' } });
    const r = await dispatchTrack({ dispatcher, upstreamBaseUrl: base, fetchImpl: emptyFetch }, { companyId: 'co-B', role: 'verify', task: 'x' });
    expect(r).toMatchObject({ status: 'no_agent', reason: 'empty_roster' });
    expect(dispatcher.dispatch).not.toHaveBeenCalled(); // never dispatched
  });

  it('roster unreadable → no_agent reason=roster_unreadable (unknown, not a fabricated dispatch)', async () => {
    const badFetch = vi.fn(async () => ({ ok: false, status: 502 }) as unknown as Response) as unknown as typeof fetch;
    const dispatcher = fakeDispatcher({ status: 'dispatched' });
    const r = await dispatchTrack({ dispatcher, upstreamBaseUrl: base, fetchImpl: badFetch }, { companyId: 'co-B', role: 'verify', task: 'x' });
    expect(r).toMatchObject({ status: 'no_agent', reason: 'roster_unreadable' });
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('empty task / companyId → error', async () => {
    const deps = { dispatcher: fakeDispatcher({}), upstreamBaseUrl: base, fetchImpl: rosterFetch };
    expect((await dispatchTrack(deps, { companyId: 'co-B', role: 'verify', task: '   ' })).status).toBe('error');
    expect((await dispatchTrack(deps, { companyId: '', role: 'verify', task: 'x' })).status).toBe('error');
  });

  it('dispatcher error → error (honest, never fake-delegated)', async () => {
    const dispatcher = fakeDispatcher({ status: 'error', detail: 'create issue failed (upstream 403)' });
    const r = await dispatchTrack({ dispatcher, upstreamBaseUrl: base, fetchImpl: rosterFetch }, { companyId: 'co-B', role: 'verify', task: 'x' });
    expect(r).toEqual({ status: 'error', detail: 'create issue failed (upstream 403)' });
  });
});
