import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { frameCount, frameTimes, LIMITS, loadConfig, pageShape, validateRenderRequest } from './config.mjs';

const TOKEN = 'x'.repeat(32);
const PAGE = '<!doctype html><html><body>hi</body></html>';

function body(overrides = {}) {
  return { renderId: 'aRender_01', html: PAGE, width: 160, height: 90, fps: 12, seconds: 1, loop: false, outputs: ['mp4'], stills: [], ...overrides };
}

function rejects(overrides, field, limits) {
  assert.throws(() => validateRenderRequest(body(overrides), limits), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'INVALID_RENDER');
    assert.equal(error.field, field);
    return true;
  });
}

test('loadConfig: defaults and readiness', () => {
  const config = loadConfig({ AWWO_RENDER_TOKEN: TOKEN, AWWO_RENDER_CHROME: '/usr/bin/chromium' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8111);
  assert.equal(config.ffmpeg, 'ffmpeg');
  assert.equal(config.ffprobe, 'ffprobe');
  assert.equal(config.tmp, path.resolve(os.tmpdir()));
  assert.equal(config.maxSeconds, 20);
  assert.equal(config.timeoutMs, 360_000);
  assert.equal(config.chromeSandbox, true);
  assert.equal(config.ready, true);
  assert.equal(Object.isFrozen(config), true);
});

test('loadConfig: a short token or no browser is not ready', () => {
  assert.equal(loadConfig({ AWWO_RENDER_TOKEN: 'x'.repeat(31), AWWO_RENDER_CHROME: '/c' }).ready, false);
  assert.equal(loadConfig({ AWWO_RENDER_TOKEN: TOKEN }).ready, false);
  assert.equal(loadConfig({}).ready, false);
});

test('loadConfig: explicit values', () => {
  const config = loadConfig({
    AWWO_RENDER_LISTEN: '[::1]:9000', AWWO_RENDER_TOKEN: TOKEN, AWWO_RENDER_CHROME: '/c', AWWO_RENDER_FFMPEG: '/opt/ffmpeg',
    AWWO_RENDER_FFPROBE: '/opt/ffprobe', AWWO_RENDER_TMP: 'scratch', AWWO_RENDER_MAX_SECONDS: '60', AWWO_RENDER_TIMEOUT_MS: '90000',
    AWWO_RENDER_CHROME_SANDBOX: '0',
  });
  assert.deepEqual([config.host, config.port, config.ffmpeg, config.ffprobe], ['::1', 9000, '/opt/ffmpeg', '/opt/ffprobe']);
  assert.equal(config.tmp, path.resolve('scratch'));
  assert.equal(config.maxSeconds, 60);
  assert.equal(config.timeoutMs, 90_000);
  assert.equal(config.chromeSandbox, false);
  assert.equal(loadConfig({ AWWO_RENDER_MAX_SECONDS: '7.5' }).maxSeconds, 7.5);
});

test('loadConfig: malformed values fail at startup', () => {
  for (const env of [
    { AWWO_RENDER_LISTEN: '8111' }, { AWWO_RENDER_LISTEN: 'localhost:0' }, { AWWO_RENDER_LISTEN: 'localhost:70000' },
    { AWWO_RENDER_MAX_SECONDS: '61' }, { AWWO_RENDER_MAX_SECONDS: '0.4' }, { AWWO_RENDER_MAX_SECONDS: 'ten' },
    { AWWO_RENDER_TIMEOUT_MS: '1.5' }, { AWWO_RENDER_TIMEOUT_MS: '1000' }, { AWWO_RENDER_CHROME_SANDBOX: 'yes' },
  ]) assert.throws(() => loadConfig(env), undefined, JSON.stringify(env));
});

test('validateRenderRequest: a normal request is normalized', () => {
  const request = validateRenderRequest(body({ outputs: ['contact', 'gif'], stills: [11, 0], loop: true }));
  assert.deepEqual(request, {
    renderId: 'aRender_01', html: PAGE, width: 160, height: 90, fps: 12, seconds: 1, frames: 12, loop: true,
    outputs: ['mp4', 'gif', 'contact'], stills: [0, 11],
  });
});

test('validateRenderRequest: renderId', () => {
  for (const renderId of ['short', 'x'.repeat(81), 'has space1', 'dot.dot.dot', 42, undefined]) rejects({ renderId }, 'renderId');
  assert.equal(validateRenderRequest(body({ renderId: 'a'.repeat(80) })).renderId.length, 80);
  assert.equal(validateRenderRequest(body({ renderId: 'Ab-_0123' })).renderId, 'Ab-_0123');
});

test('validateRenderRequest: html shape and size', () => {
  for (const html of ['', 'just text', '<div>no document</div>', `${' '.repeat(4096)}<html>`, '<html>\0</html>', 7]) rejects({ html }, 'html');
  assert.ok(validateRenderRequest(body({ html: '<HTML><body></body></HTML>' })));
  assert.ok(validateRenderRequest(body({ html: `${' '.repeat(4000)}<!DOCTYPE HTML><p>` })));
  const big = `<html>${'a'.repeat(LIMITS.maxHtmlBytes - 6)}`;
  assert.equal(Buffer.byteLength(big), LIMITS.maxHtmlBytes);
  assert.ok(validateRenderRequest(body({ html: big })));
  rejects({ html: `${big}a` }, 'html');
  rejects({ html: `<html>${'é'.repeat(LIMITS.maxHtmlBytes / 2)}` }, 'html'); // counted in UTF-8 bytes
});

test('pageShape matches within the first 4096 bytes, as the API does', () => {
  assert.equal(pageShape(`${'x'.repeat(4091)}<html`), true);
  assert.equal(pageShape(`${'x'.repeat(4092)}<html`), false);
  assert.equal(pageShape(`${'é'.repeat(2046)}<html`), false); // 4092 bytes of é, so <html ends past byte 4096
});

test('validateRenderRequest: width and height are 64–1920, rounded down to even', () => {
  for (const width of [63, 1921, 100.5, '160', null]) rejects({ width }, 'width');
  for (const height of [0, 1922, Number.NaN]) rejects({ height }, 'height');
  const request = validateRenderRequest(body({ width: 65, height: 1919 }));
  assert.deepEqual([request.width, request.height], [64, 1918]);
  const edges = validateRenderRequest(body({ width: 64, height: 1920, seconds: 0.5 }));
  assert.deepEqual([edges.width, edges.height], [64, 1920]);
});

test('validateRenderRequest: fps is an integer 1–60', () => {
  for (const fps of [0, 61, 12.5, '12']) rejects({ fps }, 'fps');
  assert.equal(validateRenderRequest(body({ fps: 1 })).frames, 1);
  assert.equal(validateRenderRequest(body({ fps: 60 })).frames, 60);
});

test('validateRenderRequest: seconds is 0.5–maxSeconds and frames 1–1800', () => {
  for (const seconds of [0.49, 20.01, Number.POSITIVE_INFINITY, '1', -1]) rejects({ seconds }, 'seconds');
  assert.equal(validateRenderRequest(body({ seconds: 0.5, fps: 1 })).frames, 1); // round(0.5) = 1, as Go's math.Round
  assert.equal(validateRenderRequest(body({ seconds: 20, fps: 60 })).frames, 1200);
  rejects({ seconds: 10 }, 'seconds', { maxSeconds: 5 });
  assert.equal(validateRenderRequest(body({ seconds: 30, fps: 60 }), { maxSeconds: 60 }).frames, 1800);
  rejects({ seconds: 30.01, fps: 60 }, 'seconds', { maxSeconds: 60 });
});

test('validateRenderRequest: loop and outputs', () => {
  rejects({ loop: 'yes' }, 'loop');
  assert.equal(validateRenderRequest(body({ loop: undefined })).loop, false);
  for (const outputs of ['mp4', ['webm'], [1], ['mp4', null]]) rejects({ outputs }, 'outputs');
  assert.deepEqual(validateRenderRequest(body({ outputs: [] })).outputs, ['mp4']);
  assert.deepEqual(validateRenderRequest(body({ outputs: undefined })).outputs, ['mp4']);
  assert.deepEqual(validateRenderRequest(body({ outputs: ['gif', 'gif'] })).outputs, ['mp4', 'gif']);
});

test('validateRenderRequest: stills are at most 8 distinct frames of the render', () => {
  for (const stills of [[12], [-1], [1.5], [3, 3], [0, 1, 2, 3, 4, 5, 6, 7, 8], 'all', ['1']]) rejects({ stills }, 'stills');
  assert.deepEqual(validateRenderRequest(body({ stills: [7, 1, 2, 3, 4, 5, 6, 0] })).stills, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(validateRenderRequest(body({ stills: undefined })).stills, []);
});

test('validateRenderRequest: not an object', () => {
  for (const value of [null, [], 'x', 3]) {
    assert.throws(() => validateRenderRequest(value), (error) => error.field === 'body' && error.status === 400);
  }
});

test('frame math: N = round(seconds × fps); t = i / fps never reaches seconds', () => {
  assert.equal(frameCount(1, 12), 12);
  assert.equal(frameCount(1.04, 12), 12);
  assert.equal(frameCount(1.05, 10), 11);
  assert.deepEqual(frameTimes(4, 4), [0, 0.25, 0.5, 0.75]);
  for (const [seconds, fps] of [[0.5, 1], [0.5, 60], [1, 12], [1.05, 10], [2.99, 30], [7.3, 24], [20, 60], [19.99, 7], [0.55, 3]]) {
    const frames = frameCount(seconds, fps);
    const times = frameTimes(frames, fps);
    assert.equal(times.length, frames);
    assert.equal(times[0], 0);
    assert.ok(times.every((t, index) => t === index / fps));
    assert.ok(times.at(-1) < seconds, `${seconds}s at ${fps}fps`);
  }
});
