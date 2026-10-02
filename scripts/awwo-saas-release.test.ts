import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checksumLines, parseImage, parseOptions, runtimeSource, validateTarget, verifyCore } from './awwo-saas-release.ts';
import { UPSTREAM_REVISION, PATCH_VERSION } from '../apps/openmaus-worker/setup.ts';

test('release requires Linux amd64 and Node 24; Docker identity must match that target', () => {
  validateTarget('linux', 'x64', 24);
  for (const values of [['darwin', 'arm64', 24], ['linux', 'arm64', 26], ['linux', 'x64', 22]] as const) assert.throws(() => validateTarget(values[0], values[1], values[2]));
  const image = { Id: 'sha256:' + 'a'.repeat(64), Os: 'linux', Architecture: 'amd64' };
  assert.deepEqual(parseImage(JSON.stringify(image)), image);
  for (const value of [null, {}, { ...image, Architecture: 'arm64' }, { ...image, Id: 'latest' }]) assert.throws(() => parseImage(JSON.stringify(value)));
  assert.equal(parseOptions(['--docker-context', 'default']).dockerContext, 'default');
  assert.throws(() => parseOptions(['--docker-context', '../foreign']));
});
test('runtime allowlist excludes credentials, private state and tests', () => {
  for (const name of ['server.mjs', 'workspace-sandbox.ts', 'package.json', 'package-lock.json']) assert.equal(runtimeSource(name), true);
  for (const name of ['.env', '.env.example', 'node_modules', '.runtime', 'test-support.mjs', 'config.test.mjs', 'terminal-exit-fixture.mjs', 'README.md']) assert.equal(runtimeSource(name), false);
});
test('checksums cover relative npm bin links but reject escaped links and special filenames', t => {
  const root = mkdtempSync(join(tmpdir(), 'awwo-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, 'release'); mkdirSync(release);
  writeFileSync(join(release, 'entry.js'), 'verified'); symlinkSync('entry.js', join(release, 'entry-bin'));
  const lines = checksumLines(release); assert.equal(lines.length, 2); assert.equal(lines[0]!.split('  ')[0], lines[1]!.split('  ')[0]);
  writeFileSync(join(root, 'private-key'), 'must not be read'); symlinkSync('../private-key', join(release, 'escape'));
  assert.throws(() => checksumLines(release), /Unsafe release symlink/);
  rmSync(join(release, 'escape')); writeFileSync(join(release, 'unsafe\nname'), 'value');
  assert.throws(() => checksumLines(release), /Unsupported release filename/);
});
test('core manifest and attribution must be present and enterprise must be absent', t => {
  const root = mkdtempSync(join(tmpdir(), 'awwo-core-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'awwo-build.json'), JSON.stringify({ upstreamRevision: UPSTREAM_REVISION, patchVersion: PATCH_VERSION }));
  for (const name of ['index.js', 'LICENSE', 'NOTICE']) writeFileSync(join(root, name), 'fixture');
  mkdirSync(join(root, 'third_party')); verifyCore(root);
  mkdirSync(join(root, 'enterprise')); assert.throws(() => verifyCore(root), /licensing boundary/);
});
