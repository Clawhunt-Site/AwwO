// Full local protocol integration. The OpenAI-compatible provider below is an
// explicit deterministic fixture, not external model inference acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { parseEnv, root, stateDir } from './awwo-saas-lib.mjs';

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await pause(40); }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p;
}
function child(command, args, options = {}) {
  const p = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = ''; for (const stream of [p.stdout, p.stderr]) stream.on('data', b => { output = (output + b).slice(-8000); });
  p.startError = null; p.on('error', e => { p.startError = e; });
  p.output = () => output; return p;
}
async function command(command, args, options = {}) {
  const p = child(command, args, options);
  const [code] = await once(p, 'exit');
  if (code !== 0) throw new Error(`${command} failed (${code}): ${p.output()}`);
  return p.output();
}
async function stop(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  const ended = once(p, 'exit').catch(() => []); p.kill('SIGTERM');
  const forced = setTimeout(() => p.kill('SIGKILL'), 10_000);
  try { await ended; } finally { clearTimeout(forced); }
}
function messagesText(messages) {
  return messages.map(m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(p => p.text ?? '').join('')).join('\n');
}

test('HTTP → Go → Pi and OpenAI Agents SDKs → local protocol fixture → PostgreSQL, SSE, history, cancel and planner', { timeout: 120_000 }, async (t) => {
  // Read the existing local configuration only. Never create credentials,
  // initialize databases or alter the persistent launcher environment here.
  const saved = parseEnv(await readFile(path.join(stateDir, '.env'), 'utf8'));
  const local = { ...saved, ...process.env };
  assert.equal(local.APP_ENV || 'development', 'development');
  const dsn = local.AWWO_TEST_DATABASE_URL || local.AWWO_DATABASE_URL
    || `postgres://awwo:${encodeURIComponent(local.AWWO_LOCAL_DB_PASSWORD)}@127.0.0.1:${local.AWWO_LOCAL_DB_PORT || '55483'}/awwo?sslmode=disable`;
  const dbURL = new URL(dsn); assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(dbURL.hostname), 'Integration DB must be loopback');
  const pgEnv = { ...process.env, PGHOST: dbURL.hostname, PGPORT: dbURL.port || '5432', PGUSER: decodeURIComponent(dbURL.username), PGPASSWORD: decodeURIComponent(dbURL.password), PGDATABASE: decodeURIComponent(dbURL.pathname.slice(1)), PGSSLMODE: dbURL.searchParams.get('sslmode') || 'prefer' };
  const schema = `awwo_stack_${randomBytes(8).toString('hex')}`;
  const dir = await mkdtemp(path.join(stateDir, 'stack-test-'));
  await writeFile(path.join(dir, 'creator.md'), 'Created by Codex on 2026-09-07 for the authorized Awwo stack integration test. Scope: temporary binary and test artifacts; removed when this test finishes.\n');
  const workers = []; let fixture; let schemaCreated = false;
  t.after(async () => {
    for (const p of workers.reverse()) await stop(p);
    if (fixture) { const closed = new Promise(resolve => fixture.close(resolve)); fixture.closeAllConnections(); await closed; }
    if (schemaCreated) await command('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-Atc', `DROP SCHEMA ${schema} CASCADE`], { env: pgEnv });
    await rm(dir, { recursive: true, force: true });
  });
  await command('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-Atc', `CREATE SCHEMA ${schema}`], { env: pgEnv }); schemaCreated = true;
  const scoped = new URL(dsn); scoped.searchParams.set('search_path', schema);
  const requests = []; let cancelledConnections = 0;
  fixture = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer stack-fixture-key');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body); assert.deepEqual(body.tools ?? [], []); assert.equal(body.model, 'stack-test-model');
      const text = messagesText(body.messages); const last = messagesText(body.messages.slice(-1));
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
      if (last.includes('hold-open')) { res.on('close', () => { cancelledConnections++; }); return; }
      let output = last.includes('second-turn') ? 'Second persisted response' : last.includes('openai-agents-turn') ? 'OpenAI Agents persisted response' : 'First persisted response';
      if (text.includes('Awwo canvas planner')) output = JSON.stringify({ version: 1, summary: 'Add backend node', operations: [{ type: 'add_node', ref: 'api', templateId: 'backend' }] });
      if (last.includes('reject-plan')) output = JSON.stringify({ version: 1, summary: 'Unsafe proposal', operations: [{ type: 'exec', command: 'must never execute' }] });
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'stack_completion', object: 'chat.completion.chunk', created: 1, model: 'stack-test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      const mid = Math.ceil(output.length / 2); send({ role: 'assistant', content: output.slice(0, mid) }); send({ content: output.slice(mid) }); send({}, 'stop'); res.end('data: [DONE]\n\n');
    } catch (error) { res.destroy(error); }
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  const apiPort = await freePort(), piPort = await freePort(), openAIAgentsPort = await freePort();
  assert.equal(new Set([apiPort, piPort, openAIAgentsPort]).size, 3);
  const apiURL = `http://127.0.0.1:${apiPort}`, piURL = `http://127.0.0.1:${piPort}`, openAIAgentsURL = `http://127.0.0.1:${openAIAgentsPort}`;
  const openAIAgentsToken = randomBytes(32).toString('base64url');
  const env = { ...process.env, APP_ENV: 'development', AWWO_DATABASE_URL: scoped.href, AWWO_LISTEN_ADDR: `127.0.0.1:${apiPort}`,
    AWWO_PUBLIC_ORIGIN: apiURL, AWWO_PI_URL: piURL, AWWO_PI_HOST: '127.0.0.1', AWWO_PI_PORT: String(piPort),
    AWWO_PI_TOKEN: randomBytes(32).toString('base64url'), AWWO_PI_PROVIDER: 'openai', AWWO_PI_MODEL: 'stack-test-model',
    AWWO_PI_API_KEY: 'stack-fixture-key', AWWO_PI_BASE_URL: `http://127.0.0.1:${fixture.address().port}/v1`,
    AWWO_PI_TIMEOUT_MS: '15000', AWWO_PI_CANCEL_GRACE_MS: '100', AWWO_PI_CONTEXT_WINDOW: '65536',
    AWWO_OPENAI_AGENTS_URL: openAIAgentsURL, AWWO_OPENAI_AGENTS_HOST: '127.0.0.1', AWWO_OPENAI_AGENTS_PORT: String(openAIAgentsPort),
    AWWO_OPENAI_AGENTS_TOKEN: openAIAgentsToken, AWWO_OPENAI_AGENTS_PROVIDER: 'openai', AWWO_OPENAI_AGENTS_MODEL: 'stack-test-model',
    AWWO_OPENAI_AGENTS_API_KEY: 'stack-fixture-key', AWWO_OPENAI_AGENTS_BASE_URL: `http://127.0.0.1:${fixture.address().port}/v1`,
    AWWO_OPENAI_AGENTS_PROTOCOL: 'chat_completions', AWWO_OPENAI_AGENTS_TOOLS_JSON: '[]', AWWO_OPENAI_AGENTS_TIMEOUT_MS: '15000',
    AWWO_OPENAI_AGENTS_CANCEL_GRACE_MS: '100', AWWO_OPENAI_AGENTS_CONTEXT_WINDOW: '65536',
    AWWO_RUN_TIMEOUT: '20s', AWWO_AUTH_REQUESTS_PER_MINUTE: '100', AWWO_BOOTSTRAP_ADMIN_EMAIL: '', AWWO_BOOTSTRAP_ADMIN_PASSWORD: '',
  };
  const binary = path.join(dir, 'awwo-api');
  await command('go', ['build', '-o', binary, './cmd/api'], { cwd: path.join(root, 'backend'), env });
  const pi = child(process.execPath, ['apps/pi-worker/server.mjs'], { env }); workers.push(pi);
  const openAIAgents = child(process.execPath, ['apps/openai-agents-worker/server.mjs'], { env }); workers.push(openAIAgents);
  let api = child(binary, [], { env }); workers.push(api);
  async function ready(url, p) {
    await waitFor(async () => { if (p.exitCode !== null || p.startError) throw new Error(`Service exited: ${p.output()}`); try { return (await fetch(url, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, 'service readiness');
  }
  await Promise.all([ready(`${apiURL}/api/v1/health`, api), ready(`${piURL}/health`, pi), ready(`${openAIAgentsURL}/health`, openAIAgents)]);
  let cookie = '';
  async function request(method, endpoint, body, expected = 200) {
    const res = await fetch(`${apiURL}/api/v1${endpoint}`, { method, headers: { origin: apiURL, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const text = await res.text(); assert.equal(res.status, expected, `${method} ${endpoint}: ${text}`);
    return { value: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie') };
  }
  const registration = await request('POST', '/auth/register', { email: 'stack@example.test', password: 'Stack test password 123!', name: 'Stack tester', tenantName: 'Stack test' }, 201);
  cookie = registration.cookie.split(';')[0]; const tid = registration.value.tenants[0].id; const prefix = `/tenants/${tid}`;
  const cv = (await request('POST', `${prefix}/canvases`, { name: 'Stack canvas', document: { nodes: [{ id: 'node-one' }], edges: [] } }, 201)).value;
  const agent = (await request('POST', `${prefix}/agents`, { name: 'Stack agent', model: 'stack-test-model', instructions: 'Answer with plain text.' }, 201)).value;
  const session = (await request('POST', `${prefix}/sessions`, { canvasId: cv.id, nodeId: 'node-one', agentId: agent.id, title: 'Stack thread' }, 201)).value;
  async function execute(prompt, operationId) { return (await request('POST', `${prefix}/runs`, { sessionId: session.id, prompt, operationId }, 202)).value; }
  async function finished(run, status = 'completed') {
    let value; await waitFor(async () => { value = (await request('GET', `${prefix}/runs/${run.id}`)).value; if (value.terminal && value.status !== status) throw new Error(`Unexpected run status: ${JSON.stringify(value)}`); return value.status === status; }, `run ${status}`); return value;
  }
  const first = await execute('first-turn', 'stack-first-operation'); await finished(first);
  const stream = await fetch(`${apiURL}/api/v1${prefix}/runs/${first.id}/events`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
  const eventText = await stream.text(); const events = eventText.split('\n\n').filter(v => v.includes('data:')).map(v => ({ id: Number(v.match(/id: (\d+)/)[1]), data: JSON.parse(v.match(/data: (.+)/)[1]) }));
  assert.equal(events.at(-1).data.type, 'completed'); assert.equal(events.at(-1).data.text, 'First persisted response');
  assert.equal(events.filter(e => e.data.type === 'text_delta').map(e => e.data.delta).join(''), 'First persisted response');
  const replay = await fetch(`${apiURL}/api/v1${prefix}/runs/${first.id}/events`, { headers: { cookie, 'Last-Event-ID': String(events[0].id) }, signal: AbortSignal.timeout(10_000) }); assert.ok(!(await replay.text()).startsWith(`id: ${events[0].id}\n`));
  const second = await execute('second-turn', 'stack-second-operation'); assert.equal((await finished(second)).output, 'Second persisted response');
  const secondProvider = requests.find(r => messagesText(r.messages.slice(-1)).includes('second-turn'));
  assert.ok(messagesText(secondProvider.messages).includes('first-turn')); assert.ok(messagesText(secondProvider.messages).includes('First persisted response'));
  const messages = (await request('GET', `${prefix}/sessions/${session.id}/messages`)).value.items; assert.equal(messages.length, 4);
  const oaCanvas = (await request('POST', `${prefix}/canvases`, { name: 'OpenAI Agents canvas', document: { nodes: [{ id: 'oa-node', runtime: 'openai-agents' }], edges: [] } }, 201)).value;
  const oaAgent = (await request('POST', `${prefix}/agents`, { name: 'OpenAI Agents member', adapterType: 'openai-agents', model: 'stack-test-model', instructions: 'OPENAI-AGENTS-SYSTEM-PROMPT' }, 201)).value;
  assert.equal(oaAgent.runtime, 'openai-agents');
  const oaSession = (await request('POST', `${prefix}/sessions`, { canvasId: oaCanvas.id, nodeId: 'oa-node', agentId: oaAgent.id, title: 'OpenAI Agents thread' }, 201)).value;
  const oaRun = (await request('POST', `${prefix}/runs`, { sessionId: oaSession.id, prompt: 'openai-agents-turn', operationId: 'stack-openai-agents-operation' }, 202)).value;
  assert.equal((await finished(oaRun)).output, 'OpenAI Agents persisted response');
  const oaProvider = requests.find(r => messagesText(r.messages.slice(-1)).includes('openai-agents-turn'));
  assert.ok(oaProvider, 'OpenAI Agents worker must reach the provider fixture');
  assert.ok(messagesText(oaProvider.messages).includes('OPENAI-AGENTS-SYSTEM-PROMPT'), 'the persisted Agent instructions must become the SDK system prompt');
  const same = (await request('POST', `${prefix}/runs`, { sessionId: session.id, prompt: 'first-turn', operationId: 'stack-first-operation' })).value; assert.equal(same.id, first.id); assert.equal(requests.length, 3);
  const active = await execute('hold-open', 'stack-cancel-operation'); await waitFor(() => requests.some(r => messagesText(r.messages.slice(-1)).includes('hold-open')), 'actual provider request before cancel');
  await request('POST', `${prefix}/runs/${active.id}/cancel`);
  // Deliberately no delay or cleanup polling between cancellation and new admission.
  const afterCancel = await execute('after-cancel', 'stack-after-cancel-operation');
  assert.equal((await finished(afterCancel)).output, 'First persisted response');
  await finished(active, 'cancelled'); await waitFor(() => cancelledConnections > 0, 'provider connection cancelled');
  const plan = (await request('POST', `${prefix}/canvases/${cv.id}/plan`, { prompt: 'Add an API node', context: 'Return valid canvas plan JSON', operationId: 'stack-plan-operation' }, 202)).value;
  const planResult = await finished(plan); assert.equal(JSON.parse(planResult.output).operations[0].type, 'add_node');
  const badPlan = (await request('POST', `${prefix}/canvases/${cv.id}/plan`, { prompt: 'reject-plan', context: 'Return valid canvas plan JSON', operationId: 'stack-bad-plan' }, 202)).value;
  assert.equal((await finished(badPlan, 'failed')).error, 'invalid_canvas_plan');
  assert.equal((await request('GET', `${prefix}/canvases/${cv.id}`)).value.document.nodes.length, 1, 'planning must not auto-apply');
  await stop(api); api = child(binary, [], { env }); workers.push(api); await ready(`${apiURL}/api/v1/health`, api);
  assert.equal((await request('GET', `${prefix}/runs/${first.id}`)).value.output, 'First persisted response');
  assert.equal((await request('GET', `${prefix}/sessions/${session.id}/messages`)).value.items.length, 7, 'cancelled prompt is retained in durable history but excluded from model context');
  t.diagnostic('Passed real Go HTTP + PostgreSQL + Pi and OpenAI Agents child/SDK paths + local OpenAI protocol fixture. No external inference or production service was exercised.');
});
