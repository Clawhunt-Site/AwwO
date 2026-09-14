import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { parseEnv, port, resolveCommand, serviceEnvironments, waitForHttp } from './awwo-saas-lib.mjs';
import { runDevelopment } from './awwo-saas-dev.mjs';
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
    AWWO_API_PORT:'18087', AWWO_PI_PORT:'18097', AWWO_OPENAI_AGENTS_PORT:'18098', VITE_AWWO_WEB_PORT:'15189',
    AWWO_PI_URL:'http://127.0.0.1:18097', AWWO_OPENAI_AGENTS_URL:'http://127.0.0.1:18098', AWWO_API_TARGET:'http://127.0.0.1:18087', AWWO_PUBLIC_ORIGIN:'http://127.0.0.1:15189',
  };
  const options = {
    runtime, logger: { log: value => messages.push(value), error: value => messages.push(value) },
    loadEnv: async () => ({ env, envFile: '/test-only/env', managedDatabase: false }),
    assertFree: async () => {},
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
  assert.equal(fixture.children.length, 4);
  assert.deepEqual(fixture.waits.map(wait => wait.url), [
    `${fixture.env.AWWO_PI_URL}/health`, `${fixture.env.AWWO_OPENAI_AGENTS_URL}/health`, `${fixture.env.AWWO_API_TARGET}/api/v1/health`, fixture.env.AWWO_PUBLIC_ORIGIN,
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
