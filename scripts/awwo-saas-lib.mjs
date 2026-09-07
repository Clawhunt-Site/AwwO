import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
export async function exists(file) { try { await access(file); return true; } catch { return false; } }
export async function loadLocalEnv(environment = process.env) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const envFile = path.join(stateDir, '.env');
  let saved = {};
  if (await exists(envFile)) saved = parseEnv(await readFile(envFile, 'utf8'));
  if ((environment.APP_ENV || saved.APP_ENV || 'development') !== 'development') throw new Error('This launcher is for local development. Use the SaaS deployment configuration for staging/production.');
  const fresh = {};
  for (const name of ['AWWO_LOCAL_DB_PASSWORD', 'AWWO_PI_TOKEN', 'AWWO_BOOTSTRAP_ADMIN_PASSWORD']) {
    if (!environment[name] && !saved[name]) fresh[name] = randomBytes(32).toString('base64url');
  }
  if (!environment.AWWO_BOOTSTRAP_ADMIN_EMAIL && !saved.AWWO_BOOTSTRAP_ADMIN_EMAIL) fresh.AWWO_BOOTSTRAP_ADMIN_EMAIL = 'admin@awwo.local';
  if (Object.keys(fresh).length) {
    const content = await exists(envFile) ? await readFile(envFile, 'utf8') : '# Local development only. Do not commit or share this file.\n';
    await writeFile(envFile, content.trimEnd() + '\n' + Object.entries(fresh).map(([k,v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  }
  const env = { ...saved, ...fresh, ...environment, APP_ENV: 'development' };
  const dbPort = port(env.AWWO_LOCAL_DB_PORT || '55483', 'AWWO_LOCAL_DB_PORT');
  const apiPort = port(env.AWWO_API_PORT || '8087', 'AWWO_API_PORT');
  const piPort = port(env.AWWO_PI_PORT || '8097', 'AWWO_PI_PORT');
  const webPort = port(env.VITE_AWWO_WEB_PORT || '5189', 'VITE_AWWO_WEB_PORT');
  if (new Set([dbPort, apiPort, piPort, webPort]).size !== 4) throw new Error('Local service ports must be distinct');
  const defaults = {
    AWWO_LOCAL_DB_PORT: String(dbPort), AWWO_API_PORT: String(apiPort), AWWO_PI_PORT: String(piPort),
    VITE_AWWO_WEB_PORT: String(webPort), VITE_AWWO_WEB_HOST: '127.0.0.1',
    AWWO_LISTEN_ADDR: `127.0.0.1:${apiPort}`, AWWO_PUBLIC_ORIGIN: `http://127.0.0.1:${webPort}`,
    AWWO_API_TARGET: `http://127.0.0.1:${apiPort}`, AWWO_PI_URL: `http://127.0.0.1:${piPort}`, AWWO_PI_HOST: '127.0.0.1',
    AWWO_DATABASE_URL: `postgres://awwo:${encodeURIComponent(env.AWWO_LOCAL_DB_PASSWORD)}@127.0.0.1:${dbPort}/awwo?sslmode=disable`,
  };
  const resolved = { ...defaults, ...env };
  for (const key of ['AWWO_PUBLIC_ORIGIN','AWWO_API_TARGET','AWWO_PI_URL','AWWO_DATABASE_URL']) {
    const url = new URL(resolved[key]);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`${key} must be loopback for local development`);
  }
  if (!/^127\.0\.0\.1:\d+$/.test(resolved.AWWO_LISTEN_ADDR) || resolved.AWWO_PI_HOST !== '127.0.0.1' || resolved.VITE_AWWO_WEB_HOST !== '127.0.0.1') throw new Error('Local services must listen on 127.0.0.1');
  return { env: resolved, envFile, managedDatabase: !environment.AWWO_DATABASE_URL && !saved.AWWO_DATABASE_URL };
}
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
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
export async function waitForHttp(url, child, timeout = 30000, { allowUnconfiguredPi = false } = {}) {
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
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Service readiness timed out: ${url}`);
}
