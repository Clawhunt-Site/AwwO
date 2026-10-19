// A real edit: real ffmpeg and ffprobe (AWWO_RENDER_FFMPEG / AWWO_RENDER_FFPROBE or PATH) and, for its card, a real
// browser. Runs only when AWWO_RENDER_TEST_CHROME names a Chrome/Chromium, like integration.test.mjs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
