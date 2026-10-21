// Tests for AwwO 本地版's web server (scripts/awwo-local-web.mjs): what the hosted nginx does, on loopback — the app,
// its assets and its 404s, the instance's own name, the proxy to the public API only, and the staged videos.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LOCAL_HOST } from './awwo-local-lib.mjs';
import { byteRange, createLocalWebServer, requestPath, sitePath } from './awwo-local-web.mjs';

const scratch = () => mkdtempSync(path.join(os.tmpdir(), 'awwo-local-web-test-'));

test('paths: dot segments and NUL are refused everywhere, a colon or backslash only for site files', () => {
  assert.equal(sitePath('/assets/app.js?x=1'), '/assets/app.js');
  assert.equal(sitePath('/%E6%95%99%E7%A8%8B'), '/教程');
  for (const bad of ['/..%2f..%2fsecret', '/assets/%2e%2e%2fx', '/%5c..%5cwindows', '/assets/x.js:stream', '/a%00b', '/%E0%A4%A']) {
    assert.equal(sitePath(bad), null, bad);
  }
  assert.equal(requestPath('/api/v1/tenants/t1/skills/builtin%3Aremotion-video'), '/api/v1/tenants/t1/skills/builtin:remotion-video');
  for (const bad of ['/api/v1/a/%2e%2e/admin', '/api/v1/..%2finternal%2fworkspace-calls', '/api/v1/x%5c..%5cinternal', '/api/v1/../internal/x', 'api/v1/x']) {
    assert.equal(requestPath(bad), null, bad);
  }
  assert.equal(requestPath('/api/v1/files/a%2Fb.txt'), '/api/v1/files/a/b.txt', 'an encoded slash in an API value is kept');
  assert.equal(sitePath('/assets/a%2Fb.js'), null, 'but never names a site file');
});

test('byteRange answers as nginx does', () => {
  assert.equal(byteRange(undefined, 10), null);
  assert.deepEqual(byteRange('bytes=0-3', 10), [0, 3]);
  assert.deepEqual(byteRange('bytes=5-', 10), [5, 9]);
  assert.deepEqual(byteRange('bytes=-4', 10), [6, 9]);
  assert.deepEqual(byteRange('bytes=8-100', 10), [8, 9]);
  assert.equal(byteRange('bytes=10-12', 10), 'invalid');
  assert.equal(byteRange('bytes=-', 10), 'invalid');
  assert.equal(byteRange('items=0-1', 10), null, 'another unit is ignored: the whole file');
});

async function listen(server, host = '127.0.0.1') {
  await new Promise(resolve => server.listen(0, host, resolve));
  return server.address().port;
}
function request(port, { method = 'GET', path: target = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: { host: host ?? `${LOCAL_HOST}:${port}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('aborted', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), aborted: true }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), aborted: true }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function freePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function webFixture({ withApp = true, stagedFallback = '', host } = {}) {
  const root = scratch();
  if (withApp) writeFileSync(path.join(root, 'saas.html'), '<!doctype html><title>AwwO</title>');
  mkdirSync(path.join(root, 'assets'));
  writeFileSync(path.join(root, 'assets', 'saas-abc.js'), 'export const x = 1;');
  writeFileSync(path.join(root, 'third-party-licenses.txt'), '© licences');
  const staged = scratch();
  mkdirSync(path.join(staged, 'academy'));
  writeFileSync(path.join(staged, 'academy', '0123456789abcdef.mp4'), Buffer.from('0123456789'));
  const seen = [];
  const api = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, origin: req.headers.origin, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/api/v1/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 50);
        return;
      }
      if (req.url === '/api/v1/cut') {
        // The API going away in the middle of a stream.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.socket.destroy(), 50);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-api': 'yes' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const apiPort = await listen(api);
  const port = await freePort();
  const web = createLocalWebServer({ root, stagedDir: staged, apiPort, port, stagedFallback, ...(host ? { host } : {}) });
  await new Promise(resolve => web.listen(port, '127.0.0.1', resolve));
  return { port, seen, close: async () => { web.closeAllConnections(); await new Promise(resolve => web.close(resolve)); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); } };
}

test('the web server serves the app, its assets and its 404s as the hosted nginx does', async () => {
  const site = await webFixture();
  try {
    const home = await request(site.port);
    assert.equal(home.status, 200);
    assert.match(home.body, /<title>AwwO/);
    assert.equal(home.headers['cache-control'], 'no-cache');
    assert.equal(home.headers['x-content-type-options'], 'nosniff');
    assert.equal(home.headers['x-frame-options'], 'DENY');
    assert.equal(home.headers['referrer-policy'], 'same-origin');
    assert.match((await request(site.port, { path: '/admin' })).body, /<title>AwwO/, 'app routes get the app');
    const asset = await request(site.port, { path: '/assets/saas-abc.js' });
    assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.match(asset.headers['cache-control'], /immutable/);
    for (const missing of ['/assets/gone.js', '/showcase/gone.mp4', '/kits/anatomy/1/gone.js']) {
      const answer = await request(site.port, { path: missing });
      assert.equal(answer.status, 404, missing);
      assert.doesNotMatch(answer.body, /<title>/, `${missing} is never the app's page`);
    }
    assert.equal((await request(site.port, { path: '/third-party-licenses.txt' })).headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal((await request(site.port, { path: '/..%2fsecret' })).status, 400);
    assert.equal((await request(site.port, { path: '/assets/saas-abc.js:secret' })).status, 400);
    assert.equal((await request(site.port, { method: 'POST', path: '/' })).status, 405);
    const ranged = await request(site.port, { path: '/assets/saas-abc.js', headers: { range: 'bytes=0-5' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.body, 'export');
    assert.equal(ranged.headers['content-range'], 'bytes 0-5/19');
    assert.equal((await request(site.port, { path: '/assets/saas-abc.js', headers: { range: 'bytes=99-' } })).status, 416);
    assert.equal((await request(site.port, { path: '/assets/saas-abc.js', headers: { range: 'items=0-1' } })).status, 200);
  } finally {
    await site.close();
  }
});

test('the web server answers its own name, sends the loopback addresses there, and refuses any other name', async () => {
  const site = await webFixture();
  try {
    assert.equal((await request(site.port)).status, 200);
    for (const alias of [`127.0.0.1:${site.port}`, `localhost:${site.port}`]) {
      const sent = await request(site.port, { host: alias, path: '/?tenant=t1' });
      assert.equal(sent.status, 302, alias);
      assert.equal(sent.headers.location, `http://${LOCAL_HOST}:${site.port}/?tenant=t1`);
      assert.equal((await request(site.port, { host: alias, method: 'POST', path: '/api/v1/auth/login' })).status, 421, 'a write under another name is refused');
    }
    assert.equal((await request(site.port, { host: `rebind.example:${site.port}` })).status, 403);
    assert.equal((await request(site.port, { host: `${LOCAL_HOST}:1` })).status, 403);
    assert.ok(!site.seen.some(item => item.url === '/api/v1/auth/login'), 'nothing under another name reached the API');
  } finally {
    await site.close();
  }
});

test('another data folder\'s instance answers its own name only, and sends awwo.localhost there', async () => {
  const host = 'awwo-0123456789ab.localhost';
  const site = await webFixture({ host });
  try {
    assert.equal((await request(site.port, { host: `${host}:${site.port}` })).status, 200);
    const sent = await request(site.port, { host: `${LOCAL_HOST}:${site.port}`, path: '/admin' });
    assert.equal(sent.status, 302);
    assert.equal(sent.headers.location, `http://${host}:${site.port}/admin`);
    assert.equal((await request(site.port, { host: `${LOCAL_HOST}:${site.port}`, method: 'POST', path: '/api/v1/auth/login' })).status, 421);
    assert.equal((await request(site.port, { host: `awwo-ffffffffffff.localhost:${site.port}` })).status, 403, 'not another instance\'s name');
    assert.ok(!site.seen.some(item => item.url === '/api/v1/auth/login'));
  } finally {
    await site.close();
  }
});

test('the proxy forwards the public API only, unchanged, including encoded colons, and streams', async () => {
  const site = await webFixture();
  try {
    const answer = await request(site.port, { method: 'POST', path: '/api/v1/echo?x=1', headers: { origin: `http://${LOCAL_HOST}:${site.port}`, 'content-type': 'application/json' }, body: '{"a":1}' });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['x-api'], 'yes');
    assert.equal(answer.headers['x-frame-options'], 'DENY');
    assert.deepEqual(site.seen.at(-1), { method: 'POST', url: '/api/v1/echo?x=1', origin: `http://${LOCAL_HOST}:${site.port}`, body: '{"a":1}' });
    await request(site.port, { path: '/api/v1/echo', headers: { origin: 'https://evil.example' } });
    assert.equal(site.seen.at(-1).origin, 'https://evil.example', 'any other origin reaches the API unchanged, to be refused there');
    const skill = await request(site.port, { path: '/api/v1/tenants/t1/skills/builtin%3Aremotion-video' });
    assert.equal(skill.status, 200, 'a skill reference keeps its colon');
    assert.equal(site.seen.at(-1).url, '/api/v1/tenants/t1/skills/builtin%3Aremotion-video');
    assert.equal((await request(site.port, { path: '/api/internal/workspace-calls' })).status, 404);
    assert.notEqual(site.seen.at(-1).url, '/api/internal/workspace-calls', 'the internal route never reached the API');
    const stream = await request(site.port, { path: '/api/v1/stream' });
    assert.equal(stream.body, 'data: one\n\ndata: two\n\n');
    const cut = await request(site.port, { path: '/api/v1/cut' });
    assert.equal(cut.body, 'data: one\n\n');
    assert.ok(cut.aborted, 'a stream the API cut ends the browser\'s side too, instead of hanging');
  } finally {
    await site.close();
  }
});

test('the proxy says so when the API is not answering, and an unbuilt app says how to build it', async () => {
  const root = scratch();
  const port = await freePort();
  const deadPort = await freePort();
  const web = createLocalWebServer({ root, apiPort: deadPort, port });
  await new Promise(resolve => web.listen(port, '127.0.0.1', resolve));
  try {
    const answer = await request(port, { path: '/api/v1/health' });
    assert.equal(answer.status, 502);
    assert.equal(JSON.parse(answer.body).error.code, 'api_unavailable');
    const unbuilt = await request(port);
    assert.equal(unbuilt.status, 503);
    assert.match(unbuilt.body, /setup:local/);
  } finally {
    await new Promise(resolve => web.close(resolve));
  }
});

test('staged videos play from this computer when there, else from the fallback, else 404', async () => {
  const site = await webFixture({ stagedFallback: 'https://awwo.example' });
  try {
    const local = await request(site.port, { path: '/showcase/staged/academy/0123456789abcdef.mp4', headers: { range: 'bytes=2-4' } });
    assert.equal(local.status, 206);
    assert.equal(local.body, '234');
    assert.match(local.headers['cache-control'], /immutable/);
    assert.equal(local.headers['x-content-type-options'], 'nosniff');
    const remote = await request(site.port, { path: '/showcase/staged/academy/fedcba9876543210.mp4' });
    assert.equal(remote.status, 302);
    assert.equal(remote.headers.location, 'https://awwo.example/showcase/staged/academy/fedcba9876543210.mp4');
  } finally {
    await site.close();
  }
  const offline = await webFixture();
  try {
    assert.equal((await request(offline.port, { path: '/showcase/staged/academy/fedcba9876543210.mp4' })).status, 404);
  } finally {
    await offline.close();
  }
});
