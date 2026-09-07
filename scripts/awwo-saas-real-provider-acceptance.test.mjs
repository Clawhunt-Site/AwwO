import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { root, stateDir } from './awwo-saas-lib.mjs';
import { inspectProviderConfig, readProjectConfig, runRealProviderAcceptance } from './awwo-saas-real-provider-acceptance.mjs';

test('missing configuration is BLOCKED and run never starts resources or substitutes a fixture', async () => {
  const report = inspectProviderConfig({});
  assert.equal(report.status, 'BLOCKED'); assert.ok(report.missing.includes('AWWO_PI_MODEL'));
  assert.deepEqual(await runRealProviderAcceptance({ report, values: {} }), report);
});
test('valid explicit provider configuration is only readiness, never inference PASS, and excludes secrets', () => {
  const report = inspectProviderConfig({ AWWO_PI_PROVIDER: 'openai', AWWO_PI_MODEL: 'project-configured-model', AWWO_PI_API_KEY: 'secret-sentinel' });
  assert.equal(report.status, 'READY'); assert.equal(report.externalInferencePerformed, false);
  assert.ok(!JSON.stringify(report).includes('secret-sentinel'));
  assert.equal(inspectProviderConfig({ AWWO_PI_PROVIDER: 'ollama', AWWO_PI_MODEL: 'local-model' }).status, 'READY');
});
test('fixture names, bad runtime limits and credential-bearing URLs fail without leaking values', () => {
  const values = { AWWO_PI_PROVIDER: 'openai', AWWO_PI_MODEL: 'real-model', AWWO_PI_API_KEY: 'private-key' };
  assert.equal(inspectProviderConfig({ ...values, AWWO_PI_MODEL: 'awwo-protocol-fixture' }).status, 'FAIL');
  assert.equal(inspectProviderConfig({ ...values, AWWO_PI_TIMEOUT_MS: 'invalid-secret-number' }).status, 'FAIL');
  const badURL = inspectProviderConfig({ ...values, AWWO_PI_BASE_URL: 'https://name:private-password@example.invalid/v1' });
  assert.equal(badURL.status, 'BLOCKED'); assert.ok(!JSON.stringify(badURL).includes('private'));
});
test('real-provider run rejects shared/remote database endpoints before starting resources', async () => {
  const report = { status: 'READY', provider: 'openai', model: 'real-model' };
  assert.equal((await runRealProviderAcceptance({ report, values: {} })).status, 'BLOCKED');
  assert.equal((await runRealProviderAcceptance({ report, values: { AWWO_DATABASE_URL: 'postgres://db.example.invalid/project' } })).status, 'FAIL');
});
test('CLI --check reads only a project file and ignores ambient provider credentials', async t => {
  const dir = await mkdtemp(path.join(stateDir, 'real-provider-preflight-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'creator.md'), 'Created by Codex on 2026-09-07 for ephemeral provider-preflight tests. Removed at test end.\n');
  const file = path.join(dir, 'project.env');
  await writeFile(file, 'AWWO_PI_PROVIDER=\nAWWO_PI_MODEL=\nAWWO_PI_API_KEY=\nAWWO_PI_BASE_URL=\n', { mode: 0o600 });
  const parsed = await readProjectConfig(file); assert.equal(parsed.report.status, 'BLOCKED');
  const child = spawn(process.execPath, ['scripts/awwo-saas-real-provider-acceptance.mjs', '--check', '--env-file', file], { cwd: root,
    env: { ...process.env, AWWO_PI_PROVIDER: 'openai', AWWO_PI_MODEL: 'ambient-other-project', AWWO_PI_API_KEY: 'ambient-private-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', data => { out += data; });
  const [code] = await once(child, 'exit'); assert.equal(code, 2); assert.equal(JSON.parse(out).status, 'BLOCKED');
  assert.ok(!out.includes('ambient'));
  await assert.rejects(readProjectConfig('/etc/hosts'), /inside this project/);
});
