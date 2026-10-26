// Tests for AwwO 本地版's web server (scripts/awwo-local-web.mjs): what the hosted nginx does, on loopback — the app,
// its assets and its 404s, the instance's own name, the proxy to the public API only, and the staged videos.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LOCAL_HOST } from './awwo-local-lib.mjs';
import { byteRange, createLocalWebServer, requestPath, sessionCookieValue, sitePath } from './awwo-local-web.mjs';

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

test('what a Set-Cookie line does to the API\'s session', () => {
  assert.equal(sessionCookieValue('awwo_session=aToken_1; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax'), 'aToken_1');
  assert.equal(sessionCookieValue('awwo_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'), '', 'Go\'s MaxAge -1');
  assert.equal(sessionCookieValue('awwo_session=aToken_1; Max-Age=-5'), '');
  assert.equal(sessionCookieValue('awwo_session=aToken_1; Expires=Thu, 01 Jan 1970 00:00:00 GMT'), '');
  assert.equal(sessionCookieValue('awwo_session=aToken_1; Expires=Fri, 01 Jan 2100 00:00:00 GMT'), 'aToken_1');
  assert.equal(sessionCookieValue('awwo_session='), '');
  assert.equal(sessionCookieValue('other=1; Path=/'), null);
  assert.equal(sessionCookieValue('awwo_sessionx=1'), null);
  assert.equal(sessionCookieValue('awwo_identity=1; Path=/api/v1/auth/clawhunt'), null);
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

async function webFixture({ withApp = true, stagedFallback = '', host, windowToken, windowSession } = {}) {
  const root = scratch();
  if (withApp) writeFileSync(path.join(root, 'saas.html'), '<!doctype html><title>AwwO</title>');
  mkdirSync(path.join(root, 'assets'));
  writeFileSync(path.join(root, 'assets', 'saas-abc.js'), 'export const x = 1;');
  writeFileSync(path.join(root, 'third-party-licenses.txt'), '© licences');
  const staged = scratch();
  mkdirSync(path.join(staged, 'academy'));
  writeFileSync(path.join(staged, 'academy', '0123456789abcdef.mp4'), Buffer.from('0123456789'));
  const seen = [];
  const seenHeaders = [];
  let logins = 0;
  const api = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, origin: req.headers.origin, body: Buffer.concat(chunks).toString('utf8') });
      seenHeaders.push({ host: req.headers.host, cookie: req.headers.cookie });
      if (req.url === '/api/v1/redirect') {
        res.writeHead(303, { location: `http://${host || LOCAL_HOST}:${port}/?account=local` });
        return res.end();
      }
      if (req.url === '/api/v1/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 50);
        return;
      }
      if (req.url === '/api/v1/hold') {
        // A run's event stream that goes on until its reader goes away.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 30_000).unref();
        return;
      }
      if (req.url === '/api/v1/cut') {
        // The API going away in the middle of a stream.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.socket.destroy(), 50);
        return;
      }
      // A sign-in and a sign-out as auth.go answers them (Go's SetCookie: MaxAge -1 is written Max-Age=0), each sign-in
      // with a session of its own.
      if (req.url === '/api/v1/login') {
        logins += 1;
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': [`awwo_session=aSession_Token-${String(logins).padStart(10, '0')}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`, 'other=1; Path=/'] });
        return res.end('{}');
      }
      if (req.url === '/api/v1/logout') {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'awwo_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
        return res.end('{}');
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-api': 'yes' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const apiPort = await listen(api);
  const port = await freePort();
  const web = createLocalWebServer({ root, stagedDir: staged, apiPort, port, stagedFallback, ...(host ? { host } : {}), ...(windowToken ? { windowToken } : {}), ...(windowSession ? { windowSession } : {}) });
  await new Promise(resolve => web.listen(port, '127.0.0.1', resolve));
  return { port, web, seen, seenHeaders, close: async () => { web.closeAllConnections(); await new Promise(resolve => web.close(resolve)); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); } };
}

test('once the runtime\'s stop has begun its port is held, answering 503 alone, and nothing reaches the API', async () => {
  const host = 'awwo-0123456789ab.localhost';
  const token = 'Tk_-'.repeat(10).concat('abc');
  const site = await webFixture({ host, windowToken: token });
  try {
    const own = { host: `${host}:${site.port}` };
    assert.equal((await request(site.port, { ...own, path: '/api/v1/echo' })).status, 200);
    // A run's event stream open when the stop begins (its first event here, so the API has it) ends with it.
    const stream = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: site.port, path: '/api/v1/hold', headers: own }, res => res.once('data', () => resolve(res)));
      req.on('error', reject);
      req.end();
    });
    const ended = new Promise(resolve => stream.once('close', () => resolve(stream.complete)));
    stream.resume();
    const before = site.seen.length;
    site.web.stopServing();
    assert.equal(await ended, false, 'an open stream is ended, not left to finish');
    const window = { host: `127.0.0.1:${site.port}`, headers: { cookie: `awwo_session=s1; awwo_shell=${token}` } };
    for (const asked of [{ ...own }, { ...own, path: '/api/v1/auth/me' }, { ...own, method: 'POST', path: '/api/v1/echo', body: '{}' },
      { ...own, path: '/assets/saas-abc.js' }, { ...window }, { ...window, path: '/api/v1/auth/me' }, { host: `127.0.0.1:${site.port}` }]) {
      const answer = await request(site.port, asked);
      assert.equal(answer.status, 503, JSON.stringify(asked));
      assert.equal(answer.headers.connection, 'close');
    }
    assert.equal(site.seen.length, before, 'none of it reached the API');
  } finally {
    await site.close();
  }
});

test('the Mac app\'s window is answered at 127.0.0.1 with its launch\'s cookie, which never reaches the API', async () => {
  const host = 'awwo-0123456789ab.localhost';
  const token = 'Tk_-'.repeat(10).concat('abc');
  const site = await webFixture({ host, windowToken: token });
  const own = `http://${host}:${site.port}`;
  const window = { host: `127.0.0.1:${site.port}`, headers: { cookie: `awwo_session=s1; awwo_shell=${token}` } };
  try {
    const home = await request(site.port, window);
    assert.equal(home.status, 200, 'the window gets the app at its own address');
    assert.match(home.body, /<title>AwwO/);
    assert.equal((await request(site.port, { ...window, path: '/assets/saas-abc.js' })).status, 200);
    const posted = await request(site.port, { ...window, method: 'POST', path: '/api/v1/echo', headers: { ...window.headers, origin: `http://127.0.0.1:${site.port}` }, body: '{}' });
    assert.equal(posted.status, 200);
    assert.equal(site.seen.at(-1).origin, own, 'the API sees the instance\'s origin and checks it as always');
    assert.deepEqual(site.seenHeaders.at(-1), { host: `${host}:${site.port}`, cookie: undefined }, 'the window\'s cookie is taken off, and so is a session of its own');
    // Its sign-in is kept here: the API's session cookie is taken off the answer, kept, and given with its requests.
    const login = await request(site.port, { ...window, method: 'POST', path: '/api/v1/login', body: '{}' });
    assert.deepEqual(login.headers['set-cookie'], ['other=1; Path=/'], 'the window is given no session cookie, and the others as they are');
    await request(site.port, { ...window, path: '/api/v1/echo', headers: { cookie: `awwo_session=forged; awwo_shell=${token}; theme=dark` } });
    assert.equal(site.seenHeaders.at(-1).cookie, 'theme=dark; awwo_session=aSession_Token-0000000001', 'the kept session, in the place of one the window sends');
    // A browser at the instance's name (perhaps another person's account) keeps its own cookies, both ways, and its
    // sign-in never becomes the window's.
    const browserLogin = await request(site.port, { host: `${host}:${site.port}`, method: 'POST', path: '/api/v1/login', body: '{}' });
    assert.match(String(browserLogin.headers['set-cookie']), /awwo_session=aSession_Token-0000000002; Path=\/; Max-Age=86400/);
    await request(site.port, { host: `${host}:${site.port}`, path: '/api/v1/echo', headers: { cookie: 'awwo_session=browsers' } });
    assert.equal(site.seenHeaders.at(-1).cookie, 'awwo_session=browsers');
    await request(site.port, { ...window, path: '/api/v1/echo' });
    assert.equal(site.seenHeaders.at(-1).cookie, 'awwo_session=aSession_Token-0000000001', 'the window is still signed in as itself');
    // A browser at the window's address without the window's cookie never reaches the API, so it sets nothing either.
    await request(site.port, { host: `127.0.0.1:${site.port}`, method: 'POST', path: '/api/v1/login', body: '{}' });
    await request(site.port, { ...window, path: '/api/v1/echo' });
    assert.equal(site.seenHeaders.at(-1).cookie, 'awwo_session=aSession_Token-0000000001');
    // Signing out from the window ends the kept session.
    const logout = await request(site.port, { ...window, method: 'POST', path: '/api/v1/logout', body: '{}' });
    assert.equal(logout.headers['set-cookie'], undefined);
    await request(site.port, { ...window, path: '/api/v1/echo' });
    assert.equal(site.seenHeaders.at(-1).cookie, undefined, 'no session after the window signed out');
    await request(site.port, { ...window, method: 'POST', path: '/api/v1/echo', headers: { ...window.headers, origin: 'https://evil.example' } });
    assert.equal(site.seen.at(-1).origin, 'https://evil.example', 'another origin reaches the API unchanged, to be refused there');
    await request(site.port, { ...window, path: '/api/v1/echo', headers: { cookie: `awwo_shell=${token}` } });
    assert.equal(site.seenHeaders.at(-1).cookie, undefined, 'a request with the window\'s cookie alone reaches the API with none');
    const sent = await request(site.port, { ...window, path: '/api/v1/redirect' });
    assert.equal(sent.headers.location, `http://127.0.0.1:${site.port}/?account=local`, 'an address the API answers with is the window\'s');
    // Without the cookie, or with another, the address is a browser's: it is sent to the instance's name as before.
    for (const cookie of [undefined, 'awwo_shell=wrong', `awwo_shell=${token}x`, `awwo_shellx=${token}`]) {
      const headers = cookie ? { cookie } : {};
      const browser = await request(site.port, { host: `127.0.0.1:${site.port}`, headers, path: '/?tenant=t1' });
      assert.equal(browser.status, 302, String(cookie));
      assert.equal(browser.headers.location, `${own}/?tenant=t1`);
      assert.equal((await request(site.port, { host: `127.0.0.1:${site.port}`, headers, path: '/admin' })).status, 302, 'no route of the app either');
      const api = await request(site.port, { host: `127.0.0.1:${site.port}`, headers, path: '/api/v1/auth/me' });
      assert.equal(api.status, 302, 'nor the API');
      assert.equal(api.headers.location, `${own}/api/v1/auth/me`);
      assert.equal((await request(site.port, { host: `127.0.0.1:${site.port}`, headers, method: 'POST', path: '/api/v1/auth/login' })).status, 421);
    }
    // The site's own files are public: the app fetches some without cookies (credentials: 'omit'), and they come.
    const asset = await request(site.port, { host: `127.0.0.1:${site.port}`, path: '/assets/saas-abc.js' });
    assert.equal(asset.status, 200, 'an asset without the window\'s cookie');
    assert.equal(asset.body, 'export const x = 1;');
    assert.equal((await request(site.port, { host: `127.0.0.1:${site.port}`, path: '/showcase/staged/academy/0123456789abcdef.mp4' })).status, 200, 'a staged video');
    assert.equal((await request(site.port, { host: `127.0.0.1:${site.port}`, path: '/assets/gone.js' })).status, 404, 'a missing asset is a 404, as at the instance\'s name');
    assert.equal((await request(site.port, { host: `127.0.0.1:${site.port}`, method: 'HEAD', path: '/assets/saas-abc.js' })).status, 200);
    // The app's page is not one of them, asked for by its file's name either.
    for (const page of ['/saas.html', '/SAAS.HTML', '/saas.html?x=1']) {
      const asked = await request(site.port, { host: `127.0.0.1:${site.port}`, path: page });
      assert.equal(asked.status, 302, page);
      assert.equal(asked.headers.location, `${own}${page}`);
    }
    assert.equal((await request(site.port, { ...window, path: '/saas.html' })).status, 200, 'the window gets it by its name too');
    assert.equal((await request(site.port, { ...window, host: `localhost:${site.port}` })).status, 302, 'only 127.0.0.1 is the window\'s address');
    assert.ok(!site.seen.some(item => item.url === '/api/v1/auth/login'), 'nothing without the cookie reached the API');
  } finally {
    await site.close();
  }
  // A runtime no Mac window started has no such address.
  const plain = await webFixture({ host });
  try {
    assert.equal((await request(plain.port, { host: `127.0.0.1:${plain.port}`, headers: { cookie: `awwo_shell=${token}` } })).status, 302);
  } finally {
    await plain.close();
  }
});

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
