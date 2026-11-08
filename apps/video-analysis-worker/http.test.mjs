import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import { createAnalysisServer } from './server.mjs';
import { TOKEN, fakeConfig, fakeMp4 } from './test-helpers.mjs';

const always = () => true;

async function start(extra = {}, options = {}) {
  const config = await fakeConfig(extra);
  const app = createAnalysisServer(config, { exists: always, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, route, { body, type, token = TOKEN } = {}) => fetch(base + route, {
    method, body, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(type ? { 'Content-Type': type } : {}) },
  });
  return { app, config, call };
}

const manifest = (data, id = 'job_12345', name = 'ref.mp4') => JSON.stringify({ analysisId: id, file: { name, size: data.length, sha256: createHash('sha256').update(data).digest('hex') } });

test('health needs no token and says what is missing', async () => {
  const { app, call } = await start();
  const ready = await call('GET', '/health', { token: '' });
  assert.equal(ready.status, 200);
  const body = await ready.json();
  assert.equal(body.service, 'awwo-video-analysis');
  assert.equal(body.ready, true);
  assert.equal(body.busy, false);
  await app.close();
  const missing = await start({ AWWO_ANALYSIS_TOKEN: 'short' });
  const notReady = await missing.call('GET', '/health', { token: '' });
  assert.equal(notReady.status, 503);
  assert.equal((await notReady.json()).ready, false);
  await missing.app.close();
});

test('every other route needs the token', async () => {
  const { app, call } = await start();
  for (const token of ['', 'x'.repeat(40)]) {
    const response = await call('POST', '/internal/analyses', { body: '{}', type: 'application/json', token });
    assert.equal(response.status, 401);
  }
  assert.equal((await call('GET', '/internal/nothing')).status, 404);
  await app.close();
});

test('a job: manifest, file, run, outputs, delete', async () => {
  const { app, config, call } = await start();
  const data = fakeMp4(8192);
  const created = await call('POST', '/internal/analyses', { body: manifest(data), type: 'application/json' });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).analysisId, 'job_12345');
  assert.equal((await call('POST', '/internal/analyses', { body: manifest(data, 'job_67890'), type: 'application/json' })).status, 429);
  assert.equal((await call('POST', '/internal/analyses/job_12345/run')).status, 409);
  assert.equal((await call('PUT', '/internal/analyses/job_12345/file', { body: data, type: 'text/plain' })).status, 400);
  const wrong = Buffer.from(data);
  wrong[100] ^= 1;
  const mismatch = await call('PUT', '/internal/analyses/job_12345/file', { body: wrong, type: 'application/octet-stream' });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error.code, 'ANALYSIS_FILE_MISMATCH');
  assert.equal((await call('PUT', '/internal/analyses/job_12345/file', { body: data, type: 'application/octet-stream' })).status, 204);
  assert.equal((await call('PUT', '/internal/analyses/job_12345/file', { body: data, type: 'application/octet-stream' })).status, 409);
  const run = await call('POST', '/internal/analyses/job_12345/run');
  assert.equal(run.status, 200);
  const result = await run.json();
  assert.equal(result.report.shots, 2);
  assert.ok(result.summary.startsWith('clip | 12.5s'));
  assert.ok(result.outputs.every((output) => !('path' in output)));
  const breakdown = await call('GET', '/internal/analyses/job_12345/outputs/breakdown.json');
  assert.equal(breakdown.status, 200);
  assert.equal(breakdown.headers.get('content-type'), 'application/json');
  assert.equal((await breakdown.json()).source.path, 'input.mp4');
  const sheet = await call('GET', '/internal/analyses/job_12345/outputs/shots/shot_001.jpg');
  assert.equal(sheet.status, 200);
  assert.equal(await sheet.text(), 'JPEG1');
  for (const name of ['env.json', 'debug.log', 'stems/vocals.wav', 'shots/notes.txt']) {
    assert.equal((await call('GET', `/internal/analyses/job_12345/outputs/${name}`)).status, 404, name);
  }
  assert.equal((await call('GET', '/internal/analyses/job_12345/outputs/..%2Fenv.json')).status, 404);
  assert.equal((await call('DELETE', '/internal/analyses/job_12345')).status, 204);
  assert.equal((await call('GET', '/internal/analyses/job_12345/outputs/breakdown.json')).status, 404);
  assert.deepEqual((await readdir(config.tmp)).filter((name) => name.startsWith('awwo-analysis-')), []);
  await app.close();
});

test('a file that is not a video is refused, and the slot frees on delete', async () => {
  const { app, call } = await start();
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(100)]);
  assert.equal((await call('POST', '/internal/analyses', { body: manifest(png), type: 'application/json' })).status, 201);
  const refused = await call('PUT', '/internal/analyses/job_12345/file', { body: png, type: 'application/octet-stream' });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, 'ANALYSIS_FILE_UNSUPPORTED');
  assert.equal((await call('DELETE', '/internal/analyses/job_12345')).status, 204);
  assert.equal((await call('POST', '/internal/analyses', { body: manifest(png, 'job_abcdef'), type: 'application/json' })).status, 201);
  await app.close();
});

test('an analysis the video itself refuses answers 400 on file', async () => {
  const run = async () => { const { AnalysisError } = await import('./analysis-run.mjs'); throw new AnalysisError('too_long', 'The video is 400 s long; at most 300 s are analysed.', 400, { field: 'file' }); };
  const { app, call } = await start({}, { run });
  const data = fakeMp4();
  await call('POST', '/internal/analyses', { body: manifest(data), type: 'application/json' });
  await call('PUT', '/internal/analyses/job_12345/file', { body: data, type: 'application/octet-stream' });
  const response = await call('POST', '/internal/analyses/job_12345/run');
  assert.equal(response.status, 400);
  assert.deepEqual((await response.json()).error, { code: 'INVALID_ANALYSIS', message: 'The video is 400 s long; at most 300 s are analysed.', field: 'file', detail: 'too_long' });
  await app.close();
});

test('a job left alone is removed after idleMs', async () => {
  const { app, call } = await start({ AWWO_ANALYSIS_IDLE_MS: '1000' });
  const data = fakeMp4();
  assert.equal((await call('POST', '/internal/analyses', { body: manifest(data), type: 'application/json' })).status, 201);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(app.busy(), false);
  assert.equal((await call('PUT', '/internal/analyses/job_12345/file', { body: data, type: 'application/octet-stream' })).status, 404);
  await app.close();
});
