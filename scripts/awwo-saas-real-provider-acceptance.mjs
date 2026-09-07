// Opt-in real inference acceptance. Never starts a fake provider or falls back to fixtures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv, root, stateDir } from './awwo-saas-lib.mjs';
import { loadConfig } from '../apps/pi-worker/config.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(value).digest('hex');
const forbiddenPorts = new Set([5189, 8087, 8097, 55483]);
export function inspectProviderConfig(values) {
  let config;
  try { config = loadConfig({ ...values, AWWO_PI_TOKEN: 'acceptance-internal-token-placeholder', AWWO_PI_PORT: '0', AWWO_PI_MAX_TOKENS: values.AWWO_PI_MAX_TOKENS || '512' }); }
  catch { return { status: 'FAIL', reason: 'Invalid project Pi runtime configuration' }; }
  if (!config.ready) return { status: 'BLOCKED', missing: config.missing.filter(name => name !== 'AWWO_PI_TOKEN') };
  if (/fixture|stack-test|mock|fake/i.test(config.model)) return { status: 'FAIL', reason: 'A fixture/mock model cannot be accepted as real inference' };
  return { status: 'READY', provider: config.provider, model: config.model, externalInferencePerformed: false };
}
export async function readProjectConfig(file = path.join(stateDir, '.env')) {
  const projectRoot = await realpath(root), selected = await realpath(path.resolve(root, file));
  if (!selected.startsWith(projectRoot + path.sep)) throw new Error('Provider configuration must be a file inside this project');
  let saved = {};
  try { saved = parseEnv(await readFile(path.join(stateDir, '.env'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid local project configuration'); }
  // Provider selection is file-only: ambient API keys from another shell/project never count.
  const values = { ...saved, ...parseEnv(await readFile(selected, 'utf8')) };
  return { values, report: inspectProviderConfig(values), selected };
}
function child(command, args, options = {}) {
  const p = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...options });
  p.startError = null; p.on('error', () => { p.startError = true; });
  for (const stream of [p.stdout, p.stderr]) stream.on('data', () => {}); // Never print environment/DSN/provider errors.
  return p;
}
async function command(program, args, options) {
  const p = child(program, args, options); const [code] = await once(p, 'exit');
  if (code !== 0) throw new Error(`${program} failed; inspect local tool availability without printing secrets`);
}
async function stop(p) {
  if (!p?.pid) return;
  const alive = () => { try { process.kill(-p.pid, 0); return true; } catch { return false; } };
  if (!alive()) return;
  process.kill(-p.pid, 'SIGTERM'); const until = Date.now() + 10000;
  while (alive() && Date.now() < until) await pause(50);
  if (alive()) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }
  const killedUntil = Date.now() + 2000;
  while (alive() && Date.now() < killedUntil) await pause(50);
  if (alive()) throw Error('Owned acceptance process group did not exit');
}
async function reserve() {
  for (;;) {
    const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    if (forbiddenPorts.has(port)) { await new Promise(resolve => server.close(resolve)); continue; }
    return { port, server, release: () => new Promise(resolve => server.close(resolve)) };
  }
}
async function waitFor(check, timeout) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await pause(100); }
  throw new Error('Acceptance operation timed out');
}
function answer(text) {
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  assert.equal(value.answer, 42, 'Model arithmetic result did not satisfy the acceptance contract');
  return value;
}

export async function runRealProviderAcceptance(project) {
  const { values, report } = project;
  if (report.status !== 'READY') return report;
  if ((values.APP_ENV || 'development') !== 'development') return { status: 'FAIL', reason: 'Acceptance requires a development project database' };
  const dsn = values.AWWO_TEST_DATABASE_URL || values.AWWO_DATABASE_URL || (values.AWWO_LOCAL_DB_PASSWORD
    ? `postgres://awwo:${encodeURIComponent(values.AWWO_LOCAL_DB_PASSWORD)}@127.0.0.1:${values.AWWO_LOCAL_DB_PORT || '55483'}/awwo?sslmode=disable` : '');
  if (!dsn) return { status: 'BLOCKED', missing: ['AWWO_TEST_DATABASE_URL or project local database configuration'] };
  let db;
  try { db = new URL(dsn); if (!['postgres:', 'postgresql:'].includes(db.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(db.hostname)) throw Error(); }
  catch { return { status: 'FAIL', reason: 'Acceptance database must be loopback PostgreSQL' }; }
  const pgEnv = { PATH: process.env.PATH, PGHOST: db.hostname, PGPORT: db.port || '5432', PGUSER: decodeURIComponent(db.username),
    PGPASSWORD: decodeURIComponent(db.password), PGDATABASE: decodeURIComponent(db.pathname.slice(1)), PGSSLMODE: db.searchParams.get('sslmode') || 'prefer' };
  const schema = `awwo_real_${randomBytes(8).toString('hex')}`;
  const dir = await mkdtemp(path.join(stateDir, 'real-provider-'));
  const evidenceFile = path.join(stateDir, `real-provider-acceptance-${Date.now()}.json`);
  const evidence = { status: 'FAIL', provider: report.provider, model: report.model, scope: 'Two real model turns through HTTP -> owned Go -> owned Pi SDK -> configured provider; persisted history and SSE', startedAt: new Date().toISOString(), schema, evidenceFile, externalInferenceAttempted: false, cleanup: 'pending' };
  const workers = [], held = []; let schemaCreated = false, interrupted = false;
  const cancellation = new AbortController();
  const interrupt = () => { interrupted = true; cancellation.abort(); };
  const signal = ms => AbortSignal.any([cancellation.signal, AbortSignal.timeout(ms)]);
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    await writeFile(path.join(dir, 'creator.md'), `Created by Codex on ${new Date().toISOString().slice(0, 10)} for explicitly requested real-provider acceptance. Own binary/schema only; cleaned on completion.\n`);
    held.push(await reserve(), await reserve()); const [api, pi] = held;
    const apiURL = `http://127.0.0.1:${api.port}`, piURL = `http://127.0.0.1:${pi.port}`;
    const scoped = new URL(dsn); scoped.searchParams.set('search_path', schema);
    const configured = Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('AWWO_PI_')));
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'en_US.UTF-8', TMPDIR: dir, ...configured,
      APP_ENV: 'development', AWWO_DATABASE_URL: scoped.href, AWWO_LISTEN_ADDR: `127.0.0.1:${api.port}`, AWWO_PUBLIC_ORIGIN: apiURL,
      AWWO_PI_URL: piURL, AWWO_PI_HOST: '127.0.0.1', AWWO_PI_PORT: String(pi.port), AWWO_PI_TOKEN: randomBytes(32).toString('base64url'),
      AWWO_PI_MAX_TOKENS: values.AWWO_PI_MAX_TOKENS || '512', AWWO_PI_MAX_CONCURRENCY: '1', AWWO_AUTH_REQUESTS_PER_MINUTE: '100',
      AWWO_BOOTSTRAP_ADMIN_EMAIL: '', AWWO_BOOTSTRAP_ADMIN_PASSWORD: '', AWWO_RUN_TIMEOUT: '11m' };
    const config = loadConfig(env), timeout = config.timeoutMs + 15000;
    const binary = path.join(dir, 'awwo-api');
    await command('go', ['build', '-o', binary, './cmd/api'], { cwd: path.join(root, 'backend') });
    if (interrupted) throw Error('Acceptance interrupted');
    await command('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-Atc', `CREATE SCHEMA ${schema}`], { env: pgEnv }); schemaCreated = true;
    for (const [port, program, args, url] of [[pi, process.execPath, ['apps/pi-worker/server.mjs'], `${piURL}/health`], [api, binary, [], `${apiURL}/api/v1/health`]]) {
      if (interrupted) throw Error('Acceptance interrupted');
      await port.release(); const worker = child(program, args, { env }); workers.push(worker);
      await waitFor(async () => {
        if (interrupted || worker.startError || worker.exitCode !== null || worker.signalCode !== null) throw Error('Owned acceptance service failed');
        try { return (await fetch(url, { signal: signal(500) })).ok; } catch { return false; }
      }, 30000);
    }
    const health = await (await fetch(`${piURL}/health`, { signal: signal(5000) })).json();
    assert.equal(health.piVersion, '0.85.1'); assert.equal(health.provider, report.provider); assert.equal(health.model, report.model);
    evidence.piVersion = health.piVersion;
    let cookie = '';
    const apiRequest = async (method, route, body, expected = 200) => {
      if (interrupted) throw Error('Acceptance interrupted');
      const result = await fetch(`${apiURL}/api/v1${route}`, { method, headers: { origin: apiURL, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: signal(10000) });
      if (result.status !== expected) throw Error(`Acceptance API returned ${result.status} for ${method}`);
      const sessionCookie = result.headers.get('set-cookie'); if (sessionCookie) cookie = sessionCookie.split(';')[0];
      return result.json();
    };
    const id = randomBytes(8).toString('hex');
    const registration = await apiRequest('POST', '/auth/register', { email: `real-${id}@example.invalid`, password: randomBytes(32).toString('base64url'), name: 'Real provider acceptance', tenantName: `Acceptance ${id}` }, 201);
    const prefix = `/tenants/${registration.tenants[0].id}`;
    const canvas = await apiRequest('POST', `${prefix}/canvases`, { name: 'Real provider acceptance', document: { version: 2, updatedAt: 0, nodes: [{ id: 'acceptance-node' }], edges: [] } }, 201);
    const agent = await apiRequest('POST', `${prefix}/agents`, { name: 'Real provider acceptance', model: report.model, instructions: 'Follow the user task. Reply with only a JSON object, without markdown fences.' }, 201);
    const session = await apiRequest('POST', `${prefix}/sessions`, { canvasId: canvas.id, nodeId: 'acceptance-node', agentId: agent.id, title: 'Two real inference turns' }, 201);
    const nonce = randomBytes(12).toString('hex');
    const execute = async (prompt, operationId) => {
      evidence.externalInferenceAttempted = true;
      const run = await apiRequest('POST', `${prefix}/runs`, { sessionId: session.id, prompt, operationId }, 202);
      const response = await fetch(`${apiURL}/api/v1${prefix}/runs/${run.id}/events`, { headers: { cookie }, signal: signal(timeout) });
      if (!response.ok) throw Error('Run SSE request failed');
      const text = await response.text();
      const events = text.split(/\r?\n\r?\n/).flatMap(part => { const data = part.match(/^data: (.+)$/m); return data ? [JSON.parse(data[1])] : []; });
      if (events.at(-1)?.type !== 'completed') throw Error('Real provider run did not complete successfully');
      const stored = await apiRequest('GET', `${prefix}/runs/${run.id}`);
      assert.equal(stored.status, 'completed'); assert.equal(stored.output, events.at(-1).text);
      assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.delta).join(''), stored.output);
      return { runId: run.id, output: stored.output, events: events.length };
    };
    const first = await execute(`Remember this nonce: ${nonce}. Compute 6 times 7. Reply exactly as JSON with keys nonce and answer.`, `real-first-${id}`);
    assert.equal(answer(first.output).nonce, nonce, 'First real model response did not preserve the nonce');
    const second = await execute('Using the nonce from my earlier message, compute 6 times 7 again. Reply as JSON with keys nonce and answer.', `real-second-${id}`);
    assert.equal(answer(second.output).nonce, nonce, 'Second real model response did not recover prior history');
    const messages = await apiRequest('GET', `${prefix}/sessions/${session.id}/messages`);
    assert.equal(messages.items.length, 4); assert.equal(messages.items[1].content, first.output); assert.equal(messages.items[3].content, second.output);
    evidence.runs = [first, second].map(r => ({ id: r.runId, outputSHA256: digest(r.output), eventCount: r.events }));
    evidence.status = 'PASS'; evidence.persistedMessages = 4;
  } catch (error) {
    evidence.status = 'FAIL'; evidence.reason = error instanceof SyntaxError ? 'Model output was not valid JSON' : (error.code === 'ERR_ASSERTION' ? 'Real inference/persistence assertion failed' : 'Real-provider acceptance failed or was interrupted; inspect configuration and provider availability');
  } finally {
    try {
      for (const worker of workers.reverse()) await stop(worker);
      for (const port of held) if (port.server.listening) await port.release();
      if (schemaCreated) await command('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-Atc', `DROP SCHEMA ${schema} CASCADE`], { env: pgEnv });
      await rm(dir, { recursive: true, force: true }); evidence.cleanup = 'PASS';
    } catch { evidence.status = 'FAIL'; evidence.cleanup = 'FAIL: inspect only the recorded owned schema and temporary directory'; evidence.temporaryDirectory = dir; }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    evidence.finishedAt = new Date().toISOString(); await writeFile(evidenceFile, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (!['--check', '--run'].includes(args[0]) || ![1, 3].includes(args.length) || (args.length === 3 && args[1] !== '--env-file')) {
    console.error('Usage: node scripts/awwo-saas-real-provider-acceptance.mjs --check|--run [--env-file <project-file>]'); process.exitCode = 1;
  } else {
    let project;
    try {
      project = await readProjectConfig(args[2]);
    } catch { console.log(JSON.stringify({ status: 'BLOCKED', reason: 'Cannot read a valid configuration file inside this project', externalInferencePerformed: false })); process.exitCode = 2; }
    if (project) {
      try {
        const result = args[0] === '--check' ? project.report : await runRealProviderAcceptance(project);
        console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === 'BLOCKED' ? 2 : ['PASS', 'READY'].includes(result.status) ? 0 : 1;
      } catch { console.log(JSON.stringify({ status: 'FAIL', reason: 'Acceptance could not finish; inspect its owned evidence/resources' })); process.exitCode = 1; }
    }
  }
}
