import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordStartupMark } from '../src/startupTrace';
import { probeCanvasReadiness } from '../src/startupReadiness';

afterEach(() => {
  delete (window as { __superclawMark?: unknown }).__superclawMark;
});

describe('browser canvas readiness', () => {
  it('accepts healthy services independently of companies, agents, and provider installation', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json(
      String(input) === '/paperclip-api/health'
        ? { status: 'ok', companies: [], agents: [], providers: { codex: { available: false } } }
        : { ok: true, upstream: { reachable: true, status: 200 } },
    ));
    expect(await probeCanvasReadiness(new AbortController().signal, fetcher)).toBe(true);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/paperclip-api/health', '/gateway-api/health']);
  });

  it.each([
    [{ status: 'error' }, { ok: true, upstream: { reachable: true } }],
    [{ status: 'ok' }, { ok: true, upstream: { reachable: false } }],
    [{ status: 'ok' }, { ok: true }],
    [{ status: 'ok' }, { ok: false, upstream: { reachable: true } }],
  ])('does not confuse liveness or an invalid contract with readiness (%j, %j)', async (node, gateway) => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json(
      String(input) === '/paperclip-api/health' ? node : gateway,
    ));
    expect(await probeCanvasReadiness(new AbortController().signal, fetcher)).toBe(false);
  });

  it('rejects non-success HTTP status, malformed responses and network failures', async () => {
    for (const fetcher of [
      vi.fn(async () => Response.json({ status: 'ok', ok: true, upstream: { reachable: true } }, { status: 503 })),
      vi.fn(async () => new Response('<html>upstream error</html>')),
      vi.fn(async () => { throw new Error('connection refused'); }),
    ]) {
      expect(await probeCanvasReadiness(new AbortController().signal, fetcher)).toBe(false);
    }
  });
});

describe('recordStartupMark', () => {
  it('forwards the label to window.__superclawMark when present', () => {
    const mark = vi.fn();
    (window as { __superclawMark?: unknown }).__superclawMark = mark;
    recordStartupMark('react-render-called');
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith('react-render-called');
  });

  it('is a no-op when the marker mechanism is absent (browser mode / pre-inline-script)', () => {
    expect(() => recordStartupMark('html-parse')).not.toThrow();
  });

  it('swallows errors thrown by the marker so diagnostics never break startup', () => {
    (window as { __superclawMark?: unknown }).__superclawMark = () => {
      throw new Error('relay exploded');
    };
    expect(() => recordStartupMark('runtime-bootstrap-sent')).not.toThrow();
  });
});
