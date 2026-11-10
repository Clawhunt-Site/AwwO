// The kits the worker supplies (kits.mjs): each pinned copy is exactly the web bundle's file, and only its exact URL is
// answered; and the brand fonts the film kit names (fonts.mjs), answered at exactly the URLs the kit asks for, from
// copies of the web's own font files. Real renders (the film guide's example through the kit route; films and pages
// whose browser can reach no host at all, so a font they draw came from the worker) run when AWWO_RENDER_TEST_CHROME
// names a Chrome/Chromium (as integration.test.mjs does).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { chromium } from 'playwright-core';
import { loadConfig, validateRenderRequest } from './config.mjs';
import { FONTS, suppliedFont } from './fonts.mjs';
import { KITS, suppliedKit } from './kits.mjs';
import { renderPage, renderPageSound } from './render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, '..', 'web', 'src', 'canvas');
const FILM = KITS.find((kit) => kit.id === 'film-kit-1');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

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

test('each brand font copy is the file the module names, by size and sha256, with its family\'s license beside it', () => {
  assert.equal(FONTS.length, 27);
  assert.equal(new Set(FONTS.map((font) => font.family)).size, 18);
  assert.equal(new Set(FONTS.map((font) => font.url)).size, FONTS.length);
  for (const font of FONTS) {
    const body = readFileSync(path.join(here, 'fonts', font.file));
    assert.equal(body.length, font.bytes, font.file);
    assert.equal(sha256(body), font.sha256, font.file);
    assert.equal(suppliedFont(font.url).equals(body), true, font.url);
    assert.match(readFileSync(path.join(here, 'fonts', font.license), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/, font.license);
  }
  // Nothing in fonts/ that the worker does not hand out or license.
  const named = new Set(FONTS.flatMap((font) => [font.file, font.license]));
  assert.deepEqual(readdirSync(path.join(here, 'fonts')).filter((name) => !named.has(name)), []);
});

test('only the exact brand font URLs are supplied', () => {
  const inter = FONTS[0].url;
  assert.equal(suppliedFont(`${inter}?v=2`), null);
  assert.equal(suppliedFont(`${inter}#x`), null);
  assert.equal(suppliedFont(inter.replace('https:', 'http:')), null);
  assert.equal(suppliedFont(inter.replace('cdn.jsdelivr.net', 'fastly.jsdelivr.net')), null);
  assert.equal(suppliedFont(inter.replace('@5.3.0', '@5.2.0')), null);
  assert.equal(suppliedFont(inter.replace('-latin-', '-latin-ext-')), null);
  assert.equal(suppliedFont('https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.3.0/files/roboto-latin-400-normal.woff2'), null);
  assert.equal(suppliedFont(undefined), null);
});

test('the brand font copies are the web\'s files byte for byte', { skip: existsSync(WEB) ? false : 'no web tree beside the worker' }, () => {
  for (const name of readdirSync(path.join(here, 'fonts'))) {
    assert.equal(readFileSync(path.join(here, 'fonts', name)).equals(readFileSync(path.join(WEB, 'fonts', name))), true, `copy apps/web/src/canvas/fonts/${name}`);
  }
  // Each pin is the one the web's font list holds for that file (previewFontList.ts), and every face it lists is here.
  const list = readFileSync(path.join(WEB, 'previewFontList.ts'), 'utf8');
  const web = [...list.matchAll(/face\('([^']+)', '[^']+', (\d+), '([0-9a-f]{64})'/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`).sort();
  assert.deepEqual(FONTS.map((font) => `${font.file} ${font.bytes} ${font.sha256}`).sort(), web);
});

/** A 2D context that answers every call: enough for the film kit to boot outside a browser. */
function stubContext() {
  const state = { font: '10px sans-serif', letterSpacing: '0px', globalAlpha: 1, filter: 'none' };
  return new Proxy({}, {
    get(_target, key) {
      if (key in state) return state[key];
      if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      if (key === 'measureText') return (text) => ({ width: String(text).length * 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 });
      if (key === 'getImageData') return (_x, _y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => undefined;
    },
    set(_target, key, value) { state[key] = value; return true; },
  });
}

/** The fonts the film kit asks for when a film's display role is `family` and the page states no font policy (a
 *  render's), run as a page runs it in a fresh global with a stub DOM: [family the face is made under, URL, descriptors]. */
async function kitFontRequests(family) {
  const made = [];
  class FontFace {
    constructor(name, source, descriptors) { made.push([name, /^url\((.*)\)$/.exec(source)?.[1] ?? source, descriptors]); }
    load() { return Promise.resolve(this); }
  }
  const element = (tag) => ({ tagName: tag, style: {}, className: '', textContent: '', width: 0, height: 0, children: [],
    getContext: () => stubContext(), appendChild(child) { this.children.push(child); }, remove() {}, setAttribute() {} });
  const document = { head: element('head'), body: element('body'), documentElement: { getAttribute: () => null }, createElement: element,
    addEventListener() {}, querySelector: () => null, fonts: { ready: Promise.resolve(), add() {}, load: async () => [] } };
  const page = { console: { ...console, warn() {}, error() {} }, document, innerWidth: 1280, innerHeight: 720, addEventListener() {},
    requestAnimationFrame() {}, performance, matchMedia: () => ({ matches: false }), FontFace };
  page.window = page;
  vm.createContext(page);
  vm.runInContext(readFileSync(path.join(WEB, 'filmKit', 'film-kit.js'), 'utf8'), page, { filename: 'film-kit.js' });
  if (family) page.Film.run({ duration: 2, type: { roles: { display: family } }, scenes: [{ from: 0, to: 2, draw() {} }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { made, brand: [...page.Film.BRAND_FONTS], ready: page.__ready };
}

test('the worker answers exactly the font URLs the film kit asks for, each with a copy of that family', { skip: existsSync(WEB) ? false : 'no web tree beside the worker' }, async () => {
  const { brand } = await kitFontRequests(null);
  assert.deepEqual([...brand].sort(), [...new Set(FONTS.map((font) => font.family))].sort());
  const asked = [];
  for (const family of brand) {
    const { made, ready } = await kitFontRequests(family);
    assert.equal(ready, true, family);
    assert.ok(made.length > 0, family);
    for (const [name, url] of made) {
      assert.equal(name, family);
      assert.equal(FONTS.find((font) => font.url === url)?.family, family, url);
      asked.push(url);
    }
  }
  assert.deepEqual([...new Set(asked)].sort(), FONTS.map((font) => font.url).sort());
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

/**
 * `work` with every render's browser unable to resolve any host, the CDNs' too (jsDelivr among them): the worker's own
 * launch flags with its resolver rule made `MAP * ~NOTFOUND`, so nothing a page asks for can come over the network and
 * whatever it draws came from the worker. Returns work's value and how many browsers were started that way.
 */
async function withNoNetwork(work) {
  const launch = chromium.launch;
  let launched = 0;
  chromium.launch = function launchWithNoNetwork(options = {}) {
    const args = (options.args || []).map((arg) => (arg.startsWith('--host-resolver-rules=') ? '--host-resolver-rules=MAP * ~NOTFOUND' : arg));
    assert.ok(args.includes('--host-resolver-rules=MAP * ~NOTFOUND'), 'the worker launches with a resolver rule');
    launched += 1;
    return launch.call(this, { ...options, args });
  };
  try {
    return { value: await work(), launched };
  } finally {
    chromium.launch = launch;
  }
}

async function renderWithNoNetwork(name, html, { width = 320, height = 180, fps = 4, seconds = 1 } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'awwo-film-fonts-test-'));
  try {
    const config = loadConfig({ AWWO_RENDER_TOKEN: 'x'.repeat(32), AWWO_RENDER_CHROME: CHROME, AWWO_RENDER_FFMPEG: process.env.AWWO_RENDER_FFMPEG,
      AWWO_RENDER_FFPROBE: process.env.AWWO_RENDER_FFPROBE, AWWO_RENDER_CHROME_SANDBOX: process.env.AWWO_RENDER_CHROME_SANDBOX, AWWO_RENDER_TMP: tmp,
      AWWO_RENDER_TIMEOUT_MS: '120000' });
    const { value, launched } = await withNoNetwork(() => renderPage(validateRenderRequest({ renderId: name, html, width, height, fps, seconds }), config));
    // The picture's browser, and one more for the page's own sound when the page defines window.renderAudio, as every
    // page that loads the film kit (by its URL or inlined) does: the sound is made in a browser of its own.
    const ownSound = html.includes(FILM.url) || html.includes('renderAudio');
    assert.equal(launched, ownSound ? 2 : 1);
    return value;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A one-scene film page whose roles are `roles` (the kit's TYPE roles), and which itself throws from a frame if any
 *  of `own` (ctx.font strings) is drawn by a stand-in, or any of `standIn` by its own face: a family drawn from its
 *  own face measures the same whatever generic family follows it. */
const typePage = (roles, own, standIn = []) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Type</title></head><body>
<script src="${FILM.url}"></script>
<script>
const OWN = ${JSON.stringify(own)}, STAND_IN = ${JSON.stringify(standIn)};
const drawnByItsFace = (g, font) => { const width = (generic) => { g.font = font + ', ' + generic; return g.measureText('Wg0').width; }; return Math.abs(width('monospace') - width('serif')) < 0.01; };
Film.run({
  title: 'Type', duration: 1, aspect: '16:9', palette: { bg: '#101418', ink: '#f4f1ea' },
  type: { lang: 'en', roles: ${JSON.stringify(roles)} },
  scenes: [{ from: 0, to: 1, draw(g, k, t, S) {
    for (const font of OWN) if (!drawnByItsFace(g, font)) throw new Error('drawn in a stand-in: ' + font);
    for (const font of STAND_IN) if (drawnByItsFace(g, font)) throw new Error('drawn by its own face: ' + font);
    Film.setFont(g, 'display', S.u * 0.2); g.fillStyle = '#f4f1ea'; g.fillText('TYPE ' + Math.round(k * 9), S.W * 0.1, S.H * 0.5);
  } }],
});
</script></body></html>`;

const NOT_A_FAULT = /^(?:page_errors|ready_timeout|fonts_timeout|network_blocked)/;

test('a film draws its brand fonts in a render that can reach no network', { skip, timeout: 120_000 }, async () => {
  const html = typePage({ display: 'Orbitron', text: 'Inter', mono: 'JetBrains Mono' },
    ['700 60px "Orbitron"', '400 60px "Inter"', 'italic 400 60px "Inter"', '400 60px "JetBrains Mono"', 'italic 400 60px "JetBrains Mono"']);
  const result = await renderWithNoNetwork('film_fonts_offline', html);
  assert.equal(result.mode, 'contract');
  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.warnings.filter((w) => NOT_A_FAULT.test(w)), [], result.warnings.join(','));
  assert.ok(result.distinctFrames > 1, `${result.distinctFrames} distinct frames`);
});

test('every brand face the film kit names loads in a render that can reach no network', { skip, timeout: 120_000 }, async () => {
  const html = `<!doctype html><html><body><script>
const URLS = ${JSON.stringify(FONTS.map((font) => font.url))};
window.__ready = false;
let failed = null;
Promise.all(URLS.map((url, i) => new FontFace('Face' + i, 'url(' + url + ')').load().then(() => null, () => url)))
  .then((outcome) => { failed = outcome.filter(Boolean); window.__ready = true; });
window.renderAt = () => { if (!failed || failed.length) throw new Error('not loaded: ' + (failed || ['every face (still loading)']).join(' ')); };
</script></body></html>`;
  const result = await renderWithNoNetwork('film_fonts_every_face', html, { width: 64, height: 64, fps: 1, seconds: 1 });
  assert.equal(result.mode, 'contract');
  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.warnings.filter((w) => NOT_A_FAULT.test(w)), [], result.warnings.join(','));
});

test('a film whose font cannot load says which role, and draws that role in a stand-in', { skip, timeout: 120_000 }, async () => {
  // Bungee is no brand font (nor one a system has): the kit asks jsDelivr for it, which this browser cannot reach. The
  // page's own check throws (a second page error) if Bebas Neue is not drawn by its face, or Bungee is.
  const bungee = { family: 'Bungee', pkg: 'bungee', version: '5.3.0', weights: [400], subsets: ['latin'] };
  const result = await renderWithNoNetwork('film_fonts_missing', typePage({ display: 'Bebas Neue', text: bungee }, ['400 60px "Bebas Neue"'], ['400 60px "Bungee"']));
  assert.equal(result.mode, 'contract');
  assert.deepEqual(result.pageErrors, ['Film: fonts not loaded: text "Bungee"']);
  assert.ok(result.warnings.includes('page_errors:1'), result.warnings.join(','));
  assert.ok(!result.warnings.includes('ready_timeout'), result.warnings.join(','));
});

test('a film sets its Chinese words in Noto Sans SC with no network, and its glyph check names a family that lacks them', { skip, timeout: 120_000 }, async () => {
  // The film lists its display role's words. The worker's Noto Sans SC has them; Instrument Serif, a Latin face, has
  // none, which the kit's glyph probes tell (after a generic family, every Han character measures an em wide).
  const film = (display) => typePage({ display }, [])
    .replace("type: { lang: 'en', roles:", "type: { lang: 'zh', check: { strings: { display: ['雨停了'] } }, roles:")
    .replace("g.fillText('TYPE ' + Math.round(k * 9), S.W * 0.1, S.H * 0.5)", "g.fillText('雨停了 ' + Math.round(k * 9), S.W * 0.1, S.H * 0.5)");
  assert.ok(film('Noto Sans SC').includes("display: ['雨停了']") && film('Noto Sans SC').includes("fillText('雨停了 '"), 'the page is built as meant');
  const noto = await renderWithNoNetwork('film_fonts_chinese', film('Noto Sans SC'));
  assert.equal(noto.mode, 'contract');
  assert.deepEqual(noto.pageErrors, []);
  assert.deepEqual(noto.warnings.filter((w) => NOT_A_FAULT.test(w)), [], noto.warnings.join(','));
  const latin = await renderWithNoNetwork('film_fonts_chinese_latin', film('Instrument Serif'));
  assert.equal(latin.mode, 'contract');
  assert.deepEqual(latin.pageErrors, ['Film: display "Instrument Serif" has no glyphs for: 雨停了']);
});

test('a film in a page that supplies its brand faces itself, as a running preview does, draws them and checks their glyphs', { skip, timeout: 120_000 }, async () => {
  // Built as AwwO's preview builds one (htmlDeliverable.ts, liveDocument.ts): fonts only as data:, the faces as
  // @font-face rules in the head and its script that starts loading them, the kit inlined. The kit fetches nothing, finds
  // the page's faces of the family and uses them, and still checks the film's glyphs in them: Inter's Latin file has no
  // Cyrillic and no Han, so the check names both, 雨 only through the kit's glyph probes, which the page's policy lets it
  // make (after a generic family, every Han character measures an em wide).
  const list = readFileSync(path.join(WEB, 'previewFontList.ts'), 'utf8');
  const loadScript = /PREVIEW_FONT_LOAD_SCRIPT = '([^']+)';/.exec(list)[1];
  const face = (file, style) => `@font-face{font-family:"Inter";src:url(data:font/woff2;base64,${readFileSync(path.join(WEB, 'fonts', file)).toString('base64')}) format("woff2");font-weight:100 900;font-style:${style};font-display:block}`;
  const film = typePage({ text: 'Inter' }, ['400 60px "Inter"', 'italic 400 60px "Inter"']).replace("type: { lang: 'en', roles:", "type: { lang: 'en', check: { strings: { text: ['Aж雨'] } }, roles:");
  // Replaced by functions: the kit's text holds `$` sequences a replacement string would read.
  const html = film
    .replace('<meta charset="utf-8">', () => `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:"><style>${face('inter-latin-wght-normal.woff2', 'normal')}\n${face('inter-latin-wght-italic.woff2', 'italic')}</style><script>${loadScript}</script>`)
    .replace(`<script src="${FILM.url}"></script>`, () => `<script>${readFileSync(path.join(here, 'kits', FILM.file), 'utf8')}</script>`);
  assert.ok(html.includes("check: { strings: { text: ['Aж雨'] } }") && !html.includes(FILM.url), 'the page is built as meant');
  const result = await renderWithNoNetwork('film_fonts_preview_page', html);
  assert.equal(result.mode, 'contract');
  assert.deepEqual(result.pageErrors, ['Film: text "Inter" has no glyphs for: ж雨']);
  assert.ok(!result.warnings.some((w) => /^(?:ready_timeout|fonts_timeout|network_blocked)/.test(w)), result.warnings.join(','));
});

test('when its own faces fail, the kit asks the browser only for the page\'s faces that would draw the role', { skip, timeout: 90_000 }, async () => {
  // The live studio's policy (fonts as data: and from the CDN), in a browser of the test's own: the kit's Inter fails
  // (its requests are refused), the page has Inter upright as data: (its preview script starts it) and an italic of its
  // own whose file never answers. The browser picks the upright for the kit's question, so the page loads, the film
  // turns ready and the italic is never asked for; waiting for every face of the family would wait for ever.
  const list = readFileSync(path.join(WEB, 'previewFontList.ts'), 'utf8');
  const loadScript = /PREVIEW_FONT_LOAD_SCRIPT = '([^']+)';/.exec(list)[1];
  const upright = readFileSync(path.join(WEB, 'fonts', 'inter-latin-wght-normal.woff2')).toString('base64');
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data: https://cdn.jsdelivr.net";
  const faces = `@font-face{font-family:"Inter";src:url(data:font/woff2;base64,${upright}) format("woff2");font-weight:100 900;font-style:normal}
@font-face{font-family:"Inter";src:url(https://cdn.jsdelivr.net/never/inter-italic.woff2) format("woff2");font-weight:100 900;font-style:italic}`;
  // As a preview orders its head: the faces, then its script that starts the ones it supplied (here the upright only).
  const start = loadScript.replace('f.load().catch(()=>{})', 'if(f.style!=="italic")f.load().catch(()=>{})');
  assert.notEqual(start, loadScript, 'the page starts its upright face only');
  const page = typePage({ text: 'Inter' }, ['400 60px "Inter"'])
    .replace('<meta charset="utf-8">', () => `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>${faces}</style><script>${start}</script>`)
    .replace(`<script src="${FILM.url}"></script>`, () => `<script>${readFileSync(path.join(here, 'kits', FILM.file), 'utf8')}</script>`);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-proxy-server'] });
  try {
    const context = await browser.newContext();
    const asked = [];
    await context.route('https://cdn.jsdelivr.net/**', (route) => {
      asked.push(route.request().url());
      if (!route.request().url().includes('/never/')) return route.abort('failed');   // the kit's own faces fail
      return undefined;                                                                // the page's italic never answers
    });
    const tab = await context.newPage();
    const errors = [];
    tab.on('pageerror', (error) => errors.push(error.message));
    await tab.setContent(page, { waitUntil: 'load', timeout: 20_000 });
    await tab.waitForFunction(() => window.__ready === true, null, { timeout: 15_000 });
    // The kit adds no face of its own that failed, so the one italic face in the set is the page's.
    const italic = await tab.evaluate(() => { const found = []; document.fonts.forEach((face) => { if (face.style === 'italic') found.push(face.status); }); return found; });
    assert.deepEqual(errors, []);
    assert.ok(asked.some((url) => url.includes('/@fontsource-variable/inter@')), asked.join(' '));
    assert.ok(!asked.some((url) => url.includes('/never/')), 'the unused italic was asked for');
    assert.deepEqual(italic, ['unloaded']);
  } finally {
    await browser.close();
  }
});
