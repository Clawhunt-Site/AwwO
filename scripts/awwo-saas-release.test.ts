import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildEnvironment, checksumLines, parseImage, parseOptions, removeBuildTree, runtimeSource, validateTarget, verifyCore, withBuildCleanup } from './awwo-saas-release.ts';
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

test('isolated npm configuration actually loads both empty scopes and Go accepts writable module cache flags', t => {
  const root = mkdtempSync(join(tmpdir(), 'awwo-release-environment-'));
  t.after(() => removeBuildTree(root));
  const env = buildEnvironment(root);
  const options = { cwd: root, env, encoding: 'utf8' as const, timeout: 30_000 };
  // Reproduce the original npm error with distinct new files collapsed to one path.
  assert.throws(() => execFileSync('npm', ['config', 'list', '--json'], { ...options, env: { ...env, npm_config_globalconfig: env.npm_config_userconfig }, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.match(execFileSync('npm', ['--version'], options).trim(), /^\d+\.\d+\.\d+/);
  const configuration = JSON.parse(execFileSync('npm', ['config', 'list', '--json'], options));
  assert.equal(configuration.userconfig, env.npm_config_userconfig);
  assert.equal(configuration.globalconfig, env.npm_config_globalconfig);
  assert.equal(readFileSync(configuration.userconfig, 'utf8'), '');
  assert.equal(readFileSync(configuration.globalconfig, 'utf8'), '');
  assert.equal(execFileSync('go', ['env', 'GOFLAGS'], options).trim(), '-modcacherw');
});

test('cleanup removes nested read-only module directories without following external symlinks', t => {
  const parent = mkdtempSync(join(tmpdir(), 'awwo-release-cleanup-'));
  t.after(() => removeBuildTree(parent));
  const build = join(parent, 'build'), nested = join(build, 'go/pkg/mod/example/module@v1/nested'), outside = join(parent, 'outside');
  mkdirSync(nested, { recursive: true }); mkdirSync(outside);
  writeFileSync(join(nested, 'module.go'), 'package module'); writeFileSync(join(outside, 'keep'), 'outside retained');
  symlinkSync(outside, join(build, 'outside-link'));
  chmodSync(outside, 0o500); chmodSync(nested, 0o500); chmodSync(join(build, 'go/pkg/mod/example/module@v1'), 0o555);
  // Linux reports EACCES; Node on macOS can report the non-empty parent instead.
  if (process.getuid?.() !== 0) assert.throws(() => rmSync(build, { recursive: true, force: true }), error => ['EACCES', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || ''));
  if (!existsSync(join(build, 'outside-link'))) symlinkSync(outside, join(build, 'outside-link'));
  const original = new Error('npm install failed first');
  assert.throws(() => withBuildCleanup(build, () => { throw original; }), error => error === original);
  assert.equal(existsSync(build), false);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'outside retained');
  assert.equal(statSync(outside).mode & 0o777, 0o500);
});

test('a cleanup failure cannot replace the original build failure', () => {
  const original = new Error('original build failure'), cleanup = new Error('cleanup failure'), reports: string[] = [];
  assert.throws(() => withBuildCleanup('/synthetic-owned-build', () => { throw original; }, () => { throw cleanup; }, message => reports.push(message)), error => error === original);
  assert.equal(reports.length, 1);
  assert.throws(() => withBuildCleanup('/synthetic-owned-build', () => 'complete', () => { throw cleanup; }), error => error === cleanup);
});
