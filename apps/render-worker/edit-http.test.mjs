// The edit job API at the HTTP boundary, with the render step replaced: create, files, render, outputs, delete,
// the shared slot, the checks on every file and the idle expiry. No ffmpeg or browser runs here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from './config.mjs';
import { EditError } from './edit-run.mjs';
import { createRenderServer } from './server.mjs';

const TOKEN = 'render-token-'.padEnd(40, 'x');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'awwo-edit-http-'));
const config = (extra = {}) => loadConfig({
  AWWO_RENDER_TOKEN: TOKEN, AWWO_RENDER_CHROME: process.execPath, AWWO_RENDER_FFMPEG: process.execPath, AWWO_RENDER_FFPROBE: process.execPath,
  AWWO_RENDER_TMP: TMP, ...extra,
});
const AUTH = { authorization: `Bearer ${TOKEN}` };
// Each file starts with its container's own signature (an MP4's ftyp box, an MP3's ID3 tag): the worker sniffs them.
const BYTES = [Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom first file bytes')]), Buffer.from('ID3 second file, longer bytes')];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function manifest(editId = 'edit_job_0001') {
  return {
    editId,
    files: [{ name: 'vid_a/video-1.mp4', size: BYTES[0].length, sha256: sha(BYTES[0]) }, { name: 'tts_a/audio-1.mp3', size: BYTES[1].length, sha256: sha(BYTES[1]) }],
    timeline: { schema: 'awwo.timeline/1', output: { width: 640, height: 360 }, tracks: { video: [{ source: 'vid_a/video-1.mp4' }], dialogue: [{ source: 'tts_a/audio-1.mp3', at: 0 }] } },
  };
}

// A render step that writes one output file and reports what it was given.
function fakeEdit(seen) {
  return async (job) => {
    seen.push(job);
    const file = path.join(job.dir, 'out', 'edit.mp4');
    writeFileSync(file, 'film');
    return { report: { schema: 'awwo.edit-report/1', seconds: 1 }, outputs: [{ name: 'edit.mp4', kind: 'video', contentType: 'video/mp4', path: file, size: 4, sha256: sha('film') }] };
  };
}

async function start(options = {}, settings = {}) {
  const app = createRenderServer(config(settings), options);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, route, body, type) => fetch(base + route, {
    method, headers: { ...AUTH, ...(type ? { 'content-type': type } : {}) }, body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)),
  });
  return { app, call };
}

const json = 'application/json';
const bytes = 'application/octet-stream';

test('a job is created, takes its files, renders once, serves its outputs and is removed', async (t) => {
  const seen = [];
  const { app, call } = await start({ edit: fakeEdit(seen) });
  t.after(() => app.close());
  const created = await call('POST', '/internal/edits', manifest(), json);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { editId: 'edit_job_0001', files: 2, expiresInSeconds: 600 });
  assert.equal(app.busy(), true);
  assert.equal((await call('POST', '/internal/edits', manifest('edit_job_0002'), json)).status, 429, 'one job at a time');
  assert.equal((await call('POST', '/internal/renders', { renderId: 'aRender_0001' }, json)).status, 429, 'a render waits for the job');

  const early = await call('POST', '/internal/edits/edit_job_0001/render');
  assert.equal(early.status, 409);
  assert.deepEqual((await early.json()).error.missing, [0, 1]);
  assert.equal((await call('PUT', '/internal/edits/edit_job_0001/files/0', BYTES[0], 'text/plain')).status, 400);
  const wrong = await call('PUT', '/internal/edits/edit_job_0001/files/0', Buffer.from('other bytes, same story, same size.'), bytes);
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error.code, 'EDIT_FILE_MISMATCH');
  assert.equal((await call('PUT', '/internal/edits/edit_job_0001/files/0', BYTES[0], bytes)).status, 204, 'a refused file may be sent again');
  assert.equal((await call('PUT', '/internal/edits/edit_job_0001/files/0', BYTES[0], bytes)).status, 409);
  assert.equal((await call('PUT', '/internal/edits/edit_job_0001/files/7', BYTES[0], bytes)).status, 404);
  assert.equal((await call('PUT', '/internal/edits/edit_job_0001/files/1', BYTES[1], bytes)).status, 204);

  const rendered = await call('POST', '/internal/edits/edit_job_0001/render');
  assert.equal(rendered.status, 200);
  const reply = await rendered.json();
  assert.deepEqual(reply.outputs, [{ name: 'edit.mp4', kind: 'video', contentType: 'video/mp4', size: 4, sha256: sha('film') }], 'no path on the worker leaves it');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].files.map((file) => file.received), [true, true]);
  assert.equal((await call('POST', '/internal/edits/edit_job_0001/render')).status, 409, 'rendered once');
  const film = await call('GET', '/internal/edits/edit_job_0001/outputs/edit.mp4');
  assert.equal(film.status, 200);
  assert.equal(film.headers.get('content-type'), 'video/mp4');
  assert.equal(await film.text(), 'film');
  assert.equal((await call('GET', '/internal/edits/edit_job_0001/outputs/report.json')).status, 404);
  const dir = seen[0].dir;
  assert.equal(existsSync(dir), true);
  assert.equal((await call('DELETE', '/internal/edits/edit_job_0001')).status, 204);
  assert.equal(existsSync(dir), false, 'the job directory is removed');
  assert.equal(app.busy(), false);
  assert.equal((await call('GET', '/internal/edits/edit_job_0001/outputs/edit.mp4')).status, 404);
});

test('a bad manifest is refused with its field, and every route needs the token', async (t) => {
  const { app, call } = await start({ edit: fakeEdit([]) });
  t.after(() => app.close());
  const bad = await call('POST', '/internal/edits', { ...manifest(), timeline: { schema: 'awwo.timeline/1', output: { width: 640, height: 360 }, tracks: { video: [{ source: 'not/wired.mp4' }] } } }, json);
  assert.equal(bad.status, 400);
  assert.deepEqual((await bad.json()).error, { code: 'INVALID_EDIT', message: 'tracks.video[0].source must name a wired file', field: 'tracks.video[0].source' });
  assert.equal((await call('POST', '/internal/edits', 'not json', json)).status, 400);
  assert.equal(app.busy(), false);
  const anonymous = await fetch(`http://127.0.0.1:${app.server.address().port}/internal/edits`, { method: 'POST', headers: { 'content-type': json }, body: JSON.stringify(manifest()) });
  assert.equal(anonymous.status, 401);
});

test('a render step that fails reports its field or detail, and the job stays until deleted', async (t) => {
  let failure = Object.assign(new Error('tracks.video[0].out is past the end'), { code: 'INVALID_EDIT', field: 'tracks.video[0].out' });
  const { app, call } = await start({ edit: async () => { throw failure; } });
  t.after(() => app.close());
  const run = async (id) => {
    assert.equal((await call('POST', '/internal/edits', manifest(id), json)).status, 201);
    for (const [index, data] of BYTES.entries()) assert.equal((await call('PUT', `/internal/edits/${id}/files/${index}`, data, bytes)).status, 204);
    return call('POST', `/internal/edits/${id}/render`);
  };
  const invalid = await run('edit_job_0003');
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.field, 'tracks.video[0].out');
  assert.equal(app.busy(), true, 'a failed job keeps the slot until the API deletes it');
  assert.equal((await call('DELETE', '/internal/edits/edit_job_0003')).status, 204);
  failure = new EditError('picture_failed', 'ffmpeg failed at picture');
  const failed = await run('edit_job_0004');
  assert.equal(failed.status, 422);
  assert.deepEqual((await failed.json()).error, { code: 'EDIT_FAILED', message: 'ffmpeg failed at picture', detail: 'picture_failed' });
});

test('a job left without a request is removed after the idle time, and the slot is free again', async (t) => {
  const seen = [];
  const { app, call } = await start({ edit: fakeEdit(seen) }, { AWWO_EDIT_IDLE_MS: '1000' });
  t.after(() => app.close());
  assert.equal((await call('POST', '/internal/edits', manifest('edit_job_0005'), json)).status, 201);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(app.busy(), false);
  assert.equal((await call('PUT', '/internal/edits/edit_job_0005/files/0', BYTES[0], bytes)).status, 404);
  assert.equal((await call('POST', '/internal/edits', manifest('edit_job_0006'), json)).status, 201);
});

test('closing the worker removes a job that is not rendering', async () => {
  const { app, call } = await start({ edit: fakeEdit([]) });
  assert.equal((await call('POST', '/internal/edits', manifest('edit_job_0007'), json)).status, 201);
  await app.close();
  assert.equal(app.busy(), false);
});

test('a file of no container the edit takes is refused when it arrives, and may be sent again as it should be', async (t) => {
  const { app, call } = await start({ edit: fakeEdit([]) });
  t.after(() => app.close());
  const playlist = Buffer.from('#EXTM3U\n#EXTINF:1.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n');
  const job = { ...manifest('edit_job_0010'), files: [{ name: 'vid_a/video-1.mp4', size: playlist.length, sha256: sha(playlist) }] };
  job.timeline = { ...job.timeline, tracks: { video: [{ source: 'vid_a/video-1.mp4' }] } };
  assert.equal((await call('POST', '/internal/edits', job, json)).status, 201);
  const refused = await call('PUT', '/internal/edits/edit_job_0010/files/0', playlist, bytes);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, 'EDIT_FILE_UNSUPPORTED');
  assert.equal((await call('POST', '/internal/edits/edit_job_0010/render')).status, 409, 'the file is still missing');
});

test('a second upload of a file while the first is still coming is refused, and the first is kept', async (t) => {
  const { app, call } = await start({ edit: fakeEdit([]) });
  t.after(() => app.close());
  assert.equal((await call('POST', '/internal/edits', manifest('edit_job_0011'), json)).status, 201);
  const port = app.server.address().port;
  const { request } = await import('node:http');
  const slow = request({ host: '127.0.0.1', port, method: 'PUT', path: '/internal/edits/edit_job_0011/files/0', headers: { ...AUTH, 'content-type': bytes, 'content-length': BYTES[0].length } });
  const done = new Promise((resolve) => slow.on('response', (response) => { response.resume(); resolve(response.statusCode); }));
  slow.write(BYTES[0].subarray(0, 8));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await call('PUT', '/internal/edits/edit_job_0011/files/0', BYTES[0], bytes)).status, 409);
  slow.end(BYTES[0].subarray(8));
  assert.equal(await done, 204);
});

test('DELETE of a job that renders stops it and frees the worker only once the render has ended', async (t) => {
  let release;
  const ended = [];
  const { app, call } = await start({
    edit: async (job, config, state) => {
      await new Promise((resolve) => { release = resolve; state.signal.addEventListener('abort', resolve, { once: true }); });
      await new Promise((resolve) => setTimeout(resolve, 150));
      ended.push(Date.now());
      throw state.stopped();
    },
  });
  t.after(() => app.close());
  assert.equal((await call('POST', '/internal/edits', manifest('edit_job_0012'), json)).status, 201);
  for (const [index, data] of BYTES.entries()) assert.equal((await call('PUT', `/internal/edits/edit_job_0012/files/${index}`, data, bytes)).status, 204);
  const rendering = call('POST', '/internal/edits/edit_job_0012/render');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const removed = await call('DELETE', '/internal/edits/edit_job_0012');
  assert.equal(removed.status, 204);
  assert.equal(ended.length, 1, 'the render had ended before the DELETE answered');
  assert.equal(app.busy(), false);
  assert.equal((await rendering).status, 422);
  release?.();
});

test('DELETE during an upload stops the upload and answers once its file is closed and the directory is gone', async (t) => {
  const { app, call } = await start({ edit: fakeEdit([]) });
  t.after(() => app.close());
  const before = new Set(readdirSync(TMP));
  assert.equal((await call('POST', '/internal/edits', manifest('edit_job_0013'), json)).status, 201);
  const dir = readdirSync(TMP).find((name) => !before.has(name));
  assert.ok(dir, 'the job has its directory');
  const port = app.server.address().port;
  const { request } = await import('node:http');
  const slow = request({ host: '127.0.0.1', port, method: 'PUT', path: '/internal/edits/edit_job_0013/files/0', headers: { ...AUTH, 'content-type': bytes, 'content-length': BYTES[0].length } });
  const outcome = new Promise((resolve) => {
    slow.on('response', (response) => { response.resume(); resolve(response.statusCode); });
    slow.on('error', () => resolve('closed'));
  });
  slow.write(BYTES[0].subarray(0, 8));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await call('DELETE', '/internal/edits/edit_job_0013')).status, 204);
  assert.equal(existsSync(path.join(TMP, dir)), false, 'nothing of the job is left once the DELETE answers');
  assert.equal(app.busy(), false);
  assert.ok(['closed', 409].includes(await outcome), 'the upload was stopped, not finished');
});

test('at startup, what a stopped worker left in its temporary root is removed, and nothing else', async () => {
  const { mkdirSync, writeFileSync: write, existsSync: exists } = await import('node:fs');
  const { sweepStale } = await import('./edit-jobs.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'awwo-sweep-'));
  for (const name of ['awwo-edit-abc123', 'awwo-render-XYZ789', 'other-dir']) {
    mkdirSync(path.join(root, name));
    write(path.join(root, name, 'f'), 'x');
  }
  assert.equal(await sweepStale({ tmp: root }), 2);
  assert.deepEqual(['awwo-edit-abc123', 'awwo-render-XYZ789', 'other-dir'].map((name) => exists(path.join(root, name))), [false, false, true]);
});
