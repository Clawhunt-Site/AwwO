import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createDevConfig, waitForHealth, assertPortsAvailable, prepareRuntime, runCommand } from './awwo-dev.mjs';
import { setup } from './awwo-setup.mjs';
import * as installer from './awwo-setup.mjs';
import * as launcher from './awwo-dev.mjs';

test('a relocated checkout isolates state and connects all three services without a sidecar', () => {
  const root = resolve('another checkout with spaces');
  const config = createDevConfig(root, {});
  assert.equal(config.env.PAPERCLIP_HOME, join(root, '.local', 'awwo', 'runtime'));
  assert.equal(config.env.SUPERCLAW_HOME, join(root, '.local', 'awwo', 'gateway'));
  assert.equal(config.env.PAPERCLIP_CONFIG, join(root, '.local', 'awwo', 'runtime', 'instances', 'default', 'config.json'));
  assert.equal(config.env.SUPERCLAW_GATEWAY_UPSTREAM_URL, 'http://127.0.0.1:3100');
  assert.equal(config.env.VITE_GATEWAY_API_TARGET, 'http://127.0.0.1:8796');
  assert.equal(config.env.VITE_SUPERCLAW_WEB_PORT, '5188');
  assert.equal(config.env.SUPERCLAW_GATEWAY_SIDECAR, 'off');
  assert.equal(config.env.SUPERCLAW_DESKTOP_PGLITE, '0');
  assert.equal(config.env.HEARTBEAT_SCHEDULER_ENABLED, 'false');
  assert.equal(config.env.APP_ENV, 'development');
  assert.equal(config.env.VITE_APP_ENV, 'development');
});

test('explicit local ports, isolated homes and Codex settings survive relocation', () => {
  const config = createDevConfig(resolve('new root'), {
    PORT: '3201', SUPERCLAW_GATEWAY_PORT: '8897', VITE_SUPERCLAW_WEB_PORT: '5289',
    PAPERCLIP_HOME: resolve('state/runtime'), SUPERCLAW_HOME: resolve('state/gateway'),
    CODEX_HOME: resolve('codex-login'), SUPERCLAW_CANVAS_PLANNER_CLI_PATH: resolve('tools/codex.exe'),
    DATABASE_URL: 'postgres://localhost:5432/awwo_dev',
  });
  assert.equal(config.env.VITE_NODE_API_TARGET, 'http://127.0.0.1:3201');
  assert.equal(config.env.SUPERCLAW_GATEWAY_UPSTREAM_URL, 'http://127.0.0.1:3201');
  assert.equal(config.env.VITE_GATEWAY_API_TARGET, 'http://127.0.0.1:8897');
  assert.equal(config.env.CODEX_HOME, resolve('codex-login'));
  assert.equal(config.env.DATABASE_URL, 'postgres://localhost:5432/awwo_dev');
});

test('the local launcher refuses production, remote endpoints and inconsistent proxy targets', () => {
  for (const env of [
    { APP_ENV: 'production' }, { VITE_APP_ENV: 'staging' },
    { HOST: '0.0.0.0' }, { DATABASE_URL: 'postgres://db.example.com/production' },
    { SUPERCLAW_DESKTOP_PGLITE: '1' },
    { SUPERCLAW_GATEWAY_UPSTREAM_URL: 'http://127.0.0.1:9999' },
    { VITE_GATEWAY_API_TARGET: 'http://example.com:8796' },
    { PORT: '8796' }, { PORT: 'not-a-port' },
  ]) assert.throws(() => createDevConfig(resolve('new root'), env));
});

test('runtime preparation creates a private ignore boundary without replacing it on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awwo-test-'));
  try {
    const config = createDevConfig(root, {});
    await prepareRuntime(config);
    const before = await readFile(join(root, '.local', 'awwo', '.gitignore'), 'utf8');
    await prepareRuntime(config);
    assert.equal(before, '*\n');
    assert.equal(await readFile(join(root, '.local', 'awwo', '.gitignore'), 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed child command rejects with its real exit status', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' }), /exit 7/);
});

test('setup stops at a failing install, before later installs or a success claim', async () => {
  const seen = [];
  await assert.rejects(setup({
    root: resolve('another checkout'),
    env: {},
    execute: async (command, args) => {
      seen.push([command, ...args]);
      if (args.includes('install')) throw new Error('frozen lock failed');
      return args.includes('--version') ? '9.15.4' : '';
    },
  }), /frozen lock failed/);
  assert.equal(seen.some((args) => args.includes('ci')), false);
});

test('setup rejects a mismatched package manager before installing anything', async () => {
  const seen = [];
  await assert.rejects(setup({ root: resolve('another checkout'), env: {}, execute: async (_command, args) => {
    seen.push(args);
    return '10.0.0';
  } }), /9\.15\.4/);
  assert.equal(seen.some((args) => args.includes('install')), false);
});

test('setup validates the server workspace package manager instead of the global default', async () => {
  await setup({ root: resolve('another checkout'), env: {}, execute: async (_command, args) => {
    if (args.includes('--version')) return args[0] === '-C' && args[1] === 'server' ? '9.15.4' : '10.30.0';
    return '';
  } });
});

test('setup enforces the installed web dependency Node range', () => {
  assert.equal(typeof installer.assertNodeVersion, 'function');
  for (const version of ['22.13.0', '22.16.0', '24.0.0', '26.1.0']) installer.assertNodeVersion(version);
  for (const version of ['20.19.0', '22.12.0', '23.5.0']) {
    assert.throws(() => installer.assertNodeVersion(version), /22\.13/);
  }
});

test('readiness requires healthy upstream and never mistakes a pre-existing listener for our service', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, upstream: { reachable: false, status: null } }));
  });
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  const port = server.address().port;
  try {
    await assert.rejects(assertPortsAvailable([{ host: '127.0.0.1', port }]), /in use/);
    await assert.rejects(waitForHealth(`http://127.0.0.1:${port}`, {
      timeoutMs: 120, intervalMs: 10, gateway: true,
    }), /not ready/);
  } finally { await new Promise((accept) => server.close(accept)); }
});

test('an aborted startup stops its pending health poll promptly', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await assert.rejects(waitForHealth('http://127.0.0.1:1/health', {
    timeoutMs: 2000, intervalMs: 10, signal: controller.signal,
  }), /aborted/i);
  assert.ok(Date.now() - started < 500);
});

test('owned child services receive graceful IPC shutdown before process termination', async () => {
  assert.equal(typeof launcher.stopChild, 'function');
  const child = spawn(process.execPath, ['-e', `
    process.on('message', (message) => {
      if (message === 'awwo:shutdown') { process.send('cleaned'); process.exit(0); }
    });
    process.send('ready');
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  try {
    await once(child, 'message');
    let cleaned = false;
    child.on('message', (message) => { if (message === 'cleaned') cleaned = true; });
    await launcher.stopChild(child, 2000);
    assert.equal(cleaned, true);
    assert.equal(child.exitCode, 0);
  } finally { if (child.exitCode === null) child.kill(); }
});
