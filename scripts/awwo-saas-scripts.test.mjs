import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv, port, resolveCommand, root, serviceEnvironments, waitForHttp } from './awwo-saas-lib.mjs';
import { assertWorkerDependencies, runDevelopment } from './awwo-saas-dev.mjs';
test('local dotenv reads literal values without executing shell expressions', () => {
  assert.deepEqual(parseEnv('# comment\nMODEL=abc\nKEY="a=b"\nEMPTY=\nLITERAL=$(touch danger)\n'), { MODEL:'abc',KEY:'a=b',EMPTY:'',LITERAL:'$(touch danger)' });
  assert.throws(() => parseEnv('export KEY=x'));
});
test('local startup accepts only explicitly identified unconfigured runtimes', async () => {
  let body = { status:'unconfigured', ready:false, configured:false, piVersion:'0.85.1' };
  const server = createServer((_req,res) => { res.writeHead(503, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/health`;
    await waitForHttp(url, {exitCode:null}, 300, {allowUnconfiguredPi:true});
    await assert.rejects(waitForHttp(url,{exitCode:null},200), /timed out/);
    body = { status:'unconfigured', ready:false, configured:false, runtime:'openai-agents' };
    await waitForHttp(url, {exitCode:null}, 300, {allowUnconfiguredRuntime:'openai-agents'});
    await assert.rejects(waitForHttp(url,{exitCode:null},200,{allowUnconfiguredRuntime:'pi'}), /timed out/);
    body = { status:'stopping', ready:false, configured:false, piVersion:'0.85.1' };
    await assert.rejects(waitForHttp(url,{exitCode:null},200,{allowUnconfiguredPi:true}), /timed out/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('ports reject command fragments, privileged and out of range values', () => {
  assert.equal(port('8087','port'),8087);
  for (const value of ['80','0','65536','8087 -h 0.0.0.0','NaN','1.5']) assert.throws(() => port(value,'port'));
});

test('managed execution reuses AwwO setup without inheriting provider, vault or external bridge credentials', () => {
  const scoped = serviceEnvironments({ PATH: '/usr/bin', HOME: '/home/operator', AWWO_OPENMAUS_TOKEN: 'internal-managed-token',
    AWWO_OPENMAUS_URL: 'http://127.0.0.1:8099', AWWO_OPENMAUS_DOCKER: '/usr/bin/docker', AWWO_OPENMAUS_WORKSPACE_IMAGE: 'sha256:fixture',
    AWWO_OPENMAUS_CONNECTIONS_JSON: '[{"token":"external-secret"}]', AWWO_COMPUTER_MODEL_PROXY_URL: 'http://127.0.0.1:8087/api/internal/computer-model/v1',
    AWWO_PI_TOKEN: 'pi-internal-token', AWWO_PI_API_KEY: 'provider-secret', AWWO_DATABASE_URL: 'database-secret', AWWO_CREDENTIAL_ENCRYPTION_KEY: 'vault-secret' });
  assert.equal(scoped.openMaus.AWWO_OPENMAUS_TOKEN, 'internal-managed-token');
  assert.equal(scoped.openMaus.AWWO_OPENMAUS_WORKSPACE_IMAGE, 'sha256:fixture');
  assert.equal(scoped.api.AWWO_OPENMAUS_TOKEN, 'internal-managed-token');
  assert.match(scoped.api.AWWO_COMPUTER_MODEL_PROXY_URL, /computer-model\/v1$/);
  for (const secret of ['provider-secret', 'vault-secret', 'database-secret', 'pi-internal-token', '[{"token":"external-secret"}]']) assert.equal(Object.values(scoped.openMaus).includes(secret), false);
  assert.equal(scoped.web.AWWO_OPENMAUS_TOKEN, undefined);
  assert.equal(scoped.api.AWWO_OPENMAUS_DOCKER, undefined);
});

test('managed readiness is authenticated and only an identified unavailable worker may leave SaaS running', async () => {
  let known = true;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-internal-token');
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: known ? 'awwo-openmaus-worker' : 'other', status: 'unconfigured', ready: false, configured: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/health`;
    const options = { allowManagedOpenMaus: true, authorizationToken: 'fixture-internal-token' };
    await waitForHttp(url, { exitCode: null }, 300, options);
    known = false;
    await assert.rejects(waitForHttp(url, { exitCode: null }, 200, options), /timed out/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('local services receive only their own provider credentials', () => {
  const env = {
    PATH: '/test/bin', APP_ENV: 'development', AWWO_API_TARGET: 'http://127.0.0.1:8087', VITE_AWWO_WEB_PORT: '5189',
    AWWO_DATABASE_URL: 'postgres://awwo:database-secret@127.0.0.1/awwo', AWWO_LOCAL_DB_PASSWORD: 'database-secret',
    AWWO_BOOTSTRAP_ADMIN_PASSWORD: 'admin-secret', AWWO_PI_URL: 'http://127.0.0.1:8097', AWWO_PI_TOKEN: 'pi-internal-token',
    AWWO_PI_API_KEY: 'pi-provider-secret', PI_REVIEW_KEY: 'pi-review-secret',
    AWWO_OPENAI_AGENTS_URL: 'http://127.0.0.1:8098', AWWO_OPENAI_AGENTS_TOKEN: 'oa-internal-token',
    AWWO_OPENAI_AGENTS_API_KEY: 'oa-provider-secret', OA_REVIEW_KEY: 'oa-review-secret', AWWO_EXTRA_PI_KEY: 'pi-prefix-secret', VITE_AWWO_EXTRA_OA_KEY: 'oa-vite-prefix-secret',
    AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([{ id: 'review', apiKeyEnv: 'OA_REVIEW_KEY' }, { id: 'prefixed', apiKeyEnv: 'VITE_AWWO_EXTRA_OA_KEY' }]),
    AWWO_PI_MODELS_JSON: JSON.stringify([{ id: 'review', apiKeyEnv: 'PI_REVIEW_KEY' }, { id: 'prefixed', apiKeyEnv: 'AWWO_EXTRA_PI_KEY' }]),
    OPENAI_API_KEY: 'ambient-openai-secret', ANTHROPIC_API_KEY: 'ambient-anthropic-secret',
  };
  const scoped = serviceEnvironments(env);
  assert.equal(scoped.pi.AWWO_PI_API_KEY, 'pi-provider-secret'); assert.equal(scoped.pi.PI_REVIEW_KEY, 'pi-review-secret');
  assert.equal(scoped.openAIAgents.AWWO_OPENAI_AGENTS_API_KEY, 'oa-provider-secret'); assert.equal(scoped.openAIAgents.OA_REVIEW_KEY, 'oa-review-secret');
  assert.equal(scoped.pi.AWWO_EXTRA_PI_KEY, 'pi-prefix-secret'); assert.equal(scoped.openAIAgents.VITE_AWWO_EXTRA_OA_KEY, 'oa-vite-prefix-secret');
  for (const service of [scoped.build, scoped.api, scoped.web]) {
    for (const secret of ['pi-provider-secret', 'pi-review-secret', 'pi-prefix-secret', 'oa-provider-secret', 'oa-review-secret', 'oa-vite-prefix-secret', 'ambient-openai-secret', 'ambient-anthropic-secret']) {
      assert.equal(Object.values(service).includes(secret), false);
    }
  }
  assert.equal(scoped.api.AWWO_DATABASE_URL, env.AWWO_DATABASE_URL); assert.equal(scoped.api.AWWO_PI_TOKEN, 'pi-internal-token');
  assert.equal(scoped.api.AWWO_OPENAI_AGENTS_TOKEN, 'oa-internal-token'); assert.equal(scoped.api.AWWO_LOCAL_DB_PASSWORD, undefined);
  assert.equal(scoped.web.AWWO_API_TARGET, env.AWWO_API_TARGET); assert.equal(scoped.web.AWWO_DATABASE_URL, undefined);
  assert.equal(scoped.pi.AWWO_DATABASE_URL, undefined); assert.equal(scoped.openAIAgents.AWWO_BOOTSTRAP_ADMIN_PASSWORD, undefined);
  assert.equal(scoped.pi.AWWO_OPENAI_AGENTS_TOKEN, undefined); assert.equal(scoped.openAIAgents.AWWO_PI_TOKEN, undefined);
});

test('observability is scoped to backend processes with distinct management listeners', () => {
  const env = { APP_ENV: 'development', AWWO_METRICS_ENABLED: 'true', AWWO_METRICS_LISTEN_ADDR: '127.0.0.1:9201',
    AWWO_LOCAL_PI_METRICS_LISTEN_ADDR: '127.0.0.1:9202', AWWO_LOCAL_OPENAI_AGENTS_METRICS_LISTEN_ADDR: '127.0.0.1:9203',
    AWWO_OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    OTEL_EXPORTER_OTLP_HEADERS: 'secret=ambient-exporter-secret', AWWO_MODEL_PRICING_JSON: '{"version":"test"}' };
  const scoped = serviceEnvironments(env);
  assert.equal(scoped.api.AWWO_METRICS_LISTEN_ADDR, '127.0.0.1:9201');
  assert.equal(scoped.pi.AWWO_METRICS_LISTEN_ADDR, '127.0.0.1:9202');
  assert.equal(scoped.openAIAgents.AWWO_METRICS_LISTEN_ADDR, '127.0.0.1:9203');
  for (const runtime of [scoped.api, scoped.pi, scoped.openAIAgents]) {
    assert.equal(runtime.AWWO_OTEL_ENABLED, 'true'); assert.equal(runtime.OTEL_EXPORTER_OTLP_ENDPOINT, env.OTEL_EXPORTER_OTLP_ENDPOINT);
    assert.equal(runtime.OTEL_EXPORTER_OTLP_HEADERS, undefined);
  }
  for (const runtime of [scoped.web, scoped.build]) {
    assert.equal(runtime.AWWO_METRICS_ENABLED, undefined); assert.equal(runtime.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
    assert.equal(runtime.OTEL_EXPORTER_OTLP_HEADERS, undefined); assert.equal(runtime.AWWO_MODEL_PRICING_JSON, undefined);
  }
  assert.equal(scoped.pi.AWWO_MODEL_PRICING_JSON, undefined); assert.equal(scoped.openAIAgents.AWWO_MODEL_PRICING_JSON, undefined);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function launcherFixture() {
  const runtime = new EventEmitter();
  runtime.argv = []; runtime.execPath = process.execPath;
  const stopped = deferred();
  let exitCode;
  Object.defineProperty(runtime, 'exitCode', { get: () => exitCode, set: value => { exitCode = value; stopped.resolve(); } });
  const commands = [], children = [], messages = [], waits = [];
  const env = {
    AWWO_API_PORT:'18087', AWWO_PI_PORT:'18097', AWWO_OPENAI_AGENTS_PORT:'18098', AWWO_OPENMAUS_PORT:'18099', AWWO_OPENMAUS_URL:'http://127.0.0.1:18099', VITE_AWWO_WEB_PORT:'15189',
    AWWO_PI_URL:'http://127.0.0.1:18097', AWWO_OPENAI_AGENTS_URL:'http://127.0.0.1:18098', AWWO_API_TARGET:'http://127.0.0.1:18087', AWWO_PUBLIC_ORIGIN:'http://127.0.0.1:15189',
  };
  const options = {
    runtime, logger: { log: value => messages.push(value), error: value => messages.push(value) },
    loadEnv: async () => ({ env, envFile: '/test-only/env', managedDatabase: false }),
    assertFree: async () => {},
    checkDependencies: async () => {},
    startDb: async () => { throw new Error('This test must not start PostgreSQL'); },
    runCommand: async (command, args, options) => { commands.push({command, args, ...(options ? {options} : {})}); },
    waitHttp: async (url, _child, _timeout, options) => { waits.push({url, options}); },
    spawnChild: (command, args, options) => {
      const child = new EventEmitter();
      child.exitCode = null; child.signalCode = null; child.signals = [];
      child.kill = signal => { child.signals.push(signal); child.signalCode = signal; child.emit('exit', null, signal); };
      children.push({command, args, options, child});
      return child;
    },
  };
  return { runtime, stopped, commands, children, messages, waits, env, options };
}

test('worker SDK preflight imports from each package directory without inheriting credentials', async () => {
  const calls = [];
  await assertWorkerDependencies('/test/bin/node', async (command, args, options) => {
    calls.push({ command, args, options });
  }, { API_KEY: 'must-not-pass' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.cwd, path.join(root, 'apps/pi-worker'));
  assert.equal(calls[1].options.cwd, path.join(root, 'apps/openai-agents-worker'));
  assert.match(calls[0].args.at(-1), /@earendil-works\/pi-coding-agent/);
  assert.match(calls[1].args.at(-1), /@openai\/agents/);
  for (const call of calls) {
    assert.equal(call.command, '/test/bin/node');
    assert.deepEqual(call.args.slice(0, 2), ['--input-type=module', '-e']);
    assert.deepEqual(call.options.env, { PATH: path.dirname('/test/bin/node') });
    assert.equal(call.options.stdio, 'ignore');
  }
});

test('worker SDK preflight preserves only Windows loader variables when present', async () => {
  const calls = [];
  await assertWorkerDependencies('/test/bin/node', async (_command, _args, options) => calls.push(options), {
    SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', API_KEY: 'must-not-pass', HOME: 'must-not-pass',
  });
  assert.equal(calls.length, 2);
  for (const options of calls) assert.deepEqual(options.env, {
    PATH: path.dirname('/test/bin/node'), SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
  });
});

test('missing worker SDK fails before local database, build, or service launch', async () => {
  const fixture = launcherFixture();
  fixture.options.loadEnv = async () => ({ env: fixture.env, envFile: '/test-only/env', managedDatabase: true });
  let databaseStarted = false;
  fixture.options.startDb = async () => { databaseStarted = true; };
  fixture.options.checkDependencies = async () => { throw new Error('Run npm run setup:saas before npm run dev:saas.'); };
  await runDevelopment(fixture.options);
  assert.equal(fixture.runtime.exitCode, 1);
  assert.deepEqual(fixture.messages, ['Run npm run setup:saas before npm run dev:saas.']);
  assert.equal(databaseStarted, false);
  assert.deepEqual(fixture.commands, []);
  assert.deepEqual(fixture.children, []);
});

test('startup passes its injected command runner to worker dependency preflight', async () => {
  const fixture = launcherFixture();
  let checked = false;
  fixture.options.checkDependencies = async (executable, runCommand) => {
    assert.equal(executable, fixture.runtime.execPath);
    assert.equal(runCommand, fixture.options.runCommand);
    checked = true;
  };
  await runDevelopment(fixture.options);
  assert.equal(checked, true);
  fixture.runtime.emit('SIGTERM');
  await fixture.stopped.promise;
});

test('dependency preflight names the failed worker and setup command', async () => {
  let checks = 0;
  await assert.rejects(assertWorkerDependencies('/test/bin/node', async () => {
    if (++checks === 2) throw new Error('module not found');
  }), /apps\/openai-agents-worker SDK dependencies are unavailable\. Run npm run setup:saas/);
  assert.equal(checks, 2);
});

test('database-only startup does not require worker SDKs', async () => {
  const fixture = launcherFixture();
  fixture.runtime.argv = ['node', 'scripts/awwo-saas-dev.mjs', '--database-only'];
  fixture.options.checkDependencies = async () => { throw new Error('Worker preflight must be skipped'); };
  await runDevelopment(fixture.options);
  assert.equal(fixture.runtime.exitCode, undefined);
  assert.equal(fixture.messages.length, 1);
  assert.deepEqual(fixture.children, []);
});

test('SIGTERM during the Go build prevents all subsequent service launches', async () => {
  const fixture = launcherFixture(), entered = deferred(), build = deferred();
  fixture.options.runCommand = async command => { assert.equal(command, 'go'); entered.resolve(); await build.promise; };
  const start = runDevelopment(fixture.options);
  await entered.promise;
  fixture.runtime.emit('SIGTERM');
  build.resolve();
  await start;
  assert.equal(fixture.children.length, 0);
  assert.equal(fixture.runtime.exitCode, 0);
  assert.equal(fixture.messages.length, 0);
});

test('stopping during database startup cleans a later acquired owned database without launching services', async () => {
  const fixture = launcherFixture(), entered = deferred(), database = deferred();
  fixture.options.loadEnv = async () => ({env: fixture.env, envFile: '/test-only/env', managedDatabase: true});
  fixture.options.startDb = async () => { entered.resolve(); return database.promise; };
  const start = runDevelopment(fixture.options);
  await entered.promise;
  fixture.runtime.emit('SIGTERM');
  database.resolve({owned: true, data: '/test-only/owned-postgres'});
  await start;
  assert.deepEqual(fixture.commands, [{command: 'pg_ctl', args: ['-D', '/test-only/owned-postgres', '-m', 'fast', '-w', 'stop']}]);
  assert.equal(fixture.children.length, 0);
  assert.equal(fixture.runtime.exitCode, 0);
});

test('stopping during Pi readiness closes Pi and prevents Go and web launches', async () => {
  const fixture = launcherFixture(), entered = deferred(), ready = deferred();
  fixture.options.waitHttp = async () => { entered.resolve(); await ready.promise; throw new Error('Service exited before readiness'); };
  const start = runDevelopment(fixture.options);
  await entered.promise;
  fixture.runtime.emit('SIGTERM');
  ready.resolve();
  await start;
  assert.equal(fixture.children.length, 1);
  assert.deepEqual(fixture.children[0].args, ['apps/pi-worker/server.mjs']);
  assert.deepEqual(fixture.children[0].child.signals, ['SIGTERM']);
  assert.equal(fixture.runtime.exitCode, 0);
  assert.equal(fixture.messages.length, 0);
});

test('stopping during OpenAI Agents readiness closes both workers and prevents Go and web launches', async () => {
  const fixture = launcherFixture(), entered = deferred(), ready = deferred();
  let waits = 0;
  fixture.options.waitHttp = async () => {
    waits += 1;
    if (waits === 1) return;
    entered.resolve();
    await ready.promise;
    throw new Error('Service exited before readiness');
  };
  const start = runDevelopment(fixture.options);
  await entered.promise;
  fixture.runtime.emit('SIGTERM');
  ready.resolve();
  await start;
  assert.deepEqual(fixture.children.map(({args}) => args), [
    ['apps/pi-worker/server.mjs'],
    ['apps/openai-agents-worker/server.mjs'],
  ]);
  assert.ok(fixture.children.every(({child}) => child.signals.length === 1 && child.signals[0] === 'SIGTERM'));
  assert.equal(fixture.runtime.exitCode, 0);
  assert.equal(fixture.messages.length, 0);
});

test('normal startup launches every service and shutdown leaves a reused database running', async () => {
  const fixture = launcherFixture();
  fixture.options.loadEnv = async () => ({env: fixture.env, envFile: '/test-only/env', managedDatabase: true});
  fixture.options.startDb = async () => ({owned: false, data: '/test-only/existing-postgres'});
  await runDevelopment(fixture.options);
  assert.equal(fixture.children.length, 5);
  assert.deepEqual(fixture.waits.map(wait => wait.url), [
    `${fixture.env.AWWO_PI_URL}/health`, `${fixture.env.AWWO_OPENAI_AGENTS_URL}/health`, `${fixture.env.AWWO_OPENMAUS_URL}/health`, `${fixture.env.AWWO_API_TARGET}/api/v1/health`, fixture.env.AWWO_PUBLIC_ORIGIN,
  ]);
  assert.deepEqual(fixture.waits[0].options, {allowUnconfiguredPi: true});
  assert.deepEqual(fixture.waits[1].options, {allowUnconfiguredRuntime: 'openai-agents'});
  assert.equal(fixture.messages.length, 1);
  fixture.runtime.emit('SIGTERM');
  await fixture.stopped.promise;
  assert.ok(fixture.children.every(({child}) => child.signals.length === 1 && child.signals[0] === 'SIGTERM'));
  assert.deepEqual(fixture.commands.map(command => command.command), ['go']);
  assert.equal(fixture.runtime.exitCode, 0);
});

test('readiness failure exits with an error and cleans only its owned Pi and database', async () => {
  const fixture = launcherFixture();
  fixture.options.loadEnv = async () => ({env: fixture.env, envFile: '/test-only/env', managedDatabase: true});
  fixture.options.startDb = async () => ({owned: true, data: '/test-only/owned-postgres'});
  fixture.options.waitHttp = async () => { throw new Error('Pi readiness failed'); };
  await runDevelopment(fixture.options);
  assert.equal(fixture.runtime.exitCode, 1);
  assert.deepEqual(fixture.messages, ['Pi readiness failed']);
  assert.equal(fixture.children.length, 1);
  assert.deepEqual(fixture.children[0].child.signals, ['SIGTERM']);
  assert.deepEqual(fixture.commands.map(command => command.command), ['go', 'pg_ctl']);
  assert.deepEqual(fixture.commands[1].args, ['-D', '/test-only/owned-postgres', '-m', 'fast', '-w', 'stop']);
});

test('npm launches without a shell on Windows and is left untouched elsewhere', () => {
  // Forward slashes so this asserts the same thing whichever platform runs it; path handles both.
  const installed = 'C:/Users/dev/AppData/Roaming/npm/node_modules/npm/bin/npm-cli.js';
  // A shell is the thing to avoid here, not an inconvenience: run() also passes argument paths built
  // from the state directory, and this repository's own path contains a space and an apostrophe.
  const win = resolveCommand('npm', ['ci', '--prefix', 'apps/web'], 'win32', () => true, { npm_execpath: installed });
  assert.equal(win.command, process.execPath);
  assert.equal(win.args[0].endsWith('npm-cli.js'), true);
  assert.deepEqual(win.args.slice(1), ['ci', '--prefix', 'apps/web']);

  // npm_execpath always names npm-cli.js, so asking for npx must reach its sibling, never npm.
  const npx = resolveCommand('npx', ['tsc'], 'win32', () => true, { npm_execpath: installed });
  assert.equal(npx.args[0].endsWith('npx-cli.js'), true);

  // Other platforms resolve npm from PATH, and a real executable is never rewritten.
  assert.deepEqual(resolveCommand('npm', ['ci'], 'linux', () => true, {}), { command: 'npm', args: ['ci'] });
  assert.deepEqual(resolveCommand('go', ['build'], 'win32', () => true, {}), { command: 'go', args: ['build'] });

  // With no CLI anywhere, fail with the reason rather than a bare ENOENT from spawn.
  assert.throws(() => resolveCommand('npm', ['ci'], 'win32', () => false, { npm_execpath: installed }),
    /cannot be launched without a shell/);
});

// A Compose default is only a fallback: the shipped env files override it, so a knob raised in one
// place and left behind in another is deployed at the stale value with nothing reporting it. All four
// files that carry these knobs drifted at least once already, including the worker templates.
test('capacity and timeout knobs cannot drift between compose and the shipped templates', async () => {
  const read = async name => readFile(new URL(name, import.meta.url), 'utf8');
  const compose = await read('../deploy/saas/compose.yml');
  const deployment = parseEnv(await read('../deploy/saas/.env.example'));
  const templates = {
    pi: parseEnv(await read('../apps/pi-worker/.env.example')),
    'openai-agents': parseEnv(await read('../apps/openai-agents-worker/.env.example')),
  };
  const service = name => compose.split(/^ {2}(?=\S)/m).find(block => block.startsWith(`${name}:`)) ?? '';
  const fallback = (name, key) => new RegExp(`\\b${key}: \\$\\{${key}:-([^}]*)\\}`).exec(service(name))?.[1];
  for (const [name, key] of [['pi', 'AWWO_PI_CONTEXT_WINDOW'], ['pi', 'AWWO_PI_MAX_TOKENS'], ['pi', 'AWWO_PI_TIMEOUT_MS'],
    ['pi', 'AWWO_PI_MAX_CONCURRENCY'], ['pi', 'AWWO_PI_RELAY_MAX_CONCURRENCY'], ['pi', 'AWWO_PI_RELAY_TIMEOUT_MS'], ['api', 'AWWO_LOCAL_RELAY'], ['api', 'AWWO_RUN_TIMEOUT'], ['api', 'AWWO_GRAPH_NODE_RETRIES'], ['openai-agents', 'AWWO_OPENAI_AGENTS_CONTEXT_WINDOW'],
    ['openai-agents', 'AWWO_OPENAI_AGENTS_MAX_TOKENS'], ['openai-agents', 'AWWO_OPENAI_AGENTS_TIMEOUT_MS']]) {
    const configured = fallback(name, key);
    // Assert presence first: deleting a knob from both files would satisfy an equality check while
    // comparing nothing, which is how a guard silently stops guarding.
    assert.ok(configured, `${key} has no Compose default in the ${name} service`);
    assert.ok(deployment[key] !== undefined, `${key} is absent from deploy/saas/.env.example`);
    assert.equal(deployment[key], configured, key);
    const template = templates[name];
    if (template && template[key] !== undefined) assert.equal(template[key], configured, `${key} in the ${name} worker template`);
  }
  // One node contract runs on either runtime, so an output envelope that differs between them makes
  // the same deliverable succeed or fail on the binding alone.
  for (const knob of ['MAX_TOKENS', 'CONTEXT_WINDOW', 'TIMEOUT_MS']) {
    assert.equal(fallback('pi', `AWWO_PI_${knob}`), fallback('openai-agents', `AWWO_OPENAI_AGENTS_${knob}`), knob);
  }
  // Only Pi may name the Docker host. extra_hosts can reach a service literally or through a merge
  // key, so count every occurrence in the file rather than scanning service blocks alone: exactly one
  // occurrence that sits inside pi leaves no room for an anchor to grant it elsewhere.
  assert.equal((compose.match(/extra_hosts/g) ?? []).length, 1);
  assert.match(service('pi'), /extra_hosts:\n\s+- host\.docker\.internal:host-gateway\n/);
  // The API verifies personal credentials and sends recovery mail; web/database
  // still have no egress and the API receives no Docker-host mapping.
  assert.match(service('api'), /networks: \[private, egress\]\n/);
  for (const name of ['web', 'database']) assert.match(service(name), /networks: \[private\]\n/);
  assert.match(compose, /^ {2}private:\n {4}internal: true$/m);
});

test('identity and Jev settings reach only the API in Compose and local services', async () => {
  const compose = await readFile(new URL('../deploy/saas/compose.yml', import.meta.url), 'utf8');
  const deployment = parseEnv(await readFile(new URL('../deploy/saas/.env.example', import.meta.url), 'utf8'));
  const service = name => compose.split(/^ {2}(?=\S)/m).find(block => block.startsWith(`${name}:`)) ?? '';
  const settings = {
    AWWO_CLAWHUNT_URL: '', AWWO_CLAWHUNT_CLIENT_ID: '', AWWO_CLAWHUNT_CLIENT_SECRET: '',
    AWWO_TYPESAFE_SPONSORED_PLANNING: 'false', AWWO_TYPESAFE_API_KEY: '',
    AWWO_TYPESAFE_MODEL: 'jev-1.13.0', AWWO_TYPESAFE_ENABLED_TENANT_IDS: '',
    AWWO_TYPESAFE_TIMEOUT: '10s', AWWO_TYPESAFE_MAX_EVALUATIONS_PER_DAY: '20',
  };
  const synthetic = Object.fromEntries(Object.keys(settings).map(key => [key, `synthetic-${key}`]));
  const local = serviceEnvironments(synthetic);
  for (const [key, fallback] of Object.entries(settings)) {
    assert.equal(deployment[key], fallback, `${key} must retain a safe deployment default`);
    assert.ok(service('api').includes(`${key}: \${${key}:-${fallback}}`), `${key} must reach the API`);
    assert.equal(local.api[key], synthetic[key]);
    for (const name of ['pi', 'openai-agents', 'web', 'database']) assert.ok(!service(name).includes(key), `${key} leaked to ${name}`);
    for (const target of [local.pi, local.openAIAgents, local.web, local.build]) assert.equal(target[key], undefined);
  }
});

// A Bedrock key is a model credential: it may reach the workers that call Bedrock and
// nothing else, while the platform policy must agree between the API and both workers.
test('Bedrock settings reach only the workers and the platform policy reaches the API too', async () => {
  const compose = await readFile(new URL('../deploy/saas/compose.yml', import.meta.url), 'utf8');
  const service = name => compose.split(/^ {2}(?=\S)/m).find(block => block.startsWith(`${name}:`)) ?? '';
  const aws = { AWS_ACCESS_KEY_ID: 'ASIASYNTHETIC0000000', AWS_SECRET_ACCESS_KEY: 'synthetic-secret', AWS_SESSION_TOKEN: 'synthetic-session',
    AWS_PROFILE: 'synthetic-profile', AWS_BEARER_TOKEN_BEDROCK: 'synthetic-bearer' };
  const local = serviceEnvironments({ AWWO_BEDROCK_CATALOG: 'builtin', AWWO_BEDROCK_REGION: 'us-east-2', AWWO_BEDROCK_API_KEY: 'synthetic-bedrock-key',
    AWWO_PI_BEDROCK_MODELS: 'bedrock.gemma-3-27b', AWWO_OPENAI_AGENTS_BEDROCK_MODELS: 'bedrock.glm-5', AWWO_PLATFORM_PROVIDERS: 'llmgate,bedrock', ...aws });
  // Ambient AWS credentials are model credentials too: workers only.
  for (const [key, value] of Object.entries(aws)) {
    assert.equal(local.pi[key], value, key);
    assert.equal(local.openAIAgents[key], value, key);
    for (const target of [local.api, local.web, local.build, local.openMaus]) assert.equal(target[key], undefined, `${key} leaked`);
  }
  for (const [target, models] of [[local.pi, 'bedrock.gemma-3-27b'], [local.openAIAgents, 'bedrock.glm-5']]) {
    assert.equal(target.AWWO_BEDROCK_CATALOG, 'builtin');
    assert.equal(target.AWWO_BEDROCK_REGION, 'us-east-2');
    assert.equal(target.AWWO_BEDROCK_API_KEY, 'synthetic-bedrock-key');
    assert.equal(target.AWWO_BEDROCK_MODELS, models);
    assert.equal(target.AWWO_PLATFORM_PROVIDERS, 'llmgate,bedrock');
    assert.equal(target.AWWO_PI_BEDROCK_MODELS, undefined);
    assert.equal(target.AWWO_OPENAI_AGENTS_BEDROCK_MODELS, undefined);
  }
  assert.equal(local.api.AWWO_PLATFORM_PROVIDERS, 'llmgate,bedrock');
  for (const target of [local.api, local.web, local.build, local.openMaus]) {
    for (const key of ['AWWO_BEDROCK_CATALOG', 'AWWO_BEDROCK_REGION', 'AWWO_BEDROCK_API_KEY', 'AWWO_BEDROCK_MODELS']) assert.equal(target[key], undefined, key);
  }
  for (const [name, models] of [['pi', 'AWWO_PI_BEDROCK_MODELS'], ['openai-agents', 'AWWO_OPENAI_AGENTS_BEDROCK_MODELS']]) {
    for (const key of ['AWWO_BEDROCK_CATALOG', 'AWWO_BEDROCK_REGION', 'AWWO_BEDROCK_API_KEY', 'AWWO_PLATFORM_PROVIDERS']) {
      assert.ok(service(name).includes(`${key}: \${${key}:-}`), `${key} must reach the ${name} worker`);
    }
    assert.ok(service(name).includes(`AWWO_BEDROCK_MODELS: \${${models}:-}`), `${name} reads its own Bedrock selection`);
  }
  assert.ok(service('api').includes('AWWO_PLATFORM_PROVIDERS: ${AWWO_PLATFORM_PROVIDERS:-}'));
  for (const name of ['api', 'web', 'database', 'openmaus']) assert.ok(!service(name).includes('AWWO_BEDROCK_'), `Bedrock settings leaked to ${name}`);
});

// The RunningHub key pays for generations: it reaches the API alone, and the media directory is
// set only together with it, on the volume that keeps generated files.
test('RunningHub settings reach only the API with its media volume', async () => {
  const compose = await readFile(new URL('../deploy/saas/compose.yml', import.meta.url), 'utf8');
  const service = name => compose.split(/^ {2}(?=\S)/m).find(block => block.startsWith(`${name}:`)) ?? '';
  assert.ok(service('api').includes('AWWO_RUNNINGHUB_API_KEY: ${AWWO_RUNNINGHUB_API_KEY:-}'));
  assert.ok(service('api').includes('AWWO_MEDIA_DIR: ${AWWO_RUNNINGHUB_API_KEY:+/var/lib/awwo/media}'));
  // Media for workspaces without an allowlist is an explicit operator choice, off by default.
  assert.ok(service('api').includes('AWWO_MEDIA_UNRESTRICTED_WORKSPACES: ${AWWO_MEDIA_UNRESTRICTED_WORKSPACES:-false}'));
  // A submission in flight is awaited at shutdown (30s client timeout), so the API gets longer to stop.
  assert.match(service('api'), /stop_grace_period: 45s\n/);
  assert.match(service('api'), /volumes:\n\s+- media-data:\/var\/lib\/awwo\/media\n/);
  assert.match(compose, /^volumes:\n {2}postgres-data:\n {2}media-data:\n/m);
  for (const name of ['pi', 'openai-agents', 'openmaus', 'web', 'database']) {
    assert.ok(!service(name).includes('RUNNINGHUB') && !service(name).includes('AWWO_MEDIA_'), `media settings leaked to ${name}`);
  }
  const local = serviceEnvironments({ AWWO_RUNNINGHUB_API_KEY: 'synthetic-rh-key', AWWO_MEDIA_DIR: '/tmp/awwo-media', AWWO_MEDIA_RUNS_PER_DAY: '5' });
  assert.equal(local.api.AWWO_RUNNINGHUB_API_KEY, 'synthetic-rh-key');
  assert.equal(local.api.AWWO_MEDIA_DIR, '/tmp/awwo-media');
  for (const target of [local.pi, local.openAIAgents, local.openMaus, local.web, local.build]) {
    assert.equal(target.AWWO_RUNNINGHUB_API_KEY, undefined);
    assert.equal(target.AWWO_MEDIA_DIR, undefined);
  }
  const dockerfile = await readFile(new URL('../deploy/saas/api.Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /chown 65532:65532 \/var\/lib\/awwo\/media/);
});

// The deployment template carries these only as commented examples, so Compose must
// forward an empty value, which the API reads as unset.
test('new-workspace defaults reach only the API and default to unset', async () => {
  const compose = await readFile(new URL('../deploy/saas/compose.yml', import.meta.url), 'utf8');
  const service = name => compose.split(/^ {2}(?=\S)/m).find(block => block.startsWith(`${name}:`)) ?? '';
  for (const key of ['AWWO_NEW_WORKSPACE_ALLOWED_MODELS', 'AWWO_NEW_WORKSPACE_MAX_RUNS_PER_DAY', 'AWWO_MAX_OWNED_WORKSPACES']) {
    assert.ok(service('api').includes(`${key}: \${${key}:-}`), `${key} must reach the API, unset by default`);
    for (const name of ['pi', 'openai-agents', 'web', 'database']) assert.ok(!service(name).includes(key), `${key} leaked to ${name}`);
    const local = serviceEnvironments({ [key]: 'synthetic' });
    assert.equal(local.api[key], 'synthetic');
    for (const target of [local.pi, local.openAIAgents, local.web, local.build]) assert.equal(target[key], undefined);
  }
});

test('personal vault and mail credentials stay API-only while both workers share the mode', () => {
  const env = serviceEnvironments({ PATH: '/usr/bin', AWWO_CREDENTIAL_MODE: 'user', AWWO_CREDENTIAL_ENCRYPTION_KEY: 'synthetic-vault-key', AWWO_SMTP_PASSWORD: 'synthetic-mail-password' });
  for (const target of [env.pi, env.openAIAgents]) assert.equal(target.AWWO_CREDENTIAL_MODE, 'user');
  for (const target of [env.web, env.build, env.pi, env.openAIAgents]) {
    assert.equal(target.AWWO_CREDENTIAL_ENCRYPTION_KEY, undefined);
    assert.equal(target.AWWO_SMTP_PASSWORD, undefined);
  }
  assert.equal(env.api.AWWO_CREDENTIAL_ENCRYPTION_KEY, 'synthetic-vault-key');
  assert.equal(env.api.AWWO_SMTP_PASSWORD, 'synthetic-mail-password');
});

const repositoryPath = file => path.join(root, file);
// The files under a folder of the repository, dot files too (a COPY takes them), but installed packages and .git.
const repositoryFiles = dir => readdirSync(repositoryPath(dir), { withFileTypes: true }).flatMap(entry => entry.name === '.git'
  || entry.name === 'node_modules' ? [] : entry.isDirectory() ? repositoryFiles(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
// A folder of the repository and every folder in it, but installed packages and .git.
const repositoryFolders = dir => [dir, ...readdirSync(repositoryPath(dir), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules')
  .flatMap(entry => repositoryFolders(path.posix.join(dir, entry.name)))];
// Whether the repository holds a path spelled exactly so: Windows also finds apps/CONTEXT-ESTIMATE.ts, BuildKit on Linux not.
const spelled = file => file.split('/').every((name, i, parts) => readdirSync(repositoryPath(parts.slice(0, i).join('/') || '.')).includes(name));
// A path and each folder it is in.
const withFolders = file => file.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')).reverse();
// A COPY source or an rm argument as a regular expression (a .dockerignore pattern is read by ignorePattern).
const globRegExp = glob => new RegExp('^' + glob.replace(/[.+^${}()|\\]/g, '\\$&')
  .replace(/\*\*\/|\*\*$|\*|\?/g, part => ({ '**/': '(.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[part]) + '$');
// A Dockerfile's instructions as Docker reads them: comment and blank lines left out (also inside a continued
// instruction), lines ending in a backslash (and blanks) joined, in any case or indent.
const dockerInstructions = text => text.split(/\r?\n/).filter(line => !/^\s*(#|$)/.test(line)).join('\n').replace(/\\[ \t]*\n/g, ' ')
  .split('\n').map(line => line.trim().split(/\s+/)).filter(([word]) => word).map(([word, ...args]) => [word.toUpperCase(), args]);

// A .dockerignore's patterns as BuildKit reads them (ignorefile.ReadAll): a comment is a line that starts with # before any
// blank is trimmed, and a pattern loses its blanks and a leading or trailing /.
const ignoreRules = text => text.split(/\r?\n/).filter(line => !line.startsWith('#')).map(line => line.trim()).filter(Boolean)
  .map(line => ({ keep: line.startsWith('!'), pattern: path.posix.normalize(line.replace(/^!\s*/, '')).replace(/^\/+|\/+$/g, '') }));
// The .dockerignore BuildKit reads for a Dockerfile: the Dockerfile's own beside it, else the build context's.
const contextIgnoreFile = dockerfile => (existsSync(repositoryPath(`${dockerfile}.dockerignore`)) ? `${dockerfile}.dockerignore` : '.dockerignore');

// A .dockerignore pattern as moby/patternmatcher matches a path with it (Pattern.compile and match, with / for the
// separator): a pattern without wildcards exactly, one ending in ** as a prefix, ** and then no other wildcard as a
// suffix (**.mjs is any path ending in .mjs), and any other as an expression in which ** is any folders (anything at the
// end), * and ? stop at /, a class and ^ are left as they are, . + ( ) | { } $ are literal and . stops at a line break;
// ? and a class take one character, not one UTF-16 unit, as in Go. What Go and JavaScript read differently fails the test
// instead: an escaped letter or digit (\s, \d), a class that starts with ] and a POSIX class ([:space:]).
function ignorePattern(pattern) {
  assert.ok(!/\[\^?\]|\[:/.test(pattern), `the test cannot read the class in the .dockerignore pattern ${pattern}; teach it`);
  let source = '^', kind = 'exact';
  for (let i = 0, at = 0; at < pattern.length; i++) {
    const ch = pattern[at++];
    if (ch === '*' && pattern[at] === '*') {
      at += pattern[at + 1] === '/' ? 2 : 1;
      if (at < pattern.length) [source, kind] = [`${source}([^\n]*/)?`, 'regexp'];
      else if (kind === 'exact') kind = 'prefix';
      else [source, kind] = [`${source}[^\n]*`, 'regexp'];
      if (i === 0) kind = 'suffix';
    } else if (ch === '*' || ch === '?') [source, kind] = [source + (ch === '*' ? '[^/]*' : '[^/]'), 'regexp'];
    else if ('.+()|{}$'.includes(ch)) source += `\\${ch}`;
    else if (ch === '\\' && at < pattern.length) {
      assert.ok(!/[\p{L}\p{N}]/u.test(pattern[at]), `the test cannot read the escape \\${pattern[at]} in the .dockerignore pattern ${pattern}; teach it`);
      [source, kind] = [`${source}\\${pattern[at++]}`, 'regexp'];
    }
    else if (ch === '[' || ch === ']') [source, kind] = [source + ch, 'regexp'];
    else source += ch === '\\' ? '\\\\' : ch;
  }
  if (kind === 'exact') return name => name === pattern;
  if (kind === 'prefix') return name => name.startsWith(pattern.slice(0, -2));
  if (kind === 'suffix') return name => name.endsWith(pattern.slice(2)) || (pattern[2] === '/' && name === pattern.slice(3));
  const expression = new RegExp(`${source}$`, 'u');
  return name => expression.test(name);
}

// What a .dockerignore leaves out of the build context, as BuildKit's walker reads it (moby/patternmatcher's
// MatchesUsingParentResults): folder by folder from the top, the last pattern that applies decides and a "!" one lets the
// path in; a pattern that matched a folder applies to what is in it, but one passed over at a folder (it could not change
// it) is not handed down. (awwo-saas-release.test.ts reads the API image's with MatchesOrParentMatches, which agrees there.)
function dockerignored(text) {
  const rules = ignoreRules(text).map(({ keep, pattern }) => ({ keep, match: ignorePattern(pattern) }));
  return file => {
    let inherited = [], out = false;
    for (const name of withFolders(file).reverse()) {
      const matched = [];
      out = false;
      rules.forEach(({ keep, match }, i) => {
        if (!inherited[i]) {
          if (keep !== out) return;
          matched[i] = match(name);
          if (!matched[i]) return;
        }
        matched[i] = true;
        out = !keep;
      });
      inherited = matched;
    }
    return out;
  };
}

// What the last stage of a Dockerfile holds from the build context (the repository): a path in the image -> the file
// copied there, COPY by COPY through the .dockerignore, less what an rm of a RUN takes out again; and the script its CMD
// runs. What another stage builds (COPY --from) is not read. A RUN there must be plain rm commands, or npm ci / npm install
// with --ignore-scripts and only the flags below, joined by &&; anything else (a cd, npm run, a quote, ;, ||, a comment,
// sh -c), npm with an .npmrc copied in or npm_config_ set by ENV or ARG, or a last stage that starts FROM an earlier one or
// a variable, fails the test rather than be guessed at.
function workerImage(dockerfile) {
  const { posix } = path;
  const ignored = dockerignored(readFileSync(repositoryPath(contextIgnoreFile(dockerfile)), 'utf8'));
  const instructions = dockerInstructions(readFileSync(repositoryPath(dockerfile), 'utf8'));
  const last = Math.max(0, instructions.findLastIndex(([word]) => word === 'FROM'));
  const stages = instructions.slice(0, last).filter(([word, args]) => word === 'FROM' && args.at(-2)?.toUpperCase() === 'AS').map(([, args]) => args.at(-1).toLowerCase());
  const base = instructions[last]?.[1].find(arg => !arg.startsWith('--'))?.toLowerCase() ?? '';
  assert.ok(!base.includes('$') && !stages.includes(base), `${dockerfile}: its last stage starts FROM ${base}, an earlier stage or a variable the test does not read`);
  let workdir = '/', cmd = [];
  const held = new Map();
  for (const [word, args] of instructions.slice(last)) {
    if (word === 'WORKDIR') workdir = posix.resolve(workdir, args[0]);
    else if (word === 'CMD') cmd = args[0]?.startsWith('[') ? JSON.parse(args.join(' ')) : args;
    else if (word === 'ENV' || word === 'ARG') assert.ok(!/npm_config_/i.test(args.join(' ')), `${dockerfile}: ${word} ${args.join(' ')} sets npm's configuration, which the test does not read`);
    else if (word === 'RUN') {
      const commands = args.join(' ').split(' && ').map(command => command.split(' '));
      const npm = ([verb, ...rest]) => verb === 'npm' && ['ci', 'install'].includes(rest[0]) && rest.includes('--ignore-scripts')
        && rest.slice(1).every(flag => ['--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'].includes(flag));
      assert.ok(!/[^\w ./*?=@+,:-]/.test(commands.flat().join(' ')) && commands.every(command => command[0] === 'rm' || npm(command))
        && !(commands.some(npm) && [...held.keys()].some(file => /(^|\/)\.?npmrc$/.test(file))),
      `${dockerfile}: the test cannot read RUN ${args.join(' ')}; keep a worker image's last stage to rm and npm ci --ignore-scripts, or teach it`);
      for (const gone of commands.filter(([verb]) => verb === 'rm').flatMap(([, ...paths]) => paths).filter(arg => arg && !arg.startsWith('-'))
        .map(arg => globRegExp(posix.resolve(workdir, arg)))) {
        for (const file of [...held.keys()]) if (withFolders(file).some(name => gone.test(name))) held.delete(file);
      }
    } else if (word === 'COPY' && !args.some(arg => arg.startsWith('--from='))) {
      const paths = args.filter(arg => !arg.startsWith('--')), target = paths.at(-1), sources = paths.slice(0, -1);
      const to = posix.resolve(workdir, target), intoFolder = sources.length > 1 || target.endsWith('/') || sources.some(source => /[*?]/.test(source));
      for (const source of sources) {
        const clean = posix.normalize(source).replace(/\/+$/, ''), folder = posix.dirname(clean);
        const found = /[*?]/.test(clean) ? readdirSync(repositoryPath(folder)).filter(name => globRegExp(posix.basename(clean)).test(name)).map(name => `${folder}/${name}`) : [clean];
        const copied = found.filter(spelled).flatMap(match => statSync(repositoryPath(match)).isDirectory()
          ? repositoryFiles(match).filter(file => !ignored(file)).map(file => [posix.join(to, file.slice(match.length + 1)), file])
          : ignored(match) ? [] : [[intoFolder ? posix.join(to, posix.basename(match)) : to, match]]);
        assert.ok(copied.length, `${dockerfile}: COPY ${source} takes nothing from the build context`);
        for (const [file, from] of copied) held.set(file, from);
      }
    }
  }
  return { held, entry: posix.resolve(workdir, cmd.find(arg => /\.[cm]?[jt]s$/.test(arg)) ?? '.') };
}

// What a script loads by a path relative to itself: its imports, re-exports and dynamic imports of a string, the files it
// opens with new URL(..., import.meta.url), and a script or JSON file beside it that it names by its name or a relative
// path (join(WORKER_DIR, 'mcp-shim.ts') starts one). One in a comment, or a type-only import (which Node erases), counts too:
// telling them apart by pattern let a real import hide, while counting them only ever fails the test, loudly. A load the
// patterns cannot read (import( of anything but one string, a comment where the path should be, new URL of a computed path,
// require, import.meta.resolve) fails it too.
function relativeLoads(file) {
  const text = readFileSync(repositoryPath(file), 'utf8');
  const unreadable = new RegExp([/\bimport\s*\(\s*(?!['"])/, /\bimport\s*\(\s*(?:'[^'\n]*'|"[^"\n]*")\s*(?![),])/, /\b(?:from|import)\s*\/[*/]/,
    /\bnew\s+URL\s*\(\s*(?!['"])[^)]*import\.meta\.url/, /\bnew\s+URL\s*\(\s*(?:'[^'\n]*'|"[^"\n]*")\s*(?!,)[^)]*import\.meta\.url/, /\bimport\.meta\.resolve\(/,
    /\brequire\(/].map(pattern => pattern.source).join('|')).exec(text);
  if (unreadable) assert.fail(`${file}:${text.slice(0, unreadable.index).split('\n').length}: the test cannot read ${JSON.stringify(unreadable[0])}; `
    + "load a file beside the worker with import('<path>'), from '<path>' or new URL('<path>', import.meta.url), or teach it");
  const imports = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"\n]+)\1|\bnew\s+URL\s*\(\s*(['"])(\.\.?\/[^'"\n]+)\3\s*,\s*import\.meta\.url\s*\)/g)]
    .map(match => match[2] ?? match[4]);
  const named = [...text.matchAll(/(['"])((?:\.\.?\/)*[\w.-]+(?:\/[\w.-]+)*\.(?:[cm]?[jt]s|json))\1/g)].map(match => match[2].startsWith('../') || match[2].startsWith('./') ? match[2] : `./${match[2]}`)
    .filter(name => spelled(path.posix.join(path.posix.dirname(file), name)));
  return { imports, named };
}

// Every Dockerfile under deploy/ that copies a worker. Compose and CI build these three, on both mains; Forgejo's main also
// has the AgentCore trial's.
function workerDockerfiles() {
  const images = repositoryFiles('deploy').filter(file => /(^|[/.])Dockerfile$/.test(file) && dockerInstructions(readFileSync(repositoryPath(file), 'utf8'))
    .some(([word, args]) => word === 'COPY' && args.some(arg => /^apps\/[\w-]+-worker(\/|$)/.test(path.posix.normalize(arg)))));
  for (const image of ['deploy/saas/pi.Dockerfile', 'deploy/saas/openai-agents.Dockerfile', 'deploy/saas/openmaus.Dockerfile']) assert.ok(images.includes(image), image);
  return images;
}

// A worker image copies what its worker loads beside its folder one file at a time, and an image that misses one still
// builds: the worker fails as it starts or, for a module it imports on a failure, at that failure (the Pi and OpenAI Agents
// images lacked context-estimate.ts and context-overflow.ts from 2026-10-21 to 2026-10-23). So what each script an image
// holds loads (tests aside) must be a file the image holds. Every Dockerfile under deploy/ that copies a worker is read.
test('every worker image holds the files its scripts import, open or start', () => {
  const missing = [], named = new Set();
  for (const dockerfile of workerDockerfiles()) {
    const { held, entry } = workerImage(dockerfile), outside = [];
    assert.ok(held.has(entry), `${dockerfile}: its CMD runs ${entry}, which it does not hold`);
    for (const [file, from] of held) {
      if (!/\.[cm]?[jt]s$/.test(from) || /\.test\.[cm]?[jt]s$/.test(from)) continue;
      const loads = relativeLoads(from);
      for (const name of loads.named) named.add(path.posix.join(path.posix.dirname(from), name));
      for (const specifier of new Set([...loads.imports, ...loads.named])) {
        const target = path.posix.resolve(path.posix.dirname(file), specifier);
        if (loads.imports.includes(specifier) && !target.startsWith(`${path.posix.dirname(entry)}/`)) outside.push(target);
        if (!held.has(target)) missing.push(`${dockerfile}: ${from} (${file}) loads ${specifier}, and the image has no ${target}`);
      }
    }
    // Imports out of the folder of the script the image runs were read: the check did not pass on nothing.
    assert.ok(outside.length, `${dockerfile}: no import out of ${path.posix.dirname(entry)} was read`);
  }
  // And the script the managed execution starts by its name was read so.
  assert.ok(named.has('apps/openmaus-worker/mcp-shim.ts'), 'no script started by its name was read');
  assert.deepEqual(missing, []);
});

// A checkout holds files git does not: a worker's own settings (.env, .env.local, ...: gitignored, real keys in them) and
// the packages npm installed for the host (node_modules: Windows or macOS builds of native ones). A worker image's build
// context must take neither: COPY apps/pi-worker/ ./ bakes the settings into the image (the AgentCore trial's build pushes
// it to ECR) and lays the host's packages over the ones npm ci installed, as "!apps/" let both into the Pi, OpenAI Agents
// and managed execution images until 2026-10-23. So both are planted, in several cases of their names (BuildKit tells
// .ENV from .env, Windows and macOS by default do not), in every folder a "!" pattern of the image's .dockerignore
// reaches, in a folder of the checkout's own in each (.local) and beside the .env files the folder already holds, and
// where each "!" pattern lets them in itself (fitted below); the context may take none of them. That .dockerignore must
// leave everything out first (**), so that what its "!" patterns reach is all the context can take. Not covered, by the
// patterns or by the test: a folder whose name holds a line break (BuildKit's . stops at one, while [^/], * and a
// pattern's trailing /** take it), which no checkout gets by accident.
test("no worker image's build context takes a checkout's .env files or installed packages", () => {
  const planted = ['.env', '.env.local', '.env.production', '.envrc', '.ENV', '.Env.local', 'node_modules', 'node_modules/.bin/tsc',
    'node_modules/pkg/package.json', 'node_modules/pkg/index.js', 'node_modules/pkg/index.mjs', 'node_modules/pkg/index.ts',
    'node_modules/@scope/pkg/node_modules/dep/index.mjs', 'NODE_MODULES/pkg/index.js', 'Node_Modules/pkg/index.mjs'];
  // A pattern's text with each wildcard made a plain name: ** one folder (x/) or a name, * and ? x, a class its first
  // member (a negated one x, which the proof below refuses where the class leaves x out).
  const plain = text => text.replace(/\[(\^?)(.)[^\]]*\]|\*\*\/|\*\*|[*?]/g, (part, negated, member) => (member === undefined
    ? (part === '**/' ? 'x/' : 'x') : negated ? 'x' : member));
  // A name with its letters in every case (.env: 8 names).
  const everyCase = name => [...name].reduce((names, ch) => names.flatMap(start => [...new Set([start + ch.toLowerCase(), start + ch.toUpperCase()])]), ['']);
  // What a "!" pattern lets in itself of a checkout's own files: a .env, in every case, named to fit its last name where
  // one can be (.env.mjs, .Env.mjs, ... for *.mjs, .envax.mjs for [a-z.]*.mjs; each kept only if the pattern alone lets it
  // in), and node_modules/pkg (in lower, upper and title case) and a .envs folder (in every case) at its first ** (as
  // folders of their own), or else in a folder named to fit the pattern (x.mjs/node_modules/pkg/x). Each folder probe is
  // proved to be one: the pattern alone lets it in, and it lies in such a folder; one that cannot be fitted to a pattern
  // fails the test rather than leave the pattern untried.
  const fitted = pattern => {
    const alone = dockerignored(`**\n!${pattern}`), last = pattern.split('/').at(-1), recursive = pattern.indexOf('**');
    const base = plain(pattern.slice(0, -last.length));
    const named = [...new Set([plain(last), `.env${plain(last)}`, `.env${plain(last.replace(/^[*?]+/, ''))}`])].filter(name => name.startsWith('.env'))
      .flatMap(name => everyCase('.env').map(start => start + name.slice(4))).map(name => base + name).filter(file => !alone(file));
    const folders = [...['node_modules', 'NODE_MODULES', 'Node_Modules'].map(name => `${name}/pkg`), ...everyCase('.envs')].map(folder => (recursive < 0 ? `${plain(pattern)}/${folder}/x`
      : plain(pattern.slice(0, recursive)).replace(/[^/]$/, '$&x/') + folder + plain(pattern.slice(recursive + 2)).replace(/^(?=[^/])/, '/')));
    for (const file of folders) assert.ok(!alone(file) && /(^|\/)(node_modules|\.envs)\//i.test(`${file}/`), `cannot fit a probe to "!${pattern}" (${file}): teach the test`);
    return [...named, ...folders];
  };
  const taken = [];
  for (const dockerfile of workerDockerfiles()) {
    const ignoreFile = contextIgnoreFile(dockerfile), text = readFileSync(repositoryPath(ignoreFile), 'utf8'), rules = ignoreRules(text);
    assert.ok(rules[0]?.pattern === '**' && !rules[0].keep, `${dockerfile}: ${ignoreFile} must leave everything out first (**), so that its "!" patterns name all its context takes`);
    const allowed = rules.filter(({ keep }) => keep).map(({ pattern }) => pattern);
    // A "!" pattern reaches the folder its path starts in, up to its first wildcard, and every folder of the repository in
    // that; one without a wildcard, the folder it names and those in it, or the folder of the file it names.
    const reached = new Set(allowed.flatMap(pattern => {
      const wildcard = pattern.search(/[*?[]/);
      const start = wildcard < 0 ? pattern : pattern.slice(0, wildcard).replace(/\/?[^/]*$/, '') || '.';
      if (!existsSync(repositoryPath(start))) return [start];
      return statSync(repositoryPath(start)).isDirectory() ? repositoryFolders(start) : [path.posix.dirname(start)];
    }));
    // Every folder the image copies a file from was planted in: the check did not pass on nothing.
    for (const from of workerImage(dockerfile).held.values()) assert.ok(reached.has(path.posix.dirname(from)), `${dockerfile}: ${path.posix.dirname(from)} was not planted in`);
    const ignored = dockerignored(text), names = [...planted, ...planted.map(file => `.local/${file}`)];
    const files = [...[...reached].flatMap(folder => [...names, ...(existsSync(repositoryPath(folder))
      ? readdirSync(repositoryPath(folder)).filter(name => /^\.env/i.test(name)) : [])].map(name => path.posix.join(folder, name))), ...allowed.flatMap(fitted)];
    for (const file of files) if (!ignored(file)) taken.push(`${dockerfile}: ${file}`);
  }
  // Listed, not diffed: a pattern such as "!third_party/" takes tens of thousands of them.
  assert.equal(taken.length, 0, `the build contexts take ${taken.length} of them:\n${taken.slice(0, 40).join('\n')}${taken.length > 40 ? '\n...' : ''}`);
});
