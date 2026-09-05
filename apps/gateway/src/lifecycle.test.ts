import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gatewayMarkerPath,
  precleanStaleGateway,
  processStartSignature,
  readGatewayMarker,
  removeGatewayMarker,
  writeGatewayMarker,
} from './lifecycle.js';

let home: string;
const SAVED = process.env.SUPERCLAW_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gw-life-'));
  process.env.SUPERCLAW_HOME = home;
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.SUPERCLAW_HOME;
  else process.env.SUPERCLAW_HOME = SAVED;
  rmSync(home, { recursive: true, force: true });
});

describe('marker roundtrip', () => {
  it('writes/reads/removes under SUPERCLAW_HOME/run', () => {
    expect(gatewayMarkerPath()).toBe(join(home, 'run', 'gateway-marker.json'));
    expect(readGatewayMarker()).toBeNull();
    writeGatewayMarker({ pid: 4242, startSignature: 'SIG', instanceId: 'i1', port: 8796 });
    expect(readGatewayMarker()).toEqual({ pid: 4242, startSignature: 'SIG', instanceId: 'i1', port: 8796 });
    removeGatewayMarker();
    expect(readGatewayMarker()).toBeNull();
  });
});

describe('processStartSignature', () => {
  it('reports unknown identity on Windows and a stable kernel signature on Unix', () => {
    const sig = processStartSignature(process.pid);
    if (process.platform === 'win32') {
      expect(sig).toBeNull();
    } else {
      expect(typeof sig).toBe('string');
      expect(sig).not.toBe('');
    }
    expect(sig).toBe(processStartSignature(process.pid)); // stable
  });
});

describe('precleanStaleGateway — identity-gated (no HTTP)', () => {
  const alive = () => true;
  const dead = () => false;

  it('no marker → no_marker', () => {
    expect(precleanStaleGateway()).toBe('no_marker');
  });

  it('dead pid → cleared_dead + marker removed', () => {
    writeGatewayMarker({ pid: 9999, startSignature: 'SIG', instanceId: 'i', port: 8796 });
    const killed: number[] = [];
    expect(precleanStaleGateway({ alive: dead, terminate: (p) => killed.push(p) })).toBe('cleared_dead');
    expect(killed).toEqual([]);
    expect(readGatewayMarker()).toBeNull();
  });

  it('alive + matching signature → reaped (terminate) + marker removed', () => {
    writeGatewayMarker({ pid: 9999, startSignature: 'SIG', instanceId: 'i', port: 8796 });
    const killed: number[] = [];
    const reason = precleanStaleGateway({ alive, signature: () => 'SIG', terminate: (p) => killed.push(p) });
    expect(reason).toBe('reaped');
    expect(killed).toEqual([9999]);
    expect(readGatewayMarker()).toBeNull();
  });

  it('alive + mismatched signature → cleared_recycled (no kill) + marker removed', () => {
    writeGatewayMarker({ pid: 9999, startSignature: 'OLD', instanceId: 'i', port: 8796 });
    const killed: number[] = [];
    const reason = precleanStaleGateway({ alive, signature: () => 'NEW', terminate: (p) => killed.push(p) });
    expect(reason).toBe('cleared_recycled');
    expect(killed).toEqual([]);
    expect(readGatewayMarker()).toBeNull();
  });

  it('alive + live signature unreadable → identity_unknown + marker KEPT', () => {
    writeGatewayMarker({ pid: 9999, startSignature: 'SIG', instanceId: 'i', port: 8796 });
    const reason = precleanStaleGateway({ alive, signature: () => null, terminate: () => {} });
    expect(reason).toBe('identity_unknown');
    expect(readGatewayMarker()).not.toBeNull(); // evidence preserved
  });

  it('alive + recorded signature missing → identity_unknown + marker KEPT (not recycled)', () => {
    writeGatewayMarker({ pid: 9999, startSignature: null, instanceId: 'i', port: 8796 });
    const reason = precleanStaleGateway({ alive, signature: () => 'LIVE', terminate: () => {} });
    expect(reason).toBe('identity_unknown');
    expect(readGatewayMarker()).not.toBeNull();
  });
});
