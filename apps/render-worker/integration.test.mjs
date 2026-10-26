// Real renders in a real browser and ffmpeg. They run only when AWWO_RENDER_TEST_CHROME names a Chrome/Chromium;
// ffmpeg and ffprobe come from AWWO_RENDER_FFMPEG / AWWO_RENDER_FFPROBE or PATH.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { loadConfig, validateRenderRequest } from './config.mjs';
import { chromeArgs, renderPage, renderPageSound } from './render.mjs';

const CHROME = process.env.AWWO_RENDER_TEST_CHROME;
const skip = CHROME ? false : 'set AWWO_RENDER_TEST_CHROME to run real renders';
const TMP = CHROME ? mkdtempSync(path.join(os.tmpdir(), 'awwo-render-test-')) : os.tmpdir();
test.after(() => { if (CHROME) rmSync(TMP, { recursive: true, force: true }); });

function configWith(overrides = {}) {
  return loadConfig({
    AWWO_RENDER_TOKEN: 'x'.repeat(32), AWWO_RENDER_CHROME: CHROME ?? '', AWWO_RENDER_FFMPEG: process.env.AWWO_RENDER_FFMPEG,
    AWWO_RENDER_FFPROBE: process.env.AWWO_RENDER_FFPROBE, AWWO_RENDER_CHROME_SANDBOX: process.env.AWWO_RENDER_CHROME_SANDBOX,
    AWWO_RENDER_TMP: TMP, AWWO_RENDER_TIMEOUT_MS: '120000', ...overrides,
  });
}

function request(html, overrides = {}) {
  return validateRenderRequest({ renderId: `it_${Math.random().toString(36).slice(2, 10)}`, html, width: 160, height: 90, fps: 12, seconds: 1, ...overrides });
}

const CSS_PAGE = `<!doctype html><html><head><style>
html, body { margin: 0; height: 100%; background: #102030; }
.box { position: absolute; left: 0; top: 30px; width: 30px; height: 30px; background: #f80; animation: slide 1s linear infinite; }
@keyframes slide { from { transform: translateX(0); } to { transform: translateX(130px); } }
</style></head><body><div class="box"></div></body></html>`;

const CONTRACT_PAGE = `<!doctype html><html><body style="margin:0"><canvas id="c" width="160" height="90"></canvas><script>
const ctx = document.getElementById('c').getContext('2d');
window.renderAt = (t) => {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 160, 90);
  ctx.fillStyle = 'hsl(' + Math.round(t * 360) + ', 80%, 50%)'; ctx.fillRect(t * 130, 30, 30, 30);
};
</script></body></html>`;

const RAF_PAGE = `<!doctype html><html><body style="margin:0;background:#fff"><div id="d" style="position:absolute;top:20px;width:20px;height:20px;background:#00f"></div><script>
const box = document.getElementById('d');
const start = performance.now();
function frame() { box.style.left = ((performance.now() - start) / 1000 * 120) + 'px'; requestAnimationFrame(frame); }
requestAnimationFrame(frame);
</script></body></html>`;

const NETWORK_PAGE = `<!doctype html><html><body><img src="http://127.0.0.1:1/x"><p>offline</p><script>
fetch('https://example.com/').catch(() => {});
try { new WebSocket('ws://127.0.0.1:1/'); } catch (error) {}
if (typeof RTCPeerConnection !== 'undefined') throw new Error('webrtc present');
window.renderAt = (t) => { if (t > 0.2) throw new Error('drawing failed at ' + t.toFixed(2)); };
</script></body></html>`;

function checkOutputs(result) {
  for (const output of result.outputs) {
    const data = Buffer.from(output.data, 'base64');
    assert.equal(data.length, output.size, output.kind);
    assert.equal(createHash('sha256').update(data).digest('hex'), output.sha256, output.kind);
  }
  const mp4 = Buffer.from(result.outputs.find((output) => output.kind === 'mp4').data, 'base64');
  assert.equal(mp4.subarray(4, 8).toString('latin1'), 'ftyp');
  assert.deepEqual(readdirSync(TMP), [], 'the render removed its temporary directory');
  return mp4;
}

test('a CSS keyframes page renders on the virtual clock, with GIF, contact sheet and stills', { skip }, async () => {
  const result = await renderPage(request(CSS_PAGE, { outputs: ['mp4', 'gif', 'contact'], stills: [0, 11], loop: true }), configWith(), { log: () => {} });
  checkOutputs(result);
  assert.equal(result.mode, 'virtual-time');
  assert.equal(result.frames, 12);
  assert.ok(result.distinctFrames > 1, `distinct ${result.distinctFrames}`);
  assert.deepEqual(result.probe, { frames: 12, width: 160, height: 90, duration: 1 });
  assert.deepEqual(result.outputs.map((output) => [output.kind, output.frame, output.contentType]),
    [['mp4', undefined, 'video/mp4'], ['gif', undefined, 'image/gif'], ['contact', undefined, 'image/png'], ['still', 0, 'image/png'], ['still', 11, 'image/png']]);
  assert.equal(Buffer.from(result.outputs[1].data, 'base64').subarray(0, 6).toString('latin1'), 'GIF89a');
  assert.equal(Buffer.from(result.outputs[2].data, 'base64').subarray(1, 4).toString('latin1'), 'PNG');
  assert.notEqual(result.outputs[3].sha256, result.outputs[4].sha256);
  assert.deepEqual(result.warnings, []);
});

test('a window.renderAt canvas page renders in contract mode', { skip }, async () => {
  const result = await renderPage(request(CONTRACT_PAGE), configWith(), { log: () => {} });
  checkOutputs(result);
  assert.equal(result.mode, 'contract');
  assert.equal(result.frames, 12);
  assert.equal(result.distinctFrames, 12);
  assert.equal(result.probe.frames, 12);
});

test('a requestAnimationFrame + performance.now page renders the same video twice', { skip }, async () => {
  const first = await renderPage(request(RAF_PAGE), configWith(), { log: () => {} });
  const second = await renderPage(request(RAF_PAGE), configWith(), { log: () => {} });
  checkOutputs(first);
  assert.equal(first.mode, 'virtual-time');
  assert.equal(first.frames, 12);
  assert.ok(first.distinctFrames > 1, `distinct ${first.distinctFrames}`);
  assert.equal(first.probe.frames, 12);
  assert.equal(first.outputs[0].sha256, second.outputs[0].sha256, 'deterministic frames and encoding');
});

test('requests off the CDN allowlist are blocked and counted; page errors are kept', { skip }, async () => {
  const result = await renderPage(request(NETWORK_PAGE, { seconds: 0.5 }), configWith(), { log: () => {} });
  checkOutputs(result);
  const blocked = result.warnings.find((warning) => warning.startsWith('network_blocked:'));
  assert.ok(blocked && Number(blocked.split(':')[1]) >= 1, result.warnings.join(','));
  assert.ok(result.warnings.includes('static_page'));
  assert.ok(result.warnings.includes('page_errors:3'), result.warnings.join(','));
  assert.deepEqual(result.pageErrors, ['drawing failed at 0.25', 'drawing failed at 0.33', 'drawing failed at 0.42']);
  assert.equal(result.frames, 6);
});

test('a page that never finishes a frame is stopped at the timeout', { skip }, async () => {
  const hang = '<!doctype html><html><body><script>window.renderAt = () => { for (;;) {} };</script></body></html>';
  const started = Date.now();
  await assert.rejects(renderPage(request(hang), configWith({ AWWO_RENDER_TIMEOUT_MS: '8000' }), { log: () => {} }),
    (error) => error.status === 422 && error.detail === 'timeout');
  assert.ok(Date.now() - started < 30_000);
  assert.deepEqual(readdirSync(TMP), []);
});

// The router never sees a redirect's next hop, so the launch flags alone must keep every non-CDN host and IP
// unreachable. Checked here without the router, against a local server that must see no request.
test('without the request router, the launch flags alone refuse local hosts and IPs', { skip }, async () => {
  let hits = 0;
  const server = createServer((request, response) => { hits += 1; response.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); response.end('local'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: chromeArgs(), chromiumSandbox: configWith().chromeSandbox });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    const results = await page.evaluate(async (urls) => Promise.all(urls.map((url) => fetch(url).then(() => 'reached', () => 'refused'))),
      [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`]);
    assert.deepEqual(results, ['refused', 'refused', 'refused']);
    assert.equal(hits, 0);
  } finally {
    await browser.close();
    server.close();
  }
});

test('an abort signal stops the render', { skip }, async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1500);
  await assert.rejects(renderPage(request(RAF_PAGE, { seconds: 20, fps: 60, width: 1280, height: 720 }), configWith(), { signal: controller.signal, log: () => {} }),
    (error) => error.status === 422 && error.detail === 'aborted');
  assert.deepEqual(readdirSync(TMP), []);
});

/** A page whose renderAudio runs `body` (its local `seconds` and `sampleRate` are what it was asked for). */
const soundPage = (body, before = '') => `<!doctype html><html><body><script>${before}
window.renderAudio = async ({ seconds, sampleRate }) => { ${body} };
</script></body></html>`;
/** A page's sound, written into TMP and read back (the file is removed again); a refused sound leaves no file behind. */
async function sound(html, seconds = 1, { config = configWith(), ...options } = {}) {
  const id = `snd_${Math.random().toString(36).slice(2, 10)}`;
  const file = path.join(TMP, `${id}.wav`);
  const made = await renderPageSound({ renderId: id, html, seconds, file }, config, { log: () => {}, ...options });
  const wav = readFileSync(file);
  rmSync(file, { force: true });
  assert.equal(wav.length, made.bytes);
  return { ...made, wav };
}
/** The WAV's header fields and its samples as the interleaved 16-bit values. */
function readWav(wav) {
  return { rate: wav.readUInt32LE(24), channels: wav.readUInt16LE(22), bits: wav.readUInt16LE(34), bytes: wav.readUInt32LE(40),
    samples: new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length)) };
}

test('a page\'s sound is read out exactly as long as asked, whatever the page made or did to the built-ins', { skip, timeout: 120_000 }, async () => {
  // A 0.25 square wave on the left only, for 10 s, of which 1 s is asked for, from a page that has replaced every built-in
  // a naive read-out would use.
  const hostile = `btoa = () => 'A'.repeat(4e6); String.fromCharCode = () => 'x';
Object.defineProperty(Object.getPrototypeOf(Uint8Array.prototype), 'length', { get() { return 1e9; } });
Uint8Array.prototype.subarray = function () { return new Uint8Array(1e7); };
Math.round = () => 7; Number.isFinite = () => false; Reflect.apply = () => 0;`;
  const big = soundPage(`const left = new Float32Array(sampleRate * 10); for (let i = 0; i < left.length; i += 1) left[i] = i % 2 ? 0.25 : -0.25;
return { sampleRate, channels: [left, new Float32Array(sampleRate * 10)] };`, hostile);
  const made = await sound(big, 1);
  const wav = readWav(made.wav);
  assert.deepEqual([wav.rate, wav.channels, wav.bits, wav.bytes, made.frames, made.peak], [48000, 2, 16, 48000 * 4, 48000, 0.25]);
  assert.deepEqual([wav.samples[0], wav.samples[1], wav.samples[2], wav.samples[3]], [-8192, 0, 8192, 0]);
  assert.equal(wav.samples.length, 96000);
  // An AudioBuffer from an OfflineAudioContext at another rate is taken at its own rate; mono is put on both sides.
  const offline = await sound(soundPage(`const ctx = new OfflineAudioContext(1, 22050, 22050); const osc = ctx.createOscillator();
osc.connect(ctx.destination); osc.start(0); return ctx.startRendering();`), 1);
  const mono = readWav(offline.wav);
  assert.deepEqual([mono.rate, mono.bytes, offline.frames], [22050, 22050 * 4, 22050]);
  assert.ok(mono.samples.some((value, index) => index % 2 === 0 && value !== 0) && mono.samples.every((value, index) => index % 2 === 0 || value === mono.samples[index - 1]));
  // Up to 50 ms short is rounding: padded with silence to the length asked. Clipped and bad samples are counted by frame.
  const short = await sound(soundPage(`const left = new Float32Array(Math.round(sampleRate * 0.97)).fill(0.5); left[0] = 2; left[1] = NaN;
return { sampleRate, channels: [left] };`), 1);
  const padded = readWav(short.wav);
  assert.deepEqual([padded.bytes, padded.samples[2 * 46000], padded.samples[2 * 47999], padded.samples[0], padded.samples[2]], [48000 * 4, 16384, 0, 32767, 0]);
  assert.deepEqual(short.warnings, ['sound_not_finite:1', 'sound_clipped:1']);
  assert.deepEqual(readdirSync(TMP), []);
});

test('a page cannot hand the worker anything but the sound asked for, even through the prototypes a promise or a serialiser meets', { skip, timeout: 120_000 }, async () => {
  // An object a naive capture would pass back with its counts now looks like a promise resolving to 2 MB, and every
  // destructured argument would read as 1e9 seconds; the page's own answer is left alone.
  const before = `Object.defineProperty(Object.prototype, 'then', { configurable: true, get() { return Object.prototype.hasOwnProperty.call(this, 'wanted') ? (resolve) => resolve('X'.repeat(2e6)) : undefined; } });
Object.defineProperty(Object.prototype, 'wanted', { configurable: true, get() { return 1e9; } });
Array.prototype[Symbol.iterator] = function* () { yield 1e9; yield 1e9; };`;
  const made = await sound(soundPage(`const left = new Float32Array(sampleRate).fill(0.125); return { sampleRate, channels: [left, left] };`, before), 1);
  const wav = readWav(made.wav);
  assert.deepEqual([wav.rate, wav.bytes, made.frames, made.peak, wav.samples[0]], [48000, 192000, 48000, 0.125, 4096]);
  assert.deepEqual(readdirSync(TMP), []);
});

test('a sound longer than one part is read out whole, every sample in its place across the part boundary', { skip, timeout: 120_000 }, async () => {
  // 17 s at 48 kHz is 3,264,000 bytes: a 3 MiB part and the rest. Every frame's left sample is a known 16-bit value.
  const page = soundPage(`const left = new Float32Array(sampleRate * seconds);
for (let i = 0; i < left.length; i += 1) { const n = ((i * 7) % 65536) - 32768; left[i] = n < 0 ? n / 32768 : n / 32767; }
return { sampleRate, channels: [left, new Float32Array(sampleRate * seconds)] };`);
  const made = readWav((await sound(page, 17)).wav);
  assert.equal(made.bytes, 17 * 48000 * 4);
  const boundary = (3 * 1024 * 1024) / 4;
  for (let frame = boundary - 8; frame < boundary + 8; frame += 1) {
    assert.equal(made.samples[frame * 2], ((frame * 7) % 65536) - 32768, `frame ${frame}`);
    assert.equal(made.samples[frame * 2 + 1], 0);
  }
  let wrong = 0;
  for (let frame = 0; frame < 17 * 48000; frame += 997) if (made.samples[frame * 2] !== ((frame * 7) % 65536) - 32768) wrong += 1;
  assert.equal(wrong, 0);
  assert.deepEqual(readdirSync(TMP), []);
});

test('a sound that takes longer to make than a page may take to open still has its own budget', { skip, timeout: 120_000 }, async () => {
  // Event timestamps keep real time under the virtual clock: this page works for 8 s inside renderAudio.
  const slow = soundPage(`const start = new Event('t').timeStamp; while (new Event('t').timeStamp - start < 8000) {}
return { sampleRate, channels: [new Float32Array(sampleRate).fill(0.1)] };`);
  const made = await sound(slow, 1, { config: configWith({ AWWO_RENDER_TIMEOUT_MS: '6000' }) });
  assert.equal(made.frames, 48000);
  assert.ok(Math.abs(made.peak - 0.1) < 1e-6, `peak ${made.peak}`);
  assert.ok(made.elapsedMs > 8000, `took ${made.elapsedMs} ms`);
  assert.deepEqual(readdirSync(TMP), []);
});

test('a page whose sound outruns its budget, or whose renderAudio cannot be read, is refused with why', { skip, timeout: 120_000 }, async () => {
  const waits = soundPage('await new Promise((resolve) => setTimeout(resolve, 10)); return { sampleRate, channels: [new Float32Array(sampleRate)] };');
  await assert.rejects(sound(waits, 1, { soundTimeoutMs: 3000 }),
    (error) => error.status === 422 && error.detail === 'timeout' && error.message.includes('waits for a timer'));
  const getter = `<!doctype html><html><body><script>Object.defineProperty(window, 'renderAudio', { get() { throw new Error('broken getter'); } });</script></body></html>`;
  await assert.rejects(sound(getter, 1), (error) => error.detail === 'sound_failed' && error.message.includes('broken getter'));
  assert.deepEqual(readdirSync(TMP), []);
});

test('a page that cannot give its sound is refused with the reason, and one that navigates meanwhile fails', { skip, timeout: 120_000 }, async () => {
  for (const [html, detail, words] of [
    ['<!doctype html><html><body>no sound</body></html>', 'sound_missing', 'defines no window.renderAudio'],
    [soundPage("throw new Error('not written yet');"), 'sound_failed', 'not written yet'],
    [soundPage('return { sampleRate, channels: [[0, 0, 0]] };'), 'sound_failed', 'must be a Float32Array'],
    [soundPage('return { sampleRate: 96000, channels: [new Float32Array(96000)] };'), 'sound_failed', 'from 8000 to 48000'],
    [soundPage('return { sampleRate, channels: [new Float32Array(sampleRate / 2)] };'), 'sound_too_short', 'not 1 s'],
    [soundPage("location.hash = 'moved'; return { sampleRate, channels: [new Float32Array(sampleRate)] };"), 'page_load_failed', 'navigated away'],
    // A new document while the sound is being made: a reload, and a refresh the page asked for in its head.
    [soundPage('location.reload(); await new Promise(() => {});'), 'page_load_failed', 'navigated away'],
    [soundPage('await new Promise(() => {});').replace('<html><body>', '<html><head><meta http-equiv="refresh" content="1"></head><body>'), 'page_load_failed', 'navigated away'],
  ]) {
    await assert.rejects(sound(html, 1), (error) => error.status === 422 && error.detail === detail && error.message.includes(words), `${detail}: ${html.slice(0, 120)}`);
  }
  assert.deepEqual(readdirSync(TMP), []);
});
