import assert from 'node:assert/strict';
import test from 'node:test';
import { EDIT_LIMITS, filmRateCap, mergeWindows, normalizeTimeline, pictureStream, placeTimeline, placeVideo, validateEditManifest } from './edit-timeline.mjs';

const SHA = 'a'.repeat(64);
const CARD = '<!doctype html><html><body>Title</body></html>';
const output = { width: 1920, height: 822, fps: 24 };
const names = new Set(['vid_a/video-1.mp4', 'vid_b/video-1.mp4', 'tts_a/audio-1.mp3', 'mus/audio-1.mp3']);
const probes = new Map([
  ['vid_a/video-1.mp4', { duration: 5.041667, video: { width: 960, height: 960, fps: 24 }, audio: { sampleRate: 44100, channels: 2 } }],
  ['vid_b/video-1.mp4', { duration: 5.041667, video: { width: 960, height: 960, fps: 24 }, audio: null }],
  ['tts_a/audio-1.mp3', { duration: 1.6, video: null, audio: { sampleRate: 48000, channels: 1 } }],
  ['mus/audio-1.mp3', { duration: 12, video: null, audio: { sampleRate: 48000, channels: 2 } }],
]);
const timeline = (tracks, extra = {}) => ({ schema: 'awwo.timeline/1', output, tracks, ...extra });
const errorOf = (fn) => { try { fn(); } catch (error) { return error; } assert.fail('expected an error'); };

test('a manifest names its files once, with sizes and digests, before any byte arrives', () => {
  const body = { editId: 'edit12345', files: [{ name: 'vid_a/video-1.mp4', size: 10, sha256: SHA }], timeline: timeline({ video: [{ source: 'vid_a/video-1.mp4' }] }) };
  const job = validateEditManifest(body);
  assert.equal(job.files[0].index, 0);
  assert.equal(job.timeline.output.crf, 18);
  const odd = validateEditManifest({ ...body, timeline: { ...body.timeline, output: { width: 1279, height: 721 } } }).timeline.output;
  assert.deepEqual([odd.width, odd.height, odd.fps, odd.fit], [1278, 720, 24, 'cover'], 'sides are rounded down to even');
  for (const [patch, field] of [
    [{ editId: 'x' }, 'editId'],
    [{ files: [{ name: '../etc/passwd', size: 1, sha256: SHA }] }, 'files[0].name'],
    [{ files: [{ name: 'a/b.mp4', size: 0, sha256: SHA }] }, 'files[0].size'],
    [{ files: [{ name: 'a/b.mp4', size: 1, sha256: 'z' }] }, 'files[0].sha256'],
    [{ files: [{ name: 'a/b.mp4', size: 1, sha256: SHA }, { name: 'a/b.mp4', size: 1, sha256: SHA }] }, 'files[1].name'],
  ]) assert.equal(errorOf(() => validateEditManifest({ ...body, ...patch })).field, field);
  assert.equal(errorOf(() => validateEditManifest(body, { maxInputBytes: 5 })).field, 'files');
});

test('the timeline names only wired files and checks every field', () => {
  const ok = { video: [{ source: 'vid_a/video-1.mp4' }] };
  assert.equal(errorOf(() => normalizeTimeline({ ...timeline(ok), schema: 'x' }, names)).field, 'schema');
  for (const [tracks, field] of [
    [{ video: [] }, 'tracks.video'],
    [{ video: [{ source: 'nope/x.mp4' }] }, 'tracks.video[0].source'],
    [{ video: [{ source: 'vid_a/video-1.mp4', in: 2, out: 1 }] }, 'tracks.video[0].out'],
    [{ video: [{ source: 'vid_a/video-1.mp4', transition: { type: 'crossfade', seconds: 1 } }] }, 'tracks.video[0].transition'],
    [{ video: [{ card: '<p>no document</p>', seconds: 3 }] }, 'tracks.video[0].card'],
    [{ video: [{ card: CARD, seconds: 21 }] }, 'tracks.video[0].seconds'],
    [{ ...ok, dialogue: [{ source: 'tts_a/audio-1.mp3', at: 0, loop: true, out: 1 }] }, 'tracks.dialogue[0].loop'],
    [{ ...ok, music: [{ source: 'mus/audio-1.mp3', at: 0, loop: true }] }, 'tracks.music[0].out'],
    [{ ...ok, music: [{ source: 'mus/audio-1.mp3', at: 0, fx: 'room' }] }, 'tracks.music[0].fx'],
    [{ ...ok, dialogue: [{ source: 'tts_a/audio-1.mp3', anchor: 'missing' }] }, 'tracks.dialogue[0].anchor'],
    [{ ...ok, dialogue: [{ source: 'tts_a/audio-1.mp3', anchor: 'video-1', at: 1 }] }, 'tracks.dialogue[0]'],
    [{ ...ok, subtitles: [{ start: 2, end: 1, text: 'x' }] }, 'tracks.subtitles[0].end'],
    [{ ...ok, subtitles: [{ start: 0, end: 1, text: 'a\u0007b' }] }, 'tracks.subtitles[0].text'],
  ]) assert.equal(errorOf(() => normalizeTimeline(timeline(tracks), names)).field, field, JSON.stringify(tracks));
  const mix = normalizeTimeline(timeline(ok, { mix: { levels: { dialogue: -20 }, ducking: {}, silence: [{ start: 1, end: 2 }] } }), names).mix;
  assert.deepEqual(mix, { levels: { dialogue: -20 }, ducking: { music: -9, sfx: -6, attack: 0.12, release: 0.5 }, silence: [{ start: 1, end: 2 }] });
});

test('video items follow each other on whole frames, minus the overlap of their transitions', () => {
  const t = normalizeTimeline(timeline({ video: [
    { id: 'v1', source: 'vid_a/video-1.mp4', in: 0.2, out: 4.2 },
    { id: 'v2', source: 'vid_b/video-1.mp4', in: 0.5, out: 4.5, transition: { type: 'crossfade', seconds: 0.5 } },
    { id: 'title', card: CARD, seconds: 3, transition: { type: 'dip', seconds: 0.5 } },
  ] }), names);
  const { items, total } = placeVideo(t.video, probes, 24);
  assert.deepEqual(items.map((item) => [item.start, item.frames, item.overlapIn, item.overlapOut]), [[0, 96, 0, 12], [84, 96, 12, 12], [168, 72, 12, 0]]);
  assert.equal(total, 240);
  assert.deepEqual(pictureStream(items), [
    { type: 'span', item: 0, from: 0, frames: 84 },
    { type: 'transition', kind: 'fade', frames: 12, a: { item: 0, from: 84 }, b: { item: 1, from: 0 } },
    { type: 'span', item: 1, from: 12, frames: 72 },
    { type: 'transition', kind: 'fadeblack', frames: 12, a: { item: 1, from: 84 }, b: { item: 2, from: 0 } },
    { type: 'span', item: 2, from: 12, frames: 60 },
  ]);
  const sum = pictureStream(items).reduce((frames, piece) => frames + piece.frames, 0);
  assert.equal(sum, total, 'the pieces add up to the film');
});

test('a clip past its file, a transition longer than its items and a wrong at are refused with the expected value', () => {
  const place = (video) => placeVideo(normalizeTimeline(timeline({ video }), names).video, probes, 24);
  assert.equal(errorOf(() => place([{ source: 'vid_a/video-1.mp4', out: 6 }])).field, 'tracks.video[0].out');
  assert.equal(errorOf(() => place([{ source: 'vid_a/video-1.mp4', in: 5.5 }])).field, 'tracks.video[0].in');
  assert.equal(errorOf(() => place([{ source: 'tts_a/audio-1.mp3' }])).field, 'tracks.video[0].source');
  assert.equal(errorOf(() => place([{ source: 'vid_a/video-1.mp4', out: 1 }, { source: 'vid_a/video-1.mp4', transition: { type: 'crossfade', seconds: 2 } }])).field,
    'tracks.video[1].transition.seconds');
  const wrong = errorOf(() => place([{ source: 'vid_a/video-1.mp4', out: 2 }, { source: 'vid_a/video-1.mp4', at: 3 }]));
  assert.equal(wrong.field, 'tracks.video[1].at');
  assert.match(wrong.message, /starts at 2\.000 s/);
  assert.equal(place([{ source: 'vid_a/video-1.mp4', out: 2 }, { source: 'vid_a/video-1.mp4', at: 2.05 }]).total, 2 * 24 + 121, 'within two frames is fine');
  assert.equal(place([{ source: 'vid_a/video-1.mp4', out: 5.08 }]).items[0].frames, 121, 'up to 0.05 s past the end is the end');
});

test('sounds are placed by at or by anchor, cut at the film end, and clip sound follows its picture', () => {
  const t = normalizeTimeline(timeline({
    video: [{ id: 'v1', source: 'vid_a/video-1.mp4', in: 0.2, out: 4.2, clipAudioDb: -3 },
      { id: 'v2', source: 'vid_b/video-1.mp4', in: 0.5, out: 4.5, clipAudioDb: 0, transition: { type: 'crossfade', seconds: 0.5 } }],
    dialogue: [{ id: 'd1', source: 'tts_a/audio-1.mp3', anchor: 'v2', offset: 0.4 }],
    music: [{ id: 'm1', source: 'mus/audio-1.mp3', at: 0, out: 10 }, { id: 'm2', source: 'mus/audio-1.mp3', at: 9 }],
    subtitles: [{ anchor: 'v2', offset: 0.4, seconds: 1.8, text: 'Line' }, { start: 7, end: 9, text: 'Late' }],
  }, { mix: { ducking: { music: -9 } } }), names);
  const plan = placeTimeline(t, probes);
  assert.equal(plan.seconds, 7.5);
  const by = Object.fromEntries(plan.audio.map((entry) => [entry.id, entry]));
  assert.deepEqual([by['v1-sound'].at, by['v1-sound'].length, by['v1-sound'].gainDb, by['v1-sound'].fadeOut], [0, 4, -3, 0.5]);
  assert.equal(by['v2-sound'], undefined, 'a clip without sound gives none');
  assert.ok(plan.warnings.includes('clip_audio_missing:v2'));
  assert.equal(by.d1.at, 3.5 + 0.4);
  assert.equal(by.m1.length, 7.5);
  assert.ok(plan.warnings.includes('audio_cut_at_end:m1'));
  assert.equal(by.m2, undefined);
  assert.ok(plan.warnings.includes('audio_past_end:m2'));
  assert.deepEqual(plan.subtitles.map((entry) => [entry.start, entry.end]), [[3.9, 5.7], [7, 7.5]]);
  assert.deepEqual(plan.dialogueWindows, [{ start: 3.9, end: 5.5 }]);
  assert.equal(errorOf(() => placeTimeline(t, probes, { maxSeconds: 5 })).field, 'tracks.video');
});

test('dialogue windows merge where their ramps would touch, so ducking gains never stack', () => {
  const ducking = { attack: 0.1, release: 0.5 };
  assert.deepEqual(mergeWindows([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 2.5, end: 3 }], ducking), [{ start: 1, end: 3 }, { start: 5, end: 6 }]);
  assert.deepEqual(mergeWindows([{ start: 1, end: 2 }], null), []);
});

test('limits are the documented ones', () => {
  assert.equal(EDIT_LIMITS.maxFiles, 300);
  assert.equal(EDIT_LIMITS.maxCardSeconds, 20);
  assert.equal(EDIT_LIMITS.maxStills, 150);
});

test('a picture is held for out − in seconds, needs its out, and has no sound of its own', () => {
  const stills = new Map([...probes, ['art/image-1.png', { duration: Number.POSITIVE_INFINITY, still: true, video: { width: 1024, height: 1024 }, audio: null }]]);
  const withArt = new Set([...names, 'art/image-1.png']);
  const t = normalizeTimeline(timeline({ video: [{ id: 'poster', source: 'art/image-1.png', out: 3 }, { source: 'vid_a/video-1.mp4', out: 2, transition: { type: 'crossfade', seconds: 0.5 } }] }), withArt);
  const plan = placeTimeline(t, stills);
  assert.deepEqual(plan.items.map((item) => item.frames), [72, 48]);
  assert.equal(plan.seconds, (72 + 48 - 12) / 24);
  assert.equal(errorOf(() => placeTimeline(normalizeTimeline(timeline({ video: [{ source: 'art/image-1.png' }] }), withArt), stills)).field, 'tracks.video[0].out');
  assert.equal(errorOf(() => placeTimeline(normalizeTimeline(timeline({ video: [{ source: 'art/image-1.png', out: 2, clipAudioDb: 0 }] }), withArt), stills)).field, 'tracks.video[0].clipAudioDb');
});

test('subtitles are one to three non-empty lines, none that could be read as a cue timing', () => {
  const ok = { video: [{ source: 'vid_a/video-1.mp4' }] };
  const one = (text) => normalizeTimeline(timeline({ ...ok, subtitles: [{ start: 0, end: 1, text }] }), names).subtitles[0].text;
  assert.equal(one('  First line \n\n\n  second  '), 'First line\nsecond');
  for (const bad of ['a\n\n99\n00:00:00,000 --> 01:00:00,000\nX', 'one\ntwo\nthree\nfour', '   \n  ']) {
    assert.equal(errorOf(() => one(bad)).field, 'tracks.subtitles[0].text', JSON.stringify(bad));
  }
});

test('clips that keep their sound count with the sounds; cards have a total; the film fits the size the API stores', () => {
  const many = Array.from({ length: 301 }, () => ({ source: 'vid_a/video-1.mp4', out: 1, clipAudioDb: 0 }));
  const sounds = Array.from({ length: 300 }, () => ({ source: 'tts_a/audio-1.mp3', at: 0 }));
  assert.equal(errorOf(() => normalizeTimeline(timeline({ video: many, dialogue: sounds }), names)).field, 'tracks');
  const cards = Array.from({ length: 7 }, () => ({ card: CARD, seconds: 20 }));
  assert.equal(errorOf(() => normalizeTimeline(timeline({ video: cards }), names)).field, 'tracks.video');
  const body = { editId: 'edit12345', files: [{ name: 'vid_a/video-1.mp4', size: 10, sha256: SHA }], timeline: timeline({ video: [{ source: 'vid_a/video-1.mp4' }] }) };
  assert.deepEqual(validateEditManifest(body).limits, { maxFilmBytes: null });
  assert.deepEqual(validateEditManifest({ ...body, limits: { maxFilmBytes: 300 * 1024 * 1024 } }).limits, { maxFilmBytes: 300 * 1024 * 1024 });
  assert.equal(errorOf(() => validateEditManifest({ ...body, limits: { maxFilmBytes: 5 } })).field, 'limits.maxFilmBytes');
  assert.equal(filmRateCap(null, 600), null);
  assert.equal(filmRateCap(300 * 1024 * 1024, 1200), 1694, '300 MiB over 20 minutes');
  assert.equal(filmRateCap(300 * 1024 * 1024, 1200, 400), 1304, 'each piece may start with its buffer full: 400 pieces take more of it');
  assert.equal(filmRateCap(300 * 1024 * 1024, 10), 50_000, 'a short film keeps a peak rate of a level 4 stream');
  assert.equal(errorOf(() => filmRateCap(2 * 1024 * 1024, 600)).field, 'limits.maxFilmBytes');
  // The bound holds however the film is cut: every second at the peak rate, every piece's buffer spent, and the sound.
  const cap = 300 * 1024 * 1024;
  for (const seconds of [60, 600, 1200]) {
    for (const pieces of [1, 40, 400]) {
      const kbps = filmRateCap(cap, seconds, pieces);
      if (kbps === null) continue;
      const worst = (kbps * 1000 * (seconds + 0.9 * pieces)) / 8 + 24_000 * seconds;
      assert.ok(worst <= 0.9 * cap, `${seconds} s in ${pieces} pieces: ${worst} bytes`);
    }
  }
  const capped = placeTimeline(normalizeTimeline(timeline({ video: [{ source: 'vid_a/video-1.mp4' }] }), names), probes, { maxFilmBytes: 1024 * 1024 });
  assert.equal(capped.output.maxKbps, filmRateCap(1024 * 1024, capped.seconds, capped.pieces.length));
  assert.equal(capped.output.maxKbps, 1107);
});
