import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createAcceptanceFaults } from './awwo-saas-acceptance-faults.mjs';
import { fixtureOutput, streamFixtureResponse, withFixtureHosts } from './awwo-saas-browser-fixture.mjs';

const token = 'acceptance-test-token-'.repeat(3);
async function listen(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const route = '/api/v1/tenants/t/sessions/s/messages?limit=1&cursor=page2';
test('real HTTP Host gate accepts the owned Vite API host while control/provider stay fixture-host-only', async t => {
  const received = [];
  const upstream = await listen(t, (req, res) => { received.push({ host: req.headers.host, origin: req.headers.origin }); res.end('api-ok'); });
  const faults = createAcceptanceFaults({ target: upstream, token });
  const webHost = '127.0.0.1:50199'; let proxy;
  proxy = await listen(t, withFixtureHosts({ fixtureHost: () => new URL(proxy).host, webHost }, (req, res) => {
    if (req.url === '/__fixture/control') return faults.control(req, res);
    if (req.url.startsWith('/api/v1/')) return faults.proxy(req, res);
    res.end('fixture-only');
  }));
  const call = (url, host, auth) => new Promise((resolve, reject) => {
    const req = request(proxy + url, { method: url === '/__fixture/control' ? 'POST' : 'GET',
      headers: { host, origin: `http://${webHost}`, ...(auth ? { authorization: `Bearer ${token}` } : {}) } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(url === '/__fixture/control' ? '{"rules":[]}' : undefined);
  });
  const fixtureHost = new URL(proxy).host;
  assert.equal(await call(route, webHost), 200);
  assert.equal(await call(route, fixtureHost), 200);
  assert.equal(await call(route, 'attacker.example'), 403);
  assert.equal(await call(route, '127.0.0.1:50200'), 403);
  assert.equal(await call('/__fixture/control', webHost, true), 403);
  assert.equal(await call('/__fixture/control', fixtureHost), 401);
  assert.equal(await call('/__fixture/control', fixtureHost, true), 200);
  assert.equal(await call('/v1/chat/completions', webHost), 403);
  assert.equal(await call('/__fixture/requests', webHost), 403);
  assert.equal(await call('/api/v1evil/path', webHost), 403);
  assert.deepEqual(received, Array(2).fill({ host: new URL(upstream).host, origin: `http://${webHost}` }));
});
test('control authentication, exact query/method one-shot matching, forwarding and safe evidence', async t => {
  const forwarded = [], evidence = [];
  const upstream = await listen(t, (req, res) => { forwarded.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); });
  const faults = createAcceptanceFaults({ target: upstream, token, record: e => evidence.push(e) });
  const proxy = await listen(t, (req, res) => req.url === '/__fixture/control' ? faults.control(req, res) : faults.proxy(req, res));
  const rules = JSON.stringify({ rules: [{ id: 'export-page-two', method: 'GET', path: route, status: 503 }] });
  assert.equal((await fetch(proxy + '/__fixture/control', { method: 'POST', body: rules })).status, 401);
  assert.equal((await fetch(proxy + '/__fixture/control', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: rules })).status, 200);
  assert.equal((await fetch(proxy + route.replace('page2', 'page1'))).status, 200);
  assert.equal((await fetch(proxy + route, { method: 'PUT' })).status, 200);
  assert.equal((await fetch(proxy + route)).status, 503);
  assert.equal((await fetch(proxy + route)).status, 200);
  assert.equal(forwarded.length, 3); assert.equal(evidence.length, 1);
  assert.deepEqual(Object.keys(evidence[0]), ['type', 'id', 'at']); assert.equal(evidence[0].id, 'export-page-two');
});
test('malformed rule sets fail closed without partial replacement; expired rules never fire', () => {
  let time = 100;
  assert.throws(() => createAcceptanceFaults({ target: 'https://example.com', token }));
  const faults = createAcceptanceFaults({ target: 'http://127.0.0.1:1', token, now: () => time });
  const valid = { id: 'valid', method: 'GET', path: route, status: 503 };
  for (const change of [{ method: 'POST' }, { path: '/api/v1/auth/login' }, { path: 'https://example.com' }, { delayMs: 30001 }, { ttlMs: -1 }, { status: 200 }, { disconnect: true }, { extra: true }]) {
    assert.throws(() => faults.replace({ rules: [{ ...valid, ...change }] }));
  }
  assert.throws(() => faults.replace({ rules: [valid, valid] }));
  assert.deepEqual(faults.replace({ rules: [] }), []);
});
test('HTTP control rejects invalid replacement while preserving the previous rule', async t => {
  const upstream = await listen(t, (_req, res) => res.end('ok'));
  const faults = createAcceptanceFaults({ target: upstream, token });
  const proxy = await listen(t, (req, res) => req.url === '/__fixture/control' ? faults.control(req, res) : faults.proxy(req, res));
  faults.replace({ rules: [{ id: 'keep', method: 'GET', path: route, status: 503 }] });
  const rejected = await fetch(proxy + '/__fixture/control', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"rules":[{"id":"bad"}]}' });
  assert.equal(rejected.status, 400); assert.equal((await fetch(proxy + route)).status, 503);
});
test('expiry and a cancelled delayed page do not leave later requests blocked', async t => {
  let time = 100; let calls = 0;
  const upstream = await listen(t, (_req, res) => { calls++; res.end('ok'); });
  const faults = createAcceptanceFaults({ target: upstream, token, now: () => time });
  const proxy = await listen(t, (req, res) => faults.proxy(req, res));
  faults.replace({ rules: [{ id: 'expires', method: 'GET', path: route, status: 503, ttlMs: 10 }] }); time = 111;
  assert.equal((await fetch(proxy + route)).status, 200);
  faults.replace({ rules: [{ id: 'cancel-page', method: 'GET', path: route, delayMs: 5000 }] });
  await assert.rejects(fetch(proxy + route, { signal: AbortSignal.timeout(100) }));
  assert.equal((await fetch(proxy + route)).status, 200); assert.equal(calls, 2);
});
test('one browser SSE disconnect leaves the upstream server and next stream usable', async t => {
  const route = '/api/v1/tenants/t/runs/r/events';
  const upstream = await listen(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"type":"completed"}\n\n'); });
  const faults = createAcceptanceFaults({ target: upstream, token });
  const proxy = await listen(t, (req, res) => faults.proxy(req, res));
  faults.replace({ rules: [{ id: 'drop-browser-stream', method: 'GET', path: route, disconnect: true }] });
  await assert.rejects(async () => (await fetch(proxy + route)).text());
  assert.match(await (await fetch(proxy + route)).text(), /completed/);
});
test('invalid plans are explicit unsupported operations only in planner requests', () => {
  const prompt = '[fixture:invalid-plan]';
  assert.equal(JSON.parse(fixtureOutput({ messages: [{ role: 'system', content: 'Awwo canvas planner' }, { role: 'user', content: prompt }] })).operations[0].type, 'exec');
  assert.match(fixtureOutput({ messages: [{ role: 'user', content: prompt }] }), /本地协议验收/);
});
test('actual provider HTTP 503 and midstream disconnect are observable failures, never completion', async t => {
  const events = [];
  const provider = await listen(t, (req, res) => streamFixtureResponse(res, { messages: [{ role: 'user', content: req.url.includes('503') ? '[fixture:provider-503]' : '[fixture:provider-disconnect]' }] }, 1, e => events.push(e)));
  assert.equal((await fetch(provider + '/503')).status, 503);
  const stream = await fetch(provider + '/disconnect'); assert.equal(stream.status, 200);
  await assert.rejects(stream.text());
  assert.deepEqual(events.map(e => e.type), ['provider_503', 'provider_disconnected']);
});
