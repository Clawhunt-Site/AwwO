// Builds AwwO's film kit: the frame engine of cinecode's one-file film (third_party/cinecode/templates/quick/film.html,
// MIT) as ONE classic browser script that defines window.Film. A film node's page loads it by its fixed URL and then
// describes its film with Film.run({...}); AwwO's running previews inline this exact file (src/canvas/previewLibraries.ts),
// the render worker answers the same URL with its own pinned copy (apps/render-worker/kits), and the hosted site serves
// the same bytes there for downloaded pages (vite.saas.config.mjs).
//
// The engine is cinecode's own text. AwwO's changes are the named edits below, each of which must match exactly once,
// so an upstream change that moves or rewords a line stops the build instead of producing a kit that silently differs;
// the film's description, the renderer's contract and the preview player are AwwO's code (RUNTIME).
//
// The output is deterministic. tests/saas-film-kit.test.ts rebuilds it in memory and compares it byte for byte with the
// committed copy, so editing the bundle by hand or forgetting to rebuild after a vendored update fails the suite.
//
//   node apps/web/scripts/build-film-kit.mjs           write src/canvas/filmKit/film-kit.js
//   node apps/web/scripts/build-film-kit.mjs --check   exit 1 when the committed bundle is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const KIT_DIR = join(here, '..', '..', '..', 'third_party', 'cinecode');
export const KIT_OUTPUT = join(here, '..', 'src', 'canvas', 'filmKit', 'film-kit.js');
export const KIT_VERSION = '1';
export const KIT_COMMIT = '67f9807112b97ae253d4a5f0eccaccc46c3b2633';

const FILM_BANNER = '// ============================== FILM ==============================';
const PICTURE_BANNER = '// ============================== HELPERS (picture) ==============================';

/** The one line of `lines` that starts with `prefix`, after index `from`; throws unless there is exactly one. */
function lineIndex(lines, prefix, from = 0, what = prefix) {
  const hits = [];
  for (let i = from; i < lines.length; i++) if (lines[i].startsWith(prefix)) hits.push(i);
  if (hits.length !== 1) throw new Error(`film kit: expected one line starting ${JSON.stringify(what)}, found ${hits.length}`);
  return hits[0];
}

/** `text` with `find` replaced by `replace`; throws unless `find` occurs exactly once. */
function replaceOnce(text, find, replace, why) {
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + 1) >= 0) throw new Error(`film kit: the edit "${why}" did not match exactly once`);
  return text.slice(0, at) + replace + text.slice(at + find.length);
}

// Blocks taken out whole, as [the first line's start, the line after the block's start): parts that need cinecode's own
// tools, local files or the URL a capture gives, none of which an AwwO page has.
const CUTS = [
  { why: 'the model sheet (a ?modelsheet= URL check)', from: '// The model sheet: every view', to: '// ---- Formulas:' },
  { why: 'formulas (MathJax loaded at run time)', from: '// ---- Formulas:', to: 'async function loadType(T) {' },
  { why: 'captions timed from a speech transcript', from: '// ---- talking-head captions', to: '// ---- type check ----' },
  { why: 'recorded instruments read from local files', from: '// Recorded instruments. sample(ctx', to: 'function loadAudio(ctx, url) {' },
  { why: 'local audio, the capture contract, the text check and the preview loop (AwwO keeps its own in RUNTIME)', from: 'function loadAudio(ctx, url) {', to: null },
];

// Lines changed in place: what AwwO's renderer gives a page instead of URL parameters, and what Film.run sets at boot.
const EDITS = [
  {
    why: 'the canvas, its size and the seed come from Film.run, not the URL',
    find: "const q = new URLSearchParams(location.search);\n"
      + "const W = +q.get('w') || 1080, H = +q.get('h') || 1920, SEED = +q.get('seed') || 7;\n"
      + 'const FRAMES = Math.round(FPS * DURATION), TAU = Math.PI * 2, SR = 48000;\n'
      + "const canvas = document.getElementById('c');\n"
      + 'canvas.width = W; canvas.height = H;\n'
      + "const g = canvas.getContext('2d', { alpha: false });\n"
      + 'const S = { W, H, u: Math.min(W, H) };       // u = the short side; sizes below are fractions of it\n',
    replace: '// AwwO: the canvas, its size and the seed are set when the page calls Film.run (boot(), at the end of the kit).\n'
      + 'let W = 0, H = 0, SEED = 7, FRAMES = 0, canvas = null, g = null;\n'
      + 'const S = { W: 0, H: 0, u: 1 };              // u = the short side; sizes below are fractions of it\n'
      + 'const TAU = Math.PI * 2, SR = 48000;\n',
  },
  {
    why: 'casing follows the film\'s language (cinecode defaults to Turkish, which turns English i into İ)',
    find: "const up = (s, lang = 'tr') => String(s).toLocaleUpperCase(lang);\nconst low = (s, lang = 'tr') => String(s).toLocaleLowerCase(lang);\n",
    replace: "const up = (s, lang = TYPE.lang || 'en') => String(s).toLocaleUpperCase(lang);\nconst low = (s, lang = TYPE.lang || 'en') => String(s).toLocaleLowerCase(lang);\n",
  },
  {
    why: 'a character keeps a one-pixel outline inside a camera plane too (cinecode sized it in screen pixels only)',
    find: 'ow = Math.max(1, h * 0.008)',
    replace: 'ow = Math.max(1 / (Math.hypot(g.getTransform().a, g.getTransform().b) || 1), h * 0.008)',
  },
  {
    why: 'the frame buffers are made at boot, at the film\'s size',
    find: 'const bufA = buffer(), bufB = buffer(), bufSub = buffer(), bufOut = buffer();\n',
    replace: 'let bufA, bufB, bufSub, bufOut;              // AwwO: made at boot, at the film\'s size\n',
  },
  {
    why: 'finishing comes from the film\'s FINISH only (no URL overrides)',
    find: "const SAMPLES = Math.max(1, Math.round(+(q.get('shutter') ?? FINISH.shutter?.samples ?? 1)) || 1);\n"
      + "const WEAVE = +(q.get('weave') ?? FINISH.weave) || 0, TONE = q.get('tone') === '0' ? null : FINISH.tone;\n",
    replace: 'let SAMPLES = 1, WEAVE = 0, TONE = null;     // AwwO: from FINISH at boot\n',
  },
  {
    why: 'the motion-blur probe is sized at boot',
    find: "const STILL = 0.6, probe = document.createElement('canvas');\n"
      + 'probe.width = 64; probe.height = Math.max(1, Math.round(64 * H / W));\n'
      + "const probeG = probe.getContext('2d', { willReadFrequently: true });\n",
    replace: "const STILL = 0.6, probe = document.createElement('canvas');\n"
      + 'let probeG = null;                           // AwwO: sized at boot\n',
  },
  {
    why: 'the print-tone filter is installed at boot',
    find: 'if (TONE) {\n',
    replace: 'function installTone() {                     // AwwO: called at boot\n  if (!TONE) return;\n',
  },
  {
    why: 'a frame is drawn for the renderer\'s t (any frame rate), not only for a frame index at 24',
    find: 'window.renderFrame = (frame) => {\n'
      + '  if (MODEL_SHEET) { modelSheet(g, S, MODEL_SHEET); return; }\n'
      + '  const t = frame / FPS;                       // time comes only from the frame index\n',
    replace: 'function renderFrame(frame, at) {             // AwwO: the renderer\'s t when it gives one\n'
      + '  const t = at ?? frame / FPS;                 // time comes only from the frame index (or the renderer\'s t)\n',
  },
  {
    why: 'no speech captions',
    find: '  const punch = CAPTIONS ? captionPunch(CAPTIONS, t, CAPTION_STYLE.punch) : 1;\n',
    replace: '  const punch = 1;\n',
  },
  {
    why: 'no speech captions',
    find: '  if (CAPTIONS) kineticCaptions(g, TYPE, CAPTIONS, t, W, H, CAPTION_STYLE);   // after the grade: exact type colours\n',
    replace: '',
  },
  {
    why: 'no capture contract (AwwO\'s is in RUNTIME)',
    find: '\n};\nwindow.captureFrame = (frame, type = \'image/png\', quality = 0.95) => { window.renderFrame(frame); return canvas.toDataURL(type, quality); };\n',
    replace: '\n}\n',
  },
];

// What must not survive the edits: names of the parts cut out, the URL parameters and the capture globals.
const GONE = /\b(?:CAPTIONS|CAPTION_STYLE|FORMULAS|FORMULA|OWN_MUSIC|INSTRUMENTS|MODEL_SHEET|modelSheet|loadFormulas|kineticCaptions|captionPunch|loadSamples|BANK|loadAudio|captureFrame|LOOK_ID)\b|\bq\.get\(|window\.(?:renderFrame|READY|renderAudio)\b/;

// AwwO's part: the film a page describes (Film.run), the renderer's contract and the preview player. AwwO's own code.
const RUNTIME = String.raw`
// ============================== AwwO: the film, the renderer's contract, the preview ==============================
// The film a page describes with Film.run({...}). The engine above reads these by name, as it read cinecode's FILM
// section; nothing else sets them.
let TITLE = 'Untitled', PURPOSE = 'cinematic', LOOK = LOOKS['cinematic-realistic'], FINISH = { shutter: null, weave: 0, tone: null };
let FPS = 24, DURATION = 8, BPM = 96, BEAT0 = 0, PALETTE = { ...LOOK.palette }, CUES = {}, VO = [], SCENES = [], SFX = [];
let TYPE = { lang: 'en', roles: { display: null, text: null, mono: null } }, ROOM = { secs: 2.2, decay: 3.2, tone: 5000 };
let ARRANGEMENT = [], CAST = {}, score = () => {};
const beat = (n) => BEAT0 + n * 60 / BPM, bar = (n) => beat(4 * n);

// AwwO's brand fonts, the families its running previews supply by name (apps/web/src/canvas/previewFontList.ts), as
// the Fontsource 5.3.0 packages the renderer loads from jsDelivr (Latin). A TYPE role may name one by family alone.
const BRAND_FONTS = {
  'Inter': { pkg: 'inter', variable: 'wght', axes: { wght: [100, 900] }, styles: ['normal', 'italic'] },
  'Space Grotesk': { pkg: 'space-grotesk', variable: 'wght', axes: { wght: [300, 700] } },
  'Manrope': { pkg: 'manrope', variable: 'wght', axes: { wght: [200, 800] } },
  'Outfit': { pkg: 'outfit', variable: 'wght', axes: { wght: [100, 900] } },
  'Montserrat': { pkg: 'montserrat', variable: 'wght', axes: { wght: [100, 900] }, styles: ['normal', 'italic'] },
  'Unbounded': { pkg: 'unbounded', variable: 'wght', axes: { wght: [200, 900] } },
  'Orbitron': { pkg: 'orbitron', variable: 'wght', axes: { wght: [400, 900] } },
  'Exo 2': { pkg: 'exo-2', variable: 'wght', axes: { wght: [100, 900] }, styles: ['normal', 'italic'] },
  'Oxanium': { pkg: 'oxanium', variable: 'wght', axes: { wght: [200, 800] } },
  'Rajdhani': { pkg: 'rajdhani', weights: [400, 500, 600, 700] },
  'Bebas Neue': { pkg: 'bebas-neue', weights: [400] },
  'Playfair Display': { pkg: 'playfair-display', variable: 'wght', axes: { wght: [400, 900] }, styles: ['normal', 'italic'] },
  'Instrument Serif': { pkg: 'instrument-serif', weights: [400], styles: ['normal', 'italic'] },
  'Cinzel': { pkg: 'cinzel', variable: 'wght', axes: { wght: [400, 900] } },
  'JetBrains Mono': { pkg: 'jetbrains-mono', variable: 'wght', axes: { wght: [100, 800] }, styles: ['normal', 'italic'] },
  'Press Start 2P': { pkg: 'press-start-2p', weights: [400] },
  'Pixelify Sans': { pkg: 'pixelify-sans', variable: 'wght', axes: { wght: [400, 700] } },
};

/** A TYPE role as the engine reads it: a brand family by name, a full Fontsource role, or any other family as written
 *  (a system font, never fetched). */
function filmRole(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const brand = BRAND_FONTS[value];
    return brand ? { family: value, version: '5.3.0', subsets: ['latin'], ...brand } : { family: value };
  }
  if (typeof value === 'object' && value.family) {
    const brand = !value.pkg && !value.files ? BRAND_FONTS[value.family] : null;
    return brand ? { version: '5.3.0', subsets: ['latin'], ...brand, ...value } : { ...value };
  }
  return null;
}

/** Loads every role's faces. A face that cannot load (a preview reaches no network) is fine when the page already has
 *  the family: AwwO's previews supply its brand fonts by name. Returns the roles that have neither. */
async function loadFilmType(T) {
  const missing = [];
  // Whether the document already has the family's faces: a running preview supplies the brand fonts it sees a page
  // name, and has no network, so a role it supplies is never fetched (the renderer, which supplies none, fetches all).
  const supplied = async (r) => {
    try { return (await document.fonts.load((r.weights?.[0] ?? 400) + ' 40px "' + r.family + '"')).length > 0; } catch (e) { return false; }
  };
  const remote = remoteFontsAllowed();
  for (const [name, r] of Object.entries(T.roles || {})) {
    if (!r || (!r.pkg && !r.files)) continue;
    if (remote) {
      const loads = roleFaces(r).map(([family, url, desc]) => {
        const face = new FontFace(family, 'url(' + url + ')', desc);
        return face.load().then(() => { document.fonts.add(face); return true; }, () => false);
      });
      if ((await Promise.all(loads)).every(Boolean)) continue;
    }
    if (!(await supplied(r))) missing.push(name);
  }
  return missing;
}

/** Whether the document's own policy lets it fetch the brand fonts: AwwO's preview allows no font but data (it
 *  supplies the brand fonts it sees a page name), so there the kit fetches none and uses the faces it has; a render's
 *  page states no such policy and loads every role's own faces, as cinecode does. */
function remoteFontsAllowed() {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
  const policy = (meta && meta.getAttribute('content')) || '';
  if (!policy) return true;
  const directive = (name) => { const m = new RegExp('(?:^|;)\\s*' + name + '\\s+([^;]*)', 'i').exec(policy); return m ? m[1] : null; };
  const sources = directive('font-src') ?? directive('default-src');
  return sources === null || /(?:^|\s)(?:\*|https?:\S*)(?:\s|$)/i.test(sources);
}

/** What is wrong with the film as described, in words a page's author can act on. */
function filmErrors() {
  const errs = [], near = (a, b) => Math.abs(a - b) < 1e-3;
  if (!(DURATION > 0 && DURATION <= 300)) errs.push('duration must be between 0 and 300 seconds, not ' + DURATION);
  if (!Array.isArray(SCENES) || !SCENES.length) errs.push('scenes: give at least one { from, to, draw }');
  else {
    for (let i = 0; i < SCENES.length; i++) {
      const s = SCENES[i], n = i + 1;
      if (!s || typeof s.draw !== 'function') errs.push('scene ' + n + ': draw is not a function');
      if (!(s && s.to > s.from)) errs.push('scene ' + n + ': to must be after from');
      if (i === 0 && s && !near(s.from, 0)) errs.push('scene 1 must start at 0');
      const before = SCENES[i - 1];
      if (i > 0 && s && before && !near(before.to, s.from)) errs.push('scenes ' + i + ' and ' + n + (before.to > s.from ? ' overlap' : ' leave a gap'));
      const type = s && s.in && s.in.type;
      if (type && !['cut', 'smash', 'match'].includes(type) && !TRANSITION[type]) errs.push('scene ' + n + ': unknown transition ' + type);
      if (type && TRANSITION[type] && !(s.in.dur > 0)) errs.push('scene ' + n + ': a ' + type + ' needs in.dur in seconds');
    }
    const last = SCENES[SCENES.length - 1];
    if (last && !near(last.to, DURATION)) errs.push('the last scene must end at the duration (' + DURATION + ' s)');
  }
  for (const e of SFX) if (!['hit', 'whoosh', 'riser', 'tick', 'air', 'foley'].includes(e && e.voice)) errs.push('sfx: unknown voice ' + (e && e.voice));
  if (ARRANGEMENT.length) { try { checkArrangement(); } catch (e) { errs.push(String(e.message || e)); } }
  return errs;
}

let READY = null, booted = false, started = false, rendering = false, hud = null, failure = '', said = false, thrown = false, aspect = '', hintLang = 'en';
// Not ready until a film has booted and its type has loaded: the renderer waits for __ready, so a page that calls
// Film.run after an await still renders from its first frame.
window.__ready = false;
// A film longer than one render is cut into cards, each a copy of the page with <html data-offset="seconds">: a card
// draws film time OFFSET + t. Its sound is made once, for the whole film, from 0 (one page sound in the edit).
let OFFSET = 0, POSTER = 0;

/** A defect in the film as described, said once to a running preview (which reports it, and AwwO repairs the page). A
 *  render gets it as an error from its first frame instead (renderAt), which the renderer records. */
function report(message) {
  if (said) return;
  said = true;
  console.error(new Error('Film: ' + message));
}

function boot() {
  if (started) return;
  started = true;
  const vw = Math.max(64, Math.round(window.innerWidth || 1280)), vh = Math.max(64, Math.round(window.innerHeight || 720));
  let w = vw, h = vh;
  const m = /^(\d+(?:\.\d+)?)\s*[:x\/]\s*(\d+(?:\.\d+)?)$/.exec(String(aspect || ''));
  if (m && +m[1] > 0 && +m[2] > 0) { const r = +m[1] / +m[2]; if (vw / vh > r) w = Math.round(vh * r); else h = Math.round(vw / r); }
  W = w; H = h; S.W = W; S.H = H; S.u = Math.min(W, H);
  FRAMES = Math.max(1, Math.round(FPS * DURATION));
  OFFSET = Math.max(0, Number(document.documentElement.getAttribute('data-offset')) || 0);
  const style = document.createElement('style');
  style.textContent = 'html,body{margin:0;height:100%;background:#000;overflow:hidden}'
    + 'canvas.awwo-film{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:block}'
    // The hint sits on the picture (a preview frames a film at its own shape), so it has its own dark backing: light
    // grey on the film alone could not be read over a light look's floor.
    + '.awwo-film-hud{position:fixed;left:8px;bottom:8px;padding:2px 8px;border-radius:4px;background:rgba(0,0,0,.62);color:#eee;font:12px/1.4 ui-monospace,Menlo,monospace;pointer-events:none}';
  document.head.appendChild(style);
  canvas = document.createElement('canvas');
  canvas.className = 'awwo-film'; canvas.width = W; canvas.height = H;
  document.body.appendChild(canvas);
  // The film keeps the size it was made at (what a page built once at that size stays right for); a window that
  // changes later (a preview made larger or smaller, a downloaded page) shows it whole, scaled to fit.
  const fit = () => {
    const k = Math.min((window.innerWidth || W) / W, (window.innerHeight || H) / H);
    canvas.style.width = Math.round(W * k) + 'px'; canvas.style.height = Math.round(H * k) + 'px';
  };
  // A frame can learn its size only after the page has started (a preview's iframe is laid out after its document
  // parses, often with no resize event): the root element's own box says when it does.
  fit();
  addEventListener('resize', fit);
  if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(document.documentElement);
  g = canvas.getContext('2d', { alpha: false });
  bufA = buffer(); bufB = buffer(); bufSub = buffer(); bufOut = buffer();
  SAMPLES = Math.max(1, Math.round(+(FINISH.shutter?.samples ?? 1)) || 1);
  WEAVE = +FINISH.weave || 0; TONE = FINISH.tone || null;
  probe.width = 64; probe.height = Math.max(1, Math.round(64 * H / W));
  probeG = probe.getContext('2d', { willReadFrequently: true });
  installTone();
  let errs;
  try { errs = filmErrors(); } catch (e) { errs = [String((e && e.message) || e)]; }
  if (errs.length) failure = errs.join('; ');
  READY = (async () => {
    const notes = [];
    try {
      const missing = await loadFilmType(TYPE);
      if (missing.length) notes.push('fonts not loaded, the system font stands in for: ' + missing.join(', '));
      await document.fonts.ready;
      // Glyphs are checked only in the faces that loaded: a system family or a stand-in proves nothing about the film's.
      const loaded = { ...TYPE, roles: Object.fromEntries(Object.entries(TYPE.roles || {}).filter(([name, r]) => r && (r.pkg || r.files) && !missing.includes(name))) };
      const qc = typeCheck(g, loaded, W, H, PALETTE);
      for (const e of qc.errors) (/glyphs/.test(e) ? (failure = failure ? failure + '; ' + e : e) : notes.push(e));
      notes.push(...qc.warnings);
    } catch (e) {
      notes.push(String((e && e.message) || e));
    }
    for (const note of notes) console.warn('Film: ' + note);
    window.__ready = true;
    if (failure && !rendering) report(failure);
  })();
  startPreview();
  // A film that boots after the renderer asked for a frame draws that frame now rather than leave it black; whatever
  // stops it is said by the renderer's next frame.
  if (rendering && pending !== null) { const t = pending; pending = null; try { frameAt(t); } catch (e) { /* said next frame */ } }
}

/** The film a page describes, once: { title, purpose, look, palette, type, fps, duration, bpm, beat0, cues, scenes,
 *  sfx, room, arrangement, score, cast, vo, finish, seed, aspect }. */
function run(spec) {
  if (booted) throw new Error('Film.run: a page describes its film once');
  booted = true;
  const f = spec || {};
  TITLE = String(f.title ?? 'Untitled');
  PURPOSE = f.purpose === 'ad' ? 'ad' : 'cinematic';
  const base = LOOKS[f.look] || (f.look && typeof f.look === 'object' && LOOKS[f.look.base]) || LOOKS['cinematic-realistic'];
  LOOK = f.look && typeof f.look === 'object' ? { ...base, ...f.look, palette: { ...base.palette, ...(f.look.palette || {}) } } : base;
  FINISH = { shutter: null, weave: 0, tone: null, ...(f.finish || {}) };
  FPS = f.fps > 0 ? +f.fps : 24;
  DURATION = +f.duration > 0 ? +f.duration : 8;
  BPM = +f.bpm > 0 ? +f.bpm : 96;
  BEAT0 = +f.beat0 || 0;
  PALETTE = { ...LOOK.palette, ...(f.palette || {}) };
  const roles = (f.type && f.type.roles) || {};
  TYPE = { lang: 'en', ...(f.type || {}), roles: { display: filmRole(roles.display), text: filmRole(roles.text), mono: filmRole(roles.mono) } };
  // The play hint's language: the film's own (type.lang), else the page's (its html lang).
  hintLang = String((f.type && f.type.lang) || (document.documentElement && document.documentElement.getAttribute('lang')) || 'en');
  CUES = f.cues || {}; VO = Array.isArray(f.vo) ? f.vo : []; SCENES = Array.isArray(f.scenes) ? f.scenes : [];
  SFX = Array.isArray(f.sfx) ? f.sfx : []; ROOM = { ...ROOM, ...(f.room || {}) };
  ARRANGEMENT = Array.isArray(f.arrangement) ? f.arrangement : []; CAST = f.cast || {};
  score = typeof f.score === 'function' ? f.score : () => {};
  SEED = Number.isFinite(+f.seed) && f.seed !== null && f.seed !== undefined ? +f.seed : 7;
  aspect = f.aspect || '';
  POSTER = Number.isFinite(+f.poster) && f.poster !== null && f.poster !== undefined ? Math.min(Math.max(0, +f.poster), DURATION) : DURATION * 0.4;
  window.__ready = false;
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, { once: true });
}

// The renderer's contract (apps/render-worker/README.md): every frame is drawn for its t from scratch; the preview
// player stops for good on the first call, so it never draws over a frame the renderer is about to take.
let unrun = false, pending = null;
const frameAt = (t) => { const time = OFFSET + Math.max(0, Number(t) || 0); renderFrame(Math.floor(time * FPS + 1e-6), time); };
window.renderAt = (t) => {
  if (!rendering) { rendering = true; if (hud) hud.remove(); }
  if (!canvas) {
    // A film that starts later still (Film.run after a timer, a frame or a long await) draws this frame as it boots.
    pending = t;
    if (!booted && !unrun) {
      unrun = true;
      throw new Error('Film: Film.run had not been called when the renderer drew its first frame; call it at the end of the page script, not from a timer, an animation frame or an await');
    }
    return;
  }
  pending = null;
  // What is wrong with the film is said first, even when it is also why its frame cannot be drawn.
  let threw = false, error;
  try { frameAt(t); } catch (e) { threw = true; error = e; }
  if (failure && !thrown) {
    thrown = true;
    throw new Error('Film: ' + failure + (threw ? ' (the frame could not be drawn: ' + String((error && error.message) || error) + ')' : ''));
  }
  if (threw) throw error;
};

// The film's sound, rendered offline in one pass: ambience per scene, the picture-locked effects, the score, all in
// one room. AwwO keeps it as 16-bit, so the peak is brought to -1 dBFS at most rather than clipped.
window.renderAudio = async (o = {}) => {
  if (!booted) throw new Error('Film: the page never called Film.run');
  const rate = Math.min(48000, Math.max(8000, Math.round(Number(o && o.sampleRate) || SR)));
  const seconds = Math.max(DURATION, Number(o && o.seconds) || 0);
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.round(seconds * rate)), rate);
  const bus = ctx.createGain(); duck(bus.gain, 0.8, VO);
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 8; lim.attack.value = 0.003; lim.release.value = 0.15;
  bus.connect(lim).connect(ctx.destination);
  ROOM_IN = makeRoom(ctx, bus);
  SCENES.forEach((s, i) => { if (s && s.amb) ambience(ctx, wet(ctx, bus, 0.15), s.from, s.to, s.amb.kind, s.amb.gain, 300 + i); });
  for (const e of SFX) sfx(ctx, bus, e);
  score(ctx, bus);
  const buf = await ctx.startRendering();
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; } }
  if (peak > 0.891) { const k = 0.891 / peak; for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; } }
  // The last 60 ms fade to nothing, so a film that ends while its sound still plays ends without a click.
  const tail = Math.min(buf.length, Math.round(0.06 * rate));
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < tail; i++) d[buf.length - 1 - i] *= i / tail; }
  return buf;
};

// The line a running preview shows until the film plays: in the film's own language (its type.lang, else the page's),
// and never its title, which can be the film's closing words (a check of 2026-11-09 saw「雨停了」 under the frame from
// the first one). Chinese in traditional characters where the language says so (zh-Hant, zh-TW, zh-HK, zh-MO).
const PLAY_HINT = { zh: '点击播放（有声音）', 'zh-Hant': '點擊播放（有聲音）', en: 'click to play with sound' };
const playHint = () => {
  const lang = hintLang.trim().toLowerCase();
  if (!/^zh(?:[-_]|$)/.test(lang)) return PLAY_HINT.en;
  return /^zh[-_](?:hant|tw|hk|mo)(?:[-_]|$)/.test(lang) ? PLAY_HINT['zh-Hant'] : PLAY_HINT.zh;
};

// A running preview shows one still of the film (its poster) and plays it, picture and sound together, on a click;
// nothing plays by itself. Space plays or pauses, the arrows step a frame. Nothing here runs once the renderer has
// called renderAt, and it draws only while the film plays or after a step. Its hint is hidden while the film plays.
function startPreview() {
  if (rendering) return;   // a film that boots after the renderer's first frame is the renderer's alone
  hud = document.createElement('div');
  hud.className = 'awwo-film-hud';
  hud.textContent = playHint();
  document.body.appendChild(hud);
  const hint = (on) => { if (hud) hud.hidden = !on; };
  // The number in run names the current play: a pause, the end or a later play leaves an older one's wait for its sound moot, so
  // only one sound and one frame loop ever run. The sound is made once, however often a click comes while it is made.
  let audio = null, source = null, making = null, playing = false, live = false, run = 0;
  let from = 0, t0 = 0, clock = 0, held = POSTER;
  const show = (t) => { if (!rendering) renderFrame(Math.floor(t * FPS + 1e-6), t); };
  // A still drawn while the film is stopped (a pause, a step, the end, the type loading): a scene that throws there
  // leaves the next play to start from the beginning, and the error goes on to be reported.
  const still = (t) => { try { show(t); } catch (e) { held = POSTER; throw e; } };
  // Until its picture starts (its sound may still be in the making) a play stands where it will start.
  const now = () => (!live ? from : source ? audio.currentTime - t0 + from : (performance.now() - clock) / 1000 + from);
  // Whatever stops a play (a pause, the end, a scene that throws) shows the hint again, before anything is drawn.
  const stop = () => {
    run += 1; playing = false; live = false;
    if (source) { source.onended = null; try { source.stop(); } catch (e) { /* already ended */ } source = null; }
    hint(true);
  };
  const tick = (id) => {
    if (id !== run || rendering) return;
    const t = now();
    if (t >= DURATION) { stop(); held = POSTER; still(held); return; }
    // A scene that throws ends the play (a later click starts again from the beginning) and the error is reported.
    try { show(t); } catch (e) { stop(); held = POSTER; throw e; }
    requestAnimationFrame(() => tick(id));
  };
  const play = async () => {
    if (rendering || playing) return;
    playing = true;
    hint(false);
    const id = ++run;
    from = held >= DURATION - 1 / FPS || held === POSTER ? 0 : held;
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume().catch(() => {});
      making = making || window.renderAudio({ seconds: DURATION, sampleRate: audio.sampleRate });
      const sound = await making;
      if (id !== run || rendering) return;
      source = audio.createBufferSource(); source.buffer = sound; source.connect(audio.destination);
      t0 = audio.currentTime; source.start(0, from);
    } catch (e) {
      if (id !== run || rendering) return;
      source = null;   // no sound here: the picture plays on its own
      console.warn('Film: the sound cannot play here (' + ((e && e.message) || e) + ')');
    }
    clock = performance.now(); live = true;
    requestAnimationFrame(() => tick(id));
  };
  const pause = () => { held = Math.min(DURATION - 1e-3, now()); stop(); still(held); };
  addEventListener('click', () => { if (playing) pause(); else play(); });
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); if (playing) pause(); else play(); }
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      if (playing) pause();
      held = Math.min(DURATION - 1e-3, Math.max(0, held + (e.code === 'ArrowRight' ? 1 : -1) / FPS));
      still(held);
    }
  });
  // The still, once the film's type has loaded; a film already playing by then draws its own frames.
  READY.then(() => { if (!failure && !playing) still(held); });
}

// The film's own type by role, for a page that sets type itself: font() is a ctx.font string, setFont() sets it with the
// tracking for its size (cinecode's typeFont and setType, bound to the film's TYPE).
const font = (role, px, o = {}) => typeFont(TYPE, role, px, o);
const setFont = (g, role, px, o = {}) => setType(g, TYPE, role, px, o);

const API = {
  run, version: KIT_VERSION_TOKEN, commit: KIT_COMMIT_TOKEN, LOOKS, BRAND_FONTS: Object.freeze(Object.keys(BRAND_FONTS)),
  EASE, MOTION, CAM, VIEW, retime, plane, TRANSITION, poly, morphShape, fillShape, lightSweep, dot, circle, text, label, lazy,
  flash, grain, shade, inkLine, vignette, rng, hash1, noise1, clamp, lerp, TAU, character, EMOTIONS, font, setFont, wrap,
  headroom, typeReveal, breathe, up, low, pad, kick, tick, hit, riser, whoosh, air, pluck, lead, foley, ambience, wet, spans,
  beats, hz, chord, chordAt, grid, snare, hat, clap, sub808, bass, stab,
};
window.Film = Object.freeze(API);
`;

export function buildFilmKit(kitDir = KIT_DIR) {
  const html = readFileSync(join(kitDir, 'templates', 'quick', 'film.html'), 'utf8');
  if (html.includes('\r')) throw new Error('film kit: film.html must have LF line endings, as upstream');
  const open = html.indexOf('\n<script>\n'), close = html.lastIndexOf('\n</script>\n');
  if (open < 0 || close < 0 || html.indexOf('<script') !== html.lastIndexOf('<script')) throw new Error('film kit: film.html must hold one inline script');
  const lines = html.slice(open + '\n<script>\n'.length, close + 1).split('\n');
  const film = lineIndex(lines, FILM_BANNER), picture = lineIndex(lines, PICTURE_BANNER);
  // The eight look families are the FILM section's starting data; the kit offers them by id.
  const looksStart = lineIndex(lines, 'const LOOKS = {', film);
  if (looksStart > picture) throw new Error('film kit: LOOKS must be in the FILM section');
  let looksEnd = looksStart;
  while (looksEnd < picture && lines[looksEnd] !== '};') looksEnd++;
  if (looksEnd === picture) throw new Error('film kit: LOOKS has no end');
  const looks = lines.slice(looksStart, looksEnd + 1).join('\n');
  let engine = lines.slice(picture);
  for (const cut of CUTS) {
    const from = lineIndex(engine, cut.from, 0, cut.why);
    const to = cut.to === null ? engine.length : lineIndex(engine, cut.to, from + 1, cut.why);
    engine = [...engine.slice(0, from), ...engine.slice(to)];
  }
  let text = engine.join('\n').trimEnd() + '\n';
  for (const edit of EDITS) text = replaceOnce(text, edit.find, edit.replace, edit.why);
  const leftover = text.match(GONE);
  if (leftover) throw new Error(`film kit: "${leftover[0]}" survived the edits`);
  const runtime = RUNTIME.replace('KIT_VERSION_TOKEN', JSON.stringify(KIT_VERSION)).replace('KIT_COMMIT_TOKEN', JSON.stringify(KIT_COMMIT));
  const license = readFileSync(join(kitDir, 'LICENSE'), 'utf8').trimEnd().split('\n').map((line) => (line ? ` * ${line}` : ' *')).join('\n');
  const body = `${looks}\n\n${text}${runtime}`
    // Inlined into an HTML <script>: nothing in it may close the element or open a comment there. In JavaScript source
    // `<\/` and `<\!` read the same as `</` and `<!` inside strings, templates and regular expressions alike.
    .replace(/<\/script/gi, (match) => `<\\/${match.slice(2)}`).replace(/<!--/g, '<\\!--');
  return `/*! AwwO film kit ${KIT_VERSION}: the frame engine of cinecode's one-file film (https://github.com/sarpstar/cinecode, commit ${KIT_COMMIT},
 * templates/quick/film.html) as one classic script that defines window.Film: looks, a 2.5D camera, depth planes,
 * transitions, type, stylised characters and a whole soundtrack rendered offline with Web Audio. AwwO's changes: a page
 * describes its film with Film.run({...}) instead of editing a FILM section; the frame comes from AwwO's renderer
 * (renderAt, __ready, renderAudio) and the picture takes the page's size; casing follows the film's language; and the
 * parts that need cinecode's own tools are left out (local files, recorded instruments, formulas, speech captions).
 * Generated by apps/web/scripts/build-film-kit.mjs from third_party/cinecode; do not edit by hand.
 *
${license}
 */
(function () {
"use strict";
// One kit a page: a second copy of the tag (after the page's Film.run) must not replace the renderer's entry points
// with ones that never booted.
try { if (window.Film && typeof window.Film.run === 'function') return; } catch (e) { /* another origin's frame named Film */ }
${body.trimEnd()}
})();
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = buildFilmKit();
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(KIT_OUTPUT, 'utf8'); } catch { /* missing counts as stale */ }
    if (current !== built) { console.error('film kit is stale: run node apps/web/scripts/build-film-kit.mjs'); process.exit(1); }
    console.log('film kit is up to date');
  } else {
    writeFileSync(KIT_OUTPUT, built);
    console.log(`wrote ${KIT_OUTPUT} (${Buffer.byteLength(built)} bytes)`);
  }
}
