import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const script = join(directory, 'awwo-private-acceptance.sh');
const bash = process.env.AWWO_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const invoke = (args, extra = {}) => spawnSync(bash, [script, '--check-inputs', ...args], {
  encoding: 'utf8', env: { ...process.env, APP_ENV: 'staging', VITE_APP_ENV: 'staging', ...extra },
});

test('installer has valid Bash syntax and read-only validation accepts defaults', () => {
  const syntax = spawnSync(bash, ['-n', script], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const result = invoke([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No installation performed/);
});

test('distinct custom paths, runtime account and ports are accepted', () => {
  const result = invoke(['--repo', '/srv/test-awwo/releases/v0.3.0', '--state', '/srv/test-awwo/data', '--user', 'awwo-test',
    '--node-bin', '/opt/node24/bin/node', '--codex-bin', '/opt/codex/bin/codex', '--node-port', '3200',
    '--gateway-port', '8896', '--web-port', '5288', '--postgres-port', '55329', '--service-prefix', 'awwo-test']);
  assert.equal(result.status, 0, result.stderr);
});

for (const [label, args] of [
  ['root runtime', ['--user', 'root']],
  ['account unit injection', ['--user', 'awwo\nExecStart=/bin/false']],
  ['relative path', ['--repo', 'release']],
  ['traversal', ['--state', '/srv/awwo/../data']],
  ['broad source', ['--repo', '/srv']],
  ['broad state', ['--state', '/home']],
  ['shell substitution', ['--state', '/srv/$(touch_BAD)']],
  ['systemd specifier', ['--repo', '/srv/awwo/%n']],
  ['whitespace', ['--repo', '/srv/my awwo/release']],
  ['same source and state', ['--state', '/srv/awwo/releases/v0.3.0']],
  ['state nested in source', ['--state', '/srv/awwo/releases/v0.3.0/data']],
  ['source nested in state', ['--state', '/srv/awwo']],
  ['duplicate service port', ['--web-port', '3100']],
  ['duplicate PostgreSQL port', ['--postgres-port', '8796']],
  ['privileged port', ['--web-port', '80']],
  ['out of range port', ['--node-port', '65536']],
  ['leading zero port', ['--node-port', '03100']],
  ['port shell arithmetic', ['--node-port', '3100+1']],
  ['unit name injection', ['--service-prefix', 'awwo-test;bad']],
  ['foreign unit prefix', ['--service-prefix', 'ssh']],
  ['missing argument', ['--repo']],
  ['public binding option', ['--host', '0.0.0.0']],
]) {
  test(`rejects ${label} before installation`, () => {
    const result = invoke(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AwwO install:/);
    assert.doesNotMatch(result.stdout, /Installing locked dependencies/);
  });
}

test('production and mismatched environments are rejected', () => {
  assert.notEqual(invoke([], { APP_ENV: 'production' }).status, 0);
  assert.notEqual(invoke([], { VITE_APP_ENV: 'development' }).status, 0);
});

test('actual runtime generator makes independent private native PostgreSQL and Agent secrets', () => {
  const text = readFileSync(script, 'utf8');
  const snippets = [...text.matchAll(/<<'JS'\r?\n([\s\S]*?)\r?\nJS/g)].map((match) => match[1]);
  const generator = snippets.find((snippet) => snippet.includes('mkdirSync, writeFileSync'));
  assert.ok(generator, 'runtime generator must be present');
  const temporary = mkdtempSync(join(tmpdir(), 'awwo-deploy-test-'));
  try {
    const homes = [join(temporary, 'first'), join(temporary, 'second')];
    const environments = [];
    for (const state of homes) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-', state, '/home/awwo', '3200', '8896', '5288', '55329', '/usr/local/bin/codex'], { input: generator, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '', 'secrets must never be printed');
      const env = Object.fromEntries(readFileSync(join(state, '.env'), 'utf8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      environments.push(env);
      assert.equal(env.APP_ENV, 'staging');
      assert.equal(env.VITE_APP_ENV, 'staging');
      assert.equal(env.PAPERCLIP_DEPLOYMENT_MODE, 'local_trusted');
      assert.equal(env.PAPERCLIP_DEPLOYMENT_EXPOSURE, 'private');
      assert.equal(env.HOST, '127.0.0.1');
      assert.equal(env.SUPERCLAW_GATEWAY_HOST, '127.0.0.1');
      assert.equal(env.SUPERCLAW_GATEWAY_UPSTREAM_URL, 'http://127.0.0.1:3200');
      assert.equal(env.VITE_GATEWAY_API_TARGET, 'http://127.0.0.1:8896');
      assert.equal(env.SUPERCLAW_CANVAS_PLANNER_PROVIDER, 'codex');
      assert.equal(env.SUPERCLAW_DESKTOP_PGLITE, '0');
      assert.equal(env.HEARTBEAT_SCHEDULER_ENABLED, 'false');
      assert.equal(env.SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL, '');
      assert.equal(env.CODEX_HOME, '/home/awwo/.codex');
      assert.equal(env.DATABASE_URL, undefined);
      assert.match(env.PAPERCLIP_AGENT_JWT_SECRET, /^[a-f0-9]{64}$/);
      const key = readFileSync(join(state, 'secrets/master.key'), 'utf8').trim();
      assert.equal(Buffer.from(key, 'base64').length, 32);
      assert.notEqual(Buffer.from(key, 'base64').toString('hex'), env.PAPERCLIP_AGENT_JWT_SECRET);
      const config = JSON.parse(readFileSync(join(state, 'runtime/instances/default/config.json'), 'utf8'));
      assert.equal(config.database.mode, 'embedded-postgres');
      assert.equal(config.database.embeddedPostgresPort, 55329);
      assert.equal(config.database.embeddedPostgresDataDir, `${state}/postgres`);
      assert.equal(config.telemetry.enabled, false);
      assert.equal(config.server.bind, 'loopback');
      if (process.platform !== 'win32') assert.equal(statSync(join(state, '.env')).mode & 0o777, 0o600);
      const retry = spawnSync(process.execPath, ['--input-type=module', '-', state, '/home/awwo', '3200', '8896', '5288', '55329', '/usr/local/bin/codex'], { input: generator, encoding: 'utf8' });
      assert.notEqual(retry.status, 0, 'generator must refuse to overwrite an existing secret');
      assert.equal(readFileSync(join(state, 'secrets/master.key'), 'utf8').trim(), key);
    }
    assert.notEqual(environments[0].PAPERCLIP_AGENT_JWT_SECRET, environments[1].PAPERCLIP_AGENT_JWT_SECRET);
  } finally {
    // Exact test-owned temporary directory, never a deployment or workspace path.
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('staging markers change built artifacts and private preview config only', () => {
  const text = readFileSync(script, 'utf8');
  const generator = [...text.matchAll(/<<'JS'\r?\n([\s\S]*?)\r?\nJS/g)].map((match) => match[1]).find((snippet) => snippet.includes('Built Web index has no title'));
  assert.ok(generator);
  const temporary = mkdtempSync(join(tmpdir(), 'awwo-staging-test-'));
  try {
    const repo = join(temporary, 'repo').replaceAll('\\', '/');
    const state = join(temporary, 'state').replaceAll('\\', '/');
    mkdirSync(`${repo}/apps/web/dist`, { recursive: true });
    mkdirSync(state);
    const source = '<title>AwwO</title><main>source</main>';
    writeFileSync(`${repo}/apps/web/index.html`, source);
    writeFileSync(`${repo}/apps/web/dist/index.html`, source);
    const result = spawnSync(process.execPath, ['--input-type=module', '-', repo, state], { input: generator, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(`${repo}/apps/web/index.html`, 'utf8'), source);
    assert.match(readFileSync(`${repo}/apps/web/dist/index.html`, 'utf8'), /<title>\[STAGING\] AwwO<\/title>/);
    assert.equal(readFileSync(`${repo}/apps/web/dist/robots.txt`, 'utf8'), 'User-agent: *\nDisallow: /\n');
    const preview = readFileSync(`${state}/preview.config.mjs`, 'utf8');
    assert.ok(preview.includes(`${repo}/apps/web/vite.config.mjs`));
    assert.match(preview, /\.\.\.base\.preview/);
    assert.match(preview, /'X-Robots-Tag': 'noindex, nofollow'/);
    const syntax = spawnSync(process.execPath, ['--check', `${state}/preview.config.mjs`], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally {
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(temporary, { recursive: true, force: true });
  }
});
