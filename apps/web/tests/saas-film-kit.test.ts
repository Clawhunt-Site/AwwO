import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildFilmKit } from '../scripts/build-film-kit.mjs';
import { FILM_GUIDE, FILM_GUIDE_HEADING, FILM_GUIDE_OLD_HEADINGS, FILM_KIT_BYTES, FILM_KIT_SHA256, FILM_KIT_URL, filmPersona, filmRole } from '../src/canvas/filmKit/filmKit';
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

  it('says how to play it in the film\'s own language, never with its title, and only while it does not play', () => {
    const listeners: Record<string, () => void> = {};
    const hud = (film: Record<string, unknown>, pageLang: string | null = null) => {
      const page = kitInSandbox({
        window: { addEventListener(type: string, listener: () => void) { listeners[type] = listener; } },
        document: { documentElement: { getAttribute: (name: string) => (name === 'lang' ? pageLang : null) } },
      });
      page.Film.run({ duration: 2, scenes: [{ from: 0, to: 2, draw() {} }], ...film });
      return page.document.body.children.find((child: { className: string }) => child.className === 'awwo-film-hud');
    };
    // The film of 2026-11-09's check: a Chinese film whose title is its closing words.
    const zh = hud({ title: '雨停了', type: { lang: 'zh' } });
    expect(zh.textContent).toBe('点击播放（有声音）');
    expect(zh.textContent).not.toContain('雨停了');
    expect(zh.hidden).not.toBe(true);
    listeners.click();   // plays (no AudioContext here: the picture plays on its own)
    expect(zh.hidden).toBe(true);
    listeners.click();   // pauses
    expect(zh.hidden).toBe(false);
    for (const lang of ['zh-CN', 'zh-Hans', 'zh-Hans-HK', 'ZH']) expect(hud({ type: { lang } }).textContent, lang).toBe('点击播放（有声音）');
    for (const lang of ['zh-TW', 'zh-Hant', 'zh-HK', 'zh_MO', 'zh-Hant-TW']) expect(hud({ type: { lang } }).textContent, lang).toBe('點擊播放（有聲音）');
    // A film that names no language takes its page's; one that names its own keeps it.
    expect(hud({ title: '雨停了' }, 'zh-CN').textContent).toBe('点击播放（有声音）');
    expect(hud({ title: 'Paper Boat', type: { lang: 'en' } }, 'zh-CN').textContent).toBe('click to play with sound');
    expect(hud({ title: 'Paper Boat' }).textContent).toBe('click to play with sound');
    for (const lang of ['fr', 'zhx', 'en-ZH']) expect(hud({ type: { lang } }).textContent, lang).toBe('click to play with sound');
  });

  it('shows the hint again whatever stops a play: its end, a key, a step, a scene that throws', () => {
    const listeners: Record<string, (event?: unknown) => void> = {};
    const frames: Array<() => void> = [];
    let clock = 0;
    let broken = false;
    const page = kitInSandbox({ window: {
      addEventListener(type: string, listener: (event?: unknown) => void) { listeners[type] = listener; },
      requestAnimationFrame(callback: () => void) { frames.push(callback); },
      performance: { now: () => clock },
    } });
    const drawn: number[] = [];
    page.Film.run({ duration: 2, scenes: [{ from: 0, to: 2, draw(_g: unknown, _k: number, t: number) { drawn.push(t); if (broken) throw new Error('the scene broke'); } }] });
    const hud = page.document.body.children.find((child: { className: string }) => child.className === 'awwo-film-hud');
    const nextFrame = () => frames.shift()!();
    const key = (code: string) => listeners.keydown({ code, preventDefault() {} });
    // Played to its end: hidden on every frame until the last, which shows the hint and asks for no more.
    listeners.click();
    expect(hud.hidden).toBe(true);
    clock = 1000; nextFrame();
    expect(hud.hidden).toBe(true);
    clock = 2500; nextFrame();
    expect(hud.hidden).toBe(false);
    expect(frames).toHaveLength(0);
    // Space plays and pauses; an arrow while it plays pauses it, and a step while it is stopped keeps the hint.
    key('Space');
    expect(hud.hidden).toBe(true);
    key('Space');
    expect(hud.hidden).toBe(false);
    key('Space');
    expect(hud.hidden).toBe(true);
    key('ArrowRight');
    expect(hud.hidden).toBe(false);
    key('ArrowLeft');
    expect(hud.hidden).toBe(false);
    // A scene that throws while the film plays ends the play: the hint is back, the error goes on to be reported, and a
    // click plays again from the beginning, not from where it stopped (1 s) nor from where it threw (1.5 s).
    frames.length = 0;
    listeners.click();                      // plays from 0
    clock += 1000; nextFrame();             // at 1 s
    listeners.click();                      // pauses there
    frames.length = 0;
    listeners.click();                      // plays from 1 s
    expect(hud.hidden).toBe(true);
    broken = true; clock += 500;
    expect(nextFrame).toThrow('the scene broke');   // at 1.5 s
    expect(drawn[drawn.length - 1]).toBeCloseTo(1.5, 6);
    expect(hud.hidden).toBe(false);
    expect(frames).toHaveLength(0);
    broken = false;
    listeners.click();
    expect(hud.hidden).toBe(true);
    drawn.length = 0;
    nextFrame();
    expect(drawn).toEqual([0]);
  });

  it('gives its hint a backing of its own, which reads over the lightest picture', () => {
    const page = kitInSandbox();
    page.Film.run({ duration: 2, scenes: [{ from: 0, to: 2, draw() {} }] });
    const css = page.document.head.children.map((child: { textContent: string }) => child.textContent).join('\n');
    const rule = /\.awwo-film-hud\{[^}]*\}/.exec(css)?.[0] ?? '';
    const backing = /background:rgba\(0,0,0,(\.\d+)\)/.exec(rule);
    const ink = /color:#([0-9a-f]{6}|[0-9a-f]{3})(?=[;}])/i.exec(rule);
    expect(backing, rule).not.toBeNull();
    expect(ink, rule).not.toBeNull();
    expect(rule).not.toMatch(/opacity/);
    // WCAG contrast of the hint's ink over its backing laid on a white picture, the worst case.
    const linear = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const luminance = ([r, g, b]: number[]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    const hex = ink![1];
    const channels = (hex.length === 3 ? [...hex].map(digit => digit + digit) : hex.match(/../g)!).map(pair => parseInt(pair, 16));
    const over = [255, 255, 255].map(white => white * (1 - Number(backing![1])));
    expect((luminance(channels) + 0.05) / (luminance(over) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it('starts the next play from the beginning when a still it draws throws (a pause, a step)', () => {
    const listeners: Record<string, (event?: unknown) => void> = {};
    const frames: Array<() => void> = [];
    let clock = 0;
    const drawn: number[] = [];
    const page = kitInSandbox({ window: {
      addEventListener(type: string, listener: (event?: unknown) => void) { listeners[type] = listener; },
      requestAnimationFrame(callback: () => void) { frames.push(callback); },
      performance: { now: () => clock },
    } });
    // The scene cannot be drawn between 0.99 s and 1.1 s.
    page.Film.run({ duration: 2, scenes: [{ from: 0, to: 2, draw(_g: unknown, _k: number, t: number) { drawn.push(t); if (t > 0.99 && t < 1.1) throw new Error('the scene broke'); } }] });
    const hud = page.document.body.children.find((child: { className: string }) => child.className === 'awwo-film-hud');
    // Paused at 1 s: the still there throws, the hint is back, and the next play starts at 0, not at 1 s.
    listeners.click();
    clock = 1000;
    expect(() => listeners.click()).toThrow('the scene broke');
    expect(hud.hidden).toBe(false);
    frames.length = 0;
    listeners.click();
    drawn.length = 0;
    frames.shift()!();
    expect(drawn).toEqual([0]);
    // Stepped onto 1 s (from a pause at 0.96 s): the same.
    listeners.click();   // pauses at 0
    frames.length = 0;
    listeners.click();   // plays from 0 again
    clock += 960;
    listeners.click();   // pauses at 0.96 s
    expect(() => listeners.keydown({ code: 'ArrowRight', preventDefault() {} })).toThrow('the scene broke');
    frames.length = 0;
    listeners.click();
    drawn.length = 0;
    frames.shift()!();
    expect(drawn).toEqual([0]);
  });

  it('draws its still once its type has loaded, but never over a film that already plays', async () => {
    const listeners: Record<string, () => void> = {};
    const frames: Array<() => void> = [];
    let clock = 0;
    const drawn: number[] = [];
    const page = kitInSandbox({ window: {
      addEventListener(type: string, listener: () => void) { listeners[type] = listener; },
      requestAnimationFrame(callback: () => void) { frames.push(callback); },
      performance: { now: () => clock },
    } });
    page.Film.run({ duration: 2, scenes: [{ from: 0, to: 2, draw(_g: unknown, _k: number, t: number) { drawn.push(t); } }] });
    listeners.click();   // played before its type has loaded
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(page.__ready).toBe(true);
    expect(drawn).toEqual([]);   // its still (0.8 s) was not drawn over the playing film
    clock = 500; frames.shift()!();
    expect(drawn).toEqual([0.5]);
    // A film that is not playing when its type loads shows its still.
    const still = kitInSandbox();
    const stillDrawn: number[] = [];
    still.Film.run({ duration: 2, scenes: [{ from: 0, to: 2, draw(_g: unknown, _k: number, t: number) { stillDrawn.push(t); } }] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(stillDrawn).toEqual([0.8]);
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
    // English, as the personas it sits in are (a homepage case's briefs show it as it is), and no earlier line again.
    expect(FILM_GUIDE_HEADING).toBe('## AwwO film kit: how to build the film page');
    expect(FILM_GUIDE_HEADING).not.toMatch(/[\u3000-\u9fff]/);
    expect(FILM_GUIDE_OLD_HEADINGS).not.toContain(FILM_GUIDE_HEADING);
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

  it('replace a guide under an earlier first line too, as the film nodes made before it changed carry', () => {
    for (const heading of FILM_GUIDE_OLD_HEADINGS) {
      const saved = `Make a film for the cafe.\n\n${heading}\n\nthe guide as it was`;
      expect(filmRole(saved)).toBe('Make a film for the cafe.');
      expect(filmPersona(saved)).toBe(`Make a film for the cafe.\n\n${FILM_GUIDE}`);
      expect(filmRole(`${heading}\n\nonly a guide`)).toBe('');
      // Whichever guide comes first ends the role, so an old guide followed by the new one leaves one guide.
      expect(filmPersona(`${saved}\n\n${FILM_GUIDE}`)).toBe(`Make a film for the cafe.\n\n${FILM_GUIDE}`);
    }
    expect(FILM_GUIDE_OLD_HEADINGS).toContain('## 代码影片组件 · how to build the film page');
  });

  it('cuts a long role to keep the persona within the node setup limit, never the guide', () => {
    const persona = filmPersona('长'.repeat(8000));
    expect(bytes(persona)).toBeLessThanOrEqual(31_000);
    expect(persona.endsWith(FILM_GUIDE)).toBe(true);
    expect(filmRole(persona)).toMatch(/^长+$/);
  });
});
