import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildFilmKit, GLYPH_PROBE_ADVANCES, probeFont } from '../scripts/build-film-kit.mjs';
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

  /** A face of the page's own, as Chrome keeps one: its status and its `loaded` promise. Once it starts loading (at
   *  `status` 'loading', or when asked to load from 'unloaded'), it loads, fails or never settles, after `ms`. */
  type Held = { family: string; status: string; loaded: Promise<unknown>; load: () => Promise<unknown>; started: boolean };
  const pageFace = (family: string, { status = 'loaded', outcome = 'load', ms = 0 }: { status?: string; outcome?: 'load' | 'fail' | 'never'; ms?: number } = {}): Held => {
    let settle = { resolve: (_value: unknown) => {}, reject: (_error: unknown) => {} };
    const face: Held = { family, status, started: status !== 'unloaded', loaded: new Promise((resolve, reject) => { settle = { resolve, reject }; }), load: () => face.loaded };
    face.loaded.catch(() => {});
    const start = () => {
      if (outcome !== 'never') setTimeout(() => { face.status = outcome === 'load' ? 'loaded' : 'error'; if (outcome === 'load') settle.resolve(face); else settle.reject(new Error('404')); }, ms);
    };
    if (status === 'loaded') settle.resolve(face); else if (status === 'error') settle.reject(new Error('404')); else if (status === 'loading') start();
    face.load = () => { if (face.status === 'unloaded') { face.status = 'loading'; face.started = true; start(); } return face.loaded; };
    return face;
  };
  type Cut = { style?: string; weight?: string; unicodeRange?: string };
  /** A page whose FontFace loads as `load` says for its family and cut, whose document holds `pageFaces` (the page's
   *  own, or a running preview's), and which lists the faces the kit adds and every load it asks the document for. The
   *  document answers a load as Chrome does: with the faces of the family it holds when asked (the kit's own among
   *  them), each started and waited for, those that loaded. */
  const fontPage = (load: (family: string, cut: Cut) => Promise<void>, pageFaces: Held[] = [], policy: string | null = null) => {
    const added: string[] = [], asked: string[] = [];
    class FontFace {
      family: string;
      cut: Cut;
      status = 'unloaded';
      constructor(family: string, _source: string, cut: Cut = {}) { this.family = family; this.cut = cut; }
      load() { return load(this.family, this.cut).then(() => { this.status = 'loaded'; return this; }, error => { this.status = 'error'; throw error; }); }
    }
    const held: Array<Held | FontFace> = [...pageFaces];
    const fonts = {
      ready: Promise.resolve(), forEach: (each: (face: unknown) => void) => held.forEach(each),
      add: (face: FontFace) => { held.push(face); added.push(face.family + (face.cut.style === 'italic' ? ' italic' : '') + (face.cut.unicodeRange ? ' ranged' : '')); },
      load: (font: string) => {
        asked.push(font);
        const now = held.filter(face => font.includes(`"${face.family}"`));
        return Promise.all(now.map(face => (face.status === 'loaded' ? Promise.resolve(face) : face.load()).then(() => face, () => null)))
          .then(all => all.filter(face => face && face.status === 'loaded'));
      },
    };
    const meta = policy === null ? null : { getAttribute: () => policy };
    return { page: kitInSandbox({ window: { FontFace }, document: { fonts, querySelector: () => meta } }), added, asked, held };
  };
  const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
  const never = () => new Promise<never>(() => {});
  const fail = () => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED'));
  const ok = () => Promise.resolve();
  const scene = [{ from: 0, to: 2, draw() {} }];
  const PREVIEW_POLICY = "default-src 'none'; font-src data:";

  it('tells a renderer, with its first frame and once, which roles a font did not load for, the frame drawn first', async () => {
    const { page, added } = fontPage(family => family === 'Orbitron' ? fail() : ok());
    const drawn: number[] = [];
    page.Film.run({ duration: 2, type: { roles: { display: 'Orbitron', text: 'Inter' } }, scenes: [{ from: 0, to: 2, draw(_g: unknown, _k: number, t: number) { drawn.push(t); } }] });
    await settle();
    expect(page.__ready).toBe(true);
    expect(added).toEqual(['Inter', 'Inter italic']);
    drawn.length = 0;
    expect(() => page.renderAt(0)).toThrow(/^Film: fonts not loaded: display "Orbitron"$/);
    expect(drawn).toEqual([0]);
    expect(() => page.renderAt(1 / 24)).not.toThrow();
    expect(drawn).toEqual([0, 1 / 24]);
  });

  it('says a role whose own faces failed is not loaded, while it waits at the first frame on a face of the page\'s', async () => {
    const { page } = fontPage(fail, [pageFace('Orbitron', { status: 'unloaded', outcome: 'never' })]);
    page.Film.run({ duration: 2, type: { roles: { display: 'Orbitron' } }, scenes: scene });
    await settle();
    expect(page.__ready).toBe(false);
    expect(() => page.renderAt(0)).toThrow(/^Film: fonts not loaded: display "Orbitron"$/);
  });

  it('gives each role at the first frame its own reason: its faces still loading, or failed while the page\'s are awaited', async () => {
    const { page } = fontPage(family => family === 'Orbitron' ? fail() : never(), [pageFace('Orbitron', { status: 'unloaded', outcome: 'never' })]);
    page.Film.run({ duration: 2, type: { roles: { display: 'Orbitron', text: 'Inter' } }, scenes: scene });
    await settle();
    expect(() => page.renderAt(0)).toThrow(/^Film: fonts not loaded: display "Orbitron"; fonts still loading at the first frame, not used in this film: text "Inter"$/);
  });

  it('says nothing of a role it has no face of its own for, reached only after the first frame: it could not ask', async () => {
    const own = pageFace('Orbitron', { status: 'loaded' });
    const { page, asked } = fontPage(fail, [own], PREVIEW_POLICY);
    expect(() => page.renderAt(0)).toThrow(/Film\.run had not been called/);
    page.Film.run({ duration: 2, type: { roles: { display: 'Orbitron' } }, scenes: scene });
    await settle();
    expect(asked).toEqual([]);
    expect(() => page.renderAt(1 / 24)).not.toThrow();
  });

  it('names the cuts and the character ranges a role lacks beside the ones it has', async () => {
    const italic = fontPage((_family, cut) => cut.style === 'italic' ? fail() : ok());
    italic.page.Film.run({ duration: 2, type: { roles: { text: 'Inter' } }, scenes: scene });
    const weights = fontPage((_family, cut) => cut.weight === '600' || cut.weight === '700' ? fail() : ok());
    weights.page.Film.run({ duration: 2, type: { roles: { display: 'Rajdhani' } }, scenes: scene });
    const ext = (cut: Cut) => !!cut.unicodeRange?.startsWith('U+0100');
    const range = fontPage((_family, cut) => ext(cut) ? fail() : ok());
    range.page.Film.run({ duration: 2, type: { roles: { text: { family: 'Inter', subsets: ['latin', 'latin-ext'] } } }, scenes: scene });
    const both = fontPage((_family, cut) => ext(cut) || cut.style === 'italic' ? fail() : ok());
    both.page.Film.run({ duration: 2, type: { roles: { text: { family: 'Inter', subsets: ['latin', 'latin-ext'] } } }, scenes: scene });
    await settle(40);
    expect(italic.added).toEqual(['Inter']);
    expect(() => italic.page.renderAt(0)).toThrow(/^Film: fonts not loaded: text "Inter" italic$/);
    expect(weights.added).toEqual(['Rajdhani', 'Rajdhani']);
    expect(() => weights.page.renderAt(0)).toThrow(/^Film: fonts not loaded: display "Rajdhani" 600 and 700$/);
    expect(range.added).toEqual(['Inter ranged', 'Inter italic ranged']);
    expect(() => range.page.renderAt(0)).toThrow(/^Film: fonts not loaded: text "Inter" latin-ext$/);
    expect(() => both.page.renderAt(0)).toThrow(/^Film: fonts not loaded: text "Inter" latin italic and latin-ext$/);
  });

  it('says what it knows of a role from the first frame, while another role still loads', async () => {
    const roboto = { family: 'Roboto', pkg: 'roboto', version: '5.3.0', weights: [400], subsets: ['latin'] };
    const { page } = fontPage(family => family === 'Roboto' ? fail() : family === 'Inter' ? never() : ok());
    page.Film.run({ duration: 2, type: { roles: { display: 'Bebas Neue', text: 'Inter', mono: roboto } }, scenes: scene });
    await settle();
    expect(() => page.renderAt(0)).toThrow(/^Film: fonts not loaded: mono "Roboto"; fonts still loading at the first frame, not used in this film: text "Inter"$/);
    expect(() => page.renderAt(1 / 24)).not.toThrow();
  });

  it('says the roles a font did not load for under one reason, in role order whatever order they failed in', async () => {
    const later = () => new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('blocked')), 8));
    const { page } = fontPage(family => family === 'Orbitron' ? later() : family === 'Inter' ? ok() : fail());
    page.Film.run({ duration: 2, type: { roles: { display: 'Orbitron', text: 'Inter', mono: 'JetBrains Mono' } }, scenes: scene });
    await settle(40);
    expect(() => page.renderAt(0)).toThrow(/^Film: fonts not loaded: display "Orbitron", mono "JetBrains Mono"$/);
  });

  it('uses no face of its own that is still loading at the first frame, for the whole film, and says so', async () => {
    let finish = () => {};
    const late = new Promise<void>(resolve => { finish = resolve; });
    const { page, added } = fontPage(family => family === 'Inter' ? late : ok());
    page.Film.run({ duration: 2, type: { roles: { display: 'Bebas Neue', text: 'Inter' } }, scenes: scene });
    await settle();
    expect(page.__ready).toBe(false);
    expect(added).toEqual(['Bebas Neue']);
    // The renderer's ready wait ran out: its first frame is drawn now, and the type it has is the film's.
    expect(() => page.renderAt(0)).toThrow(/^Film: fonts still loading at the first frame, not used in this film: text "Inter"$/);
    finish();
    await settle();
    expect(page.__ready).toBe(true);
    expect(added).toEqual(['Bebas Neue']);
    expect(() => page.renderAt(1 / 24)).not.toThrow();
  });

  it('uses no face that loads after a renderer\'s first frame when the film boots after it, and asks the page for none', async () => {
    const unloaded = pageFace('Inter', { status: 'unloaded' });
    const { page, added, asked } = fontPage(ok, [unloaded]);
    expect(() => page.renderAt(0)).toThrow(/Film\.run had not been called/);
    page.Film.run({ duration: 2, type: { roles: { display: 'Inter' } }, scenes: scene });
    await settle();
    expect(added).toEqual([]);
    expect(asked).toEqual([]);
    expect(unloaded.started).toBe(false);
    expect(() => page.renderAt(1 / 24)).toThrow(/^Film: fonts loaded only after the first frame, not used in this film: display "Inter"$/);
    expect(() => page.renderAt(2 / 24)).not.toThrow();
  });

  it('asks the document to load nothing while the kit\'s own faces load, however long a face of the page\'s own takes', async () => {
    // A face asked for while the page loads holds up its load event, which a render waits for, and so would the kit's
    // ready: the page names the family in a font of its own that never arrives (a Google Fonts link where it never loads).
    // (One the page itself had started would hold up document.fonts.ready, which the kit waits for, whatever the kit
    // does: that is the page's own wait, and not this case.)
    const own = pageFace('Inter', { status: 'unloaded', outcome: 'never' });
    const { page, added, asked } = fontPage(ok, [own]);
    page.Film.run({ duration: 2, type: { roles: { display: 'Inter', text: 'Space Grotesk' } }, scenes: scene });
    await settle();
    expect(page.__ready).toBe(true);
    expect(asked).toEqual([]);
    expect(own.started).toBe(false);
    expect(added).toEqual(['Inter', 'Inter italic', 'Space Grotesk']);
    expect(() => page.renderAt(0)).not.toThrow();
  });

  it('draws a role from the page\'s own faces of its family, as a running preview supplies them, and says nothing', async () => {
    // A preview allows fonts only as data: the kit fetches none, and uses the faces the preview started loading.
    const preview = fontPage(fail, [pageFace('Orbitron', { status: 'loading', ms: 5 })], PREVIEW_POLICY);
    preview.page.Film.run({ duration: 2, type: { roles: { display: 'Orbitron' } }, scenes: scene });
    // A page face that comes after Film.run is found when the kit's own fail before the first frame, and asked to load.
    const arriving = fontPage(() => new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('blocked')), 10)));
    arriving.page.Film.run({ duration: 2, type: { roles: { display: 'Orbitron' } }, scenes: scene });
    const late = pageFace('Orbitron', { status: 'unloaded', ms: 5 });
    arriving.held.push(late);
    await settle(60);
    expect(preview.page.__ready).toBe(true);
    expect(preview.added).toEqual([]);
    expect(() => preview.page.renderAt(0)).not.toThrow();
    expect(arriving.page.__ready).toBe(true);
    expect(late.started).toBe(true);
    expect(() => arriving.page.renderAt(0)).not.toThrow();
  });

  it('counts none of its own faces, nor a failed face of the page\'s, as the page having the family', async () => {
    const failing = fontPage((_family, cut) => cut.style === 'italic' ? fail() : ok(), [pageFace('Inter', { status: 'loading', outcome: 'fail', ms: 5 })]);
    failing.page.Film.run({ duration: 2, type: { roles: { text: 'Inter' } }, scenes: scene });
    const broken = fontPage(fail, [pageFace('Orbitron', { status: 'error' })]);
    broken.page.Film.run({ duration: 2, type: { roles: { display: 'Orbitron' } }, scenes: scene });
    await settle(40);
    expect(failing.asked).toHaveLength(1);
    expect(() => failing.page.renderAt(0)).toThrow(/^Film: fonts not loaded: text "Inter" italic$/);
    expect(() => broken.page.renderAt(0)).toThrow(/^Film: fonts not loaded: display "Orbitron"$/);
  });

  it('names a role it has no face of its own for, still waiting on the page\'s at the first frame, without saying what is used', async () => {
    const { page } = fontPage(fail, [pageFace('Orbitron', { status: 'loading', outcome: 'never' })], PREVIEW_POLICY);
    page.Film.run({ duration: 2, type: { roles: { display: 'Orbitron' } }, scenes: scene });
    await settle();
    expect(() => page.renderAt(0)).toThrow(/^Film: fonts still loading at the first frame: display "Orbitron"$/);
  });

  it('still checks the glyphs of a role some of whose cuts loaded', async () => {
    // A context that measures a character in the role's family only where the family draws it, and otherwise in the
    // generic family after it, as a browser falls back: Inter here has no Cyrillic.
    const covers = (family: string, char: string) => family === 'Inter' && char !== 'ж';
    const measuring = () => {
      const state: Record<string, unknown> = { font: '10px sans-serif', letterSpacing: '0px' };
      return new Proxy({}, {
        get(_target, key) {
          if (key in state) return state[key];
          if (key === 'measureText') return (text: string) => {
            const [, family = '', generic = ''] = /"([^"]+)",\s*([\w-]+)/.exec(String(state.font)) ?? [];
            const width = [...String(text)].reduce((sum, char) => sum + (covers(family, char) ? 8 : generic === 'monospace' ? 7 : generic === 'serif' ? 9 : 10), 0);
            return { width, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 };
          };
          if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
          if (key === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
          if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
          return () => undefined;
        },
        set(_target, key, value) { state[key] = value; return true; },
      });
    };
    const added: string[] = [];
    class FontFace {
      family: string;
      style: string;
      constructor(family: string, _source: string, cut: { style?: string } = {}) { this.family = family; this.style = cut.style ?? 'normal'; }
      load() { return this.style === 'italic' ? Promise.reject(new Error('404')) : Promise.resolve(this); }
    }
    const element = (tag: string) => ({ tagName: tag, style: {}, className: '', textContent: '', width: 0, height: 0, children: [] as unknown[],
      getContext: () => measuring(), appendChild(child: unknown) { this.children.push(child); }, remove() {}, setAttribute() {} });
    const page = kitInSandbox({ window: { FontFace }, document: { createElement: element, body: element('body'), head: element('head'),
      fonts: { ready: Promise.resolve(), forEach() {}, add: (face: FontFace) => added.push(face.family), load: async () => [] } } });
    page.Film.run({ duration: 2, type: { lang: 'en', roles: { text: 'Inter' }, check: { strings: { text: ['Aж'] } } }, scenes: [{ from: 0, to: 2, draw() {} }] });
    await settle();
    expect(added).toEqual(['Inter']);
    expect(() => page.renderAt(0)).toThrow(/^Film: text "Inter" has no glyphs for: ж; fonts not loaded: text "Inter" italic$/);
  });

  /** A 2D context that measures as Chrome does: each character in the first family of the font string that has it, at
   *  that family's width. `covers` says which characters a page's family has; a generic family has every character, and
   *  so does each of the kit's glyph probes, while `present` finds a face of it in the document (one not in it is no
   *  family at all, and the browser falls back past it). A probe draws a character as a blank of its own width; a Han
   *  character is an em wide in every font that has it, whichever that is: the reason the generic families cannot tell
   *  a family lacks one. */
  const chromeContext = (covers: (family: string, char: string) => boolean, present: (family: string) => boolean) => {
    const state: Record<string, unknown> = { font: '10px sans-serif', letterSpacing: '0px' };
    const han = /\p{Script=Han}/u, generic = ['monospace', 'serif', 'cursive', 'sans-serif'];
    const probe = (family: string) => /^AwwO glyph probe ([ab])$/.exec(family)?.[1];
    const width = (family: string, char: string, px: number) => {
      const which = probe(family);
      if (which) return px * GLYPH_PROBE_ADVANCES['ab'.indexOf(which)] / 1000;
      if (han.test(char)) return px;
      return ({ monospace: 7, serif: 9, cursive: 10 } as Record<string, number>)[family] ?? 8;
    };
    const measure = (text: string) => {
      const [, size = '10', list = ''] = /(\d+(?:\.\d+)?)px\s+(.*)$/.exec(String(state.font)) ?? [];
      const families = list.split(',').map(name => name.trim().replace(/^"|"$/g, ''));
      return [...String(text)].reduce((sum, char) => {
        const family = families.find(name => generic.includes(name) || (probe(name) ? present(name) : covers(name, char)));
        return sum + width(family ?? 'serif', char, Number(size));
      }, 0);
    };
    return new Proxy({}, {
      get(_target, key) {
        if (key in state) return state[key];
        if (key === 'measureText') return (text: string) => ({ width: measure(text), actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 });
        if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        if (key === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
        return () => undefined;
      },
      set(_target, key, value) { state[key] = value; return true; },
    });
  };
  /** A render's page (no font policy) whose canvas measures as chromeContext does, with every FontFace loading: what the
   *  kit made (family and whether from bytes), and the families in the document's set, now and ever. Its FontFace
   *  refuses a family a word of which starts with a digit, as Firefox 142's does: the face is made, in error, and its
   *  load() rejects ("probe 1", "Exo 2" and "Press Start 2P" are no family names there; "probe1" is one). */
  const glyphPage = (covers: (family: string, char: string) => boolean, { bytes = true }: { bytes?: boolean } = {}) => {
    const made: { family: string; bytes: boolean }[] = [], set = new Set<{ family: string }>(), ever: string[] = [];
    class FontFace {
      family: string;
      status: string;
      constructor(family: string, source: unknown) {
        this.family = family;
        this.status = /(?:^|\s)\d/.test(family) ? 'error' : 'unloaded';
        made.push({ family, bytes: typeof source !== 'string' });
      }
      load() {
        if (this.status === 'error') return Promise.reject(new SyntaxError(`FontFace: ${this.family} is no family name`));
        this.status = 'loaded';
        return Promise.resolve(this);
      }
    }
    const present = (family: string) => [...set].some(face => face.family === family);
    const element = (tag: string) => ({ tagName: tag, style: {}, className: '', textContent: '', width: 0, height: 0, children: [] as unknown[],
      getContext: () => chromeContext(covers, present), appendChild(child: unknown) { this.children.push(child); }, remove() {}, setAttribute() {} });
    const fonts = { ready: Promise.resolve(), forEach: (each: (face: unknown) => void) => set.forEach(each), load: async () => [],
      add: (face: { family: string }) => { set.add(face); ever.push(face.family); }, delete: (face: { family: string }) => set.delete(face) };
    const page = kitInSandbox({ window: { FontFace, ...(bytes ? { atob } : {}) },
      document: { createElement: element, body: element('body'), head: element('head'), fonts } });
    return { page, made, ever, now: () => [...set].map(face => face.family) };
  };
  // A Latin family draws Latin only. Noto Sans SC's subset draws Latin, 雨停了 and its punctuation, not the rare 毖 and
  // no Cyrillic.
  const latinOnly = /^[ -ɏ]$/u;
  const notoCovers = (family: string, char: string) => family === 'Noto Sans SC' ? char !== '毖' && !/\p{Script=Cyrillic}/u.test(char) : latinOnly.test(char);
  const PROBES = ['AwwO glyph probe a', 'AwwO glyph probe b'];

  it('checks a film\'s Chinese words in the faces that set them, after its own glyph probes', async () => {
    const latin = glyphPage(notoCovers), noto = glyphPage(notoCovers), rare = glyphPage(notoCovers);
    latin.page.Film.run({ duration: 2, type: { lang: 'zh', roles: { display: 'Instrument Serif' }, check: { strings: { display: ['雨停了。'] } } }, scenes: scene });
    noto.page.Film.run({ duration: 2, type: { lang: 'zh', roles: { display: 'Noto Sans SC' }, check: { strings: { display: ['雨停了，Rain'] } } }, scenes: scene });
    rare.page.Film.run({ duration: 2, type: { lang: 'zh', roles: { display: 'Noto Sans SC' }, check: { strings: { display: ['毖'] } } }, scenes: scene });
    await settle();
    expect(() => latin.page.renderAt(0)).toThrow(/^Film: display "Instrument Serif" has no glyphs for: 雨停了。$/);
    expect(() => noto.page.renderAt(0)).not.toThrow();
    expect(() => rare.page.renderAt(0)).toThrow(/^Film: display "Noto Sans SC" has no glyphs for: 毖$/);
    // The two probes were made from bytes, under names any browser takes, and were in the document only while the
    // check measured.
    for (const { made, ever, now } of [latin, noto, rare]) {
      expect(made.filter(face => face.family.startsWith('AwwO glyph probe'))).toEqual(PROBES.map(family => ({ family, bytes: true })));
      expect(ever.filter(family => family.startsWith('AwwO glyph probe'))).toEqual(PROBES);
      expect(now().filter(family => family.startsWith('AwwO glyph probe'))).toEqual([]);
    }
  });

  it('leaves emoji out of the glyph check: no family choice makes them the film\'s', async () => {
    const mixed = glyphPage(notoCovers), only = glyphPage(notoCovers);
    // 🚀, a heart drawn as emoji (its selector), a family of people joined, a flag, a hand with a skin tone and two
    // text-default pictographs joined go uncounted, and a keycap's digit is measured as a digit; 新 is counted.
    mixed.page.Film.run({ duration: 2, type: { lang: 'zh', roles: { display: 'Instrument Serif' },
      check: { strings: { display: ['新🚀', '❤\uFE0F \u{1F469}\u200D\u{1F469}\u200D\u{1F467}', '🇨🇳',
        '\u270C\u{1F3FD} \u{1F441}\u200D\u{1F5E8} 1\uFE0F\u20E3'] } } }, scenes: scene });
    only.page.Film.run({ duration: 2, type: { lang: 'zh', roles: { display: 'Instrument Serif' }, check: { strings: { display: '🚀🚀' } } }, scenes: scene });
    await settle();
    expect(() => mixed.page.renderAt(0)).toThrow(/^Film: display "Instrument Serif" has no glyphs for: 新$/);
    // Nothing left to measure: no probe is made, and the film is fine.
    expect(only.made.filter(face => face.family.startsWith('AwwO glyph probe'))).toEqual([]);
    expect(() => only.page.renderAt(0)).not.toThrow();
  });

  it('measures each listed string without its emoji on its own: a base and a skin tone listed apart are no emoji', async () => {
    const apart = glyphPage(notoCovers), whole = glyphPage(notoCovers);
    apart.page.Film.run({ duration: 2, type: { lang: 'zh', roles: { display: 'Instrument Serif' }, check: { strings: { display: ['\u270C', '\u{1F3FD}'] } } }, scenes: scene });
    whole.page.Film.run({ duration: 2, type: { lang: 'zh', roles: { display: 'Instrument Serif' }, check: { strings: { display: '\u270C\u{1F3FD}' } } }, scenes: scene });
    await settle();
    // Drawn apart, the hand is text, which a Latin family lacks; written as one string, it is the emoji with its tone.
    expect(() => apart.page.renderAt(0)).toThrow(/^Film: display "Instrument Serif" has no glyphs for: \u270C$/);
    expect(() => whole.page.renderAt(0)).not.toThrow();
  });

  it('still counts a string\'s emoji in its length, for the warning that a line is long', async () => {
    const warned: string[] = [];
    const { page } = glyphPage(notoCovers);
    page.console = { ...console, warn: (message: string) => { warned.push(String(message)); }, error() {} };
    page.Film.run({ duration: 2, type: { lang: 'zh', roles: { display: 'Noto Sans SC' }, check: { strings: { display: ['A'.repeat(20) + '🚀'.repeat(20)] } } }, scenes: scene });
    await settle();
    expect(() => page.renderAt(0)).not.toThrow();
    expect(warned.some(message => /is 60 characters on one line \(max 42\)/.test(message))).toBe(true);
  });

  it('cannot see a missing Chinese glyph without its probes, and still checks: the generic families measure instead', async () => {
    // A page with no atob cannot make the probes: Chrome draws 雨 an em wide after every generic family, so the old check
    // passes a Latin family; a Cyrillic letter it still tells.
    const { page, made } = glyphPage(notoCovers, { bytes: false });
    page.Film.run({ duration: 2, type: { lang: 'zh', roles: { display: 'Instrument Serif' }, check: { strings: { display: ['雨ж'] } } }, scenes: scene });
    await settle();
    expect(made.filter(face => face.family.startsWith('AwwO glyph probe'))).toEqual([]);
    expect(() => page.renderAt(0)).toThrow(/^Film: display "Instrument Serif" has no glyphs for: ж$/);
  });

  it('makes no glyph probe for a film with no characters to check', async () => {
    const { page, made } = glyphPage(notoCovers);
    page.Film.run({ duration: 2, type: { lang: 'zh', roles: { display: 'Noto Sans SC', text: 'Inter' } }, scenes: scene });
    await settle();
    expect(page.__ready).toBe(true);
    expect(made.map(face => face.family)).toEqual(['Noto Sans SC', 'Inter', 'Inter']);
    expect(() => page.renderAt(0)).not.toThrow();
  });

  it('loads Noto Sans SC as its one bold cut of the simplified Chinese subset, for any role that names it', async () => {
    const faces: [string, string, Record<string, string>][] = [];
    class FontFace { constructor(family: string, source: string, descriptors: Record<string, string>) { faces.push([family, source, descriptors]); } load() { return Promise.resolve(this); } }
    const page = kitInSandbox({ window: { FontFace } });
    page.Film.run({ duration: 2, type: { lang: 'zh', roles: { display: 'Noto Sans SC', text: { family: 'Noto Sans SC' } } }, scenes: scene });
    await settle();
    const url = 'url(https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.3.0/files/noto-sans-sc-chinese-simplified-700-normal.woff2)';
    expect(faces).toEqual([['Noto Sans SC', url, { style: 'normal', weight: '700' }], ['Noto Sans SC', url, { style: 'normal', weight: '700' }]]);
    expect(page.Film.font('display', 40)).toBe('700 normal 40px "Noto Sans SC", ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif');
  });

  it('carries the glyph probes the build script makes: TrueType fonts whose one blank glyph every character maps to', () => {
    const embedded = /const GLYPH_PROBES = (\[[^\]]*\]);/.exec(kitText)?.[1];
    expect(JSON.parse(embedded ?? 'null')).toEqual(GLYPH_PROBE_ADVANCES.map(advance => probeFont(advance).toString('base64')));
    expect(GLYPH_PROBE_ADVANCES).toEqual([100, 700]);
    for (const advance of GLYPH_PROBE_ADVANCES) {
      const font = probeFont(advance);
      const sum = (bytes: Buffer) => { let s = 0; for (let i = 0; i < bytes.length; i += 4) s = (s + bytes.readUInt32BE(i)) >>> 0; return s; };
      expect(font.readUInt32BE(0)).toBe(0x00010000);
      expect(font.length % 4).toBe(0);
      const tables = new Map<string, Buffer>();
      for (let i = 0; i < font.readUInt16BE(4); i++) {
        const at = 12 + 16 * i, tag = font.toString('latin1', at, at + 4), offset = font.readUInt32BE(at + 8), length = font.readUInt32BE(at + 12);
        const table = font.subarray(offset, offset + length);
        const padded = Buffer.concat([table, Buffer.alloc((4 - (length % 4)) % 4)]);
        if (tag === 'head') padded.writeUInt32BE(0, 8);
        expect(sum(padded), tag).toBe(font.readUInt32BE(at + 4));
        tables.set(tag, table);
      }
      expect([...tables.keys()]).toEqual(['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']);
      // The whole font sums to the magic number with its adjustment in.
      expect(sum(font)).toBe(0xB1B0AFBA);
      const head = tables.get('head')!, hhea = tables.get('hhea')!, hmtx = tables.get('hmtx')!, maxp = tables.get('maxp')!, cmap = tables.get('cmap')!;
      expect([head.readUInt32BE(12), head.readUInt16BE(18), head.readInt16BE(50)]).toEqual([0x5F0F3CF5, 1000, 0]);
      expect([maxp.readUInt16BE(4), hhea.readUInt16BE(34), hmtx.readUInt16BE(0)]).toEqual([2, 1, advance]);
      // One Windows full-Unicode subtable, format 13: every code point but the surrogates to glyph 1.
      expect([cmap.readUInt16BE(2), cmap.readUInt16BE(4), cmap.readUInt16BE(6), cmap.readUInt32BE(8), cmap.readUInt16BE(12)]).toEqual([1, 3, 10, 12, 13]);
      const groups = Array.from({ length: cmap.readUInt32BE(24) }, (_, i) => [cmap.readUInt32BE(28 + 12 * i), cmap.readUInt32BE(32 + 12 * i), cmap.readUInt32BE(36 + 12 * i)]);
      expect(groups).toEqual([[0, 0xD7FF, 1], [0xE000, 0x10FFFF, 1]]);
      // Both glyphs are empty: no outline to draw.
      expect([...tables.get('loca')!]).toEqual([0, 0, 0, 0, 0, 0]);
    }
  });

  it('says what is wrong with a film before what its type lacks, in one error with the frame\'s own', async () => {
    const { page } = fontPage(fail);
    page.Film.run({ duration: 2, type: { roles: { display: 'Orbitron' } }, scenes: [] });
    await settle();
    expect(() => page.renderAt(0)).toThrow(/^Film: scenes: give at least one .*; fonts not loaded: display "Orbitron" \(the frame could not be drawn: /);
    expect(() => page.renderAt(1 / 24)).not.toThrow(/^Film:/);
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
