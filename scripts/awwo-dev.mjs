import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = (ms) => new Promise((accept) => setTimeout(accept, ms));
const localHost = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
const absolute = (root, value) => resolve(root, value.replace(/^~(?=$|[\\/])/, homedir()));

export function loadEnvironment(root, inherited = process.env) {
  const file = join(root, '.local', 'awwo', '.env');
  return { ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...inherited };
}

function port(value, fallback) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Invalid local service port.');
  return n;
}

function localUrl(value, label, protocols = ['http:']) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a local URL.`); }
  if (!protocols.includes(parsed.protocol) || !localHost(parsed.hostname)) {
    throw new Error(`${label} must point to a dedicated loopback development service.`);
  }
  return parsed;
}

export function createDevConfig(root, inherited = process.env) {
  root = resolve(root);
  const env = { ...inherited };
  for (const key of ['APP_ENV', 'VITE_APP_ENV']) {
    if (env[key] && env[key].trim().toLowerCase() !== 'development') {
      throw new Error(`${key}: this launcher is for local development only.`);
    }
  }
  if (['1', 'true'].includes(env.SUPERCLAW_DESKTOP_PGLITE?.toLowerCase())) {
    throw new Error('This launcher requires native PostgreSQL; unset SUPERCLAW_DESKTOP_PGLITE.');
  }
  for (const key of ['DATABASE_URL', 'DATABASE_MIGRATION_URL']) {
    if (env[key]) localUrl(env[key], key, ['postgres:', 'postgresql:']);
  }
  const host = env.HOST || '127.0.0.1';
  const gatewayHost = env.SUPERCLAW_GATEWAY_HOST || '127.0.0.1';
  const webHost = env.VITE_SUPERCLAW_WEB_HOST || '127.0.0.1';
  for (const value of [host, gatewayHost, webHost]) {
    if (!localHost(value)) throw new Error('The local launcher only binds loopback addresses.');
  }
  const nodePort = port(env.PORT, 3100);
  const gatewayPort = port(env.SUPERCLAW_GATEWAY_PORT || env.VITE_GATEWAY_PORT, 8796);
  const webPort = port(env.VITE_SUPERCLAW_WEB_PORT, 5188);
  if (new Set([nodePort, gatewayPort, webPort]).size !== 3) throw new Error('Service ports must be distinct.');
  const url = (hostName, value) => `http://${hostName.includes(':') && !hostName.startsWith('[') ? `[${hostName}]` : hostName}:${value}`;
  const nodeUrl = url(host, nodePort);
  const gatewayUrl = url(gatewayHost, gatewayPort);
  for (const [key, expectedPort] of [
    ['SUPERCLAW_GATEWAY_UPSTREAM_URL', nodePort], ['VITE_NODE_API_TARGET', nodePort],
    ['VITE_PAPERCLIP_API_TARGET', nodePort], ['VITE_GATEWAY_API_TARGET', gatewayPort],
  ]) {
    if (!env[key]) continue;
    const value = localUrl(env[key], key);
    if (Number(value.port || 80) !== expectedPort || value.pathname !== '/' || value.search || value.hash || value.username || value.password) {
      throw new Error(`${key} does not match the service port. Set the listen port and proxy target together.`);
    }
  }
  const stateDir = join(root, '.local', 'awwo');
  const runtimeHome = absolute(root, env.PAPERCLIP_HOME || join(stateDir, 'runtime'));
  const instance = env.PAPERCLIP_INSTANCE_ID || 'default';
  if (!/^[A-Za-z0-9_-]+$/.test(instance)) throw new Error('Invalid local instance ID.');
  const configPath = absolute(root, env.PAPERCLIP_CONFIG || join(runtimeHome, 'instances', instance, 'config.json'));
  if (existsSync(configPath)) {
    let config;
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch { throw new Error('The selected local runtime config is invalid JSON.'); }
    if (config.database?.connectionString) localUrl(config.database.connectionString, 'config.database.connectionString', ['postgres:', 'postgresql:']);
  }
  Object.assign(env, {
    APP_ENV: 'development', VITE_APP_ENV: 'development',
    PAPERCLIP_HOME: runtimeHome, PAPERCLIP_CONFIG: configPath, PAPERCLIP_INSTANCE_ID: instance,
    PAPERCLIP_IN_WORKTREE: 'false', PAPERCLIP_DEPLOYMENT_MODE: 'local_trusted',
    PAPERCLIP_DEPLOYMENT_EXPOSURE: 'private', PAPERCLIP_BIND: 'loopback',
    PAPERCLIP_LOG_DIR: absolute(root, env.PAPERCLIP_LOG_DIR || join(stateDir, 'logs')),
    PAPERCLIP_STORAGE_LOCAL_DIR: absolute(root, env.PAPERCLIP_STORAGE_LOCAL_DIR || join(stateDir, 'storage')),
    PAPERCLIP_STORAGE_PROVIDER: 'local_disk',
    SUPERCLAW_HOME: absolute(root, env.SUPERCLAW_HOME || join(stateDir, 'gateway')),
    SUPERCLAW_DESKTOP_PGLITE: '0', SERVE_UI: 'false',
    HEARTBEAT_SCHEDULER_ENABLED: 'false', PAPERCLIP_DB_BACKUP_ENABLED: 'false',
    PAPERCLIP_TELEMETRY_DISABLED: '1', PAPERCLIP_OPEN_ON_LISTEN: 'false',
    PAPERCLIP_MIGRATION_AUTO_APPLY: 'true', PAPERCLIP_MIGRATION_PROMPT: 'never',
    HOST: host, PORT: String(nodePort),
    SUPERCLAW_GATEWAY_HOST: gatewayHost, SUPERCLAW_GATEWAY_PORT: String(gatewayPort),
    SUPERCLAW_GATEWAY_UPSTREAM_URL: env.SUPERCLAW_GATEWAY_UPSTREAM_URL || nodeUrl,
    VITE_NODE_API_TARGET: env.VITE_NODE_API_TARGET || nodeUrl,
    VITE_GATEWAY_API_TARGET: env.VITE_GATEWAY_API_TARGET || gatewayUrl,
    VITE_SUPERCLAW_WEB_HOST: webHost, VITE_SUPERCLAW_WEB_PORT: String(webPort),
    SUPERCLAW_GATEWAY_SIDECAR: 'off',
  });
  return {
    root, stateDir, env, nodeUrl, gatewayUrl, webUrl: url(webHost, webPort),
    ports: [{ host, port: nodePort }, { host: gatewayHost, port: gatewayPort }, { host: webHost, port: webPort }],
  };
}

export async function prepareRuntime(config) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(config.stateDir, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  for (const directory of [config.env.PAPERCLIP_HOME, dirname(config.env.PAPERCLIP_CONFIG), config.env.SUPERCLAW_HOME]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

export function runCommand(command, args, options = {}) {
  const { capture = false, packageManager = false, ...spawnOptions } = options;
  // Only fixed package-manager arguments cross cmd.exe on Windows. Runtime paths
  // are always passed directly to node.exe without shell interpretation.
  if (packageManager && (!['npm', 'pnpm'].includes(command) || args.some((arg) => !/^[A-Za-z0-9@/_:.=-]+$/.test(arg)))) {
    throw new Error('Unsupported package-manager command.');
  }
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true, shell: packageManager && process.platform === 'win32', ...spawnOptions,
    });
    let output = '';
    if (capture) {
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', () => {});
    }
    child.once('error', () => reject(new Error(`Unable to launch ${command}. Check that the required tool is installed.`)));
    child.once('exit', (code, signal) => {
      if (code === 0) accept(output.trim());
      else reject(new Error(`${command} failed (exit ${code ?? signal}).`));
    });
  });
}

export async function assertPortsAvailable(ports) {
  for (const endpoint of ports) {
    await new Promise((accept, reject) => {
      const server = createServer();
      server.once('error', () => reject(new Error(`Port ${endpoint.port} is in use or unavailable; no existing process was stopped.`)));
      server.listen({ ...endpoint, exclusive: true }, () => server.close(accept));
    });
  }
}

export async function waitForHealth(url, { timeoutMs = 120_000, intervalMs = 500, gateway = false, html = false, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Startup health check aborted.');
    try {
      const timeout = AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now())));
      const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      if (response.ok) {
        if (html) { await response.arrayBuffer(); return; }
        const body = await response.json();
        if (gateway ? body.ok === true && body.upstream?.reachable === true : body.status === 'ok' || body.ok === true) return;
      }
    } catch { /* A starting service may not accept connections yet. */ }
    await pause(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Service not ready: ${url}`);
}

export function stopChild(child, graceMs = 10_000) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((accept) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, graceMs);
    child.once('exit', () => { clearTimeout(timer); accept(); });
    const terminate = () => { try { child.kill('SIGTERM'); } catch { clearTimeout(timer); accept(); } };
    if (child.connected) child.send('awwo:shutdown', (error) => { if (error) terminate(); });
    else terminate();
  });
}

// IPC lets Windows request the service's own shutdown instead of hard-killing
// node.exe before the native PostgreSQL child has been stopped.
async function runManagedService(kind) {
  let ready = false;
  let requested = false;
  let stopping = false;
  let stop;
  const request = () => {
    requested = true;
    if (!ready || stopping) return;
    stopping = true;
    void stop();
  };
  process.on('message', (message) => { if (message === 'awwo:shutdown') request(); });
  if (kind === 'control-plane') {
    // Upstream installs its own signal hooks once startup completes.
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { requested = true; if (ready) stopping = true; });
    const { startServer } = await import(pathToFileURL(join(repositoryRoot, 'server', 'server', 'src', 'index.ts')).href);
    await startServer();
    stop = () => process.emit('SIGTERM');
  } else {
    const { startGateway } = await import(pathToFileURL(join(repositoryRoot, 'apps', 'gateway', 'dist', 'index.js')).href);
    const runtime = await startGateway();
    stop = async () => { await runtime.stop(); process.exit(0); };
    process.once('SIGINT', request);
    process.once('SIGTERM', request);
  }
  ready = true;
  if (requested && !stopping) request();
}

export async function startDevelopment(root = repositoryRoot, inherited = process.env) {
  const config = createDevConfig(root, loadEnvironment(root, inherited));
  const tsx = join(root, 'server', 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const tsxLoader = join(root, 'server', 'server', 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const cliTsx = join(root, 'server', 'cli', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const gateway = join(root, 'apps', 'gateway', 'dist', 'index.js');
  const vite = join(root, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js');
  for (const file of [tsx, tsxLoader, cliTsx, gateway, vite, join(root, 'server', 'packages', 'plugins', 'sdk', 'dist', 'index.js')]) {
    if (!existsSync(file)) throw new Error('Dependencies or build outputs are missing. Run npm run setup first.');
  }
  await assertPortsAvailable(config.ports);
  await prepareRuntime(config);
  const jwtModule = pathToFileURL(join(root, 'server', 'cli', 'src', 'config', 'env.ts')).href;
  const initialize = `import(${JSON.stringify(jwtModule)}).then(({ ensureAgentJwtSecret }) => { ensureAgentJwtSecret(process.env.PAPERCLIP_CONFIG); });`;
  await runCommand(process.execPath, [cliTsx, '-e', initialize], { cwd: config.stateDir, env: config.env, capture: true });

  const children = [];
  const startup = new AbortController();
  let stopping = false;
  let stopped;
  let failed;
  const failure = new Promise((_accept, reject) => { failed = reject; });
  failure.catch(() => {});
  const stop = () => {
    if (stopped) return stopped;
    stopping = true;
    startup.abort();
    stopped = Promise.all(children.map((child) => stopChild(child)));
    return stopped;
  };
  const onSignal = () => { failed(new Error('Local development stopped.')); void stop(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const launch = (name, args, cwd, ipc = false) => {
    const child = spawn(process.execPath, args, { cwd, env: config.env, stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', windowsHide: true });
    children.push(child);
    child.once('error', () => failed(new Error(`${name} could not start.`)));
    child.once('exit', (code, signal) => {
      if (!stopping) failed(new Error(`${name} stopped unexpectedly (exit ${code ?? signal}).`));
    });
  };
  try {
    const entry = join(root, 'scripts', 'awwo-dev.mjs');
    launch('Control plane', ['--import', pathToFileURL(tsxLoader).href, entry, '--control-plane'], config.stateDir, true);
    await Promise.race([waitForHealth(`${config.nodeUrl}/api/health`, { signal: startup.signal }), failure]);
    launch('Gateway', [entry, '--gateway'], config.stateDir, true);
    await Promise.race([waitForHealth(`${config.gatewayUrl}/health`, { gateway: true, signal: startup.signal }), failure]);
    launch('Web', [vite, '--configLoader', 'runner', '--config', 'vite.config.mjs', '--strictPort'], join(root, 'apps', 'web'));
    await Promise.race([waitForHealth(config.webUrl, { html: true, signal: startup.signal }), failure]);
    console.log(`\nAwwO ready: ${config.webUrl}\nControl plane: ${config.nodeUrl}\nGateway: ${config.gatewayUrl}\nRuntime: ${config.stateDir}\nNo Agent job was submitted. Press Ctrl+C to stop.\n`);
    await failure;
  } finally {
    await stop();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--control-plane') || process.argv.includes('--gateway')) {
    runManagedService(process.argv.includes('--control-plane') ? 'control-plane' : 'gateway').catch((error) => {
      console.error(`[AwwO] Service startup failed: ${error.message}`);
      process.exit(1);
    });
  } else if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/awwo-dev.mjs\nStarts local AwwO at 5188 + gateway 8796 + control plane 3100.\nSee docs/awwo-development.md for isolated state and environment overrides.');
  } else {
    startDevelopment().catch((error) => { console.error(`[AwwO] ${error.message}`); process.exitCode = error.message === 'Local development stopped.' ? 0 : 1; });
  }
}
