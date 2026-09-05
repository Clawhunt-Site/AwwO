import { describe, expect, it, vi } from 'vitest';
import { HttpUpstreamCompanyReader, MAX_MATCH_COMPANIES, deriveCapability } from './upstream-reader.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('deriveCapability', () => {
  it('counts staffable agents (active/idle/running/error) and excludes paused/pending/terminated', () => {
    const cap = deriveCapability({ id: 'co-1', name: 'Acme' }, [
      { role: 'ceo', title: 'CEO', status: 'active' },
      { role: 'general', title: 'Backend Engineer', status: 'idle' }, // healthy default → staffable
      { role: 'general', title: 'Frontend Dev', status: 'running' }, // busy but invokable
      { role: 'general', title: 'Ops', status: 'error' }, // errored but still invokable per upstream
      { role: 'general', title: 'QA 测试', status: 'paused' }, // NOT staffable
      { role: 'general', title: 'Reviewer', status: 'pending_approval' }, // NOT staffable
      { role: 'general', title: 'gone', status: 'terminated' }, // NOT staffable
    ]);
    expect(cap.availableAgents).toBe(4); // ceo(active) + backend(idle) + frontend(running) + ops(error)
    expect(cap.strengths.sort()).toEqual(['implement', 'plan']); // ceo→plan, engineers/ops→implement
    expect(cap.strengths).not.toContain('verify'); // paused QA confers no coverage
    expect(cap.strengths).not.toContain('review'); // pending reviewer confers no coverage
  });

  it('an agent with no status defaults to idle (staffable)', () => {
    const cap = deriveCapability({ id: 'c', name: 'C' }, [{ role: 'general', title: 'Engineer' }]);
    expect(cap.availableAgents).toBe(1);
    expect(cap.strengths).toEqual(['implement']);
  });

  it('a non-array / empty roster yields no capability', () => {
    expect(deriveCapability({ id: 'c', name: 'C' }, null)).toEqual({
      companyId: 'c',
      companyName: 'C',
      strengths: [],
      availableAgents: 0,
    });
    expect(deriveCapability({ id: 'c', name: 'C' }, []).strengths).toEqual([]);
  });
});

describe('HttpUpstreamCompanyReader', () => {
  it('reads companies + agents and excludes archived AND paused companies (paused cannot start work)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/companies')) {
        return jsonResponse([
          { id: 'co-1', name: 'Acme', status: 'active' },
          { id: 'co-dead', name: 'Gone', status: 'archived' },
          { id: 'co-pause', name: 'Paused', status: 'paused' },
        ]);
      }
      if (u.includes('/api/companies/co-1/agents')) {
        return jsonResponse([{ role: 'ceo', title: 'CEO', status: 'idle' }]);
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;
    const reader = new HttpUpstreamCompanyReader('http://127.0.0.1:3100', { fetchImpl });
    const { capabilities, unreadableCompanies } = await reader.readCompanyCapabilities();
    expect(capabilities.map((c) => c.companyId)).toEqual(['co-1']); // archived + paused dropped
    expect(capabilities[0]!.strengths).toEqual(['plan']);
    expect(unreadableCompanies).toEqual([]);
  });

  it('a failed agents fetch records the company as unreadable (NOT a fake empty capability)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/companies')) {
        return jsonResponse([
          { id: 'co-1', name: 'Acme' },
          { id: 'co-2', name: 'Beta' },
        ]);
      }
      if (u.includes('/api/companies/co-2/agents')) return jsonResponse([{ role: 'ceo', title: 'CEO', status: 'idle' }]);
      return jsonResponse({ error: 'nope' }, false, 500); // co-1 roster fails
    }) as unknown as typeof fetch;
    const reader = new HttpUpstreamCompanyReader('http://127.0.0.1:3100', { fetchImpl });
    const { capabilities, unreadableCompanies } = await reader.readCompanyCapabilities();
    expect(capabilities.map((c) => c.companyId)).toEqual(['co-2']); // co-1 excluded, not empty-capped
    expect(unreadableCompanies).toEqual(['co-1']); // surfaced honestly
  });

  it('throws when /companies itself is unreadable (route maps to 502)', async () => {
    const down = vi.fn(async () => jsonResponse('x', false, 503)) as unknown as typeof fetch;
    await expect(new HttpUpstreamCompanyReader('http://127.0.0.1:3100', { fetchImpl: down }).readCompanyCapabilities()).rejects.toThrow();
    const nonArray = vi.fn(async () => jsonResponse({ not: 'array' })) as unknown as typeof fetch;
    await expect(
      new HttpUpstreamCompanyReader('http://127.0.0.1:3100', { fetchImpl: nonArray }).readCompanyCapabilities(),
    ).rejects.toThrow();
  });

  it('dedupes duplicate company ids and caps the company count', async () => {
    const many = Array.from({ length: MAX_MATCH_COMPANIES + 5 }, (_, i) => ({ id: `co-${i}`, name: `C${i}` }));
    many.push({ id: 'co-0', name: 'dup' }); // duplicate of the first
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/companies')) return jsonResponse(many);
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    const reader = new HttpUpstreamCompanyReader('http://127.0.0.1:3100', { fetchImpl });
    const { capabilities } = await reader.readCompanyCapabilities();
    expect(capabilities).toHaveLength(MAX_MATCH_COMPANIES);
    expect(new Set(capabilities.map((c) => c.companyId)).size).toBe(MAX_MATCH_COMPANIES); // no dup
  });
});
