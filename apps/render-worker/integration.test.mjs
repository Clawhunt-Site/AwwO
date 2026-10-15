// Real renders in a real browser and ffmpeg. They run only when AWWO_RENDER_TEST_CHROME names a Chrome/Chromium;
// ffmpeg and ffprobe come from AWWO_RENDER_FFMPEG / AWWO_RENDER_FFPROBE or PATH.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { loadConfig, validateRenderRequest } from './config.mjs';
import { chromeArgs, renderPage } from './render.mjs';

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
