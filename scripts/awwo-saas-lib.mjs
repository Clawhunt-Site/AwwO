import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const stateDir = path.join(root, '.local', 'awwo-saas');
export function parseEnv(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error('Invalid environment configuration line');
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}
export function port(value, name) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1024 || Number(value) > 65535) throw new Error(`${name} must be a port from 1024 to 65535`);
  return Number(value);
}
function modelCredentialNames(env, catalogName) {
  const value = env[catalogName];
  if (!value) return [];
  let profiles;
  try { profiles = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(profiles)) return [];
  return profiles.flatMap(profile => profile && typeof profile.apiKeyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv)
    ? [profile.apiKeyEnv] : []);
}
/** Give each long-running local service only its own AwwO configuration and model credentials. */
export function serviceEnvironments(env) {
  const piCredentials = new Set(['AWWO_PI_API_KEY', ...modelCredentialNames(env, 'AWWO_PI_MODELS_JSON')]);
  const openAIAgentsCredentials = new Set(['AWWO_OPENAI_AGENTS_API_KEY', ...modelCredentialNames(env, 'AWWO_OPENAI_AGENTS_MODELS_JSON')]);
  const modelCredentials = new Set([...piCredentials, ...openAIAgentsCredentials, 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
  const base = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('AWWO_') && !key.startsWith('VITE_AWWO_') && !key.startsWith('OTEL_') && !modelCredentials.has(key)));
  const select = predicate => Object.fromEntries(Object.entries(env).filter(([key]) => predicate(key) && !modelCredentials.has(key)));
  const telemetry = select(key => ['AWWO_METRICS_ENABLED','AWWO_OTEL_ENABLED','AWWO_REVISION','OTEL_EXPORTER_OTLP_ENDPOINT','OTEL_SERVICE_NAME','OTEL_RESOURCE_ATTRIBUTES','OTEL_TRACES_SAMPLER','OTEL_TRACES_SAMPLER_ARG'].includes(key) || key.startsWith('AWWO_TRACE_REF_'));
  // One dotenv drives three processes, each with its own loopback listener.
  // The general address is the API address; worker overrides are launcher-only.
  const pi = { ...base, ...telemetry, AWWO_CREDENTIAL_MODE: env.AWWO_CREDENTIAL_MODE, OTEL_SERVICE_NAME: 'awwo-pi-worker', ...select(key => key.startsWith('AWWO_PI_')) };
  if (env.AWWO_LOCAL_PI_METRICS_LISTEN_ADDR) pi.AWWO_METRICS_LISTEN_ADDR = env.AWWO_LOCAL_PI_METRICS_LISTEN_ADDR;
  const openAIAgents = { ...base, ...telemetry, AWWO_CREDENTIAL_MODE: env.AWWO_CREDENTIAL_MODE, OTEL_SERVICE_NAME: 'awwo-openai-agents-worker', ...select(key => key.startsWith('AWWO_OPENAI_AGENTS_')) };
  if (env.AWWO_LOCAL_OPENAI_AGENTS_METRICS_LISTEN_ADDR) openAIAgents.AWWO_METRICS_LISTEN_ADDR = env.AWWO_LOCAL_OPENAI_AGENTS_METRICS_LISTEN_ADDR;
  for (const key of piCredentials) if (Object.hasOwn(env, key)) pi[key] = env[key];
  for (const key of openAIAgentsCredentials) if (Object.hasOwn(env, key)) openAIAgents[key] = env[key];
  const api = { ...base, ...telemetry, OTEL_SERVICE_NAME: 'awwo-api', ...select(key => key.startsWith('AWWO_')
    && !key.startsWith('AWWO_PI_') && !key.startsWith('AWWO_OPENAI_AGENTS_')
    && key !== 'AWWO_LOCAL_DB_PASSWORD'),
    ...select(key => ['AWWO_PI_URL', 'AWWO_PI_TOKEN', 'AWWO_PI_SESSION_WAIT', 'AWWO_OPENAI_AGENTS_URL', 'AWWO_OPENAI_AGENTS_TOKEN'].includes(key)) };
  const web = { ...base, ...select(key => key.startsWith('VITE_AWWO_') || key === 'AWWO_API_TARGET') };
  return { build: base, pi, openAIAgents, api, web };
}
export async function exists(file) { try { await access(file); return true; } catch { return false; } }
export async function loadLocalEnv(environment = process.env) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const envFile = path.join(stateDir, '.env');
  let saved = {};
  if (await exists(envFile)) saved = parseEnv(await readFile(envFile, 'utf8'));
  if ((environment.APP_ENV || saved.APP_ENV || 'development') !== 'development') throw new Error('This launcher is for local development. Use the SaaS deployment configuration for staging/production.');
  const fresh = {};
  for (const name of ['AWWO_LOCAL_DB_PASSWORD', 'AWWO_PI_TOKEN', 'AWWO_OPENAI_AGENTS_TOKEN', 'AWWO_BOOTSTRAP_ADMIN_PASSWORD']) {
    if (!environment[name] && !saved[name]) fresh[name] = randomBytes(32).toString('base64url');
  }
  if (!environment.AWWO_CREDENTIAL_ENCRYPTION_KEY && !saved.AWWO_CREDENTIAL_ENCRYPTION_KEY) fresh.AWWO_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  if (!environment.AWWO_CREDENTIAL_MODE && !saved.AWWO_CREDENTIAL_MODE) fresh.AWWO_CREDENTIAL_MODE = 'user';
  if (!environment.AWWO_BOOTSTRAP_ADMIN_EMAIL && !saved.AWWO_BOOTSTRAP_ADMIN_EMAIL) fresh.AWWO_BOOTSTRAP_ADMIN_EMAIL = 'admin@awwo.local';
  if (Object.keys(fresh).length) {
    const content = await exists(envFile) ? await readFile(envFile, 'utf8') : '# Local development only. Do not commit or share this file.\n';
    await writeFile(envFile, content.trimEnd() + '\n' + Object.entries(fresh).map(([k,v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  }
  const env = { ...saved, ...fresh, ...environment, APP_ENV: 'development' };
  const dbPort = port(env.AWWO_LOCAL_DB_PORT || '55483', 'AWWO_LOCAL_DB_PORT');
  const apiPort = port(env.AWWO_API_PORT || '8087', 'AWWO_API_PORT');
  const piPort = port(env.AWWO_PI_PORT || '8097', 'AWWO_PI_PORT');
  const openAIAgentsPort = port(env.AWWO_OPENAI_AGENTS_PORT || '8098', 'AWWO_OPENAI_AGENTS_PORT');
  const webPort = port(env.VITE_AWWO_WEB_PORT || '5189', 'VITE_AWWO_WEB_PORT');
  if (new Set([dbPort, apiPort, piPort, openAIAgentsPort, webPort]).size !== 5) throw new Error('Local service ports must be distinct');
  const defaults = {
    AWWO_LOCAL_DB_PORT: String(dbPort), AWWO_API_PORT: String(apiPort), AWWO_PI_PORT: String(piPort), AWWO_OPENAI_AGENTS_PORT: String(openAIAgentsPort),
    VITE_AWWO_WEB_PORT: String(webPort), VITE_AWWO_WEB_HOST: '127.0.0.1',
    AWWO_LISTEN_ADDR: `127.0.0.1:${apiPort}`, AWWO_PUBLIC_ORIGIN: `http://127.0.0.1:${webPort}`,
    AWWO_API_TARGET: `http://127.0.0.1:${apiPort}`, AWWO_PI_URL: `http://127.0.0.1:${piPort}`, AWWO_PI_HOST: '127.0.0.1',
    AWWO_OPENAI_AGENTS_URL: `http://127.0.0.1:${openAIAgentsPort}`, AWWO_OPENAI_AGENTS_HOST: '127.0.0.1',
    AWWO_DATABASE_URL: `postgres://awwo:${encodeURIComponent(env.AWWO_LOCAL_DB_PASSWORD)}@127.0.0.1:${dbPort}/awwo?sslmode=disable`,
  };
  const resolved = { ...defaults, ...env };
  for (const key of ['AWWO_PUBLIC_ORIGIN','AWWO_API_TARGET','AWWO_PI_URL','AWWO_OPENAI_AGENTS_URL','AWWO_DATABASE_URL']) {
    const url = new URL(resolved[key]);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`${key} must be loopback for local development`);
  }
  if (!/^127\.0\.0\.1:\d+$/.test(resolved.AWWO_LISTEN_ADDR) || resolved.AWWO_PI_HOST !== '127.0.0.1' || resolved.AWWO_OPENAI_AGENTS_HOST !== '127.0.0.1' || resolved.VITE_AWWO_WEB_HOST !== '127.0.0.1') throw new Error('Local services must listen on 127.0.0.1');
  return { env: resolved, envFile, managedDatabase: !environment.AWWO_DATABASE_URL && !saved.AWWO_DATABASE_URL };
}
// Windows ships npm as npm.cmd, and since the fix for CVE-2024-27980 Node refuses to spawn a .cmd
// without a shell, so setup:saas failed here with a bare ENOENT. Enabling a shell is the worse
// trade: run() also carries argument paths built from stateDir, and this repository's own directory
// contains a space and an apostrophe, so shell quoting would become a live hazard for every caller.
// Running npm's own JS entry point under this same Node needs no shell and cannot be misquoted.
// Takes platform and a probe so both branches are testable without a Windows host.
export function resolveCommand(command, args, platform = process.platform, present = existsSync, environment = process.env) {
  if (platform !== 'win32' || !/^(npm|npx)$/.test(command)) return { command, args };
  // npm sets npm_execpath for its own lifecycle scripts, and these launchers are npm scripts, so
  // this finds the npm actually in use under nvm, volta, corepack or a user-level install. The
  // bundled tree beside the node binary is only a fallback, and on this machine it is a different
  // npm than the one running.
  const candidates = [];
  const running = environment.npm_execpath;
  // Take the directory, not the file: npm_execpath always names npm-cli.js, and npx-cli.js is its
  // sibling, so asking for npx must not silently launch npm.
  if (running && running.endsWith('.js')) candidates.push(path.join(path.dirname(running), `${command}-cli.js`));
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${command}-cli.js`));
  const cli = candidates.find(file => present(file));
  if (!cli) {
    throw new Error(`${command} cannot be launched without a shell on Windows and no ${command}-cli.js was found (looked in ${candidates.join(', ')}); run ${command} directly instead`);
  }
  return { command: process.execPath, args: [cli, ...args] };
}
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let resolved;
    try {
      resolved = resolveCommand(command, args);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(resolved.command, resolved.args, { cwd: root, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code ?? signal})`)));
  });
}
export function assertPortFree(p) {
  return new Promise((resolve,reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${p} is occupied; the existing process will not be stopped`)));
    server.listen(p, '127.0.0.1', () => server.close(resolve));
  });
}
export async function startDatabase(env) {
  const data = path.join(stateDir, 'postgres');
  if (spawnSync('pg_ctl', ['-D', data, 'status'], { stdio: 'ignore' }).status === 0) return { owned: false, data };
  await assertPortFree(Number(env.AWWO_LOCAL_DB_PORT));
  if (!(await exists(path.join(data, 'PG_VERSION')))) {
    const passwordFile = path.join(stateDir, 'postgres-password');
    await writeFile(passwordFile, env.AWWO_LOCAL_DB_PASSWORD + '\n', { mode: 0o600 });
    await run('initdb', ['-D', data, '-U', 'awwo', '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C', '--pwfile', passwordFile]);
  }
  await run('pg_ctl', ['-D', data, '-l', path.join(stateDir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${env.AWWO_LOCAL_DB_PORT} -k ''`, '-w', 'start']);
  try {
    const connectionEnv = { ...env, PGHOST: '127.0.0.1', PGPORT: env.AWWO_LOCAL_DB_PORT, PGUSER: 'awwo', PGPASSWORD: env.AWWO_LOCAL_DB_PASSWORD };
    const check = spawnSync('psql', ['-d', 'postgres', '-Atc', "SELECT 1 FROM pg_database WHERE datname = 'awwo'"], { env: connectionEnv, encoding:'utf8', timeout:15000 });
    if (check.status !== 0) throw new Error('Cannot verify the local PostgreSQL database');
    if (check.stdout.trim() !== '1') await run('createdb', ['awwo'], { env: connectionEnv });
  } catch (error) {
    await run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']).catch(() => console.error('Failed to stop the newly started local database; inspect its dedicated data directory.'));
    throw error;
  }
  return { owned: true, data };
}
export async function waitForHttp(url, child, timeout = 30000, { allowUnconfiguredPi = false, allowUnconfiguredRuntime = '' } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error('Service exited before readiness');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      if (allowUnconfiguredPi && response.status === 503) {
        const health = await response.json();
        if (health.status === 'unconfigured' && health.ready === false && health.configured === false && typeof health.piVersion === 'string') return;
      }
      if (allowUnconfiguredRuntime && response.status === 503) {
        const health = await response.json();
        if (health.status === 'unconfigured' && health.ready === false && health.configured === false && health.runtime === allowUnconfiguredRuntime) return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Service readiness timed out: ${url}`);
}
