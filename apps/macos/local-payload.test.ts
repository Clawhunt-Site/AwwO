import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PAYLOAD_ENTRIES, PAYLOAD_FORMAT, readPayload } from './local-payload.ts';

const revision = 'a'.repeat(40);
function payload(manifest: Record<string, unknown>, entries: readonly string[] = PAYLOAD_ENTRIES): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'awwo-mac-payload-'));
  for (const entry of entries) {
    const file = path.join(folder, ...entry.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'x');
  }
  writeFileSync(path.join(folder, 'awwo-local-payload.json'), JSON.stringify(manifest));
  return folder;
}
const complete = { format: PAYLOAD_FORMAT, system: 'macos-arm64', revision, dirty: false, packagedAt: '2026-10-24T00:00:00Z', files: 5, bytes: 5 };

test('a payload is built into the app only when complete, of this format and system, and from the same commit', () => {
  assert.equal(readPayload(payload(complete), { revision }).revision, revision);
  assert.throws(() => readPayload('relative/payload', { revision }), /absolute path/);
  assert.throws(() => readPayload(payload({ assembling: true }), { revision }), /not complete/);
  assert.throws(() => readPayload(payload({ ...complete, format: 0 }), { revision }), /format 0/);
  assert.throws(() => readPayload(payload({ ...complete, system: 'windows-x64' }), { revision }), /for windows-x64/);
  assert.throws(() => readPayload(payload({ ...complete, revision: 'b'.repeat(40) }), { revision }), /assembled from b+/);
  assert.throws(() => readPayload(payload({ ...complete, dirty: true }), { revision }), /with changes/);
  assert.equal(readPayload(payload({ ...complete, dirty: true }), { revision, allowDirty: true }).dirty, true, 'a build to test may take one');
  assert.throws(() => readPayload(payload(complete, PAYLOAD_ENTRIES.filter(entry => entry !== 'build/node/bin/node')), { revision }), /lacks build\/node\/bin\/node/);
  const empty = mkdtempSync(path.join(os.tmpdir(), 'awwo-mac-payload-'));
  assert.throws(() => readPayload(empty, { revision }), /holds no payload/);
});
