import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildHireBody,
  hireAgentIntoCompany,
  missionRoleToAgentRole,
} from '../src/canvasHire';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}
afterEach(() => vi.unstubAllGlobals());

describe('missionRoleToAgentRole', () => {
  it('maps the five mission roles to AGENT_ROLES buckets', () => {
    expect(missionRoleToAgentRole('explore')).toBe('researcher');
    expect(missionRoleToAgentRole('plan')).toBe('pm');
    expect(missionRoleToAgentRole('implement')).toBe('engineer');
    expect(missionRoleToAgentRole('verify')).toBe('qa');
    expect(missionRoleToAgentRole('review')).toBe('general');
  });
  it('falls back to general for an unknown role', () => {
    expect(missionRoleToAgentRole('bogus')).toBe('general');
  });
});

describe('buildHireBody', () => {
  it('puts model/effort under adapterConfig (NOT top-level), maps role, uses title=name', () => {
    const body = buildHireBody({
      name: '验证官',
      missionRole: 'verify',
      adapterType: 'claude_local',
      model: 'claude-opus-4-8',
      effort: 'high',
    });
    expect(body).toEqual({
      name: '验证官',
      role: 'qa',
      title: '验证官',
      adapterType: 'claude_local',
      adapterConfig: { model: 'claude-opus-4-8', effort: 'high' },
      runtimeConfig: { heartbeat: { enabled: false } },
    });
  });
  it('omits adapterConfig entirely when model+effort are blank (use runtime defaults)', () => {
    const body = buildHireBody({ name: 'X', missionRole: 'implement', adapterType: 'gemini_local', model: '  ', effort: '' });
    expect(body).not.toHaveProperty('adapterConfig');
    expect(body).toMatchObject({ name: 'X', role: 'engineer', adapterType: 'gemini_local' });
  });
  it('maps explicit Codex effort to its native reasoning field while disabling both server bypass aliases', () => {
    const safeguards = {
      dangerouslyBypassApprovalsAndSandbox: false,
      dangerouslyBypassSandbox: false,
      extraArgs: ['--sandbox', 'workspace-write'],
    };
    expect(buildHireBody({ name: 'X', missionRole: 'plan', adapterType: 'codex_local', model: 'gpt-5.5', effort: '' }).adapterConfig).toEqual({ ...safeguards, model: 'gpt-5.5' });
    expect(buildHireBody({ name: 'X', missionRole: 'plan', adapterType: 'codex_local', model: '', effort: ' high ' }).adapterConfig).toEqual({ ...safeguards, modelReasoningEffort: 'high' });
  });
  it('keeps other runtimes on their existing effort field', () => {
    for (const adapterType of ['claude_local', 'opencode_local']) {
      const body = buildHireBody({ name: 'X', missionRole: 'plan', adapterType, model: '', effort: ' high ' });
      expect(body.adapterConfig).toEqual({ effort: 'high' });
    }
  });
  it('keeps Codex guarded even when the runtime chooses its own model and effort', () => {
    const body = buildHireBody({ name: 'X', missionRole: 'plan', adapterType: 'codex_local', model: ' ', effort: '' });
    expect(body.adapterConfig).toEqual({
      dangerouslyBypassApprovalsAndSandbox: false,
      dangerouslyBypassSandbox: false,
      extraArgs: ['--sandbox', 'workspace-write'],
    });
  });
  it('disables only scheduled heartbeats and leaves requested graph/conversation wakes available', () => {
    for (const adapterType of ['codex_local', 'claude_local', 'gemini_local']) {
      const body = buildHireBody({ name: 'X', missionRole: 'plan', adapterType, model: '', effort: '' });
      expect(body.runtimeConfig).toEqual({ heartbeat: { enabled: false } });
      expect(body.runtimeConfig).not.toHaveProperty('heartbeat.wakeOnDemand');
    }
  });
});

describe('hireAgentIntoCompany — guards + tri-state', () => {
  const spec = { name: '验证官', missionRole: 'verify', adapterType: 'claude_local', model: '', effort: '' };

  it('rejects empty name / no runtime / disallowed base WITHOUT sending', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await hireAgentIntoCompany('/paperclip-api', 'co', { ...spec, name: ' ' })).outcome).toBe('rejected');
    expect((await hireAgentIntoCompany('/paperclip-api', 'co', { ...spec, adapterType: '' })).outcome).toBe('rejected');
    expect((await hireAgentIntoCompany('https://evil.example.com/api', 'co', spec)).outcome).toBe('rejected');
    expect((await hireAgentIntoCompany('//evil/api', 'co', spec)).outcome).toBe('rejected');
    expect((await hireAgentIntoCompany('http://127.evil.com/api', 'co', spec)).outcome).toBe('rejected');
    expect(f).not.toHaveBeenCalled();
  });

  it('created: 2xx with agent id + status (idle or pending_approval)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ agent: { id: 'ag-1', status: 'idle' }, approval: null }, true, 201)));
    expect(await hireAgentIntoCompany('/paperclip-api', 'co', spec)).toEqual({ outcome: 'created', agentId: 'ag-1', status: 'idle' });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ agent: { id: 'ag-2', status: 'pending_approval' }, approval: { id: 'ap' } }, true, 201)));
    expect(await hireAgentIntoCompany('/paperclip-api', 'co', spec)).toEqual({ outcome: 'created', agentId: 'ag-2', status: 'pending_approval' });
  });

  it('4xx {400,401,403,422} → rejected; 404/409/5xx/network/2xx-no-id → unknown', async () => {
    for (const s of [400, 401, 403, 422]) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'no' }, false, s)));
      expect((await hireAgentIntoCompany('/paperclip-api', 'co', spec)).outcome).toBe('rejected');
    }
    for (const s of [404, 409, 500, 503]) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: '?' }, false, s)));
      expect((await hireAgentIntoCompany('/paperclip-api', 'co', spec)).outcome).toBe('unknown');
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect((await hireAgentIntoCompany('/paperclip-api', 'co', spec)).outcome).toBe('unknown');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ agent: { status: 'idle' } }, true, 201))); // no id
    expect((await hireAgentIntoCompany('/paperclip-api', 'co', spec)).outcome).toBe('unknown');
  });

  it('real loopback HTTP round-trip: POSTs the hire body to /companies/:id/agent-hires', async () => {
    const received: Array<{ url?: string; body: unknown }> = [];
    const server = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          received.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ agent: { id: 'ag-real', status: 'idle' }, approval: null }));
        });
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const r = await hireAgentIntoCompany(`http://127.0.0.1:${port}/api`, 'co-x', {
        name: '实现工程师', missionRole: 'implement', adapterType: 'claude_local', model: 'claude-opus-4-8', effort: 'high',
      });
      expect(r).toEqual({ outcome: 'created', agentId: 'ag-real', status: 'idle' });
      expect(received[0]!.url).toBe('/api/companies/co-x/agent-hires');
      expect(received[0]!.body).toEqual({
        name: '实现工程师', role: 'engineer', title: '实现工程师', adapterType: 'claude_local',
        adapterConfig: { model: 'claude-opus-4-8', effort: 'high' },
        runtimeConfig: { heartbeat: { enabled: false } },
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
