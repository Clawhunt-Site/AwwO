import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createMissionRouter, parseMissionRequest } from './routes.js';
import type { UpstreamCompanyReader } from './upstream-reader.js';
import type { CompanyCapability } from './types.js';

const TOKEN = 'test-token';

function fakeReader(
  caps: CompanyCapability[] | Error,
  unreadableCompanies: string[] = [],
): UpstreamCompanyReader {
  return {
    readCompanyCapabilities: async () => {
      if (caps instanceof Error) throw caps;
      return { capabilities: caps, unreadableCompanies };
    },
  };
}

// Boot the router on a loopback express app; return base URL + closer. Real HTTP
// over loopback so the loopback/token gate is genuinely exercised (no subprocess).
async function serve(reader: UpstreamCompanyReader): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/api', express.json(), createMissionRouter({ reader, controlToken: TOKEN }));
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe('parseMissionRequest', () => {
  it('requires a non-empty prompt and defaults topology to linear', () => {
    expect(parseMissionRequest({ prompt: '  build a thing ' })).toEqual({ prompt: 'build a thing', topology: 'linear' });
    expect(() => parseMissionRequest({ prompt: '   ' })).toThrow(/prompt is required/);
    expect(() => parseMissionRequest({})).toThrow(/prompt is required/);
  });
  it('rejects an unknown topology', () => {
    expect(() => parseMissionRequest({ prompt: 'x', topology: 'nope' })).toThrow(/topology must be one of/);
    expect(parseMissionRequest({ prompt: 'x', topology: 'review_consensus' }).topology).toBe('review_consensus');
  });
  it('rejects an over-long prompt', () => {
    expect(() => parseMissionRequest({ prompt: 'a'.repeat(8001) })).toThrow(/exceeds/);
  });
});

describe('POST /api/missions/plan', () => {
  it('constructor refuses an empty control token', () => {
    expect(() => createMissionRouter({ reader: fakeReader([]), controlToken: '' })).toThrow(/controlToken/);
  });

  it('401 without the control token', async () => {
    const { base, close } = await serve(fakeReader([]));
    try {
      const res = await fetch(`${base}/api/missions/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'x' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('plans + matches against real companies with a valid token', async () => {
    const caps: CompanyCapability[] = [
      { companyId: 'co-a', companyName: 'A', strengths: ['explore', 'plan', 'implement', 'verify', 'review'], availableAgents: 5 },
    ];
    const { base, close } = await serve(fakeReader(caps));
    try {
      const res = await fetch(`${base}/api/missions/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-superclaw-gateway-token': TOKEN },
        body: JSON.stringify({ prompt: '给结算服务加对账', topology: 'linear' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        fullyMatched: boolean;
        matches: { companyId: string | null }[];
        unmatchedRoles: string[];
        plan: { tracks: unknown[] };
      };
      expect(body.fullyMatched).toBe(true);
      expect(body.unmatchedRoles).toEqual([]);
      expect(body.matches.every((m) => m.companyId === 'co-a')).toBe(true);
      expect(body.plan.tracks).toHaveLength(5);
    } finally {
      await close();
    }
  });

  it('400 on a bad request body', async () => {
    const { base, close } = await serve(fakeReader([]));
    try {
      const res = await fetch(`${base}/api/missions/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-superclaw-gateway-token': TOKEN },
        body: JSON.stringify({ prompt: '' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('an unreadable company roster keeps fullyMatched=false even if every track bound', async () => {
    // co-a covers everything (so every track binds), but co-b's roster was
    // unreadable → coverage is unproven → the response must NOT claim full match.
    const caps: CompanyCapability[] = [
      { companyId: 'co-a', companyName: 'A', strengths: ['explore', 'plan', 'implement', 'verify', 'review'], availableAgents: 5 },
    ];
    const { base, close } = await serve(fakeReader(caps, ['co-b']));
    try {
      const res = await fetch(`${base}/api/missions/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-superclaw-gateway-token': TOKEN },
        body: JSON.stringify({ prompt: 'x', topology: 'linear' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { fullyMatched: boolean; unreadableCompanies: string[]; unmatchedRoles: string[] };
      expect(body.unmatchedRoles).toEqual([]); // every track bound...
      expect(body.unreadableCompanies).toEqual(['co-b']); // ...but a roster was unproven...
      expect(body.fullyMatched).toBe(false); // ...so NOT full coverage (honest)
    } finally {
      await close();
    }
  });

  it('502 when the upstream company read fails (no fake empty plan)', async () => {
    const { base, close } = await serve(fakeReader(new Error('upstream down')));
    try {
      const res = await fetch(`${base}/api/missions/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-superclaw-gateway-token': TOKEN },
        body: JSON.stringify({ prompt: 'x' }),
      });
      expect(res.status).toBe(502);
    } finally {
      await close();
    }
  });
});
