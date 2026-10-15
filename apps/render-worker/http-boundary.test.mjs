import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.mjs';
import { RenderError } from './render.mjs';
import { createRenderServer } from './server.mjs';

const TOKEN = 'render-token-'.padEnd(40, 'x');
// Any existing file stands in for the browser, ffmpeg and ffprobe: the fake render never runs them.
const READY = loadConfig({ AWWO_RENDER_TOKEN: TOKEN, AWWO_RENDER_CHROME: process.execPath, AWWO_RENDER_FFMPEG: process.execPath, AWWO_RENDER_FFPROBE: process.execPath });
const PAGE = '<!doctype html><html><body></body></html>';
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

function renderBody(overrides = {}) {
  return { renderId: 'aRender_0001', html: PAGE, width: 160, height: 90, fps: 12, seconds: 1, loop: false, outputs: ['mp4'], stills: [], ...overrides };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function start(config, options) {
  const app = createRenderServer(config, options);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (body, headers = AUTH, init = {}) => fetch(`${base}/internal/renders`, {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body), ...init,
  });
  return { app, base, post };
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}

test('health reports readiness and limits without a token', async (t) => {
  const ready = await start(READY);
  t.after(() => ready.app.close());
  const response = await fetch(`${ready.base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ready: true, service: 'awwo-render', version: 1, chrome: true, ffmpeg: true, sandbox: true,
    limits: { maxSeconds: 20, maxFps: 60, maxWidth: 1920, maxHeight: 1920, maxFrames: 1800, maxHtmlBytes: 6291456 }, busy: false,
  });
  const missing = await start(loadConfig({ AWWO_RENDER_TOKEN: TOKEN, AWWO_RENDER_CHROME: `${process.execPath}.missing`, AWWO_RENDER_FFMPEG: 'no-such-ffmpeg-awwo' }));
  t.after(() => missing.app.close());
  const unready = await fetch(`${missing.base}/health`);
  assert.equal(unready.status, 503);
  assert.deepEqual((({ ready, chrome, ffmpeg }) => ({ ready, chrome, ffmpeg }))(await unready.json()), { ready: false, chrome: false, ffmpeg: false });
  const refused = await missing.post(renderBody());
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).error.code, 'RENDER_UNAVAILABLE');
});

test('401 without the exact bearer token', async (t) => {
  let calls = 0;
  const { app, base, post } = await start(READY, { render: async () => { calls += 1; } });
  t.after(() => app.close());
  for (const authorization of [undefined, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}y`, TOKEN, `bearer ${TOKEN}`]) {
    const headers = { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) };
    const response = await post(renderBody(), headers);
    assert.equal(response.status, 401, String(authorization));
    assert.deepEqual(await response.json(), { error: { code: 'UNAUTHORIZED', message: 'Internal service authentication required.' } });
  }
  assert.equal((await fetch(`${base}/internal/renders/aRender_0001`, { method: 'DELETE' })).status, 401);
  assert.equal(calls, 0);
  const short = await start(loadConfig({ AWWO_RENDER_TOKEN: 'short', AWWO_RENDER_CHROME: process.execPath }));
  t.after(() => short.app.close());
  assert.equal((await short.post(renderBody(), { ...AUTH, authorization: 'Bearer short' })).status, 401);
});

test('400 names the invalid field; 404 for unknown routes', async (t) => {
  const { app, base, post } = await start(READY, { render: async () => assert.fail('render must not run') });
  t.after(() => app.close());
  for (const [body, field] of [[renderBody({ fps: 0 }), 'fps'], [renderBody({ width: 50 }), 'width'], [renderBody({ html: 'text' }), 'html'],
    [renderBody({ stills: [12] }), 'stills'], [renderBody({ outputs: ['webm'] }), 'outputs'], ['{not json', 'body'], ['[]', 'body']]) {
    const response = await post(body);
    assert.equal(response.status, 400, field);
    const { error } = await response.json();
    assert.equal(error.code, 'INVALID_RENDER');
    assert.equal(error.field, field);
  }
  const wrongType = await post(renderBody(), { ...AUTH, 'content-type': 'text/plain' });
  assert.equal(wrongType.status, 400);
  assert.equal((await wrongType.json()).error.field, 'contentType');
  assert.equal((await fetch(`${base}/internal/other`, { headers: AUTH })).status, 404);
  assert.equal((await fetch(`${base}/internal/renders`, { headers: AUTH })).status, 404);
});

test('413 for a body over 8 MiB, after reading it, and the worker stays usable', async (t) => {
  const { app, post } = await start(READY, { render: async (request) => ({ renderId: request.renderId }) });
  t.after(() => app.close());
  const html = `<html>${'a'.repeat(8 * 1024 * 1024)}`;
  const response = await post(JSON.stringify(renderBody({ html })));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'TOO_LARGE');
  const after = await post(renderBody());
  assert.equal(after.status, 200);
});

test('200 returns the render reply; the renderer gets the normalized request and a signal', async (t) => {
  const reply = {
    renderId: 'aRender_0001', mode: 'contract', frames: 12, fps: 12, width: 160, height: 90, seconds: 1, distinctFrames: 12, elapsedMs: 5,
    probe: { frames: 12, width: 160, height: 90, duration: 1 }, warnings: [], pageErrors: [],
    outputs: [{ kind: 'mp4', contentType: 'video/mp4', size: 3, sha256: 'ab', data: 'AAAA' }],
  };
  let seen;
  const { app, post } = await start(READY, { render: async (request, config, { signal }) => { seen = { request, config, signal }; return reply; } });
  t.after(() => app.close());
  const response = await post(renderBody({ width: 161, outputs: ['contact'], stills: [3] }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), reply);
  assert.deepEqual({ ...seen.request, html: undefined }, {
    renderId: 'aRender_0001', html: undefined, width: 160, height: 90, fps: 12, seconds: 1, frames: 12, loop: false, outputs: ['mp4', 'contact'], stills: [3],
  });
  assert.equal(seen.config, READY);
  assert.ok(seen.signal instanceof AbortSignal);
});

test('422 carries the failure detail; 503 when the worker itself cannot render', async (t) => {
  const failures = [new RenderError('timeout', 'too long'), new RenderError('page_load_failed', 'did not load'), new Error('surprise'),
    new RenderError('browser_unavailable', 'no browser', 503)];
  const { app, post } = await start(READY, { render: async () => { throw failures.shift(); } });
  t.after(() => app.close());
  for (const [status, code, detail] of [[422, 'RENDER_FAILED', 'timeout'], [422, 'RENDER_FAILED', 'page_load_failed'],
    [422, 'RENDER_FAILED', 'render_failed'], [503, 'RENDER_UNAVAILABLE', 'browser_unavailable']]) {
    const response = await post(renderBody());
    assert.equal(response.status, status);
    const { error } = await response.json();
    assert.deepEqual([error.code, error.detail], [code, detail]);
  }
});

test('one render at a time: 429 while busy', async (t) => {
  const started = deferred();
  const release = deferred();
  const { app, base, post } = await start(READY, { render: async (request) => { started.resolve(); await release.promise; return { renderId: request.renderId }; } });
  t.after(() => app.close());
  const first = post(renderBody());
  await started.promise;
  assert.equal((await (await fetch(`${base}/health`)).json()).busy, true);
  const second = await post(renderBody({ renderId: 'aRender_0002' }));
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'RENDER_BUSY');
  release.resolve();
  assert.equal((await first).status, 200);
  await waitFor(async () => (await (await fetch(`${base}/health`)).json()).busy === false);
  assert.equal((await post(renderBody({ renderId: 'aRender_0003' }))).status, 200);
});

test('DELETE stops the render in progress; unknown ids are 404', async (t) => {
  const started = deferred();
  const { app, base, post } = await start(READY, {
    render: (request, config, { signal }) => new Promise((resolve, reject) => {
      started.resolve();
      signal.addEventListener('abort', () => reject(new RenderError('aborted', 'stopped')));
    }),
  });
  t.after(() => app.close());
  const running = post(renderBody());
  await started.promise;
  assert.equal((await fetch(`${base}/internal/renders/aRender_9999`, { method: 'DELETE', headers: AUTH })).status, 404);
  const stop = await fetch(`${base}/internal/renders/aRender_0001`, { method: 'DELETE', headers: AUTH });
  assert.equal(stop.status, 204);
  const response = await running;
  assert.equal(response.status, 422);
  assert.deepEqual((await response.json()).error.detail, 'aborted');
  assert.equal((await fetch(`${base}/internal/renders/aRender_0001`, { method: 'DELETE', headers: AUTH })).status, 404);
});

test('a caller that disconnects stops its render', async (t) => {
  const started = deferred();
  const aborted = deferred();
  const { app, post } = await start(READY, {
    render: (request, config, { signal }) => new Promise((resolve, reject) => {
      started.resolve();
      signal.addEventListener('abort', () => { aborted.resolve(true); reject(new RenderError('aborted', 'stopped')); });
    }),
  });
  t.after(() => app.close());
  const client = new AbortController();
  const running = post(renderBody(), AUTH, { signal: client.signal }).catch((error) => error);
  await started.promise;
  client.abort();
  assert.equal(await aborted.promise, true);
  assert.equal((await running).name, 'AbortError');
});
