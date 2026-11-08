import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildFilmKit } from '../scripts/build-film-kit.mjs';
import { FILM_GUIDE, FILM_GUIDE_HEADING, FILM_KIT_BYTES, FILM_KIT_SHA256, FILM_KIT_URL, filmPersona, filmRole } from '../src/canvas/filmKit/filmKit';
import { loadPreviewLibraries, PREVIEW_LIBRARIES, previewScriptNeeds } from '../src/canvas/previewLibraries';
import { htmlPreviewDocument } from '../src/canvas/htmlDeliverable';
import { PREVIEW_FONTS } from '../src/canvas/previewFontList';

const web = join(__dirname, '..');
const kitText = readFileSync(join(web, 'src', 'canvas', 'filmKit', 'film-kit.js'), 'utf8');
const upstream = readFileSync(join(web, '..', '..', 'third_party', 'cinecode', 'templates', 'quick', 'film.html'), 'utf8');
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** A 2D context that answers every call: enough for the kit's drawing code to run outside a browser. */
function stubContext(): unknown {
  const state: Record<string | symbol, unknown> = { font: '10px sans-serif', letterSpacing: '0px', globalAlpha: 1, filter: 'none' };
  const handler: ProxyHandler<object> = {
    get(_target, key) {
      if (key in state) return state[key];
      if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      if (key === 'measureText') return (text: string) => ({ width: String(text).length * 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3,
        actualBoundingBoxLeft: 0, actualBoundingBoxRight: String(text).length * 8, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4 });
      if (key === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (key === 'createPattern') return () => ({});
      if (key === 'canvas') return { width: 1280, height: 720 };
      return () => undefined;
    },
    set(_target, key, value) { state[key] = value; return true; },
  };
  return new Proxy({}, handler);
}

/** The kit run the way a page runs it, in a fresh global with a stub DOM; returns that global (its Film, renderAt...). */
function kitInSandbox(extra: { window?: Record<string, unknown>; document?: Record<string, unknown> } = {}): Record<string, any> {
  const element = (tag: string) => ({ tagName: tag, style: {}, className: '', textContent: '', width: 0, height: 0, children: [] as any[],
    getContext: () => stubContext(), appendChild(child: unknown) { this.children.push(child); }, remove() {}, setAttribute() {}, insertAdjacentHTML() {} });
  const document = {
    head: element('head'), body: element('body'), documentElement: { getAttribute: () => null },
    createElement: element, addEventListener() {}, querySelector: () => null, fonts: { ready: Promise.resolve(), add() {}, load: async () => [] },
    ...extra.document,
  };
  const sandbox: Record<string, unknown> = { console: { ...console, warn() {}, error() {} }, document, innerWidth: 1280, innerHeight: 720,
    addEventListener() {}, requestAnimationFrame() {}, performance, matchMedia: () => ({ matches: false }), ...extra.window };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(kitText, sandbox, { filename: 'film-kit.js' });
  return sandbox;
}

/** The example page in the guide: the shape every film node is told to copy. */
function guideExample(): string {
  const start = FILM_GUIDE.indexOf('```html', FILM_GUIDE.indexOf('### 2.'));
  const body = FILM_GUIDE.slice(start + '```html'.length);
  return body.slice(0, body.indexOf('```')).trim();
}
const scriptOf = (page: string) => page.slice(page.lastIndexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'));

describe('the film kit bundle', () => {
  it('is the deterministic build of the vendored cinecode engine, pinned by size and sha256', () => {
    expect(kitText).toBe(buildFilmKit());
    expect(bytes(kitText)).toBe(FILM_KIT_BYTES);
    expect(createHash('sha256').update(kitText).digest('hex')).toBe(FILM_KIT_SHA256);
    expect(/<\/script|<!--/i.test(kitText)).toBe(false);
    expect(kitText).toContain('MIT License');
    expect(kitText).toContain('Copyright (c) 2026 Sarp Yıldız');
    expect(kitText).not.toContain('\r');
  });

  it('keeps the upstream engine: its helpers, looks and voices are cinecode\'s own text', () => {
    for (const line of [
      'const CAM = {', 'function plane(g, S, c, z, fn) {', 'const TRANSITION = {', 'function character(g, S, who, x, y, h, pose = {}, t = 0) {',
      'function typeReveal(g, str, x, y, p, o = {}) {', 'function makeRoom(ctx, out) {', 'function whoosh(ctx, out, t, dur, gain) {',
      'function chord(name, octave = 3, o = {}) {', 'function grid(part, pattern, o = {}) {', "  'papercut-collage': {",
    ]) {
      expect(upstream).toContain(line);
      expect(kitText).toContain(line);
    }
    // Nothing that needs cinecode's tools, local files or URL parameters survived.
    expect(kitText).not.toMatch(/\b(?:MathJax|loadSamples|loadAudio|kineticCaptions|captureFrame|MODEL_SHEET)\b|q\.get\(/);
  });

  it('defines window.Film and the renderer\'s contract, and refuses to describe a film twice', () => {
    const page = kitInSandbox();
    const Film = page.Film;
    expect(Object.isFrozen(Film)).toBe(true);
    expect(Film.version).toBe('1');
    expect(Film.commit).toBe('67f9807112b97ae253d4a5f0eccaccc46c3b2633');
    expect(Object.keys(Film.LOOKS).sort()).toEqual(['anime-cel', 'cinematic-realistic', 'claymation', 'glossy-commercial', 'handmade-ink',
      'papercut-collage', 'pastel-storybook', 'retro-synthwave-vhs']);
    for (const name of ['run', 'CAM', 'EASE', 'MOTION', 'plane', 'text', 'label', 'character', 'font', 'setFont', 'pad', 'kick', 'chord', 'chordAt', 'grid', 'beats', 'hz', 'wet']) {
      expect(Film[name], name).toBeDefined();
    }
    expect(typeof page.renderAt).toBe('function');
    expect(typeof page.renderAudio).toBe('function');
    expect(page.__ready).toBe(false);
    expect(() => page.renderAt(0)).toThrow(/Film\.run had not been called when the renderer drew its first frame/);
    Film.run({ duration: 2, scenes: [{ from: 0, to: 2, draw() {} }] });
    expect(page.__ready).toBe(false);
    expect(() => Film.run({})).toThrow(/once/);
  });

  it('names exactly the brand fonts AwwO\'s previews supply', () => {
    expect([...kitInSandbox().Film.BRAND_FONTS].sort()).toEqual(PREVIEW_FONTS.map(font => font.family).sort());
  });

  it('computes notes, chords and grooves as cinecode does', () => {
    const { Film } = kitInSandbox();
    expect(Film.hz('A4')).toBe(440);
    expect(Film.chord('Am7', 3).map((f: number) => Math.round(f))).toEqual([220, 262, 330, 392]);
    Film.run({ duration: 4, bpm: 120, scenes: [{ from: 0, to: 4, draw() {} }], arrangement: [{ section: 'a', from: 0, to: 4, parts: ['drums'] }] });
    expect(Film.grid('drums', 'X...x...X...x...').map((h: { t: number }) => h.t)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(Film.chordAt(['C', 'G'], 2.1)).toBe('G');
  });

  it('runs the guide\'s example in every scene and across its transitions without a missing helper', async () => {
    const page = kitInSandbox();
    vm.runInContext(scriptOf(guideExample()), page as vm.Context);
    expect(page.__ready).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(page.__ready).toBe(true);
    for (const t of [0, 1.2, 2.39, 2.4, 3.6, 4.6, 4.8, 5.0, 7.1]) expect(() => page.renderAt(t), `t=${t}`).not.toThrow();
  });

  it('loads once: a second copy of the tag leaves the film the first one booted', () => {
    const page = kitInSandbox();
    const { Film, renderAt, renderAudio } = page;
    vm.runInContext(kitText, page as vm.Context, { filename: 'film-kit.js' });
    expect(page.Film).toBe(Film);
    expect(page.renderAt).toBe(renderAt);
    expect(page.renderAudio).toBe(renderAudio);
  });

  it('fails a page that never runs its film in its sound as in its picture', async () => {
    const page = kitInSandbox();
    await expect(page.renderAudio({ seconds: 1 })).rejects.toThrow(/never called Film\.run/);
  });

  it('says what is wrong with a film first, even when that is why its frame cannot be drawn', async () => {
    const page = kitInSandbox();
    page.Film.run({ duration: 2, scenes: [] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(() => page.renderAt(0)).toThrow(/^Film: scenes: give at least one/);
    expect(() => page.renderAt(1 / 30)).toThrow();
    expect(() => page.renderAt(1 / 30)).not.toThrow(/^Film: scenes/);
  });

  it('draws the frame a renderer asked for when a film boots after it, and shows no player', () => {
    const page = kitInSandbox();
    expect(() => page.renderAt(0.5)).toThrow(/Film\.run had not been called/);
    const drawn: number[] = [];
    page.Film.run({ duration: 2, scenes: [{ from: 0, to: 2, draw(_g: unknown, _k: number, t: number) { drawn.push(t); } }] });
    expect(drawn).toEqual([0.5]);
    const appended = page.document.body.children.map((child: { className: string }) => child.className);
    expect(appended).toContain('awwo-film');
    expect(appended).not.toContain('awwo-film-hud');
    expect(() => page.renderAt(1)).not.toThrow();
    expect(drawn).toEqual([0.5, 1]);
  });

  it('reports a scene list with a hole as the film\'s own error, and is still ready', async () => {
    const page = kitInSandbox();
    page.Film.run({ duration: 2, scenes: [{ from: 0, to: 1, draw() {} }, undefined, { from: 1, to: 2, draw() {} }] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(page.__ready).toBe(true);
    expect(() => page.renderAt(0)).toThrow(/^Film: scene 2: draw is not a function/);
    const sparse = kitInSandbox();
    // eslint-disable-next-line no-sparse-arrays
    sparse.Film.run({ duration: 2, scenes: [{ from: 0, to: 1, draw() {} }, , { from: 1, to: 2, draw() {} }] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(() => sparse.renderAt(0)).toThrow(/^Film: scene 2: draw is not a function/);
  });

  it('is the kit even when an element named Film came first', () => {
    const page = kitInSandbox({ window: { Film: { tagName: 'CANVAS' } } });
    expect(typeof page.Film.run).toBe('function');
  });

  it('fetches no font where the page may fetch none (a preview), and every role\'s faces elsewhere (a render)', async () => {
    const faces = (policy: string | null) => {
      const made: string[] = [];
      class FontFace { constructor(_family: string, source: string) { made.push(source); } load() { return Promise.resolve(this); } }
      const meta = policy === null ? null : { getAttribute: () => policy };
      const page = kitInSandbox({ window: { FontFace }, document: { querySelector: () => meta } });
      page.Film.run({ duration: 2, type: { roles: { display: 'Space Grotesk', text: 'Inter' } }, scenes: [{ from: 0, to: 2, draw() {} }] });
      return { page, made };
    };
    const preview = faces("default-src 'none'; font-src data:; style-src 'unsafe-inline'");
    const render = faces(null);
    const allowed = faces("default-src 'none'; font-src https://cdn.jsdelivr.net/npm/; style-src 'unsafe-inline'");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(preview.page.__ready).toBe(true);
    expect(preview.made).toEqual([]);
    expect(allowed.made.length).toBeGreaterThanOrEqual(2);
    expect(render.made.length).toBeGreaterThanOrEqual(2);
    expect(render.made.every(source => source.startsWith('url(https://cdn.jsdelivr.net/'))).toBe(true);
  });

  it('passes on whatever a scene throws, falsy values too', async () => {
    const page = kitInSandbox();
    // It throws for frame 0 only, not for the poster (0.8 s) a running preview draws once the film is ready.
    page.Film.run({ duration: 2, scenes: [{ from: 0, to: 2, draw(_g: unknown, _k: number, t: number) { if (t < 0.1) throw 0; } }] });
    await new Promise(resolve => setTimeout(resolve, 20));
    let caught: unknown = 'nothing';
    try { page.renderAt(0); } catch (e) { caught = e; }
    expect(caught).toBe(0);
  });

  it('reports a film whose scenes do not tile it, from the first frame a renderer draws', async () => {
    const page = kitInSandbox();
    page.Film.run({ duration: 4, scenes: [{ from: 0, to: 1.5, draw() {} }, { from: 2, to: 4, draw() {} }] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(() => page.renderAt(0)).toThrow(/scenes 1 and 2 leave a gap/);
    expect(() => page.renderAt(1 / 30)).not.toThrow();
  });

  it('is supplied to a running page for its fixed URL and inlined ahead of the page script', async () => {
    const library = PREVIEW_LIBRARIES.find(item => item.id === 'film-kit-1')!;
    expect(library.urls).toEqual([FILM_KIT_URL]);
    expect(library.bytes).toBe(FILM_KIT_BYTES);
    expect(library.sha256).toBe(FILM_KIT_SHA256);
    expect(library.labelZh).toBe('代码影片组件');
    const page = guideExample();
    const needs = previewScriptNeeds(page);
    // The page names its brand fonts where the preview looks for them, so a preview with no network still has them.
    expect(needs.libraries.map(item => item.id)).toEqual(['film-kit-1', 'brand-fonts']);
    expect(needs.fonts?.map(font => font.family)).toEqual(['Inter', 'Space Grotesk']);
    expect(needs.blocked).toEqual([]);
    const code = await loadPreviewLibraries(needs);
    expect(code.get(FILM_KIT_URL)).toBe(kitText);
    const doc = new DOMParser().parseFromString(htmlPreviewDocument(page, true, code), 'text/html');
    const scripts = Array.from(doc.body.querySelectorAll('script'));
    expect(scripts).toHaveLength(2);
    expect(scripts[0].textContent).toBe(kitText);
    expect(scripts[1].textContent).toContain('Film.run(');
    expect(doc.querySelector('[src]')).toBeNull();
  });

  it('is served by the hosted site at the path of its URL', () => {
    const config = readFileSync(join(web, 'vite.saas.config.mjs'), 'utf8');
    expect(config).toContain(`const FILM_KIT_PATH = '${new URL(FILM_KIT_URL).pathname}';`);
    expect(config).toContain("join(root, 'src', 'canvas', 'filmKit', 'film-kit.js')");
    expect(config).toContain("servedKit('awwo-saas-film-kit', FILM_KIT_PATH, FILM_KIT_FILE)");
  });

  it('is the bundle the render worker answers the same URL with', () => {
    const worker = readFileSync(join(web, '..', 'render-worker', 'kits', 'film-kit-1.js'), 'utf8');
    expect(worker).toBe(kitText);
    const kits = readFileSync(join(web, '..', 'render-worker', 'kits.mjs'), 'utf8');
    expect(kits).toContain(`url: '${FILM_KIT_URL}'`);
    expect(kits).toContain(`bytes: ${FILM_KIT_BYTES},`);
    expect(kits).toContain(`sha256: '${FILM_KIT_SHA256}'`);
  });
});

describe('the film guide', () => {
  it('names the kit URL, fits a node persona and shows a page whose script compiles', () => {
    expect(FILM_GUIDE.startsWith(FILM_GUIDE_HEADING)).toBe(true);
    expect(FILM_GUIDE).toContain(`<script src="${FILM_KIT_URL}"></script>`);
    expect(bytes(FILM_GUIDE)).toBeLessThan(16_500);
    const page = guideExample();
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(() => new Function('Film', scriptOf(page))).not.toThrow();
  });

  it('lists the brand fonts the kit can load and the looks it has, and no other', () => {
    const { Film } = kitInSandbox();
    for (const family of Film.BRAND_FONTS) expect(FILM_GUIDE).toContain(family);
    for (const look of Object.keys(Film.LOOKS)) expect(FILM_GUIDE).toContain(`'${look}'`);
  });
});

describe('film personas', () => {
  it('put the guide after the role once, and replace an older guide instead of adding another', () => {
    const persona = filmPersona('做一支咖啡店开业短片。');
    expect(persona).toBe(`做一支咖啡店开业短片。\n\n${FILM_GUIDE}`);
    expect(filmPersona(persona)).toBe(persona);
    expect(filmRole(persona)).toBe('做一支咖啡店开业短片。');
    const older = `新的角色。\n\n${FILM_GUIDE_HEADING}\n\nan older guide`;
    expect(filmPersona(older)).toBe(`新的角色。\n\n${FILM_GUIDE}`);
    expect(filmPersona('')).toBe(FILM_GUIDE);
  });

  it('cuts a long role to keep the persona within the node setup limit, never the guide', () => {
    const persona = filmPersona('长'.repeat(8000));
    expect(bytes(persona)).toBeLessThanOrEqual(31_000);
    expect(persona.endsWith(FILM_GUIDE)).toBe(true);
    expect(filmRole(persona)).toMatch(/^长+$/);
  });
});
