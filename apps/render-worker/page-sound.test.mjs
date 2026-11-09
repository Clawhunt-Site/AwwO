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
import { addPageSound, parseCapture, partBytes, RenderError, SOUND_PAGE_FAULTS, soundNotes, wavFile, writeAll } from './render.mjs';

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
  // A render asks for its picture's length, 13 frames at 24 fps here: said to the millisecond.
  refused(() => parseCapture('ok:48000,1000,26000,0,0,0.5', 13 / 24), 'sound_too_short', 'made 0.021 s of sound, not 0.542 s');
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

test("a render names its sound page's notes sound_, and leaves out the ones its picture says of the same page", () => {
  assert.deepEqual(soundNotes(['ready_timeout', 'fonts_timeout', 'sound_clipped:3', 'sound_not_finite:1', 'sound_silent', 'page_errors:2', 'network_blocked:4']),
    ['sound_clipped:3', 'sound_not_finite:1', 'sound_silent', 'sound_page_errors:2', 'sound_network_blocked:4']);
  assert.deepEqual(soundNotes([]), []);
});

test("the page's own sound faults are one list, which an edit refuses its timeline for and a render leaves its sound out for", () => {
  assert.deepEqual([...SOUND_PAGE_FAULTS].sort(), ['page_load_failed', 'page_waits_on_timers', 'sound_failed', 'sound_missing', 'sound_too_short', 'timeout']);
  const entry = { id: 'score', track: 'music', trackIndex: 0 };
  for (const detail of SOUND_PAGE_FAULTS) assert.equal(soundFailure(entry, new RenderError(detail, 'why', detail === 'page_waits_on_timers' ? 400 : 422)).status, 400, detail);
  for (const detail of ['render_timeout', 'render_failed', 'aborted']) assert.equal(soundFailure(entry, new RenderError(detail, 'why')).detail, 'sound_render_failed', detail);
});

// The sound stage's own decisions (render.mjs addPageSound), its sound made by a stand-in: no browser, and every case
// here ends before the sound would reach ffmpeg.
function soundStage() {
  const controller = new AbortController();
  const stage = new AbortController();
  const state = {
    signal: controller.signal, soundWarnings: [], soundReason: '', log: () => {},
    halted: () => controller.signal.aborted, stopped: () => new RenderError('aborted', 'The render was stopped'),
  };
  // 1.04 s at 12 fps is 12 frames: a picture of exactly 1 s.
  const request = { renderId: 'stage-test-1', html: '<!doctype html><html></html>', seconds: 1.04, frames: 12, fps: 12 };
  const files = { sound: 's.wav', level: 'l.wav', mp4: 'm.mp4', film: 'f.mp4' };
  const config = { timeoutMs: 8000, ffmpeg: 'ffmpeg-is-not-reached', ffprobe: 'ffprobe-is-not-reached' };
  return { controller, stage, state, run: (make) => addPageSound(request, config, state, files, stage, { log: () => {}, soundTimeoutMs: 1000, make }) };
}
const SILENCE = { frames: 12000, pageFrames: 12000, sampleRate: 12000, peak: 0, warnings: ['sound_silent'] };

test('a stop that comes while the page\'s sound is made stops the render, even when that sound turns out silent', async () => {
  const { controller, state, run } = soundStage();
  await assert.rejects(run(async () => { controller.abort(); return SILENCE; }), (error) => error.detail === 'aborted');
  assert.deepEqual([state.soundWarnings, state.soundReason], [[], '']);
});

test('the render\'s limit, reached while the page\'s sound is made, leaves the sound out and says so', async () => {
  const { stage, state, run } = soundStage();
  assert.equal(await run(async () => { stage.abort(); return SILENCE; }), null);
  assert.deepEqual([state.soundWarnings, state.soundReason],
    [['sound_failed'], "The render reached its limit of 8 s while the page's sound was being made: render fewer frames to leave time for it"]);
});

test('a silent sound adds none, a page\'s fault leaves its sound out in its own words, and the worker\'s own failure fails the render', async () => {
  let stage = soundStage();
  assert.equal(await stage.run(async () => SILENCE), null);
  assert.deepEqual([stage.state.soundWarnings, stage.state.soundReason], [['sound_silent'], '']);
  stage = soundStage();
  assert.equal(await stage.run(async () => { throw new RenderError('sound_failed', 'window.renderAudio failed: no score yet'); }), null);
  assert.deepEqual([stage.state.soundWarnings, stage.state.soundReason], [['sound_failed'], 'window.renderAudio failed: no score yet']);
  // A sound that outran its budget is said as a sentence of its own, not as the clause that ends an edit's.
  stage = soundStage();
  assert.equal(await stage.run(async () => { throw new RenderError('timeout', 'it took longer than 1 s to make (time stands still while it is made)'); }), null);
  assert.equal(stage.state.soundReason,
    "The page's sound took longer than 1 s to make: time stands still while it is made, so a renderAudio that waits for a timer or an animation frame never finishes");
  stage = soundStage();
  await assert.rejects(stage.run(async () => { throw new RenderError('browser_unavailable', 'The browser could not be started', 503); }), (error) => error.status === 503);
  stage = soundStage();
  await assert.rejects(stage.run(async () => { throw new RenderError('render_failed', 'The sound capture failed in the page'); }), (error) => error.detail === 'render_failed');
  assert.deepEqual(stage.state.soundWarnings, []);
  // Its sound is asked for the picture's own length (frames / fps), whatever the request's seconds said.
  stage = soundStage();
  let asked;
  await stage.run(async (sound) => { asked = sound.seconds; return SILENCE; });
  assert.equal(asked, 1);
});
