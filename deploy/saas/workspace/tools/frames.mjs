// awwo-check-page --frames: the page at several moments, as pictures and numbers. One screenshot 1.5 s after the load says
// whether a page drew anything; it does not say whether a 3D piece moves, what it looks like later, or what a frame of it
// costs (2026-10-18: PALLWARD's testers read 61 test results and never saw its flat grass or its glowing headstones).
// For each time asked, the page is brought there (window.renderAt(t) where it defines it, as AwwO's renderer drives it;
// otherwise t seconds after its load, on the real clock), its WebGL draw calls and primitives for that frame are counted
// by a probe installed before the page's code, and a screenshot is taken. The frames are then measured (colours, light,
// clipping, what changed between neighbours) and laid out on one contact sheet an agent can look at (workspace_view).
// Protocol and report: deploy/saas/workspace/README.md, "Frames".
import { setTimeout as delay } from 'node:timers/promises';

export const MAX_FRAMES = 8;
/** The longest time a frame may be asked at (seconds), and the bounds of a frame's own steps (ms). */
export const MAX_FRAME_SECONDS = 600;
export const FRAME_MS = { ready: 10_000, render: 10_000, screenshot: 20_000, measure: 10_000, settle: 30_000 };
/** The contact sheet: at most 4 frames across and 1,600 px wide (what workspace_view shows whole), at most this many bytes. */
export const SHEET = { columns: 4, width: 1600, cell: 640, label: 24, bytes: 400_000 };
/** Frames are still when no pair of neighbours differs in more than this share of the sampled pixels. */
export const STILL_SHARE = 0.002;

/** --frames takes up to 8 times in seconds, such as 0,2,5.5: each from 0 to 600, at most three decimals, none twice. They
 *  are taken in rising order. An Error says what is wrong. */
export function parseFrames(text) {
  const parts = String(text ?? '').split(',');
  if (!parts.length || parts.length > MAX_FRAMES) return new Error(`--frames takes 1 to ${MAX_FRAMES} times in seconds, separated by commas`);
  const times = [];
  for (const part of parts) {
    if (!/^\d{1,3}(?:\.\d{1,3})?$/.test(part) || Number(part) > MAX_FRAME_SECONDS) return new Error(`--frames takes times in seconds from 0 to ${MAX_FRAME_SECONDS}, such as 0,2,5.5`);
    if (times.includes(Number(part))) return new Error(`--frames names ${part} twice`);
    times.push(Number(part));
  }
  return times.sort((a, b) => a - b);
}

/** How many primitives a draw of `count` vertices in `mode` makes, `instances` times: [triangles, lines, points]. */
export function primitives(mode, count, instances = 1) {
  const n = Math.max(0, Math.trunc(Number(count)) || 0), copies = Math.max(0, Math.trunc(Number(instances)) || 0);
  switch (mode) {
    case 4: return [Math.floor(n / 3) * copies, 0, 0];             // TRIANGLES
    case 5: case 6: return [Math.max(0, n - 2) * copies, 0, 0];    // TRIANGLE_STRIP, TRIANGLE_FAN
    case 1: return [0, Math.floor(n / 2) * copies, 0];             // LINES
    case 3: return [0, Math.max(0, n - 1) * copies, 0];            // LINE_STRIP
    case 2: return [0, n * copies, 0];                             // LINE_LOOP
    case 0: return [0, 0, n * copies];                             // POINTS
    default: return [0, 0, 0];
  }
}

// Installed before the page's code. Every WebGL or WebGL 2 context a canvas hands out gets its draw functions wrapped on
// the context object itself (the prototypes stay as they are), so a frame's draw calls and primitives can be counted
// whatever library drew it; what a page keeps alive (programs, textures, framebuffers) is counted too, since a number
// that grows from frame to frame is a leak. The page sees no difference but window.__awwoGl, which it must not use.
export const GL_PROBE_SCRIPT = `(() => {
  const primitives = ${primitives.toString()};
  const frame = { drawCalls: 0, triangles: 0, lines: 0, points: 0 };
  const state = { contexts: [], lost: 0, programs: 0, textures: 0, framebuffers: 0 }, drawn = [];
  const count =(mode, vertices, instances) => {
    const [triangles, lines, points] = primitives(mode, vertices, instances);
    frame.drawCalls += 1; frame.triangles += triangles; frame.lines += lines; frame.points += points;
  };
  const sum = (list, offset, n) => { let total = 0; for (let i = 0; i < n; i += 1) total += Number(list[offset + i]) || 0; return total; };
  const wrap = (target, name, counted) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function (...args) { try { counted(args); } catch { /* counting never breaks a draw */ } return original.apply(this, args); };
  };
  const alive = (gl, make, drop, key) => {
    wrap(gl, make, () => { state[key] += 1; });
    wrap(gl, drop, args => { if (args[0]) state[key] = Math.max(0, state[key] - 1); });
  };
  const instrument = (gl, type, canvas) => {
    if (!gl || gl.__awwoCounted) return gl;
    try { Object.defineProperty(gl, '__awwoCounted', { value: true }); } catch { return gl; }
    state.contexts.push(type);
    wrap(gl, 'drawArrays', a => count(a[0], a[2], 1));
    wrap(gl, 'drawElements', a => count(a[0], a[1], 1));
    wrap(gl, 'drawRangeElements', a => count(a[0], a[3], 1));
    wrap(gl, 'drawArraysInstanced', a => count(a[0], a[2], a[3]));
    wrap(gl, 'drawElementsInstanced', a => count(a[0], a[1], a[4]));
    alive(gl, 'createProgram', 'deleteProgram', 'programs');
    alive(gl, 'createTexture', 'deleteTexture', 'textures');
    alive(gl, 'createFramebuffer', 'deleteFramebuffer', 'framebuffers');
    const extension = gl.getExtension;
    gl.getExtension = function (name) {
      const found = extension.call(this, name);
      if (found && !found.__awwoCounted) {
        try { Object.defineProperty(found, '__awwoCounted', { value: true }); } catch { return found; }
        wrap(found, 'drawArraysInstancedANGLE', a => count(a[0], a[2], a[3]));
        wrap(found, 'drawElementsInstancedANGLE', a => count(a[0], a[1], a[4]));
        // WEBGL_multi_draw: one call, many draws (three.js BatchedMesh).
        // (mode, firsts, firstsOffset, counts, countsOffset, drawcount) and (mode, counts, countsOffset, type, offsets, offsetsOffset, drawcount)
        wrap(found, 'multiDrawArraysWEBGL', a => count(a[0], sum(a[3], a[4], a[5]), 1));
        wrap(found, 'multiDrawElementsWEBGL', a => count(a[0], sum(a[1], a[2], a[6]), 1));
        // The instanced forms end with (instanceCounts, instanceCountsOffset, drawcount); each is one call however many it draws.
        wrap(found, 'multiDrawArraysInstancedWEBGL', a => { for (let i = 0; i < a[7]; i += 1) count(a[0], a[3][a[4] + i], a[5][a[6] + i]); frame.drawCalls -= Math.max(0, a[7] - 1); });
        wrap(found, 'multiDrawElementsInstancedWEBGL', a => { for (let i = 0; i < a[8]; i += 1) count(a[0], a[1][a[2] + i], a[6][a[7] + i]); frame.drawCalls -= Math.max(0, a[8] - 1); });
      }
      return found;
    };
    if (canvas && typeof canvas.addEventListener === 'function') canvas.addEventListener('webglcontextlost', () => { state.lost += 1; });
    drawn.push(gl);
    return gl;
  };
  for (const owner of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas]) {
    if (!owner) continue;
    const original = owner.prototype.getContext;
    owner.prototype.getContext = function (type, ...rest) {
      const context = original.call(this, type, ...rest);
      return /^(?:webgl2?|experimental-webgl)$/.test(String(type)) ? instrument(context, String(type) === 'webgl2' ? 'webgl2' : 'webgl', this) : context;
    };
  }
  const begin = () => { frame.drawCalls = 0; frame.triangles = 0; frame.lines = 0; frame.points = 0; };
  const read = () => {
    // The largest drawing buffer of the page's contexts: what its heaviest canvas renders at.
    let width = 0, height = 0;
    for (const gl of drawn) if (gl.drawingBufferWidth * gl.drawingBufferHeight > width * height) [width, height] = [gl.drawingBufferWidth, gl.drawingBufferHeight];
    return { ...frame, contexts: [...state.contexts], lost: state.lost, programs: state.programs, textures: state.textures, framebuffers: state.framebuffers, width, height };
  };
  // What the page draws in one animation frame of its own: from the end of one frame's callbacks to the end of the next.
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => { begin(); requestAnimationFrame(() => resolve(read())); }));
  Object.defineProperty(window, '__awwoGl', { value: Object.freeze({ begin, read, nextFrame }) });
})();`;

/** Brings the page to each time and takes its picture. `deps` are the check's own helpers: left(ms) (a step's bound
 *  within the budget), within(promise, ms), firstLine(error), and route(context) (the page's private origin). Answers
 *  { mode, items: [{ t, ok, ms, png?, gl?, error? }], gl, note, failure, unfinished }. */
export async function captureFrames(browser, { url, viewport, times, waitMs }, deps) {
  const { left, within, firstLine, route } = deps;
  const frames = { mode: null, items: [], gl: null, note: null, failure: null, unfinished: null };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
  try {
    await route(context);
    await context.addInitScript(GL_PROBE_SCRIPT);
    const page = await context.newPage();
    const bound = left(10_000), loaded = await within(page.goto(url, { waitUntil: 'load', timeout: bound }), bound + 500);
    if (!loaded.ok) return Object.assign(frames, { unfinished: `the page did not load for its frames: ${loaded.timedOut || loaded.error?.name === 'TimeoutError' ? `not within ${bound} ms` : firstLine(loaded.error)}` });
    const loadedAt = Date.now();
    // As the renderer waits for a page that says when it is ready; any other page gets --wait-ms, as the first load did.
    const asks = await within(page.evaluate(() => '__ready' in window), left(FRAME_MS.ready));
    if (!asks.ok) return Object.assign(frames, { unfinished: 'the page did not answer when its frames were to be taken' });
    if (asks.value) {
      const allowed = left(FRAME_MS.ready);
      let ready = false;
      for (const until = Date.now() + allowed; !ready && Date.now() < until;) {
        const answer = await within(page.evaluate(() => window.__ready === true), Math.max(1, until - Date.now()));
        if (answer.ok && answer.value === true) ready = true; else if (answer.ok || answer.timedOut) await delay(100); else break;
      }
      if (!ready && allowed < FRAME_MS.ready) return Object.assign(frames, { unfinished: `window.__ready had not turned true after ${allowed} ms (what --budget-ms had left)` });
      if (!ready) frames.note = `window.__ready was not true within ${FRAME_MS.ready / 1000} s: the frames show the page before it was ready`;
    }
    const defines = () => within(page.evaluate(() => typeof window.renderAt === 'function'), left(FRAME_MS.ready));
    // The seconds since the load, and a wait until `t` of them have passed: null when the budget does not reach that far.
    const since = () => Math.round((Date.now() - loadedAt) / 10) / 100;
    const reach = async t => {
      const wait = Math.round(loadedAt + t * 1000 - Date.now());
      if (wait > left(wait)) return `the frame at ${t} s was not reached: --budget-ms left ${Math.max(0, Math.round(left(wait)))} ms of the ${wait} ms to wait`;
      if (wait > 0) await delay(wait);
      return null;
    };
    let shape = await defines();
    // A page with no window.__ready that defines renderAt is given --wait-ms first, as the first load was; one that does
    // not is shown on its own clock, from its load, and asked once more at its first frame's time whether it defines
    // renderAt by then.
    if (shape.ok && shape.value && !asks.value) await delay(left(waitMs, 8000));
    else if (shape.ok && !shape.value) {
      const short = await reach(times[0]);
      if (short) return Object.assign(frames, { mode: 'clock', items: [{ t: times[0], ok: false, ms: 0, unfinished: short }], unfinished: short });
      shape = await defines();
    }
    if (!shape.ok) return Object.assign(frames, { unfinished: 'the page did not answer when its frames were to be taken' });
    frames.mode = shape.value ? 'renderAt' : 'clock';
    for (const t of times) {
      const item = { t, ok: false, ms: 0 }, started = Date.now();
      frames.items.push(item);
      const allowed = left(FRAME_MS.render);
      let drawn;
      if (frames.mode === 'renderAt') {
        // The draws of renderAt(t) itself; a page that only sets its state there and draws in its own loop is counted
        // over its next animation frame instead.
        drawn = await within(page.evaluate(async t => {
          const gl = window.__awwoGl;
          gl.begin();
          try { await window.renderAt(t); } catch (error) { return { threw: String(error?.message ?? error).slice(0, 300) }; }
          const counted = gl.read();
          return counted.drawCalls ? { counted, over: 'renderAt' } : { counted: await gl.nextFrame(), over: 'frame' };
        }, t), allowed);
      } else {
        const short = await reach(t);
        if (short) { item.unfinished = frames.unfinished = short; break; }
        // When the frame was really taken: a page that loads slowly, or a time already past, shows later than asked.
        item.at = since();
        drawn = await within(page.evaluate(async () => ({ counted: await window.__awwoGl.nextFrame(), over: 'frame' })), allowed);
      }
      item.ms = Date.now() - started;
      if (!drawn.ok) {
        item.unfinished = frames.unfinished = drawn.timedOut ? `the frame at ${t} s had not been drawn after ${allowed} ms${allowed < FRAME_MS.render ? ' (what --budget-ms had left)' : ''}` : `the frame at ${t} s could not be drawn: ${firstLine(drawn.error)}`;
        break;
      }
      if (drawn.value.threw !== undefined) {
        // The renderer counts a throw of renderAt as a page error on every frame it happens on.
        item.error = frames.failure = `window.renderAt(${t}) threw: ${drawn.value.threw}`;
        continue;
      }
      const { contexts, lost, programs, textures, framebuffers, width, height, ...counted } = drawn.value.counted;
      item.gl = { ...counted, over: drawn.value.over, programs, textures, framebuffers };
      frames.gl = { contexts, lost, width, height };
      const limit = left(FRAME_MS.screenshot), shot = await within(page.screenshot({ type: 'png', timeout: limit }), limit + 500);
      item.ms = Date.now() - started;
      if (!shot.ok) {
        item.unfinished = frames.unfinished = `the frame at ${t} s could not be pictured: ${shot.timedOut || shot.error?.name === 'TimeoutError' ? `the screenshot timed out (${limit} ms${limit < FRAME_MS.screenshot ? ', what --budget-ms had left' : ''})` : firstLine(shot.error)}`;
        break;
      }
      Object.assign(item, { ok: true, png: shot.value });
    }
    return frames;
  } finally {
    await within(context.close(), left(2000, 0));
  }
}

// Runs in the measuring page, once per frame: the frame's own numbers on a copy scaled down 4x (as the blank signal's),
// what changed since the frame before, and the frame drawn into its cell of the sheet.
const MEASURE_FRAME = async ({ base64, index, total, label, sheet }) => {
  const image = Object.assign(new Image(), { src: `data:image/png;base64,${base64}` });
  await image.decode();
  const sample = new OffscreenCanvas(Math.max(1, Math.round(image.naturalWidth / 4)), Math.max(1, Math.round(image.naturalHeight / 4)));
  const graphics = Object.assign(sample.getContext('2d', { willReadFrequently: true }), { imageSmoothingQuality: 'high' });
  graphics.drawImage(image, 0, 0, sample.width, sample.height);
  const data = graphics.getImageData(0, 0, sample.width, sample.height).data, count = data.length / 4;
  const luma = new Uint8Array(count), colours = new Set();
  let sum = 0, squares = 0, dark = 0, bright = 0;
  for (let at = 0, pixel = 0; at < data.length; at += 4, pixel += 1) {
    colours.add(((data[at] >> 4) << 8) | ((data[at + 1] >> 4) << 4) | (data[at + 2] >> 4));
    const value = 0.2126 * data[at] + 0.7152 * data[at + 1] + 0.0722 * data[at + 2];
    luma[pixel] = value; sum += value; squares += value * value;
    if (value <= 8) dark += 1; else if (value >= 247) bright += 1;
  }
  const state = (globalThis.__awwoFrames ??= { previous: null, sheet: null, cell: null });
  const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits, mean = sum / count;
  let motion = null;
  if (state.previous && state.previous.length === count) {
    let changed = 0, difference = 0;
    for (let pixel = 0; pixel < count; pixel += 1) { const d = Math.abs(luma[pixel] - state.previous[pixel]); difference += d; if (d > 8) changed += 1; }
    motion = { changed: round(changed / count, 4), meanDifference: round(difference / count, 2) };
  }
  state.previous = luma;
  if (!state.sheet) {
    const columns = Math.min(sheet.columns, total), width = Math.min(sheet.cell, Math.floor(sheet.width / columns));
    const height = Math.max(1, Math.round(width * image.naturalHeight / image.naturalWidth));
    state.cell = { columns, width, height, row: height + sheet.label };
    state.sheet = new OffscreenCanvas(columns * width, Math.ceil(total / columns) * state.cell.row);
    const ground = state.sheet.getContext('2d');
    ground.fillStyle = '#111'; ground.fillRect(0, 0, state.sheet.width, state.sheet.height);
  }
  const { columns, width, height, row } = state.cell, x = (index % columns) * width, y = Math.floor(index / columns) * row;
  const paper = Object.assign(state.sheet.getContext('2d'), { imageSmoothingQuality: 'high' });
  paper.drawImage(image, x, y, width, height);
  paper.fillStyle = '#eee'; paper.font = '13px "DejaVu Sans", sans-serif'; paper.textBaseline = 'middle';
  paper.fillText(label, x + 8, y + height + sheet.label / 2, width - 16);
  const lumaStdDev = round(Math.sqrt(Math.max(0, squares / count - mean * mean)), 2);
  return { pixels: { distinctColours: colours.size, lumaMean: round(mean, 1), lumaStdDev, dark: round(dark / count, 4), bright: round(bright / count, 4) },
    blank: colours.size <= 2 && lumaStdDev < 1, motion };
};
// The sheet as a JPEG within its bytes: lower quality first, then a smaller picture.
const WRITE_SHEET = async ({ bytes }) => {
  const state = globalThis.__awwoFrames;
  if (!state?.sheet) return null;
  const encode = async (canvas, quality) => {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve({ base64: String(reader.result).split(',')[1], size: blob.size }); reader.readAsDataURL(blob); });
  };
  let canvas = state.sheet, scale = 1;
  for (const quality of [0.84, 0.7, 0.55]) { const made = await encode(canvas, quality); if (made.size <= bytes) return { ...made, scale, width: canvas.width, height: canvas.height }; }
  for (scale of [0.75, 0.5, 0.35, 0.25]) {
    canvas = new OffscreenCanvas(Math.max(1, Math.round(state.sheet.width * scale)), Math.max(1, Math.round(state.sheet.height * scale)));
    Object.assign(canvas.getContext('2d'), { imageSmoothingQuality: 'high' }).drawImage(state.sheet, 0, 0, canvas.width, canvas.height);
    const made = await encode(canvas, 0.6);
    if (made.size <= bytes) return { ...made, scale, width: canvas.width, height: canvas.height };
  }
  return null;
};

const thousands = value => Number(value).toLocaleString('en-US');
/** A frame's label on the sheet and in the summary: its time and what it cost to draw. */
export const frameLabel = item => `t = ${item.t} s${item.gl ? ` · ${thousands(item.gl.drawCalls)} draw${item.gl.drawCalls === 1 ? '' : 's'} · ${thousands(item.gl.triangles)} triangles` : ''}`;

/** Measures the frames taken, in a fresh context of its own (one renderer at a time), and makes their sheet. Each item
 *  gains pixels, blank and motion (against the frame before it) and loses its png; answers the sheet as a Buffer, or null. */
export async function measureFrames(browser, frames, deps) {
  const { left, within, firstLine } = deps, taken = frames.items.filter(item => item.png);
  if (!taken.length) return null;
  // The browser opens no new context while it is still taking a heavy WebGL page down (13 to 14 s after GATHER's page
  // closed, on SwiftShader and one CPU, 2026-11-11), so opening the measuring page has a bound of its own.
  const opened = await within(browser.newContext().then(async context => ({ context, page: await context.newPage() })), left(FRAME_MS.settle, 500));
  if (!opened.ok) {
    for (const item of frames.items) delete item.png;
    frames.measureError = `could not measure the frames: the browser opened no page for it${opened.timedOut ? ' in time' : `: ${firstLine(opened.error)}`}`;
    return null;
  }
  const { context, page } = opened.value;
  try {
    for (const [index, item] of taken.entries()) {
      const measured = await within(page.evaluate(MEASURE_FRAME, { base64: item.png.toString('base64'), index, total: taken.length, label: frameLabel(item), sheet: SHEET }), left(FRAME_MS.measure, 500));
      delete item.png;
      if (!measured.ok) { frames.measureError = `could not measure the frame at ${item.t} s: ${measured.timedOut ? 'timed out' : firstLine(measured.error)}`; break; }
      Object.assign(item, measured.value);
    }
    for (const item of frames.items) delete item.png;
    if (frames.measureError) return null;
    const written = await within(page.evaluate(WRITE_SHEET, { bytes: SHEET.bytes }), left(FRAME_MS.measure, 500));
    if (!written.ok || !written.value) { frames.sheetError = `could not write the contact sheet: ${written.ok ? `it does not fit ${SHEET.bytes} bytes` : written.timedOut ? 'timed out' : firstLine(written.error)}`; return null; }
    frames.sheetSize = { width: written.value.width, height: written.value.height, scale: written.value.scale };
    return Buffer.from(written.value.base64, 'base64');
  } finally {
    await within(context.close(), left(2000, 0));
  }
}

/** What the frames say of the page as a whole, once measured: whether anything moved between them, and the most a frame
 *  drew. `still` is null with fewer than two measured frames. */
export function framesTotals(frames) {
  const measured = frames.items.filter(item => item.pixels), pairs = measured.filter(item => item.motion);
  const most = key => measured.reduce((value, item) => Math.max(value, item.gl?.[key] ?? 0), 0);
  return { taken: measured.length, still: pairs.length ? pairs.every(item => item.motion.changed <= STILL_SHARE) : null,
    maxDrawCalls: most('drawCalls'), maxTriangles: most('triangles') };
}

/** Why the frames fail the page: a frame that is one flat colour, a renderAt that threw, frames that were to move and
 *  did not, or a frame over a budget the caller set. */
export function framesReasons(frames, options) {
  if (!frames?.ran) return [];
  const totals = framesTotals(frames), measured = frames.items.filter(item => item.pixels);
  const blank = measured.filter(item => item.blank).map(item => `${item.t} s`);
  const over = (key, limit, noun) => { const worst = measured.filter(item => (item.gl?.[key] ?? 0) > limit).sort((a, b) => b.gl[key] - a.gl[key])[0];
    return worst && `frames: ${thousands(worst.gl[key])} ${noun} at ${worst.t} s, over the ${thousands(limit)} allowed`; };
  return [frames.failure && `frames: ${frames.failure}`,
    blank.length && `frames: blank at ${blank.join(', ')} (a single flat colour)`,
    options.expectMotion && totals.still === true && `frames: nothing moved between ${measured[0].t} s and ${measured.at(-1).t} s (--expect-motion)`,
    options.expectMotion && totals.still === null && !frames.unfinished && !frames.failure && 'frames: --expect-motion needs two frames to compare',
    options.maxDrawCalls !== undefined && over('drawCalls', options.maxDrawCalls, 'draw calls'),
    options.maxTriangles !== undefined && over('triangles', options.maxTriangles, 'triangles')].filter(Boolean);
}

/** The summary's lines for the frames. */
export function framesSummary(frames, relative) {
  if (!frames?.requested?.length) return [];
  if (!frames.ran) return [`  frames: not taken (${frames.why})`];
  const totals = framesTotals(frames), lines = [];
  const how = frames.mode === 'renderAt' ? 'by window.renderAt(t)' : frames.mode === 'clock' ? 't seconds after the load (the page defines no window.renderAt)' : 'none reached';
  lines.push(`  frames: ${totals.taken} of ${frames.requested.length} taken ${how}${totals.still === null ? '' : totals.still ? ', STILL (nothing moved between them)' : ', moving'}${frames.sheet ? `, sheet: ${relative(frames.sheet)}` : ''}`);
  for (const item of frames.items) {
    if (item.pixels) lines.push(`    ${frameLabel(item)} · luma ${item.pixels.lumaMean} ± ${item.pixels.lumaStdDev}${item.blank ? ' · BLANK' : ''}${item.pixels.bright >= 0.05 ? ` · ${Math.round(item.pixels.bright * 100)}% clipped white` : ''}${item.pixels.dark >= 0.6 ? ` · ${Math.round(item.pixels.dark * 100)}% black` : ''}${item.motion ? ` · ${(item.motion.changed * 100).toFixed(1)}% changed` : ''}`);
    else if (item.error) lines.push(`    t = ${item.t} s: ${item.error}`);
  }
  if (frames.gl?.lost) lines.push(`    the WebGL context was lost ${frames.gl.lost} time${frames.gl.lost === 1 ? '' : 's'}`);
  if (frames.unfinished) lines.push(`  frames: NOT FINISHED, ${frames.unfinished}`);
  if (frames.note) lines.push(`  frames note: ${frames.note}`);
  for (const problem of [frames.measureError, frames.sheetError]) if (problem) lines.push(`  frames: ${problem}`);
  return lines;
}
