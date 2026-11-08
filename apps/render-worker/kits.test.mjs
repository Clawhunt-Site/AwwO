// The kits the worker supplies (kits.mjs): each pinned copy is exactly the web bundle's file, and only its exact URL is
// answered. A real render of the film guide's example, through the kit route, runs when AWWO_RENDER_TEST_CHROME names a
// Chrome/Chromium (as integration.test.mjs does).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateRenderRequest } from './config.mjs';
import { KITS, suppliedKit } from './kits.mjs';
import { renderPage, renderPageSound } from './render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, '..', 'web', 'src', 'canvas');
const FILM = KITS.find((kit) => kit.id === 'film-kit-1');

test('each pinned kit is the file the module names, by size and sha256', () => {
  for (const kit of KITS) {
    const body = readFileSync(path.join(here, 'kits', kit.file));
    assert.equal(body.length, kit.bytes, kit.file);
    assert.equal(createHash('sha256').update(body).digest('hex'), kit.sha256, kit.file);
    assert.equal(suppliedKit(kit.url).equals(body), true, kit.url);
  }
});

test('the film kit copy is the web bundle\'s file byte for byte, at the URL the web names', { skip: existsSync(WEB) ? false : 'no web tree beside the worker' }, () => {
  const web = readFileSync(path.join(WEB, 'filmKit', 'film-kit.js'));
  assert.equal(readFileSync(path.join(here, 'kits', FILM.file)).equals(web), true, 'run node apps/web/scripts/build-film-kit.mjs and copy the bundle');
  const ts = readFileSync(path.join(WEB, 'filmKit', 'filmKit.ts'), 'utf8');
  assert.match(ts, new RegExp(`FILM_KIT_URL = '${FILM.url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'`));
  assert.match(ts, new RegExp(`FILM_KIT_BYTES = ${FILM.bytes};`));
  assert.match(ts, new RegExp(`FILM_KIT_SHA256 = '${FILM.sha256}';`));
});

test('only the exact kit URL is supplied', () => {
  assert.equal(suppliedKit(`${FILM.url}?v=2`), null);
  assert.equal(suppliedKit(`${FILM.url}#x`), null);
  assert.equal(suppliedKit(FILM.url.replace('https:', 'http:')), null);
  assert.equal(suppliedKit(FILM.url.replace('/1/', '/2/')), null);
  assert.equal(suppliedKit('https://awwo.clawhunt.store/kits/anatomy/1/anatomy.js'), null);
  assert.equal(suppliedKit(undefined), null);
});

// The film guide's example page, the shape every film node is told to copy.
function guideExample() {
  const guide = readFileSync(path.join(WEB, 'filmKit', 'film-guide.md'), 'utf8');
  const start = guide.indexOf('```html', guide.indexOf('### 2.'));
  const body = guide.slice(start + '```html'.length);
  return body.slice(0, body.indexOf('```')).trim();
}

const CHROME = process.env.AWWO_RENDER_TEST_CHROME;
const skip = !CHROME ? 'set AWWO_RENDER_TEST_CHROME to run real renders' : existsSync(WEB) ? false : 'no web tree beside the worker';

test('the film guide\'s example renders through the supplied kit: every frame drawn for its t, its sound as long as asked', { skip, timeout: 240_000 }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'awwo-film-kit-test-'));
  try {
    const config = loadConfig({ AWWO_RENDER_TOKEN: 'x'.repeat(32), AWWO_RENDER_CHROME: CHROME, AWWO_RENDER_FFMPEG: process.env.AWWO_RENDER_FFMPEG,
      AWWO_RENDER_FFPROBE: process.env.AWWO_RENDER_FFPROBE, AWWO_RENDER_CHROME_SANDBOX: process.env.AWWO_RENDER_CHROME_SANDBOX, AWWO_RENDER_TMP: tmp,
      AWWO_RENDER_TIMEOUT_MS: '200000' });
    const html = guideExample();
    const result = await renderPage(validateRenderRequest({ renderId: 'film_kit_example', html, width: 320, height: 180, fps: 12, seconds: 7.2, stills: [60] }), config);
    assert.equal(result.mode, 'contract');
    assert.deepEqual(result.pageErrors, []);
    assert.equal(result.warnings.filter((w) => /^(?:network_blocked|page_errors|ready_timeout|static_page)/.test(w)).length, 0, result.warnings.join(','));
    assert.ok(result.distinctFrames > result.frames / 3, `${result.distinctFrames} of ${result.frames} frames differ`);
    // A card is the same page with a start offset: its first frame is the film's frame at that time (5 s, frame 60 at
    // 12 fps), pixel for pixel.
    const card = await renderPage(validateRenderRequest({ renderId: 'film_kit_card', html: html.replace('<html lang="en">', '<html lang="en" data-offset="5">'),
      width: 320, height: 180, fps: 12, seconds: 1, stills: [0] }), config);
    assert.deepEqual(card.pageErrors, []);
    const still = (render, frame) => render.outputs.find((o) => o.kind === 'still' && o.frame === frame);
    assert.ok(still(card, 0) && still(result, 60), 'both stills were kept');
    assert.equal(still(card, 0).sha256, still(result, 60).sha256);
    const file = path.join(tmp, 'film.wav');
    const sound = await renderPageSound({ renderId: 'film_kit_sound', html, seconds: 7.2, file }, config);
    assert.equal(sound.seconds, 7.2);
    assert.ok(sound.peak > 0.05 && sound.peak <= 0.8912, `peak ${sound.peak}`);
    assert.deepEqual(sound.warnings, []);
    // Its score still plays at the end, and its last 60 ms fade to nothing rather than stop on a click.
    const wav = readFileSync(file), data = wav.indexOf('data') + 8, frames = (wav.length - data) / 4;
    const level = (from, to) => { let sum = 0; for (let i = from; i < to; i++) sum += wav.readInt16LE(data + i * 4) ** 2; return Math.sqrt(sum / (to - from)); };
    const rate = frames / 7.2;
    assert.ok(level(frames - Math.round(0.3 * rate), frames - Math.round(0.1 * rate)) > 100, 'the score is still playing 0.1-0.3 s before the end');
    assert.equal(wav.readInt16LE(data + (frames - 1) * 4), 0);
    assert.ok(level(frames - Math.round(0.005 * rate), frames) < level(frames - Math.round(0.3 * rate), frames - Math.round(0.1 * rate)) / 10, 'the last 5 ms are faded');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
