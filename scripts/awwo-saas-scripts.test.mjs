import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { parseEnv, port, waitForHttp } from './awwo-saas-lib.mjs';
import { runDevelopment } from './awwo-saas-dev.mjs';
test('local dotenv reads literal values without executing shell expressions', () => {
  assert.deepEqual(parseEnv('# comment\nMODEL=abc\nKEY="a=b"\nEMPTY=\nLITERAL=$(touch danger)\n'), { MODEL:'abc',KEY:'a=b',EMPTY:'',LITERAL:'$(touch danger)' });
  assert.throws(() => parseEnv('export KEY=x'));
});
test('local startup accepts an explicitly unconfigured Pi, but rejects unrelated unavailable services', async () => {
  let body = { status:'unconfigured', ready:false, configured:false, piVersion:'0.85.1' };
  const server = createServer((_req,res) => { res.writeHead(503, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/health`;
    await waitForHttp(url, {exitCode:null}, 300, {allowUnconfiguredPi:true});
    await assert.rejects(waitForHttp(url,{exitCode:null},200), /timed out/);
    body = { status:'stopping', ready:false, configured:false, piVersion:'0.85.1' };
    await assert.rejects(waitForHttp(url,{exitCode:null},200,{allowUnconfiguredPi:true}), /timed out/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('ports reject command fragments, privileged and out of range values', () => {
  assert.equal(port('8087','port'),8087);
  for (const value of ['80','0','65536','8087 -h 0.0.0.0','NaN','1.5']) assert.throws(() => port(value,'port'));
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
    AWWO_API_PORT:'18087', AWWO_PI_PORT:'18097', VITE_AWWO_WEB_PORT:'15189',
    AWWO_PI_URL:'http://127.0.0.1:18097', AWWO_API_TARGET:'http://127.0.0.1:18087', AWWO_PUBLIC_ORIGIN:'http://127.0.0.1:15189',
  };
  const options = {
    runtime, logger: { log: value => messages.push(value), error: value => messages.push(value) },
    loadEnv: async () => ({ env, envFile: '/test-only/env', managedDatabase: false }),
    assertFree: async () => {},
    startDb: async () => { throw new Error('This test must not start PostgreSQL'); },
    runCommand: async (command, args) => { commands.push({command, args}); },
    waitHttp: async (url, _child, _timeout, options) => { waits.push({url, options}); },
    spawnChild: (command, args) => {
      const child = new EventEmitter();
      child.exitCode = null; child.signalCode = null; child.signals = [];
      child.kill = signal => { child.signals.push(signal); child.signalCode = signal; child.emit('exit', null, signal); };
      children.push({command, args, child});
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

test('normal startup launches every service and shutdown leaves a reused database running', async () => {
  const fixture = launcherFixture();
  fixture.options.loadEnv = async () => ({env: fixture.env, envFile: '/test-only/env', managedDatabase: true});
  fixture.options.startDb = async () => ({owned: false, data: '/test-only/existing-postgres'});
  await runDevelopment(fixture.options);
  assert.equal(fixture.children.length, 3);
  assert.deepEqual(fixture.waits.map(wait => wait.url), [
    `${fixture.env.AWWO_PI_URL}/health`, `${fixture.env.AWWO_API_TARGET}/api/v1/health`, fixture.env.AWWO_PUBLIC_ORIGIN,
  ]);
  assert.deepEqual(fixture.waits[0].options, {allowUnconfiguredPi: true});
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
