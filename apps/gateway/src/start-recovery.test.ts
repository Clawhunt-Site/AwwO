// A stale marker must not be able to brick the gateway forever.
//
// The marker lives in the run dir, which in the container deployment is a PERSISTENT VOLUME. It
// therefore outlives the container that wrote it — and in the next container that pid number
// belongs to something else entirely, because PID namespaces restart at 1. `precleanStaleGateway`
// then reports `identity_unknown` (a live pid we cannot prove is ours), which used to make
// startGateway throw before binding. It could never succeed again: the gateway never started, and
// every /gateway-api call answered 503 "Node control plane unavailable" — a whole-product outage
// caused by a leftover file. Observed in production 2026-08-27.
//
// The port is the honest arbiter: if the marked process really were our gateway it would still be
// holding the port, so a successful bind proves it is not. Only a real EADDRINUSE defers, and that
// path still keeps the marker — preserving the evidence the original guard existed to protect.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGateway } from './index.js';
import { readGatewayMarker, writeGatewayMarker } from './lifecycle.js';

let home: string;
let blocker: Server | null = null;
const PORT = 8899;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gw-recovery-'));
  process.env.SUPERCLAW_HOME = home;
  process.env.SUPERCLAW_GATEWAY_PORT = String(PORT);
  process.env.SUPERCLAW_GATEWAY_UPSTREAM_URL = 'http://127.0.0.1:59999';
});

afterEach(async () => {
  if (blocker) {
    await new Promise<void>((resolve) => blocker!.close(() => resolve()));
    blocker = null;
  }
  delete process.env.SUPERCLAW_HOME;
  delete process.env.SUPERCLAW_GATEWAY_PORT;
  delete process.env.SUPERCLAW_GATEWAY_UPSTREAM_URL;
  rmSync(home, { recursive: true, force: true });
});

/** A marker naming a pid that is alive but is NOT our gateway — the container-restart shape.
 *  `process.pid` is alive by definition, and its real start signature will never equal this. */
function writeUnidentifiableMarker(): void {
  writeGatewayMarker({
    pid: process.pid,
    startSignature: null, // recorded signature missing → identity_unknown, marker kept
    instanceId: 'from-a-previous-container',
    port: PORT,
  });
}

describe('startGateway with an unidentifiable marker', () => {
  it('takes the port when it is FREE, instead of deferring forever', async () => {
    writeUnidentifiableMarker();

    const runtime = await startGateway();
    try {
      expect(runtime.server.listening).toBe(true);
      // The marker is now OURS — a later run can identify and reap this process.
      const marker = readGatewayMarker();
      expect(marker?.pid).toBe(process.pid);
      expect(marker?.instanceId).not.toBe('from-a-previous-container');
    } finally {
      await runtime.stop();
    }
  });

  it('still defers, marker intact, when the port is genuinely HELD', async () => {
    writeUnidentifiableMarker();
    blocker = createServer(() => {});
    await new Promise<void>((resolve) => blocker!.listen(PORT, '127.0.0.1', () => resolve()));

    await expect(startGateway()).rejects.toThrow(/still holds the port/);
    // Evidence preserved for the next attempt — the whole point of the original guard.
    expect(readGatewayMarker()?.instanceId).toBe('from-a-previous-container');
  });
});
