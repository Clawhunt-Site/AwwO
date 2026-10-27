// A real edit: real ffmpeg and ffprobe (AWWO_RENDER_FFMPEG / AWWO_RENDER_FFPROBE or PATH) and, for its card, a real
// browser. Runs only when AWWO_RENDER_TEST_CHROME names a Chrome/Chromium, like integration.test.mjs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from './config.mjs';
import { createRenderServer } from './server.mjs';

const CHROME = process.env.AWWO_RENDER_TEST_CHROME;
const skip = CHROME ? false : 'set AWWO_RENDER_TEST_CHROME to run a real edit';
const FFMPEG = process.env.AWWO_RENDER_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.AWWO_RENDER_FFPROBE || 'ffprobe';
const TMP = CHROME ? mkdtempSync(path.join(os.tmpdir(), 'awwo-edit-test-')) : os.tmpdir();
test.after(() => { if (CHROME) rmSync(TMP, { recursive: true, force: true }); });

function make(name, args) {
  const file = path.join(TMP, name);
  execFileSync(FFMPEG, ['-v', 'error', '-y', ...args, file]);
  return file;
}

/** The RMS level (dB) of the line's own band (880 Hz) in a window of the film's sound. */
function lineLevel(file, start, seconds) {
  const run = spawnSync(FFMPEG, ['-hide_banner', '-ss', String(start), '-t', String(seconds), '-i', file, '-vn', '-af',
    'bandpass=f=880:width_type=q:w=8,astats=measure_overall=RMS_level:measure_perchannel=none', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = /RMS level dB: (-?[\d.]+|-inf)/.exec(run.stderr);
  return match ? Number.parseFloat(match[1].replace('-inf', '-Infinity')) : Number.NaN;
}

test('at the lowest film rate, pictures alone (a PNG, a GIF of 2 cs frames, a JPEG) make every frame, through a crossfade and a dip, in their own colour', { skip, timeout: 300_000 }, async (t) => {
  // The PNG is one colour, RGB (200, 100, 50): the film, read as its tags say (BT.709, limited range), shows it.
  const png = make('still12.png', ['-f', 'lavfi', '-i', 'color=c=0xC86432:size=400x300:duration=1', '-frames:v', '1']);
  const gif = make('still12.gif', ['-f', 'lavfi', '-i', 'testsrc=size=200x150:rate=50:duration=0.5']);
  const jpg = make('still12.jpg', ['-f', 'lavfi', '-i', 'testsrc=size=400x300:duration=1', '-frames:v', '1']);
  const files = [['art/image-1.png', png], ['art/image-2.gif', gif], ['art/image-3.jpg', jpg]].map(([name, file]) => ({ name, bytes: readFileSync(file) }));
  const token = 'edit-test-token-'.padEnd(40, 'x');
  const app = createRenderServer(loadConfig({ AWWO_RENDER_TOKEN: token, AWWO_RENDER_CHROME: CHROME, AWWO_RENDER_FFMPEG: FFMPEG, AWWO_RENDER_FFPROBE: FFPROBE, AWWO_RENDER_TMP: TMP,
    AWWO_RENDER_CHROME_SANDBOX: process.env.AWWO_RENDER_CHROME_SANDBOX }));
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, route, body, type) => fetch(base + route, { method, headers: { authorization: `Bearer ${token}`, ...(type ? { 'content-type': type } : {}) }, body });
  const timeline = {
    schema: 'awwo.timeline/1', name: 'stills',
    output: { width: 320, height: 180, fps: 12, crf: 24, stillsEverySeconds: 2 },
    tracks: { video: [
      { id: 'png', source: 'art/image-1.png', out: 2 },
      { id: 'gif', source: 'art/image-2.gif', out: 1, transition: { type: 'crossfade', seconds: 0.5 } },
      { id: 'jpg', source: 'art/image-3.jpg', out: 0.5, transition: { type: 'dip', seconds: 0.25 } },
    ] },
  };
  const manifest = { editId: 'edit_it_0002', timeline, files: files.map(({ name, bytes }) => ({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) };
  assert.equal((await call('POST', '/internal/edits', JSON.stringify(manifest), 'application/json')).status, 201);
  for (const [index, file] of files.entries()) assert.equal((await call('PUT', `/internal/edits/edit_it_0002/files/${index}`, file.bytes, 'application/octet-stream')).status, 204);
  const rendered = await call('POST', '/internal/edits/edit_it_0002/render');
  const reply = await rendered.json();
  assert.equal(rendered.status, 200, JSON.stringify(reply));
  // 24 + 12 − 6 (the crossfade) + 6 − 3 (the dip) = 33 frames at 12 fps.
  assert.deepEqual([reply.report.frames, reply.report.seconds, reply.report.loudness], [33, 2.75, null]);
  const film = path.join(TMP, 'stills.mp4');
  const got = Buffer.from(await (await call('GET', '/internal/edits/edit_it_0002/outputs/stills.mp4')).arrayBuffer());
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'mp4', '-i', 'pipe:0', '-c', 'copy', film], { input: got });
  // Before the dip (its first 27 frames, 2.25 s) every frame shows a picture, not black.
  const shown = spawnSync(FFMPEG, ['-hide_banner', '-i', film, '-vf', 'trim=end_frame=27,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-'], { encoding: 'utf8' });
  const lumas = [...shown.stderr.matchAll(/YAVG=([\d.]+)/g)].map((match) => Number(match[1]));
  assert.ok(lumas.length === 27 && Math.min(...lumas) > 40, `the pictures' frames: ${lumas.join(', ')}`);
  const tags = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space,color_range,color_transfer,color_primaries', '-of', 'csv=p=0', film], { encoding: 'utf8' }).trim();
  assert.equal(tags, 'tv,bt709,bt709,bt709');
  const pixel = [...execFileSync(FFMPEG, ['-v', 'error', '-i', film, '-frames:v', '1', '-vf', 'crop=2:2:iw/2:ih/2,scale=1:1:in_color_matrix=bt709:in_range=tv,format=rgb24', '-f', 'rawvideo', '-'])];
  assert.ok(pixel.length === 3 && Math.abs(pixel[0] - 200) <= 4 && Math.abs(pixel[1] - 100) <= 4 && Math.abs(pixel[2] - 50) <= 4, `the PNG's colour in the film: ${pixel.join(', ')}`);
  // The first still (the last frame before 1 s: the PNG's), read as a JPEG viewer reads one (BT.601, full range), shows
  // the PNG's colour too.
  const still = path.join(TMP, 'stills-001.jpg');
  const jpeg = Buffer.from(await (await call('GET', '/internal/edits/edit_it_0002/outputs/still-001.jpg')).arrayBuffer());
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'image2pipe', '-i', 'pipe:0', '-c', 'copy', still], { input: jpeg });
  const shownStill = [...execFileSync(FFMPEG, ['-v', 'error', '-i', still, '-vf', 'crop=2:2:iw/2:ih/2,scale=1:1,format=rgb24', '-f', 'rawvideo', '-'])];
  assert.ok(shownStill.length === 3 && Math.abs(shownStill[0] - 200) <= 5 && Math.abs(shownStill[1] - 100) <= 5 && Math.abs(shownStill[2] - 50) <= 5,
    `the PNG's colour in the first still: ${shownStill.join(', ')}`);
  assert.equal((await call('DELETE', '/internal/edits/edit_it_0002')).status, 204);
});

test('a two-clip film with a crossfade, a card, dialogue, a looped bed and music renders to the frame', { skip, timeout: 300_000 }, async (t) => {
  const clipA = make('a.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  const clipB = make('b.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=480x480:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const line = make('line.wav', ['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1']);
  const bed = make('bed.wav', ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.2:sample_rate=48000:duration=1.5']);
  const poster = make('poster.png', ['-f', 'lavfi', '-i', 'testsrc=size=400x300:duration=1', '-frames:v', '1']);
  // An animated GIF is a picture too: its first frame, decoded once and held (a frame of 2 cs, shorter than the film's).
  const gif = make('anim.gif', ['-f', 'lavfi', '-i', 'testsrc=size=200x150:rate=50:duration=0.5']);
  const files = [['vid_a/video-1.mp4', clipA], ['vid_b/video-1.mp4', clipB], ['tts_a/audio-1.wav', line], ['sfx_bed/audio-1.wav', bed], ['art/image-1.png', poster],
    ['art/image-2.gif', gif]]
    .map(([name, file]) => ({ name, bytes: readFileSync(file) }));
  const token = 'edit-test-token-'.padEnd(40, 'x');
  const app = createRenderServer(loadConfig({ AWWO_RENDER_TOKEN: token, AWWO_RENDER_CHROME: CHROME, AWWO_RENDER_FFMPEG: FFMPEG, AWWO_RENDER_FFPROBE: FFPROBE, AWWO_RENDER_TMP: TMP,
    AWWO_RENDER_CHROME_SANDBOX: process.env.AWWO_RENDER_CHROME_SANDBOX }));
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, route, body, type) => fetch(base + route, { method, headers: { authorization: `Bearer ${token}`, ...(type ? { 'content-type': type } : {}) }, body });
  const timeline = {
    schema: 'awwo.timeline/1', name: 'it',
    output: { width: 320, height: 180, fps: 24, crf: 24, stillsEverySeconds: 2 },
    tracks: {
      video: [
        { id: 'v1', source: 'vid_a/video-1.mp4', in: 0.25, out: 2.75, clipAudioDb: -6 },
        { id: 'v2', source: 'vid_b/video-1.mp4', in: 0, out: 2, transition: { type: 'crossfade', seconds: 0.5 } },
        { id: 'end', card: '<!doctype html><html><body style="margin:0;background:#000;color:#fff;font:40px serif">The end</body></html>', seconds: 1 },
        { id: 'poster', source: 'art/image-1.png', out: 1, transition: { type: 'dip', seconds: 0.25 } },
        { id: 'gif', source: 'art/image-2.gif', out: 0.5 },
      ],
      dialogue: [{ id: 'd1', source: 'tts_a/audio-1.wav', anchor: 'v2', offset: 0.5 }],
      sfx: [{ id: 'f1', source: 'sfx_bed/audio-1.wav', at: 0, out: 5, loop: true, gainDb: -12 }],
      subtitles: [{ anchor: 'v2', offset: 0.5, seconds: 1, text: 'A line.' }],
    },
    mix: { ducking: { sfx: -12 } },
  };
  const manifest = { editId: 'edit_it_0001', timeline, files: files.map(({ name, bytes }) => ({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) };
  assert.equal((await call('POST', '/internal/edits', JSON.stringify(manifest), 'application/json')).status, 201);
  for (const [index, file] of files.entries()) assert.equal((await call('PUT', `/internal/edits/edit_it_0001/files/${index}`, file.bytes, 'application/octet-stream')).status, 204);
  const rendered = await call('POST', '/internal/edits/edit_it_0001/render');
  const reply = await rendered.json();
  assert.equal(rendered.status, 200, JSON.stringify(reply));
  // 2.5 s + 2 s − 0.5 s + 1 s + a picture held 1 s through a 0.25 s dip + a GIF's frame for 0.5 s = 6.25 s = 150 frames.
  assert.deepEqual([reply.report.frames, reply.report.seconds, reply.report.width, reply.report.height], [150, 6.25, 320, 180]);
  assert.deepEqual(reply.report.counts, { video: 4, cards: 1, transitions: 2, dialogue: 1, music: 0, sfx: 1, clipSound: 1, subtitles: 1 });
  assert.ok(Math.abs(reply.report.loudness.integratedLUFS + 16) < 1, `loudness ${reply.report.loudness.integratedLUFS}`);
  assert.ok(reply.report.loudness.truePeakDb <= -0.5);
  assert.deepEqual(reply.outputs.map((output) => output.name), ['it.mp4', 'it.srt', 'still-001.jpg', 'still-002.jpg', 'still-003.jpg', 'report.json']);
  const film = path.join(TMP, 'it.mp4');
  const got = Buffer.from(await (await call('GET', '/internal/edits/edit_it_0001/outputs/it.mp4')).arrayBuffer());
  assert.equal(createHash('sha256').update(got).digest('hex'), reply.outputs[0].sha256);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'mp4', '-i', 'pipe:0', '-c', 'copy', film], { input: got });
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,nb_read_packets,sample_rate', '-of', 'json', film], { encoding: 'utf8' }));
  assert.deepEqual(probe.streams.map((stream) => stream.codec_type), ['video', 'audio']);
  assert.equal(Number(probe.streams[0].nb_read_packets), 150);
  // The GIF's half second shows its picture (testsrc's colours), not black.
  const shown = spawnSync(FFMPEG, ['-hide_banner', '-ss', '5.85', '-t', '0.35', '-i', film, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-'], { encoding: 'utf8' });
  const lumas = [...shown.stderr.matchAll(/YAVG=([\d.]+)/g)].map((match) => Number(match[1]));
  assert.ok(lumas.length > 0 && Math.min(...lumas) > 40, `the GIF's frames: ${lumas.join(', ')}`);
  // The line sits at v2's start (2.0 s) + 0.5 s: its band is quiet just before 2.5 s and loud just after.
  const before = lineLevel(film, 2.3, 0.15);
  const during = lineLevel(film, 2.6, 0.15);
  assert.ok(during - before > 15, `the line's band: ${before} dB before, ${during} dB during`);
  assert.equal(await (await call('GET', '/internal/edits/edit_it_0001/outputs/it.srt')).text(), '1\n00:00:02,500 --> 00:00:03,500\nA line.\n');
  assert.equal((await call('DELETE', '/internal/edits/edit_it_0001')).status, 204);
});

/** A page whose window.renderAudio makes `body` (the code inside an async function given ctx, an OfflineAudioContext). */
const soundPage = (body) => `<!doctype html><html><body><script>
window.renderAudio = async ({ seconds, sampleRate }) => {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * sampleRate), sampleRate);
  ${body}
  return ctx.startRendering();
};
</script></body></html>`;

/** A worker on a free port, with a call(method, route, body, type) for its routes. */
async function editServer(t) {
  const token = 'edit-test-token-'.padEnd(40, 'x');
  const app = createRenderServer(loadConfig({ AWWO_RENDER_TOKEN: token, AWWO_RENDER_CHROME: CHROME, AWWO_RENDER_FFMPEG: FFMPEG, AWWO_RENDER_FFPROBE: FFPROBE, AWWO_RENDER_TMP: TMP,
    AWWO_RENDER_CHROME_SANDBOX: process.env.AWWO_RENDER_CHROME_SANDBOX }));
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return (method, route, body, type) => fetch(base + route, { method, headers: { authorization: `Bearer ${token}`, ...(type ? { 'content-type': type } : {}) }, body });
}

const BLACK_CARD = '<!doctype html><html><body style="margin:0;background:#000"></body></html>';

test('a sound a page makes is the film\'s sound, to the sample its code put it at', { skip, timeout: 300_000 }, async (t) => {
  const call = await editServer(t);
  // An 880 Hz tone from 0.5 s to 1.5 s of a 2 s sound, written as code: the film's line band is silent before 0.5 s.
  const page = soundPage(`const osc = ctx.createOscillator(); osc.frequency.value = 880;
  const gain = ctx.createGain(); gain.gain.value = 0.5; osc.connect(gain).connect(ctx.destination); osc.start(0.5); osc.stop(1.5);`);
  const timeline = {
    schema: 'awwo.timeline/1', name: 'scored', output: { width: 160, height: 90, fps: 24, crf: 26, stillsEverySeconds: 0 },
    tracks: { video: [{ id: 'v1', card: BLACK_CARD, seconds: 2 }], music: [{ id: 'score', page, seconds: 2, at: 0 }] },
  };
  assert.equal((await call('POST', '/internal/edits', JSON.stringify({ editId: 'edit_it_0003', timeline, files: [] }), 'application/json')).status, 201);
  const rendered = await call('POST', '/internal/edits/edit_it_0003/render');
  const reply = await rendered.json();
  assert.equal(rendered.status, 200, JSON.stringify(reply));
  assert.deepEqual([reply.report.frames, reply.report.counts.music, reply.report.inputs], [48, 1, []]);
  assert.equal(reply.report.pageSounds.length, 1);
  assert.deepEqual([reply.report.pageSounds[0].item, reply.report.pageSounds[0].seconds], ['score', 2]);
  assert.ok(Math.abs(reply.report.pageSounds[0].peak - 0.5) < 0.01, `peak ${reply.report.pageSounds[0].peak}`);
  assert.ok(Math.abs(reply.report.loudness.integratedLUFS + 16) < 1.5, `loudness ${reply.report.loudness.integratedLUFS}`);
  // The page's WAV served its purpose once the mix was made: the job keeps only its outputs.
  const left = readdirSync(TMP).filter((name) => name.startsWith('awwo-edit-')).flatMap((dir) => readdirSync(path.join(TMP, dir)).filter((name) => name.endsWith('.wav')));
  assert.deepEqual(left, []);
  const film = path.join(TMP, 'scored.mp4');
  const got = Buffer.from(await (await call('GET', '/internal/edits/edit_it_0003/outputs/scored.mp4')).arrayBuffer());
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'mp4', '-i', 'pipe:0', '-c', 'copy', film], { input: got });
  // Within 30 ms of where the code put it, on both sides.
  const before = lineLevel(film, 0.42, 0.05);
  const during = lineLevel(film, 0.53, 0.05);
  const ending = lineLevel(film, 1.42, 0.05);
  const after = lineLevel(film, 1.53, 0.05);
  assert.ok(during - before > 30 && ending - after > 30, `the tone's band: ${before} dB before, ${during} dB at its start, ${ending} dB at its end, ${after} dB after`);
  assert.equal((await call('DELETE', '/internal/edits/edit_it_0003')).status, 204);
});

/** The RMS level (dB) of a band around `frequency` in a window of the film's sound. */
function bandLevel(file, frequency, start, seconds) {
  const run = spawnSync(FFMPEG, ['-hide_banner', '-ss', String(start), '-t', String(seconds), '-i', file, '-vn', '-af',
    `bandpass=f=${frequency}:width_type=q:w=8,astats=measure_overall=RMS_level:measure_perchannel=none`, '-f', 'null', '-'], { encoding: 'utf8' });
  const match = /RMS level dB: (-?[\d.]+|-inf)/.exec(run.stderr);
  return match ? Number.parseFloat(match[1].replace('-inf', '-Infinity')) : Number.NaN;
}

test('page sounds on two tracks beside a received file each play where the timeline puts them, cut, looped and levelled', { skip, timeout: 300_000 }, async (t) => {
  const call = await editServer(t);
  const line = readFileSync(make('line1500.wav', ['-f', 'lavfi', '-i', 'sine=frequency=1500:sample_rate=48000:duration=0.5']));
  // Music: a 440 Hz tone at 0.5–0.9 s of a 3 s sound, played from its 0.25 s (in) to 1.25 s (out) at 0.5 s of the film:
  // in the film from 0.75 s to 1.15 s. Effects: a 2 kHz burst at 0.1–0.2 s of a 0.5 s sound, looped from 1.5 s for 1.5 s:
  // in the film at 1.6, 2.1 and 2.6 s.
  const music = soundPage(`const osc = ctx.createOscillator(); osc.frequency.value = 440; const gain = ctx.createGain(); gain.gain.value = 0.4;
  osc.connect(gain).connect(ctx.destination); osc.start(0.5); osc.stop(0.9);`);
  const hits = soundPage(`const osc = ctx.createOscillator(); osc.frequency.value = 2000; const gain = ctx.createGain(); gain.gain.value = 0.3;
  osc.connect(gain).connect(ctx.destination); osc.start(0.1); osc.stop(0.2);`);
  const timeline = {
    schema: 'awwo.timeline/1', name: 'tracks', output: { width: 160, height: 90, fps: 24, crf: 26, stillsEverySeconds: 0 },
    tracks: {
      video: [{ id: 'v1', card: BLACK_CARD, seconds: 3.5 }],
      dialogue: [{ id: 'line', source: 'tts_a/audio-1.wav', at: 2.9 }],
      music: [{ id: 'score', page: music, seconds: 3, in: 0.25, out: 1.25, at: 0.5 }],
      sfx: [{ id: 'hits', page: hits, seconds: 0.5, at: 1.5, out: 1.5, loop: true }],
    },
    mix: { levels: { music: -20, sfx: -20 } },
  };
  const files = [{ name: 'tts_a/audio-1.wav', size: line.length, sha256: createHash('sha256').update(line).digest('hex') }];
  assert.equal((await call('POST', '/internal/edits', JSON.stringify({ editId: 'edit_it_0007', timeline, files }), 'application/json')).status, 201);
  assert.equal((await call('PUT', '/internal/edits/edit_it_0007/files/0', line, 'application/octet-stream')).status, 204);
  const rendered = await call('POST', '/internal/edits/edit_it_0007/render');
  const reply = await rendered.json();
  assert.equal(rendered.status, 200, JSON.stringify(reply));
  assert.deepEqual(reply.report.pageSounds.map((sound) => [sound.item, sound.seconds]), [['score', 3], ['hits', 0.5]]);
  assert.deepEqual(reply.report.inputs.map((input) => input.name), ['tts_a/audio-1.wav']);
  assert.ok(!reply.report.warnings.some((warning) => warning.startsWith('level_unmeasured')), reply.report.warnings.join(', '));
  const film = path.join(TMP, 'tracks.mp4');
  const got = Buffer.from(await (await call('GET', '/internal/edits/edit_it_0007/outputs/tracks.mp4')).arrayBuffer());
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'mp4', '-i', 'pipe:0', '-c', 'copy', film], { input: got });
  const louder = (frequency, quiet, loud) => {
    const [a, b] = [bandLevel(film, frequency, quiet, 0.05), bandLevel(film, frequency, loud, 0.05)];
    assert.ok(b - a > 25, `${frequency} Hz: ${a} dB at ${quiet} s, ${b} dB at ${loud} s`);
  };
  louder(440, 0.68, 0.79);
  louder(440, 1.2, 1.08);
  louder(2000, 1.5, 1.62);
  louder(2000, 1.78, 2.12);
  louder(2000, 2.3, 2.62);
  louder(1500, 2.8, 2.95);
  assert.equal((await call('DELETE', '/internal/edits/edit_it_0007')).status, 204);
});

/** The RMS level (dB) of a window of the film's sound, all bands. */
function rmsLevel(file, start, seconds) {
  const run = spawnSync(FFMPEG, ['-hide_banner', '-ss', String(start), '-t', String(seconds), '-i', file, '-vn', '-af',
    'astats=measure_overall=RMS_level:measure_perchannel=none', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = /RMS level dB: (-?[\d.]+|-inf)/.exec(run.stderr);
  return match ? Number.parseFloat(match[1].replace('-inf', '-Infinity')) : Number.NaN;
}

/** Renders one edit of a black card with the given tracks and mix, and returns the film's local path. */
async function renderEdit(call, editId, seconds, tracks, mix, files = []) {
  const timeline = { schema: 'awwo.timeline/1', name: editId, output: { width: 160, height: 90, fps: 24, crf: 26, stillsEverySeconds: 0 },
    tracks: { video: [{ id: 'v1', card: BLACK_CARD, seconds }], ...tracks }, mix };
  const manifest = { editId, timeline, files: files.map(({ name, bytes }) => ({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) };
  assert.equal((await call('POST', '/internal/edits', JSON.stringify(manifest), 'application/json')).status, 201);
  for (const [index, file] of files.entries()) assert.equal((await call('PUT', `/internal/edits/${editId}/files/${index}`, file.bytes, 'application/octet-stream')).status, 204);
  const rendered = await call('POST', `/internal/edits/${editId}/render`);
  const reply = await rendered.json();
  assert.equal(rendered.status, 200, JSON.stringify(reply));
  const film = path.join(TMP, `${editId}.mp4`);
  const got = Buffer.from(await (await call('GET', `/internal/edits/${editId}/outputs/${editId}.mp4`)).arrayBuffer());
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'mp4', '-i', 'pipe:0', '-c', 'copy', film], { input: got });
  assert.equal((await call('DELETE', `/internal/edits/${editId}`)).status, 204);
  return film;
}

test('page sounds are levelled and ducked like files', { skip, timeout: 300_000 }, async (t) => {
  const call = await editServer(t);
  const tone = (frequency, from, to, gain) => soundPage(`const osc = ctx.createOscillator(); osc.frequency.value = ${frequency}; const g = ctx.createGain();
  g.gain.value = ${gain}; osc.connect(g).connect(ctx.destination); osc.start(${from}); osc.stop(${to});`);
  // The same 1 kHz tone on two tracks, levelled 12 dB apart: so they are, measured where each plays alone.
  const levelled = await renderEdit(call, 'edit_it_0008', 3.5, {
    music: [{ id: 'm', page: tone(1000, 0, 1, 0.3), seconds: 1, at: 0.5 }],
    sfx: [{ id: 's', page: tone(1000, 0, 1, 0.3), seconds: 1, at: 2 }],
  }, { levels: { music: -20, sfx: -32 } });
  const [music, effects] = [rmsLevel(levelled, 0.7, 0.6), rmsLevel(levelled, 2.2, 0.6)];
  assert.ok(Math.abs(music - effects - 12) < 2, `levelled 12 dB apart: music ${music} dB, effects ${effects} dB`);
  // A 500 Hz bed made by a page, ducked 12 dB under a received line from 2.5 s to 3 s.
  const line = { name: 'tts_b/audio-1.wav', bytes: readFileSync(make('line-duck.wav', ['-f', 'lavfi', '-i', 'sine=frequency=1500:sample_rate=48000:duration=0.5'])) };
  const ducked = await renderEdit(call, 'edit_it_0009', 4, {
    music: [{ id: 'bed', page: tone(500, 0, 4, 0.3), seconds: 4, at: 0 }],
    dialogue: [{ id: 'l', source: 'tts_b/audio-1.wav', at: 2.5 }],
  }, { ducking: { music: -12 } }, [line]);
  const [open, under] = [bandLevel(ducked, 500, 1.8, 0.3), bandLevel(ducked, 500, 2.65, 0.25)];
  assert.ok(open - under > 8, `the bed: ${open} dB alone, ${under} dB under the line`);
});

test('a page that cannot make its sound is refused with its own reason, naming the item', { skip, timeout: 300_000 }, async (t) => {
  const call = await editServer(t);
  for (const [index, page, reason] of [
    [4, '<!doctype html><html><body>no sound here</body></html>', 'defines no window.renderAudio'],
    [5, soundPage("throw new Error('the score is not written yet');"), 'the score is not written yet'],
    [6, soundPage('return { sampleRate: 48000, channels: [new Float32Array(4800)] };'), 'not 2 s'],
  ]) {
    const editId = `edit_it_000${index}`;
    const timeline = {
      schema: 'awwo.timeline/1', name: 'refused', output: { width: 160, height: 90, fps: 24 },
      tracks: { video: [{ card: BLACK_CARD, seconds: 1 }], sfx: [{ id: 'hits', page, seconds: 2, at: 0 }] },
    };
    assert.equal((await call('POST', '/internal/edits', JSON.stringify({ editId, timeline, files: [] }), 'application/json')).status, 201);
    const rendered = await call('POST', `/internal/edits/${editId}/render`);
    const reply = await rendered.json();
    assert.equal(rendered.status, 400, JSON.stringify(reply));
    assert.deepEqual([reply.error.code, reply.error.field], ['INVALID_EDIT', 'tracks.sfx.page']);
    assert.ok(reply.error.message.startsWith('The sound of hits could not be made: ') && reply.error.message.includes(reason), reply.error.message);
    await call('DELETE', `/internal/edits/${editId}`);
  }
});

// A film written as code: its cards are the page from given moments (data-offset) and its music the same page's
// renderAudio. A kernel that waits on a timer before it boots never boots on the renderer's held clock, so neither its
// frames nor its sound, which wait on the boot, ever come.
const filmPage = (boot) => `<!doctype html><html data-offset="0"><body style="margin:0;background:#000"><canvas id="c" width="160" height="90"></canvas><script>
window.__ready = false;
const offset = Number(document.documentElement.dataset.offset || 0);
const booted = ${boot}.then(() => { window.__ready = true; });
setInterval(() => {}, 100);
window.renderAt = (t) => booted.then(() => { const ctx = document.getElementById('c').getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 160, 90);
  ctx.fillStyle = '#2f7df6'; ctx.fillRect(((offset + t) * 60) % 160, 30, 30, 30); });
window.renderAudio = ({ seconds, sampleRate }) => booted.then(() => {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * sampleRate), sampleRate);
  const osc = ctx.createOscillator(); osc.frequency.value = 660; const gain = ctx.createGain(); gain.gain.value = 0.3;
  osc.connect(gain).connect(ctx.destination); osc.start(0); return ctx.startRendering();
});
</script></body></html>`;

test('an edit whose card or page sound waits on its own clock is refused at once as the timeline\'s fault, on that page\'s field', { skip, timeout: 300_000 }, async (t) => {
  const call = await editServer(t);
  const hung = filmPage('new Promise((resolve) => setTimeout(resolve, 0))');
  for (const [editId, tracks, field, words] of [
    ['edit_it_0010', { video: [{ id: 'p1', card: hung, seconds: 1 }] }, 'tracks.video[0].card', 'Card p1 could not be rendered: window.renderAt(0) had not settled after 5 s'],
    ['edit_it_0011', { video: [{ id: 'p1', card: BLACK_CARD, seconds: 1 }], music: [{ id: 'score', page: hung, seconds: 1, at: 0 }] }, 'tracks.music.page',
      'The sound of score could not be made: window.renderAudio had not settled after 5 s'],
  ]) {
    const timeline = { schema: 'awwo.timeline/1', name: 'held', output: { width: 160, height: 90, fps: 24, crf: 26, stillsEverySeconds: 0 }, tracks };
    assert.equal((await call('POST', '/internal/edits', JSON.stringify({ editId, timeline, files: [] }), 'application/json')).status, 201);
    const started = Date.now();
    const rendered = await call('POST', `/internal/edits/${editId}/render`);
    const reply = await rendered.json();
    assert.equal(rendered.status, 400, JSON.stringify(reply));
    assert.deepEqual([reply.error.code, reply.error.field], ['INVALID_EDIT', field]);
    assert.ok(reply.error.message.startsWith(words) && reply.error.message.includes(' while 1 setTimeout timer and 1 setInterval timer were waiting on its clock.') && reply.error.message.length <= 500, reply.error.message);
    // Its __ready, set by the same boot, is waited for its 10 s first; then the frame or the sound for 5 s.
    assert.ok(Date.now() - started < 45_000, `refused after ${Date.now() - started} ms`);
    await call('DELETE', `/internal/edits/${editId}`);
  }
});

test('the same film whose kernel boots without a timer makes its cards and its sound, an interval of its own waiting all along', { skip, timeout: 300_000 }, async (t) => {
  const call = await editServer(t);
  const booting = filmPage('Promise.resolve()');
  const film = await renderEdit(call, 'edit_it_0012', 1, { music: [{ id: 'score', page: booting, seconds: 1, at: 0 }] });
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,nb_read_packets', '-of', 'json', film], { encoding: 'utf8' }));
  assert.deepEqual(probe.streams.map((stream) => stream.codec_type), ['video', 'audio']);
  assert.ok(bandLevel(film, 660, 0.3, 0.4) > -40, 'the page\'s tone is in the film');
  // Its two cards, each the page from its own moment.
  const cards = booting.replace('data-offset="0"', 'data-offset="0.5"');
  const timeline = { schema: 'awwo.timeline/1', name: 'edit_it_0013', output: { width: 160, height: 90, fps: 24, crf: 26, stillsEverySeconds: 0 },
    tracks: { video: [{ id: 'p1', card: booting, seconds: 0.5 }, { id: 'p2', card: cards, seconds: 0.5 }] } };
  assert.equal((await call('POST', '/internal/edits', JSON.stringify({ editId: 'edit_it_0013', timeline, files: [] }), 'application/json')).status, 201);
  const rendered = await call('POST', '/internal/edits/edit_it_0013/render');
  const reply = await rendered.json();
  assert.equal(rendered.status, 200, JSON.stringify(reply));
  assert.deepEqual([reply.report.frames, reply.report.counts.cards], [24, 2]);
  assert.equal((await call('DELETE', '/internal/edits/edit_it_0013')).status, 204);
});
