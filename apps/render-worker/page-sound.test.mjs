// The worker's own checks of what a page's sound capture answers (render.mjs parseCapture, partBytes), how its WAV is
// written (writeAll), and how a sound or a card that could not be made reaches the edit (edit-run.mjs soundFailure,
// cardFailure): no browser.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cardFailure, EditError, soundFailure } from './edit-run.mjs';
import { parseCapture, partBytes, RenderError, wavFile, writeAll } from './render.mjs';

const refused = (fn, detail, words) => assert.throws(fn, (error) => error instanceof RenderError && error.detail === detail && error.message.includes(words), `${detail}: ${words}`);

test('a capture answer is taken only as the numbers it can be', () => {
  assert.deepEqual(parseCapture('ok:48000,48000,48000,0,1,0.25', 1), { rate: 48000, available: 48000, wanted: 48000, invalid: 0, clipped: 1, peak: 0.25 });
  assert.deepEqual(parseCapture('ok:22050,44100,44100,0,0,1e-7', 2).peak, 1e-7);
  refused(() => parseCapture('missing', 1), 'sound_missing', 'defines no window.renderAudio');
  refused(() => parseCapture('failed:no score\u0007\nyet', 1), 'sound_failed', 'window.renderAudio failed: no score yet');
  refused(() => parseCapture('bad:each channel of the sound must be a Float32Array', 1), 'sound_failed', 'must be a Float32Array');
  for (const answer of [
    'ok:48000,48000,96000,0,0,0.5', // more frames kept than one second at 48 kHz
    'ok:96000,96000,96000,0,0,0.5', // a rate above 48 kHz
    'ok:4000,4000,4000,0,0,0.5', // a rate below 8 kHz
    'ok:48000,48000,48000,48001,0,0.5', // more bad frames than kept
    'ok:48000,48000,48000,0,0,NaN',
    'ok:48000,-1,48000,0,0,0.5',
    'ok:48000,48000,48000,0,0', // a field missing
    `ok:48000,48000,48000,0,0,0.5${'0'.repeat(400)}`, // longer than an answer can be
    { then() {} }, // not a string
    '',
  ]) refused(() => parseCapture(answer, 1), 'sound_failed', 'could not be read');
  refused(() => parseCapture('ok:48000,45000,48000,0,0,0.5', 1), 'sound_too_short', 'made 0.938 s of sound, not 1 s');
  assert.equal(parseCapture('ok:48000,47600,48000,0,0,0.5', 1).available, 47600, 'up to 50 ms short is padding');
});

test('a part is taken only when it is exactly the bytes asked for', () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(partBytes(bytes.toString('base64'), 0, 7), bytes);
  assert.equal(partBytes(bytes.subarray(0, 6).toString('base64'), 0, 7), null, 'a byte short');
  assert.equal(partBytes(Buffer.alloc(8).toString('base64'), 0, 7), null, 'a byte over');
  assert.equal(partBytes('A'.repeat(4_000_000), 0, 7), null, 'a long answer is refused before it is decoded');
  assert.equal(partBytes(null, 0, 7), null);
  assert.equal(partBytes('', 7, 7), null, 'nothing left to read');
  const wav = wavFile(Buffer.alloc(16), 22050);
  assert.deepEqual([wav.toString('ascii', 0, 4), wav.toString('ascii', 8, 16), wav.readUInt32LE(24), wav.readUInt32LE(28), wav.readUInt32LE(40), wav.length],
    ['RIFF', 'WAVEfmt ', 22050, 88200, 16, 60]);
});

test('a sound that could not be made is the timeline\'s fault with its reason, or the worker\'s', () => {
  const entry = { id: 'score', track: 'music', trackIndex: 0 };
  const page = soundFailure(entry, new RenderError('sound_failed', 'window.renderAudio failed: nope'));
  assert.deepEqual([page.status, page.code, page.field, page.message], [400, 'INVALID_EDIT', 'tracks.music.page', 'The sound of score could not be made: window.renderAudio failed: nope']);
  for (const detail of ['sound_missing', 'sound_too_short', 'page_load_failed', 'timeout']) assert.equal(soundFailure(entry, new RenderError(detail, 'x')).status, 400, detail);
  // A page that waited on its own clock, before it was ready or in renderAudio: the timeline's fault, with the reason.
  const held = soundFailure(entry, new RenderError('page_waits_on_timers', 'window.renderAudio had not settled after 5 s, …', 400));
  assert.deepEqual([held.status, held.code, held.field, held.message], [400, 'INVALID_EDIT', 'tracks.music.page', 'The sound of score could not be made: window.renderAudio had not settled after 5 s, …']);
  const worker = soundFailure(entry, new RenderError('render_timeout', 'The page took too long to open'));
  assert.deepEqual([worker.status, worker.code, worker.detail], [422, 'EDIT_FAILED', 'sound_render_failed']);
  assert.equal(soundFailure(entry, new RenderError('render_failed', 'The render failed')).detail, 'sound_render_failed');
  const gone = soundFailure(entry, new RenderError('browser_unavailable', 'x', 503));
  assert.deepEqual([gone.status, gone.code], [503, 'EDIT_UNAVAILABLE']);
});

test('a card that waited on its own clock is the timeline\'s fault on the card\'s field; any other card failure is as before', () => {
  const item = { id: 'p2', index: 3 };
  const held = cardFailure(item, new RenderError('page_waits_on_timers', 'window.__ready was still not true after 5 s, …', 400));
  assert.ok(!(held instanceof EditError));
  assert.deepEqual([held.status, held.code, held.field, held.message], [400, 'INVALID_EDIT', 'tracks.video[3].card', 'Card p2 could not be rendered: window.__ready was still not true after 5 s, …']);
  for (const [error, status, detail] of [[new RenderError('timeout', 'The render took too long'), 422, 'card_failed'],
    [new RenderError('page_load_failed', 'The page crashed the browser'), 422, 'card_failed'], [new Error('surprise'), 422, 'card_failed'],
    [new RenderError('browser_unavailable', 'x', 503), 503, 'browser_unavailable']]) {
    const failure = cardFailure(item, error);
    assert.ok(failure instanceof EditError, detail);
    assert.deepEqual([failure.status, failure.detail, failure.message], [status, detail, 'Card p2 could not be rendered']);
  }
});

test('a render error says whose it is by its status: 400 is the page\'s, on its html', () => {
  const held = new RenderError('page_waits_on_timers', 'why', 400);
  assert.deepEqual([held.status, held.code, held.field, held.detail], [400, 'INVALID_RENDER', 'html', 'page_waits_on_timers']);
  assert.deepEqual([new RenderError('timeout', 'x').code, new RenderError('tmp_unavailable', 'x', 503).code], ['RENDER_FAILED', 'RENDER_UNAVAILABLE']);
  assert.equal(new RenderError('timeout', 'x').field, undefined);
});

test('a write the disk stores only part of is written again until whole, and one it stores none of fails', async () => {
  const data = Buffer.from(Array.from({ length: 23 }, (_, index) => index));
  const stored = [];
  // A disk that takes at most 5 bytes a write, from where it is told to start.
  const short = { write: async (buffer, offset, length) => { const take = Math.min(5, length); stored.push(...buffer.subarray(offset, offset + take)); return { bytesWritten: take }; } };
  await writeAll(short, data);
  assert.deepEqual(Buffer.from(stored), data);
  for (const answer of [{ bytesWritten: 0 }, {}, { bytesWritten: Number.NaN }]) {
    await assert.rejects(writeAll({ write: async () => answer }, data), (error) => error.code === 'EIO', JSON.stringify(answer));
  }
  // On a real file each call continues where the last ended.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'awwo-write-all-'));
  try {
    const file = path.join(dir, 'a.bin');
    const handle = await open(file, 'w');
    await writeAll(handle, data.subarray(0, 4));
    await writeAll(handle, data.subarray(4));
    await handle.close();
    assert.deepEqual(readFileSync(file), data);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
