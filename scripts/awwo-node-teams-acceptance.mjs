// Explicit real-provider local acceptance. Secrets arrive over stdin and are never written.
// Start: node scripts/awwo-node-teams-acceptance.mjs --provider-stdin
// First stdin line: {provider,model,baseURL,apiKey}. Subsequent lines: {command:"run"|"collect"|"finish"}.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { root, stateDir, parseEnv, waitForHttp } from './awwo-saas-lib.mjs';
import { inspectProviderConfig } from './awwo-saas-real-provider-acceptance.mjs';

if (process.argv[2] !== '--provider-stdin') throw Error('Explicit --provider-stdin is required; this performs real inference');
const lines = createInterface({ input: process.stdin, terminal: false });
const queue = [], receivers = [];
lines.on('line', line => { const receiver = receivers.shift(); if (receiver) receiver(line); else queue.push(line); });
const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => receivers.push(resolve));
lines.on('close', () => { const receiver = receivers.shift(); if (receiver) receiver('{"command":"finish"}'); else queue.push('{"command":"finish"}'); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [], ports = [];
let interrupted = false;
const interrupt = () => { interrupted = true; const receiver = receivers.shift(); if (receiver) receiver('{"command":"finish"}'); else queue.push('{"command":"finish"}'); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const evidence = { status: 'RUNNING', startedAt: new Date().toISOString(), scenarios: [], cleanup: 'pending' };
const id = randomBytes(6).toString('hex'), schema = `awwo_teams_${id}`;
const dir = path.join(stateDir, `node-teams-acceptance-${id}`);
let pgEnv, schemaCreated = false;
function child(program, args, options = {}) {
  const p = spawn(program, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...options });
  p.on('error', () => {}); for (const s of [p.stdout, p.stderr]) s.on('data', () => {});
  return p;
}
async function command(program, args, options = {}) {
  const p = child(program, args, options); const [code] = await once(p, 'exit'); if (code !== 0) throw Error(`${program} failed`);
}
async function reserve() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const p = { server, port: server.address().port, release: () => new Promise(resolve => server.close(resolve)) }; ports.push(p); return p;
}
async function stop(p) {
  const alive = () => { try { process.kill(-p.pid, 0); return true; } catch { return false; } };
  if (!alive()) return;
  process.kill(-p.pid, 'SIGTERM'); const until = Date.now() + 8000;
  while (alive() && Date.now() < until) await pause(50);
  if (alive()) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }
}
const save = () => writeFile(path.join(dir, 'results.json'), JSON.stringify(evidence, null, 2));
try {
  const input = JSON.parse(await next());
  const saved = parseEnv(await readFile(path.join(stateDir, '.env'), 'utf8'));
  assert.equal(saved.APP_ENV || 'development', 'development');
  const providerValues = { AWWO_PI_PROVIDER: input.provider, AWWO_PI_MODEL: input.model, AWWO_PI_BASE_URL: input.baseURL, AWWO_PI_API_KEY: input.apiKey, AWWO_PI_MAX_TOKENS: '1536' };
  assert.equal(inspectProviderConfig(providerValues).status, 'READY');
  const dsn = saved.AWWO_DATABASE_URL || `postgres://awwo:${encodeURIComponent(saved.AWWO_LOCAL_DB_PASSWORD)}@127.0.0.1:${saved.AWWO_LOCAL_DB_PORT || '55483'}/awwo?sslmode=disable`;
  const db = new URL(dsn); assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(db.hostname));
  pgEnv = { PATH: process.env.PATH, PGHOST: db.hostname, PGPORT: db.port, PGUSER: decodeURIComponent(db.username), PGPASSWORD: decodeURIComponent(db.password), PGDATABASE: decodeURIComponent(db.pathname.slice(1)), PGSSLMODE: 'disable' };
  await mkdir(dir, { mode: 0o700 });
  await writeFile(path.join(dir, 'creator.md'), `Created by Codex on ${new Date().toISOString().slice(0,10)} for AwwO node team real inference and browser acceptance. Contains synthetic test outputs and screenshots; no provider credentials. Temporary schema and owned processes are removed on finish.\n`);
  const [apiPort, piPort, webPort] = await Promise.all([reserve(), reserve(), reserve()]);
  const apiURL = `http://127.0.0.1:${apiPort.port}`, piURL = `http://127.0.0.1:${piPort.port}`, webURL = `http://127.0.0.1:${webPort.port}`;
  const scoped = new URL(dsn); scoped.searchParams.set('search_path', schema);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'en_US.UTF-8', ...providerValues,
    AWWO_PI_MODELS_JSON: JSON.stringify([{ id: 'reviewer', provider: input.provider, model: input.model, baseURL: input.baseURL, apiKeyEnv: 'AWWO_ACCEPTANCE_REVIEWER_KEY', maxTokens: 1536 }]), AWWO_ACCEPTANCE_REVIEWER_KEY: input.apiKey,
    APP_ENV: 'development', AWWO_DATABASE_URL: scoped.href, AWWO_LISTEN_ADDR: `127.0.0.1:${apiPort.port}`, AWWO_PUBLIC_ORIGIN: webURL,
    AWWO_API_TARGET: apiURL, AWWO_PI_URL: piURL, AWWO_PI_HOST: '127.0.0.1', AWWO_PI_PORT: String(piPort.port), AWWO_PI_TOKEN: randomBytes(32).toString('base64url'),
    AWWO_PI_MAX_CONCURRENCY: '4', AWWO_PI_TIMEOUT_MS: '120000', AWWO_RUN_TIMEOUT: '15m', AWWO_AUTH_REQUESTS_PER_MINUTE: '100',
    AWWO_BOOTSTRAP_ADMIN_EMAIL: '', AWWO_BOOTSTRAP_ADMIN_PASSWORD: '', VITE_AWWO_WEB_HOST: '127.0.0.1', VITE_AWWO_WEB_PORT: String(webPort.port) };
  const binary = path.join(dir, 'awwo-api');
  await command('go', ['build', '-o', binary, './cmd/api'], { cwd: path.join(root, 'backend') });
  await command('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-Atc', `CREATE SCHEMA ${schema}`], { env: pgEnv }); schemaCreated = true;
  for (const [port, program, args, url] of [[piPort, process.execPath, ['apps/pi-worker/server.mjs'], `${piURL}/health`], [apiPort, binary, [], `${apiURL}/api/v1/health`], [webPort, process.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--configLoader', 'runner', '--config', 'apps/web/vite.saas.config.mjs'], webURL]]) {
    if (interrupted) throw Error('Acceptance interrupted');
    await port.release(); const p = child(program, args, { env }); children.push(p); await waitForHttp(url, p);
  }
  let cookie = '';
  const request = async (method, route, body, expected = 200) => {
    const response = await fetch(`${apiURL}/api/v1${route}`, { method, headers: { origin: webURL, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const value = await response.json();
    assert.equal(response.status, expected, `HTTP ${response.status} for ${method} ${route}: ${JSON.stringify(value)}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return value;
  };
  const credentials = { email: `teams-${id}@example.invalid`, password: randomBytes(20).toString('base64url') };
  const auth = await request('POST', '/auth/register', { ...credentials, name: '节点团队验收', tenantName: 'AwwO 多 Agent 本地验收' }, 201);
  const tid = auth.tenants[0].id, prefix = `/tenants/${tid}`;
  const agent = await request('POST', `${prefix}/agents`, { name: '节点负责人', adapterType: 'pi', model: input.model, instructions: 'Complete the task precisely. Keep answers concise. For the strict review verdict instruction use its outer JSON schema with the final node JSON escaped inside output.' }, 201);
  const member = (mid, name, role, model = '') => ({ id: mid, name, role, instructions: 'Compute accurately and keep the deliverable brief. Respect the final output schema.', runtime: 'pi', model, context: 'shared', tools: [] });
  const team = mode => ({ version: 1, mode, runtime: 'pi', maxRounds: mode === 'debate' || mode === 'review' ? 2 : 1, maxTurns: 12, timeoutSeconds: 600,
    members: mode === 'parallel' ? [member('a', '独立分析 A', '独立计算 6×7'), member('b', '独立分析 B', '交叉检查计算', 'reviewer'), member('c', '汇总负责人', '汇总并输出最终结果', 'reviewer')] : [member('a', '方案 Agent', '提出并完善解答'), member('b', mode === 'review' ? '审核 Agent' : '校验 Agent', mode === 'review' ? '认真审核，只在满足任务时批准' : '校验并输出最终答案', 'reviewer')] });
  const node = (nid, title, config, x = 120) => ({ id: nid, kind: 'session', title, x, y: 160, w: 390, h: 390, agentKind: 'llm', runtime: 'pi', model: input.model, effort: '', persona: '',
    binding: { companyId: tid, agentId: agent.id, agentName: agent.name }, bindAttempt: null, issueId: null, preview: '', ...(config ? { team: config } : {}),
    contract: { version: 1, inputs: [{ id: 'brief', label: '任务', type: 'text', required: true, value: '计算 6×7，结果必须包含 42。最终输出严格 JSON：{"result":"6×7=42"}。' }], outputs: [{ id: 'result', label: '结果', type: 'text', required: true, value: '' }] } });
  const canvases = [];
  for (const mode of ['sequential', 'parallel', 'debate', 'review']) {
    const config = team(mode);
    if (mode === 'review') config.members[1].instructions = 'For this acceptance test, on your FIRST review (no earlier approved:false verdict inside team_outputs), reject with strict JSON {"approved":false,"output":"","feedback":"Please explicitly verify 6 times 7 equals 42."}. If a previous rejection verdict is present, verify the revised answer and approve using the requested strict JSON verdict schema.';
    const nodes = [node('team', `${mode} · 节点内协作`, config)];
    const doc = { version: 2, updatedAt: Date.now(), nodes, edges: [], waypoints: [], view: null };
    canvases.push({ mode, ...(await request('POST', `${prefix}/canvases`, { name: `${mode} · 真实模型验收`, document: doc }, 201)) });
  }
  const backgroundDoc = { version: 2, updatedAt: Date.now(), nodes: [node('upstream', '上游 · 两位 Agent 讨论', team('debate')), node('downstream', '下游 · 交付确认', null, 690)], edges: [{ id: 'deliver', fromNode: 'upstream', fromPort: 'out:result', toNode: 'downstream', toPort: 'in:brief', dataType: 'text' }], waypoints: [], view: null };
  canvases.push({ mode: 'background', ...(await request('POST', `${prefix}/canvases`, { name: '关闭页面后 · 后台继续整图', document: backgroundDoc }, 201)) });
  const chatNode = node('chat', '手动聊天 · 两位 Agent 讨论', team('debate'));
  chatNode.contract.inputs[0].value = '按当前用户消息回答；没有消息时回答已就绪。';
  canvases.push({ mode: 'chat', ...(await request('POST', `${prefix}/canvases`, { name: '手动聊天 · 团队执行', document: { ...backgroundDoc, nodes: [chatNode], edges: [] } }, 201)) });
  evidence.provider = input.provider; evidence.model = input.model; evidence.models = (await request('GET', `${prefix}/runtime`)).models;
  evidence.webURL = webURL; evidence.apiURL = apiURL; evidence.tenantId = tid; evidence.canvases = canvases.map(c => ({ id: c.id, mode: c.mode, name: c.name }));
  await writeFile(path.join(dir, '.browser-credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
  await save();
  console.log(JSON.stringify({ status: 'READY', webURL, apiURL, tenantId: tid, dir, canvases: evidence.canvases }));
  async function collectCanvas(c, wait) {
    const base = `${prefix}/canvases/${c.id}/graph-runs`;
    let graph = (await request('GET', base)).items[0];
    if (!graph) return null;
    const deadline = Date.now() + 900000;
    while (wait && ['queued', 'running'].includes(graph.status) && Date.now() < deadline) { if (interrupted) throw Error('Acceptance interrupted'); await pause(1000); graph = await request('GET', `${base}/${graph.id}`); }
    const turns = {};
    for (const n of graph.nodes) if (n.runId) turns[n.nodeId] = (await request('GET', `${prefix}/runs/${n.runId}/turns`)).items;
    const result = { mode: c.mode, graph, turns };
    evidence.scenarios = evidence.scenarios.filter(s => s.mode !== c.mode); evidence.scenarios.push(result); await save(); return result;
  }
  for (;;) {
    const { command: action } = JSON.parse(await next());
    if (interrupted || action === 'finish') break;
    if (action === 'run') {
      for (const c of canvases.filter(c => ['sequential', 'parallel', 'debate', 'review'].includes(c.mode))) {
        const base = `${prefix}/canvases/${c.id}/graph-runs`;
        await request('POST', base, { operationId: `acceptance-${id}-${c.mode}`, documentVersion: c.version }, 202);
        const result = await collectCanvas(c, true);
        assert.equal(result.graph.status, 'completed', `${c.mode}: ${result.graph.error}`);
        assert.match(result.graph.nodes[0].output, /42/);
        const turns = result.turns.team;
        assert.equal(turns.length, { sequential: 2, parallel: 3, debate: 5, review: 4 }[c.mode]);
        assert.ok(turns.every(t => t.status === 'completed')); assert.ok(turns.some(t => t.model === 'reviewer'));
        console.log(JSON.stringify({ scenario: c.mode, status: 'PASS', graphId: result.graph.id, calls: turns.length }));
      }
      evidence.status = 'API_PASS_BROWSER_PENDING'; await save();
    } else if (action === 'collect') {
      for (const c of canvases) { const result = await collectCanvas(c, false); if (result) console.log(JSON.stringify({ scenario: c.mode, status: result.graph.status, nodes: result.graph.nodes.map(n => ({ id: n.nodeId, state: n.state })), calls: Object.values(result.turns).reduce((n,v) => n+v.length, 0) })); }
      evidence.history = [];
      for (const c of canvases) for (const graph of (await request('GET', `${prefix}/canvases/${c.id}/graph-runs`)).items) evidence.history.push({ mode: c.mode, graph });
      evidence.runs = (await request('GET', `${prefix}/runs?limit=100`)).items;
      for (const run of evidence.runs) run.turns = (await request('GET', `${prefix}/runs/${run.id}/turns`)).items;
      await save();
    }
  }
} catch (error) {
  process.exitCode = 1;
  evidence.status = 'FAIL'; evidence.failure = String(error.message).replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]'); console.log(JSON.stringify({ status: 'FAIL', reason: evidence.failure, dir }));
} finally {
  lines.close(); for (const p of children.reverse()) await stop(p);
  for (const p of ports) if (p.server.listening) await p.release();
  try {
    if (schemaCreated) await command('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-Atc', `DROP SCHEMA ${schema} CASCADE`], { env: pgEnv });
    await rm(path.join(dir, '.browser-credentials.json'), { force: true }); await rm(path.join(dir, 'awwo-api'), { force: true }); evidence.cleanup = 'PASS';
  } catch { evidence.cleanup = 'FAIL'; process.exitCode = 1; }
  evidence.finishedAt = new Date().toISOString(); await save().catch(() => {}); console.log(JSON.stringify({ status: evidence.status, cleanup: evidence.cleanup, dir }));
}
