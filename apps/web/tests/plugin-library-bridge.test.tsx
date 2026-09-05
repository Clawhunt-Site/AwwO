import { afterEach, describe, expect, it, vi } from 'vitest';

// Covers the data-source helpers behind the board's "Plugins" settings page after it
// was repointed from the vendored Paperclip demo examples onto ClawHunt's unified
// plugin library: embedded reads /plugins/global (the same ~/.superclaw/plugins library
// the CLI shows), standalone keeps reading the bundled demos at /plugins/examples.
//
// The capability-store CONTEXT bridge + the full PluginManager render-timing test
// (embedded first render hits /plugins/global and never /plugins/examples, and vice
// versa, under StrictMode) live next to the component in
// server/ui/src/host/capability-store.test.tsx + server/ui/src/pages/PluginManager.test.tsx:
// rendering a server/ui hook/component needs a single react + react-query instance,
// which only holds inside server/ui's own test env — apps/web's vitest resolves the
// board's react/react-query to second copies. These pure-fetch helper checks run
// cleanly in apps/web's CI gate.
import { pluginsApi } from '@/api/plugins';
import { apiBase } from '@/api/client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function recordFetch(body: unknown = []) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url,
      );
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

describe('plugin library data-source helpers', () => {
  it('listGlobal() targets the unified ~/.superclaw/plugins library at /plugins/global', async () => {
    const calls = recordFetch();
    await pluginsApi.listGlobal();
    expect(calls[0]).toBe(`${apiBase}/plugins/global`);
  });

  it('listBundled() targets bundled examples at /plugins/examples (standalone path preserved)', async () => {
    const calls = recordFetch();
    await pluginsApi.listBundled();
    expect(calls[0]).toBe(`${apiBase}/plugins/examples`);
  });
});
