// Explicit local browser protocol acceptance fixture. No external inference.
// --self-test runs pure checks only; --start starts an isolated temporary stack.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv, root, stateDir } from './awwo-saas-lib.mjs';
import { createAcceptanceFaults } from './awwo-saas-acceptance-faults.mjs';

export const MODEL = 'awwo-protocol-fixture';
const forbiddenPorts = new Set([5189, 8087, 8097, 55483]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = text => createHash('sha256').update(text).digest('hex');
function content(message) {
  return typeof message?.content === 'string' ? message.content
    : Array.isArray(message?.content) ? message.content.map(part => part?.text ?? '').join('') : '';
}
function visibleMessages(messages) { return Array.isArray(messages) ? messages.filter(m => m && typeof m.role === 'string') : []; }

export function withFixtureHosts({ fixtureHost, webHost }, handler) {
  return (req, res) => {
    // Vite preserves the original Web Host. Only the application API proxy may
    // accept that exact owned host; provider/control/evidence stay fixture-only.
    const allowedWebAPI = req.url?.startsWith('/api/v1/') && req.headers.host === webHost;
    if (req.headers.host !== fixtureHost() && !allowedWebAPI) { res.writeHead(403).end(); return; }
    return handler(req, res);
  };
}

export function summarizeRequest(body, index) {
  const messages = visibleMessages(body.messages);
  return { index, at: new Date().toISOString(), model: body.model, messageCount: messages.length,
    // Never save request headers, provider keys, process environment or DB DSNs.
    // These excerpts contain only deliberately submitted local test content.
    messages: messages.slice(-30).map(m => ({ role: m.role, bytes: Buffer.byteLength(content(m)),
      sha256: digest(content(m)), excerpt: content(m).slice(0, m.role === 'system' || m.role === 'developer' ? 2048 : 1024) })),
  };
}
export function fixtureOutput(body) {
  const messages = visibleMessages(body.messages);
  const systems = messages.filter(m => m.role === 'system' || m.role === 'developer').map(content).join('\n');
  const prompt = content(messages.filter(m => m.role === 'user').at(-1));
  if (systems.includes('Awwo canvas planner')) {
    if (prompt.includes('[fixture:invalid-plan]')) return JSON.stringify({ version: 1, summary: 'Explicit invalid plan fixture', operations: [{ type: 'exec', command: 'never-execute-fixture' }] });
    return JSON.stringify({ version: 1, summary: '本地协议 fixture：添加两个通用节点及一条依赖，需绑定 awwo-protocol-fixture 后运行；无外部模型推理。', operations: [
      { type: 'add_node', ref: 'fixture_first', templateId: 'general', title: 'Fixture A · 协议输出',
        persona: 'PROTOCOL_FIXTURE_PERSONA_A。仅用于本地协议验收，内容由确定性 fixture 生成，不代表真实推理或业务交付。',
        inputValues: { brief: '验证 Go → Pi SDK → 本地协议 fixture 的 JSON 交付与流式输出。' } },
      { type: 'add_node', ref: 'fixture_second', templateId: 'general', title: 'Fixture B · 依赖接收',
        persona: 'PROTOCOL_FIXTURE_PERSONA_B。检查收到上游结果，供本地协议传递验收。' },
      { type: 'connect', fromNode: 'fixture_first', fromField: 'result', toNode: 'fixture_second', toField: 'brief' },
    ] });
  }
  const historyUsers = Math.max(0, messages.filter(m => m.role === 'user').length - 1);
  const historyAssistants = messages.filter(m => m.role === 'assistant').length;
  const proof = `[${MODEL} / 本地协议验收]\n历史 user=${historyUsers}, assistant=${historyAssistants}；persona SHA256=${digest(systems).slice(0, 16)}。\n输入摘要：${prompt.slice(0, 200)}\n此文本来自确定性本地协议 fixture，无外部模型推理。`;
  // Parse only the existing runGraph output contract format, never pretend to
  // solve arbitrary JSON schemas or natural-language instructions.
  const declared = declaredOutputFields(prompt);
  if (declared) {
    if (declared.length > 64) throw new Error('Fixture supports at most 64 declared fields');
    const output = Object.create(null);
    for (const field of declared) {
      const id = field?.id;
      if (typeof id !== 'string' || id === '' || id.length > 128) throw new Error('Invalid fixture field ID');
      output[id] = fixtureFieldValue(id, field?.type, proof);
    }
    return JSON.stringify(output);
  }
  return proof;
}

const OUTPUT_FORMAT_MARKER = '【输出格式】';

// graphOutputPolicy writes the declared fields as one JSON array line, surrounded by policy prose
// whose amount and order are the server's business. So find the array by parsing, never by
// position: the first version of this fixture matched a Markdown list the product never emitted,
// and a fixed "line after the marker" broke the moment the server added a policy preamble. Both
// failures were silent — every contract fell through to plain text and the typed-output path went
// unexercised — which is why this reads the section defensively and the Go side pins the shape.
function declaredOutputFields(prompt) {
  const marker = prompt.lastIndexOf(OUTPUT_FORMAT_MARKER);
  if (marker < 0) return null;
  // The section ends at the blank line that separates prompt parts, so a later part cannot be
  // mistaken for this contract's fields.
  const section = prompt.slice(marker + OUTPUT_FORMAT_MARKER.length).split(/\r?\n[ \t]*\r?\n/, 1)[0];
  for (const line of section.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('[')) continue;
    let fields;
    try {
      fields = JSON.parse(text);
    } catch {
      continue;
    }
    if (Array.isArray(fields) && fields.length && fields.every(f => f && typeof f.id === 'string')) return fields;
  }
  return null;
}

// A `file` output must carry real content: the contract accepts {name, content} and stores it as a
// downloadable artifact, so returning a path would assert a deliverable that does not exist.
function fixtureFieldValue(id, type, proof) {
  switch (type) {
    case 'number': return 42;
    case 'boolean': return true;
    case 'html': return `<!doctype html><html><head><meta charset="utf-8"><title>协议 fixture ${id}</title></head>`
      + `<body><p>字段 ${id} 的协议测试文档。此文档由确定性本地 fixture 生成，无外部模型推理。</p></body></html>`;
    case 'file': return { name: `${(id.replace(/[^A-Za-z0-9._-]/g, '_') || 'fixture').slice(0, 64)}.md`,
      content: `${proof}\n字段 ${id} 的协议测试文件内容。\n` };
    default: return `${proof}\n字段 ${id} 的协议测试值。`;
  }
}

export function streamFixtureResponse(res, body, index, record) {
  const output = fixtureOutput(body), prompt = content(visibleMessages(body.messages).filter(m => m.role === 'user').at(-1));
  if (prompt.includes('[fixture:provider-503]')) {
    record({ type: 'provider_503', index, at: new Date().toISOString() });
    res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Explicit fixture provider failure', type: 'fixture_error' } })); return;
  }
  const duration = prompt.includes('[fixture:slow]') ? 15000 : 4000;
  const hold = prompt.includes('[fixture:hold]'), disconnect = prompt.includes('[fixture:provider-disconnect]');
  const letters = Array.from(output), chunkSize = Math.ceil(letters.length / 20);
  let position = chunkSize, completed = false, injectedDisconnect = false;
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `fixture_${index}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' }); res.flushHeaders();
  send({ role: 'assistant', content: letters.slice(0, chunkSize).join('') });
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) { clearInterval(timer); return; }
    if (disconnect) { injectedDisconnect = true; record({ type: 'provider_disconnected', index, at: new Date().toISOString() }); res.destroy(); return; }
    if (hold) { res.write(': waiting for explicit UI cancellation\n\n'); return; }
    if (position < letters.length) { send({ content: letters.slice(position, position + chunkSize).join('') }); position += chunkSize; return; }
    completed = true; clearInterval(timer); send({}, 'stop'); res.end('data: [DONE]\n\n');
    record({ type: 'completed', index, at: new Date().toISOString(), outputBytes: Buffer.byteLength(output), outputSHA256: digest(output) });
  }, duration / 20);
  res.once('close', () => { clearInterval(timer); if (!completed && !injectedDisconnect) record({ type: 'cancelled_connection', index, at: new Date().toISOString() }); });
}

export function selfTest() {
  const body = { model: MODEL, messages: [{ role: 'system', content: 'PROTOCOL_FIXTURE_PERSONA_A' },
    { role: 'user', content: 'first-turn' }, { role: 'assistant', content: 'prior response' },
    { role: 'user', content: 'second-turn' }] };
  assert.match(fixtureOutput(body), /历史 user=1, assistant=1/);
  assert.match(fixtureOutput(body), /second-turn/);
  assert.match(fixtureOutput(body), /无外部模型推理/);
  // This must stay byte-identical in shape to what graphPrompt emits: marker, newline, one JSON
  // array line, then prose. Asserting against any other shape is how the parser went stale before.
  const declaredFields = [
    { id: 'result', label: 'Result', type: 'markdown', required: true, help: '', placeholder: '' },
    { id: 'count', label: 'Count', type: 'number', required: true, help: '', placeholder: '' },
    { id: 'valid', label: 'Valid', type: 'boolean', required: true, help: '', placeholder: '' },
    { id: 'page', label: 'Page', type: 'html', required: true, help: '', placeholder: '' },
    { id: 'file', label: 'File', type: 'file', required: true, help: '', placeholder: '' },
    { id: '__proto__', label: 'Prototype', type: 'text', required: true, help: '', placeholder: '' },
  ];
  const contract = { ...body, messages: [...body.messages.slice(0, -1), { role: 'user',
    content: `【输出格式】\nFrozen graph output contract (server-owned serialization policy):\n`
      + `${JSON.stringify(declaredFields)}\nReturn a JSON object keyed by exact field ID. `
      + `Example shape only (replace example values with actual results): {"result":"<actual result content>"}\n\n`
      + '请按本节点职责完成任务，并按声明的格式给出最终输出。' }] };
  const output = JSON.parse(fixtureOutput(contract));
  assert.equal(output.count, 42); assert.equal(output.valid, true); assert.equal(typeof output.result, 'string');
  assert.equal(typeof output.__proto__, 'string');
  assert.match(output.page, /^<!doctype html><html><head>.*<\/body><\/html>$/);
  // A real deliverable, not a path: the contract stores this content and serves it for download.
  assert.equal(output.file.name, 'file.md'); assert.match(output.file.content, /协议测试文件内容/);
  assert.deepEqual(Object.keys(fixtureFieldValue('f', 'file', 'p')), ['name', 'content']);
  // A prompt without the marker, or with a non-array after it, stays plain text rather than
  // inventing a schema.
  assert.match(fixtureOutput({ ...body, messages: [...body.messages.slice(0, -1),
    { role: 'user', content: '【输出格式】\n- "result": markdown，必填' }] }), /本地协议验收/);
  const planner = JSON.parse(fixtureOutput({ messages: [{ role: 'system', content: 'Awwo canvas planner' }, { role: 'user', content: '添加节点' }] }));
  assert.equal(planner.version, 1); assert.equal(planner.operations.length, 3);
  assert.deepEqual(planner.operations.map(op => op.type), ['add_node', 'add_node', 'connect']);
  assert.equal(planner.operations[2].fromNode, planner.operations[0].ref);
  assert.equal(planner.operations[2].toNode, planner.operations[1].ref);
  const summary = summarizeRequest({ ...body, authorization: 'must-never-save-this', apiKey: 'must-never-save-that' }, 1);
  const serialized = JSON.stringify(summary); assert.ok(!serialized.includes('must-never-save'));
  assert.equal(summary.messages[0].sha256, digest('PROTOCOL_FIXTURE_PERSONA_A'));
  console.log('PASS: fixture text/history/persona, typed JSON output, planner shape, summary key exclusion. No processes, database or network listeners started.');
}

async function reservation() {
  for (;;) {
    const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    if (forbiddenPorts.has(port)) { await new Promise(resolve => server.close(resolve)); continue; }
    return { server, port, release: () => new Promise(resolve => server.close(resolve)) };
  }
}
function launch(command, args, options = {}) {
  const worker = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  worker.startError = undefined;
  worker.on('error', error => { worker.startError = error; });
  // Service output is intentionally not forwarded: startup errors can include a
  // connection string. Process status and safe readiness URLs are enough here.
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', () => {});
  return worker;
}
async function command(command, args, options = {}) {
  const worker = launch(command, args, options);
  const [code] = await once(worker, 'exit');
  if (code !== 0) throw new Error(`${command} failed (${code}); inspect local tool availability without printing credentials`);
}
async function stop(worker) {
	if (worker?.spawnargs && worker.fixtureProcessGroup) {
		const groupAlive = () => { try { process.kill(-worker.pid, 0); return true; } catch { return false; } };
		if (!groupAlive()) return;
		try { process.kill(-worker.pid, 'SIGTERM'); } catch {}
		const until = Date.now() + 10_000;
		while (groupAlive() && Date.now() < until) await sleep(100);
		if (groupAlive()) { try { process.kill(-worker.pid, 'SIGKILL'); } catch {} }
		return;
	}
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  const ended = once(worker, 'exit').catch(() => []);
  worker.kill('SIGTERM');
  const forced = setTimeout(() => worker.kill('SIGKILL'), 10_000);
  try { await ended; } finally { clearTimeout(forced); }
}
async function ready(url, worker, abort, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (abort()) throw new Error('Fixture startup interrupted');
    if (worker.exitCode !== null || worker.signalCode !== null || worker.startError) throw new Error(`Owned service exited before readiness: ${url}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error(`Owned service readiness timed out: ${url}`);
}

export async function start() {
  // Read only. In particular, do not invoke loadLocalEnv/startDatabase, because
  // those normal launcher helpers may initialize or update persistent state.
  const saved = parseEnv(await readFile(path.join(stateDir, '.env'), 'utf8'));
  const local = { ...saved, ...process.env };
  if ((local.APP_ENV || 'development') !== 'development') throw new Error('Browser fixture requires development environment');
  const dsn = local.AWWO_TEST_DATABASE_URL || local.AWWO_DATABASE_URL
    || `postgres://awwo:${encodeURIComponent(local.AWWO_LOCAL_DB_PASSWORD)}@127.0.0.1:${local.AWWO_LOCAL_DB_PORT || '55483'}/awwo?sslmode=disable`;
  const dbURL = new URL(dsn);
  if (!['postgres:', 'postgresql:'].includes(dbURL.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(dbURL.hostname)) throw new Error('Fixture database must be loopback PostgreSQL');
  const pgEnv = { ...process.env, PGHOST: dbURL.hostname, PGPORT: dbURL.port || '5432', PGUSER: decodeURIComponent(dbURL.username),
    PGPASSWORD: decodeURIComponent(dbURL.password), PGDATABASE: decodeURIComponent(dbURL.pathname.slice(1)), PGSSLMODE: dbURL.searchParams.get('sslmode') || 'prefer' };
  const schema = `awwo_browser_${randomBytes(8).toString('hex')}`;
  const dir = await mkdtemp(path.join(stateDir, 'browser-fixture-'));
  const summaryFile = path.join(dir, 'requests.jsonl');
  let schemaCreated = false, shuttingDown = false, startupFinished = false;
  let fixture, logChain = Promise.resolve(), requestIndex = 0;
  const summaries = [], workers = [], reservations = [];
  const record = item => {
    summaries.push(item); if (summaries.length > 200) summaries.shift();
    // Bound disk evidence too: at most 1000 requests plus terminal summaries.
    if (requestIndex <= 1000) logChain = logChain.then(() => appendFile(summaryFile, JSON.stringify(item) + '\n', { mode: 0o600 })).catch(() => {
      process.exitCode = 1; console.error('Fixture request evidence could not be saved; stopping this fixture.'); signal();
    });
  };
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    shuttingDown = true;
    for (const worker of [...workers].reverse()) await stop(worker);
    if (fixture?.listening) { const closed = new Promise(resolve => fixture.close(resolve)); fixture.closeAllConnections(); await closed; }
    for (const held of reservations) if (held.server.listening) await held.release();
    await logChain;
    if (schemaCreated) await command('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-Atc', `DROP SCHEMA ${schema} CASCADE`], { env: pgEnv });
    await rm(dir, { recursive: true, force: true });
    console.log('Stopped owned fixture processes and removed only its temporary schema/artifacts. Existing local services were not changed.');
  })();
  const signal = () => { shuttingDown = true; if (startupFinished) cleanup().catch(() => { process.exitCode = 1; console.error('Fixture cleanup failed; inspect the owned temporary schema/artifact location.'); }); };
  process.once('SIGTERM', signal); process.once('SIGINT', signal);
  try {
    await writeFile(path.join(dir, 'creator.md'), `Created by Codex on ${new Date().toISOString().slice(0, 10)} for explicitly authorized local browser protocol acceptance. Scope: owned Go binary and bounded request summaries; removed when the fixture exits. No external inference.\n`);
    await writeFile(summaryFile, '', { mode: 0o600 });
    const scoped = new URL(dsn); scoped.searchParams.set('search_path', schema);
    // Reserve the three service ports concurrently until each owned process is
    // ready to bind. No scan, stop or replacement of existing services occurs.
    for (let i = 0; i < 3; i++) reservations.push(await reservation());
    const [api, pi, web] = reservations;
    const apiURL = `http://127.0.0.1:${api.port}`, piURL = `http://127.0.0.1:${pi.port}`, webURL = `http://127.0.0.1:${web.port}`;
    const fixtureKey = randomBytes(32).toString('base64url');
    const controlToken = randomBytes(32).toString('base64url');
    const bootstrapAdmin = { email: `fixture-admin-${randomBytes(6).toString('hex')}@example.invalid`, password: randomBytes(32).toString('base64url') };
    const faults = createAcceptanceFaults({ target: apiURL, token: controlToken, record });
    fixture = createServer(withFixtureHosts({ fixtureHost: () => `127.0.0.1:${fixture.address().port}`, webHost: new URL(webURL).host }, async (req, res) => {
      try {
        if (req.url === '/__fixture/control') { await faults.control(req, res); return; }
        if (req.url?.startsWith('/api/v1/')) { await faults.proxy(req, res); return; }
        if (req.method === 'GET' && req.url === '/__fixture/requests') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ model: MODEL, externalInference: false, items: summaries })); return;
        }
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
        if (req.headers.authorization !== `Bearer ${fixtureKey}`) { res.writeHead(401).end(); return; }
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 2_097_152) { res.writeHead(413).end(); return; } chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body.model !== MODEL || (body.tools?.length ?? 0) !== 0) { res.writeHead(400).end(); return; }
        const index = ++requestIndex;
        record({ type: 'request', ...summarizeRequest(body, index) });
        streamFixtureResponse(res, body, index, record);
      } catch { if (!res.destroyed && !res.writableEnded) res.destroy(); }
    }));
    fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
    assert.ok(!forbiddenPorts.has(fixture.address().port));
    const browserApiProxyURL = `http://127.0.0.1:${fixture.address().port}`;
    const credentialsFile = path.join(dir, 'acceptance-credentials.json');
    await writeFile(credentialsFile, JSON.stringify({ controlURL: `${browserApiProxyURL}/__fixture/control`, controlToken, bootstrapAdmin }, null, 2), { mode: 0o600 });
    const env = { ...process.env, APP_ENV: 'development', AWWO_DATABASE_URL: scoped.href, AWWO_LISTEN_ADDR: `127.0.0.1:${api.port}`,
      AWWO_PUBLIC_ORIGIN: webURL, AWWO_API_TARGET: browserApiProxyURL, AWWO_PI_URL: piURL, AWWO_PI_HOST: '127.0.0.1', AWWO_PI_PORT: String(pi.port),
      AWWO_PI_TOKEN: randomBytes(32).toString('base64url'), AWWO_PI_PROVIDER: 'openai', AWWO_PI_MODEL: MODEL, AWWO_PI_API_KEY: fixtureKey,
      AWWO_PI_BASE_URL: `http://127.0.0.1:${fixture.address().port}/v1`, AWWO_PI_TIMEOUT_MS: '120000', AWWO_PI_CANCEL_GRACE_MS: '100',
      AWWO_PI_CONTEXT_WINDOW: '262144', AWWO_PI_MAX_TOKENS: '4096', AWWO_PI_MAX_CONCURRENCY: '4', AWWO_RUN_TIMEOUT: '150s',
      AWWO_AUTH_REQUESTS_PER_MINUTE: '100', AWWO_BOOTSTRAP_ADMIN_EMAIL: bootstrapAdmin.email, AWWO_BOOTSTRAP_ADMIN_PASSWORD: bootstrapAdmin.password,
      VITE_AWWO_WEB_HOST: '127.0.0.1', VITE_AWWO_WEB_PORT: String(web.port), AWWO_TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      TMPDIR: dir,
    };
    const binary = path.join(dir, 'awwo-api');
    await command('go', ['build', '-o', binary, './cmd/api'], { cwd: path.join(root, 'backend'), env });
    if (shuttingDown) throw new Error('Fixture startup interrupted');
    await command('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-Atc', `CREATE SCHEMA ${schema}`], { env: pgEnv }); schemaCreated = true;
    for (const [held, cmd, args, health] of [
      [pi, process.execPath, ['apps/pi-worker/server.mjs'], `${piURL}/health`],
      [api, binary, [], `${apiURL}/api/v1/health`],
      [web, process.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.saas.config.mjs', '--host', '127.0.0.1', '--port', String(web.port), '--strictPort'], webURL],
    ]) {
      if (shuttingDown) throw new Error('Fixture startup interrupted');
      await held.release(); const worker = launch(cmd, args, { env, detached: true }); worker.fixtureProcessGroup = true; workers.push(worker);
      await ready(health, worker, () => shuttingDown);
      worker.once('exit', () => { if (startupFinished && !shuttingDown) { process.exitCode = 1; console.error('An owned fixture service exited; stopping only this fixture stack.'); signal(); } });
    }
    if (shuttingDown || workers.some(worker => worker.exitCode !== null || worker.signalCode !== null || worker.startError)) throw new Error('Fixture startup interrupted');
    startupFinished = true;
    console.log(JSON.stringify({ fixture: MODEL, externalInference: false, webURL, apiURL, piURL, browserApiProxyURL, credentialsFile,
      requestSummaryURL: `http://127.0.0.1:${fixture.address().port}/__fixture/requests`, requestSummaryFile: summaryFile, schema, pid: process.pid }, null, 2));
    console.log('仅本地协议验收：在此 URL 注册新的测试账号；先规划添加两节点，应用后分别绑定模型 awwo-protocol-fixture，再运行整图。');
    console.log('单节点聊天：first-turn → second-turn；[fixture:slow] 给约15秒刷新窗口；[fixture:hold] 发出部分内容后等待你取消，可立即重跑。');
    console.log('负向标记：[fixture:invalid-plan]（规划拒绝）、[fixture:provider-503]、[fixture:provider-disconnect]。标记会保留在规划上下文中，请使用专用测试画布。');
    console.log('随机测试管理员和故障控制token仅写入上述600 credentialsFile；node scripts/awwo-saas-fixture-control.mjs --credentials <file> --rules <json-file> 配置一次性精确API故障。默认无故障。');
    console.log('Persona/history证据：查看requestSummaryURL或临时requests.jsonl（仅测试文本摘要，无headers/API keys）。无需改用户模型配置。');
    console.log('边界：确定性协议文本与现有【输出格式】字段类型；不支持任意JSON schema推理。file 字段返回确定性占位内容，会被真实存成可下载交付物（非真实业务成果）。请勿输入真实业务秘密。Ctrl-C清理本实例。');
  } catch (error) { await cleanup(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv.slice(2);
  if (mode.length === 1 && mode[0] === '--self-test') selfTest();
  else if (mode.length === 1 && mode[0] === '--start') start().catch(() => { process.exitCode = 1; console.error('Browser fixture could not start or clean up. No existing service was stopped; check local tool availability and the owned fixture artifacts.'); });
  else { console.log('Usage: node scripts/awwo-saas-browser-fixture.mjs --self-test | --start'); process.exitCode = mode.length ? 1 : 0; }
}
