// One render: a fresh headless Chromium freezes the page at every frame time and ffmpeg encodes the frames.
// The browser may reach only the CDN allowlist (network.mjs), runs on the virtual clock (virtual-time.mjs) and
// is closed, with the render's own temporary directory removed, however the render ends. A page whose renderAt or
// renderAudio waits on its own clock, which moves only when a frame is drawn, is refused as soon as that is all it
// waits on (held-clock.mjs).
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { frameTimes } from './config.mjs';
import { childEnv, contactArgs, encodeArgs, gifArgs, gifRate, parseProbe, probeArgs, runProcess, writeChunk } from './ffmpeg.mjs';
import { heldClockMessage, openWatch, watchHeldClock } from './held-clock.mjs';
import { allowedRequest, hostResolverRules, NETWORK_GUARD_SCRIPT } from './network.mjs';
import { MAX_TIMER_FIRINGS, VIRTUAL_TIME_SCRIPT } from './virtual-time.mjs';

const MIB = 1024 * 1024;
/** Largest files a render returns. The reply carries them as base64, so the whole stays under the API's 160 MiB. */
export const OUTPUT_LIMITS = Object.freeze({ mp4: 80 * MIB, gif: 15 * MIB, contact: 10 * MIB, total: 112 * MIB });
const LOAD_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 10_000;

export const CHROME_ARGS = Object.freeze(['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-first-run',
  '--disable-background-networking', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb']);

/**
 * The launch flags: the fixed set, plus every hostname but the CDNs' unresolvable, no WebRTC over raw UDP, and no
 * proxy — the browser connects directly, so it resolves names itself (where the rules apply) and a host's system
 * or environment proxy never sees a page's traffic.
 */
export function chromeArgs() {
  return [...CHROME_ARGS, `--host-resolver-rules=${hostResolverRules()}`, '--no-proxy-server', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
}

/**
 * A render that did not produce a video: 422 RENDER_FAILED with a detail, 503 when the worker itself cannot, or 400
 * INVALID_RENDER on the page's field (`html`) when the page is at fault in a way the worker can name (its renderAt or
 * renderAudio waits on its own clock: page_waits_on_timers).
 */
export class RenderError extends Error {
  constructor(detail, message, status = 422) {
    super(message);
    this.status = status;
    this.code = status === 503 ? 'RENDER_UNAVAILABLE' : status === 400 ? 'INVALID_RENDER' : 'RENDER_FAILED';
    this.detail = detail;
    if (status === 400) this.field = 'html';
  }
}

/**
 * `work`'s value, unless the page is held on its own clock first (held-clock.mjs) while it is waited on for `wait`
 * ({ kind: 'renderAt', t } or { kind: 'renderAudio' }): then a 400 page_waits_on_timers that names what waits on it.
 * `work` is left to settle on its own (the browser is closed after).
 */
async function unlessHeld(work, state, wait) {
  const watch = watchHeldClock(state.watched);
  try {
    const outcome = await Promise.race([work.then((value) => ({ value }), (error) => ({ error })), watch.held.then((waiting) => ({ waiting }))]);
    if (outcome.waiting) throw new RenderError('page_waits_on_timers', heldClockMessage(wait, outcome.waiting), 400);
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  } finally {
    watch.stop();
  }
}

// Runs in the page for every frame (serialized by Playwright, so it must stay self-contained): renderAt(t) for a
// contract page, the virtual clock to t in this frame and every same-origin child frame, each Web/CSS animation
// paused at t measured from the frame it first appeared in. All of it but renderAt is synchronous, so the held-clock
// watch, which waits on this call for a contract page, waits on renderAt alone; the paint is paintFrame's.
async function stepFrame({ t, contract }) {
  const ms = t * 1000;
  const errors = [];
  const note = (error) => errors.push(String((error && error.message) || error));
  if (contract) {
    try {
      const result = window.renderAt(t);
      if (result && typeof result.then === 'function') await result;
    } catch (error) { note(error); }
  }
  let fired = 0;
  const visit = (win) => {
    if (typeof win.__awwoAdvanceTo === 'function') {
      try { fired = Math.max(fired, win.__awwoAdvanceTo(ms)); } catch (error) { note(error); }
    }
    const seen = win.__awwoAnimationStart || (win.__awwoAnimationStart = new WeakMap());
    for (const animation of win.document.getAnimations()) {
      if (!seen.has(animation)) seen.set(animation, ms);
      try { animation.pause(); animation.currentTime = ms - seen.get(animation); } catch (ignored) { /* e.g. a scroll timeline */ }
    }
    for (let index = 0; index < win.frames.length; index += 1) {
      try { visit(win.frames[index]); } catch (ignored) { /* a cross-origin frame keeps its own time */ }
    }
  };
  visit(window);
  return { errors, fired };
}

// Then two real animation frames, so the frame is painted (in the page, self-contained like stepFrame).
async function paintFrame() {
  const raf = window.__awwoRealRaf;
  if (typeof raf === 'function') await new Promise((resolve) => raf(() => raf(resolve)));
}

/** Resolves true when promise settles within ms, false otherwise (the promise is left to settle on its own). */
async function within(promise, ms) {
  const timer = new AbortController();
  try {
    return await Promise.race([promise.then(() => true, () => true), delay(ms, false, { signal: timer.signal }).catch(() => false)]);
  } finally {
    timer.abort();
  }
}

async function waitForReady(page, halted) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline && !halted()) {
    if (await page.evaluate(() => window.__ready === true)) return true;
    await delay(100);
  }
  return false;
}

// Opens the page in a fresh browser: blocked requests are counted, page errors kept (count + first three), and what the
// held-clock watch reads of it kept for unlessHeld (state.watched; null when it could not be opened, and the page is
// then never held). `extra` are init scripts installed after the network guard and the virtual clock, before any script
// of the page.
async function openPage(request, config, state, extra = []) {
  state.browser = await chromium.launch({
    executablePath: config.chrome, headless: true, chromiumSandbox: config.chromeSandbox, args: chromeArgs(), env: childEnv(),
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, timeout: 60_000,
  }).catch((error) => {
    state.log(`browser launch failed: ${error.message.split('\n')[0]}`);
    throw new RenderError('browser_unavailable', 'The browser could not be started', 503);
  });
  if (state.halted()) throw state.stopped();
  const context = await state.browser.newContext({
    viewport: { width: request.width, height: request.height }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false,
  });
  await context.route('**/*', (route) => {
    if (allowedRequest(route.request().url())) return route.continue().catch(() => {});
    state.blocked += 1;
    return route.abort('blockedbyclient').catch(() => {});
  });
  await context.routeWebSocket(/.*/, (socket) => {
    state.blocked += 1;
    socket.close().catch(() => {});
  });
  await context.addInitScript(NETWORK_GUARD_SCRIPT);
  await context.addInitScript(VIRTUAL_TIME_SCRIPT);
  for (const script of extra) await context.addInitScript(script);
  const page = await context.newPage();
  context.on('page', (other) => { if (other !== page) other.close().catch(() => {}); });
  page.on('pageerror', (error) => state.notePageError(error.message));
  page.on('crash', () => { state.crashed = true; });
  state.watched = await openWatch(context, page);
  try {
    await page.setContent(request.html, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
  } catch {
    if (state.halted()) throw state.stopped();
    throw new RenderError('page_load_failed', 'The page did not finish loading');
  }
  // A render is of the page itself: a page that navigates away (meta refresh, location = …) fails.
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) state.navigated = true; });
  if (!(await within(page.evaluate(() => document.fonts.ready.then(() => true)), SETTLE_TIMEOUT_MS))) state.warnings.push('fonts_timeout');
  if (await page.evaluate(() => '__ready' in window) && !(await waitForReady(page, state.halted))) state.warnings.push('ready_timeout');
  const contract = await page.evaluate(() => typeof window.renderAt === 'function');
  return { page, contract };
}

// Every frame: step the page, screenshot, hash (distinct frames), keep requested stills, pipe the PNG to ffmpeg.
async function encodeFrames(page, contract, request, config, state, mp4Path) {
  const encoder = runProcess(config.ffmpeg, encodeArgs({ fps: request.fps, output: mp4Path }), { stdin: 'pipe', signal: state.signal });
  state.encoder = encoder;
  encoder.catch(() => {});
  const wanted = new Set(request.stills);
  const hashes = new Set();
  for (const [index, t] of frameTimes(request.frames, request.fps).entries()) {
    if (state.halted()) throw state.stopped();
    if (state.navigated) throw new RenderError('page_load_failed', 'The page navigated away');
    // A contract page's step waits on its renderAt(t), and so may be held there; the paint after it is never watched.
    const stepping = page.evaluate(stepFrame, { t, contract });
    const step = contract ? await unlessHeld(stepping, state, { kind: 'renderAt', t }) : await stepping;
    for (const message of step.errors) state.notePageError(message);
    if (step.fired >= MAX_TIMER_FIRINGS) state.timerLimit = true;
    await page.evaluate(paintFrame);
    const png = await page.screenshot({ type: 'png' });
    hashes.add(createHash('sha256').update(png).digest('hex'));
    if (wanted.has(index)) state.stills.set(index, png);
    try {
      await writeChunk(encoder.stdin, png);
    } catch (error) {
      await encoder; // ffmpeg's own failure says more than the closed pipe
      throw error;
    }
  }
  encoder.stdin.end();
  await encoder;
  return hashes.size;
}

function output(kind, contentType, data, extra = {}) {
  return { kind, ...extra, contentType, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data: data.toString('base64') };
}

async function probeVideo(config, state, mp4Path) {
  try {
    return parseProbe((await runProcess(config.ffprobe, probeArgs(mp4Path), { signal: state.signal })).stdout);
  } catch (error) {
    if (state.halted() || error?.code === 'PROCESS_SPAWN_FAILED') throw error;
    state.log(`ffprobe: ${error.message}`);
    throw new RenderError('ffmpeg_failed', 'The video could not be read back');
  }
}

// A GIF or contact sheet is extra: if it fails or is too large it is left out with a warning, and the MP4 stands.
async function optionalOutput(kind, command, args, file, limit, config, state) {
  try {
    await runProcess(command, args, { signal: state.signal });
  } catch (error) {
    if (state.halted()) throw error;
    state.log(`${kind}: ${error.message} ${String(error.stderr ?? '').slice(-300)}`);
    state.warnings.push(`${kind}_failed`);
    return null;
  }
  if ((await stat(file)).size > limit) {
    state.warnings.push(`${kind}_too_large`);
    return null;
  }
  return readFile(file);
}

function classify(error, state) {
  if (state.halted()) return state.stopped();
  if (error instanceof RenderError) return error;
  if (state.crashed) return new RenderError('page_load_failed', 'The page crashed the browser');
  if (state.navigated) return new RenderError('page_load_failed', 'The page navigated away');
  if (error?.code === 'PROCESS_SPAWN_FAILED') {
    state.log(error.message);
    return new RenderError('ffmpeg_unavailable', 'ffmpeg could not be started', 503);
  }
  if (error?.code === 'PROCESS_FAILED' || error?.code === 'PROCESS_STDIN_CLOSED') {
    state.log(`ffmpeg: ${error.message} ${String(error.stderr ?? '').slice(-300)}`);
    return new RenderError('ffmpeg_failed', 'ffmpeg could not encode the video');
  }
  state.log(`failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`);
  return new RenderError('render_failed', 'The render failed');
}

const defaultLog = (message) => { process.stderr.write(`${message}\n`); };

/** The rate a page's sound is asked for: the one an edit mixes at (edit-ffmpeg.mjs SAMPLE_RATE), and the highest taken. */
export const SOUND_RATE = 48000;
const SOUND_VIEWPORT = Object.freeze({ width: 640, height: 360 });
/** Bytes of the kept sound read at a time (a multiple of 3, so every part but the last is base64 without padding). */
const SOUND_PART_BYTES = 3 * MIB;
/** How much shorter than asked a page's sound may be (rounding); it is padded with silence to the length asked. */
const SOUND_SHORT_SECONDS = 0.05;
/** The longest a page's sound may take to make and read out, once the page has opened: synthesis takes seconds. */
const SOUND_TIMEOUT_MS = 120_000;

/**
 * The capture side of a sound render, installed before any page script and built only from the browser's own
 * built-ins as they were then: a page cannot reach what it keeps or replace the two functions it defines (non-writable,
 * non-configurable), whatever it does to the globals later. Both take one number and give back one string, never an
 * object (an object passing through a promise or Playwright's serialiser meets the page's prototypes; a primitive
 * does not), and the worker checks every string it gets (parseCapture, partBytes).
 * __awwoCaptureSound(seconds) looks up and calls window.renderAudio({ seconds, sampleRate }) once, inside its own guard,
 * and keeps exactly round(seconds × rate) frames as 16-bit stereo PCM (frames short of that are silence; frames past it
 * are never read). Its channels must be real Float32Arrays (an AudioBuffer's, or the `channels` of {sampleRate,
 * channels}). It answers "missing", "failed:<what renderAudio threw>", "bad:<what is wrong with what it gave>" or
 * "ok:<rate>,<frames given>,<frames kept>,<frames with a bad sample>,<frames clipped>,<peak>".
 * __awwoSoundPart(start) gives the kept bytes from start (a multiple of SOUND_PART_BYTES) for SOUND_PART_BYTES or to the
 * end, as base64 encoded here by hand rather than with any function the page could replace.
 */
export const SOUND_SCRIPT = `(() => {
  'use strict';
  const w = window;
  if (Object.prototype.hasOwnProperty.call(w, '__awwoCaptureSound')) return;
  const apply = Reflect.apply;
  const define = Object.defineProperty;
  const describe = Object.getOwnPropertyDescriptor;
  const isArray = Array.isArray;
  const isInteger = Number.isInteger;
  const isFinite = Number.isFinite;
  const round = Math.round;
  const sliceOf = String.prototype.slice;
  const I16 = Int16Array;
  const U8 = Uint8Array;
  const TYPED = Object.getPrototypeOf(U8.prototype);
  const tagOf = describe(TYPED, Symbol.toStringTag).get;
  const lengthOf = describe(TYPED, 'length').get;
  const bufferOf = describe(TYPED, 'buffer').get;
  const AUDIO = w.AudioBuffer ? w.AudioBuffer.prototype : null;
  const channelCount = AUDIO ? describe(AUDIO, 'numberOfChannels').get : null;
  const rateOf = AUDIO ? describe(AUDIO, 'sampleRate').get : null;
  const channelData = AUDIO ? AUDIO.getChannelData : null;
  const MAX_RATE = ${SOUND_RATE};
  const MAX_PART = ${SOUND_PART_BYTES};
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let kept = null;
  let keptBytes = 0;
  // What a thrown value says, as a string of at most 200 characters, read inside a guard.
  const words = (error) => {
    let text;
    try {
      const said = error !== null && typeof error === 'object' ? error.message : error;
      text = typeof said === 'string' ? said : 'a value that is not an Error';
    } catch (ignored) { text = 'an error that could not be read'; }
    return text.length > 200 ? apply(sliceOf, text, [0, 200]) : text;
  };
  const floats = (data) => {
    try { return apply(tagOf, data, []) === 'Float32Array' ? data : null; } catch (ignored) { return null; }
  };
  const channelsOf = (made) => {
    let count = 0;
    if (channelCount) { try { count = apply(channelCount, made, []); } catch (ignored) { count = 0; } }
    if (count >= 1) return { rate: apply(rateOf, made, []), left: apply(channelData, made, [0]), right: apply(channelData, made, [count > 1 ? 1 : 0]) };
    if (made !== null && typeof made === 'object' && isArray(made.channels)) {
      const list = made.channels;
      const left = floats(list[0]);
      const right = list.length > 1 ? floats(list[1]) : left;
      if (!left || !right) throw new TypeError('each channel of the sound must be a Float32Array');
      return { rate: made.sampleRate, left, right };
    }
    throw new TypeError('window.renderAudio must resolve to an AudioBuffer or to {sampleRate, channels: [Float32Array]}');
  };
  const capture = async (seconds) => {
    kept = null;
    keptBytes = 0;
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds <= 0) return 'bad:no length was asked for';
    let made;
    try {
      const make = w.renderAudio;
      if (typeof make !== 'function') return 'missing';
      made = await apply(make, w, [{ seconds, sampleRate: MAX_RATE }]);
    } catch (error) { return 'failed:' + words(error); }
    let rate;
    let left;
    let right;
    try {
      const shape = channelsOf(made);
      rate = shape.rate;
      left = shape.left;
      right = shape.right;
    } catch (error) { return 'bad:' + words(error); }
    if (!isInteger(rate) || rate < 8000 || rate > MAX_RATE) return 'bad:the sample rate of the sound must be a whole number from 8000 to ' + MAX_RATE;
    const wanted = round(seconds * rate);
    const leftLength = apply(lengthOf, left, []);
    const rightLength = apply(lengthOf, right, []);
    const available = leftLength < rightLength ? leftLength : rightLength;
    const frames = available < wanted ? available : wanted;
    const pcm = new I16(wanted * 2);
    let invalid = 0;
    let clipped = 0;
    let peak = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      let bad = false;
      let over = false;
      for (let channel = 0; channel < 2; channel += 1) {
        let value = channel === 0 ? left[frame] : right[frame];
        if (!isFinite(value)) { bad = true; value = 0; }
        const size = value < 0 ? -value : value;
        if (size > peak) peak = size;
        if (size > 1) { over = true; value = value > 0 ? 1 : -1; }
        pcm[frame * 2 + channel] = value < 0 ? round(value * 32768) : round(value * 32767);
      }
      if (bad) invalid += 1;
      if (over) clipped += 1;
    }
    kept = new U8(apply(bufferOf, pcm, []));
    keptBytes = wanted * 4;
    return 'ok:' + rate + ',' + available + ',' + wanted + ',' + invalid + ',' + clipped + ',' + peak;
  };
  const part = (start) => {
    if (!kept || typeof start !== 'number' || !isInteger(start) || start < 0 || start >= keptBytes || start % MAX_PART !== 0) return '';
    const end = start + MAX_PART < keptBytes ? start + MAX_PART : keptBytes;
    let out = '';
    let index = start;
    for (; index + 2 < end; index += 3) {
      const n = (kept[index] << 16) | (kept[index + 1] << 8) | kept[index + 2];
      out += ALPHA[n >>> 18] + ALPHA[(n >>> 12) & 63] + ALPHA[(n >>> 6) & 63] + ALPHA[n & 63];
    }
    if (end - index === 1) {
      const n = kept[index] << 16;
      out += ALPHA[n >>> 18] + ALPHA[(n >>> 12) & 63] + '==';
    } else if (end - index === 2) {
      const n = (kept[index] << 16) | (kept[index + 1] << 8);
      out += ALPHA[n >>> 18] + ALPHA[(n >>> 12) & 63] + ALPHA[(n >>> 6) & 63] + '=';
    }
    return out;
  };
  define(w, '__awwoCaptureSound', { value: capture, writable: false, configurable: false, enumerable: false });
  define(w, '__awwoSoundPart', { value: part, writable: false, configurable: false, enumerable: false });
})();`;

/** The 44-byte header of a 16-bit stereo PCM WAV file holding `bytes` bytes of samples. */
export function wavHeader(bytes, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(bytes, 40);
  return header;
}

/** A 16-bit stereo PCM WAV file of the given samples (interleaved little-endian bytes). */
export const wavFile = (pcm, sampleRate) => Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);

/**
 * Writes all of `data` at the handle's current position. A write may store fewer bytes than it was given, so the rest is
 * written again; one that stores none is the disk's fault (EIO).
 */
export async function writeAll(handle, data) {
  for (let done = 0; done < data.length;) {
    const { bytesWritten } = await handle.write(data, done, data.length - done);
    if (!(bytesWritten > 0)) throw Object.assign(new Error('The disk stored none of a write'), { code: 'EIO' });
    done += bytesWritten;
  }
}

/** A sound that could not be stored: the worker's disk (503), never the page's fault. */
function storageError(error) {
  const full = ['ENOSPC', 'EDQUOT'].includes(error?.code);
  return new RenderError(full ? 'disk_full' : 'tmp_unavailable', full ? 'No disk space for the sound' : 'The sound could not be stored', 503);
}

const CAPTURED = /^ok:(\d{4,6}),(\d{1,9}),(\d{1,9}),(\d{1,9}),(\d{1,9}),(\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/;

/**
 * What __awwoCaptureSound answered, checked: { rate, available, wanted, invalid, clipped, peak } for a sound of
 * `seconds`, or a RenderError (sound_missing; sound_failed with the page's own words, control characters removed;
 * sound_too_short). Its numbers decide how many bytes are read and written, so each is held to what it can be.
 */
export function parseCapture(text, seconds) {
  const plain = (said) => said.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (typeof text !== 'string' || text.length > 400) throw new RenderError('sound_failed', 'The sound could not be read from the page');
  if (text === 'missing') throw new RenderError('sound_missing', 'The page defines no window.renderAudio');
  if (text.startsWith('failed:')) throw new RenderError('sound_failed', `window.renderAudio failed: ${plain(text.slice(7)) || 'it threw'}`);
  if (text.startsWith('bad:')) throw new RenderError('sound_failed', plain(text.slice(4)) || 'The page gave no sound');
  const match = CAPTURED.exec(text);
  const [rate, available, wanted, invalid, clipped] = match ? match.slice(1, 6).map(Number) : [];
  const peak = match ? Number(match[6]) : Number.NaN;
  if (!match || rate < 8000 || rate > SOUND_RATE || wanted !== Math.round(seconds * rate) || wanted < 1 || invalid > wanted || clipped > wanted || !Number.isFinite(peak)) {
    throw new RenderError('sound_failed', 'The sound could not be read from the page');
  }
  if (available < wanted - Math.round(SOUND_SHORT_SECONDS * rate)) {
    throw new RenderError('sound_too_short', `The page made ${(available / rate).toFixed(3)} s of sound, not ${seconds} s`);
  }
  return { rate, available, wanted, invalid, clipped, peak };
}

/** The bytes of the part from `start` that __awwoSoundPart answered with, or null unless they are exactly that part's. */
export function partBytes(text, start, total) {
  const end = Math.min(total, start + SOUND_PART_BYTES);
  if (typeof text !== 'string' || end <= start || text.length !== 4 * Math.ceil((end - start) / 3)) return null;
  const data = Buffer.from(text, 'base64');
  return data.length === end - start ? data : null;
}

/**
 * The sound a page makes (an edit's audio item with a `page`): the page opened as for a render (the same browser, network
 * walls and virtual clock, plus SOUND_SCRIPT), window.renderAudio called once for request.seconds at SOUND_RATE, and the
 * kept samples read out part by part, each checked for its exact length, into a 16-bit stereo WAV exactly
 * request.seconds long. Opening the page is bounded as a render's is (config.timeoutMs); the sound itself then has
 * soundTimeoutMs (120 s). Rejects with a RenderError: sound_missing (no renderAudio), sound_failed (it threw, gave
 * something else, or what it kept could not be read), sound_too_short, timeout (the sound took longer than its budget),
 * page_load_failed (it did not load, crashed or navigated, also while its sound was read), render_timeout (opening it
 * took longer than a render may), aborted, render_failed; 400 page_waits_on_timers (its renderAudio waited on its own
 * clock); 503 when the browser is missing.
 */
export async function renderPageSound(request, config, { signal, log = defaultLog, soundTimeoutMs = SOUND_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  let why = '';
  const stop = (reason) => () => { why = why || reason; controller.abort(); };
  const whole = setTimeout(stop('whole'), config.timeoutMs);
  let budget = null;
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', forward, { once: true });
  const pageErrors = [];
  const state = {
    signal: controller.signal, browser: null, encoder: null, watched: null, blocked: 0, crashed: false, navigated: false, timerLimit: false,
    pageErrorCount: 0, warnings: [], stills: new Map(),
    halted: () => controller.signal.aborted,
    stopped: () => {
      if (why === 'sound') {
        return new RenderError('timeout', `it took longer than ${Math.round(soundTimeoutMs / 1000)} s to make (time stands still while it is made, so a page that waits for a timer or an animation frame never finishes)`);
      }
      if (why === 'crash') return new RenderError('page_load_failed', 'The page crashed the browser');
      return why === 'whole' ? new RenderError('render_timeout', 'The page took too long to open') : new RenderError('aborted', 'The sound was stopped');
    },
    notePageError: (message) => {
      state.pageErrorCount += 1;
      if (pageErrors.length < 3) pageErrors.push(String(message).slice(0, 200));
    },
    log: (message) => log(`sound ${request.renderId}: ${message}`),
  };
  controller.signal.addEventListener('abort', () => { state.browser?.close().catch(() => {}); }, { once: true });
  // Between steps: stopped, crashed or navigated away (a sound is of the page that loaded, as a render's frames are).
  const left = () => {
    if (state.halted()) throw state.stopped();
    if (state.crashed) throw new RenderError('page_load_failed', 'The page crashed the browser');
    if (state.navigated) throw new RenderError('page_load_failed', 'The page navigated away');
  };
  let handle = null;
  let written = false;
  try {
    const { page } = await openPage({ ...request, ...SOUND_VIEWPORT }, config, state, [SOUND_SCRIPT]);
    left();
    // Opened: from here the sound's own budget counts, through its making and its reading out; a crash ends it at once.
    clearTimeout(whole);
    budget = setTimeout(stop('sound'), soundTimeoutMs);
    page.once('crash', stop('crash'));
    // The browser's own evaluation, the number written into the expression and one string back by value: no argument
    // or answer passes through the page's JavaScript (Playwright's in-page helper iterates its arguments, which a page
    // can redefine), and `window` and the two functions cannot be replaced.
    const cdp = await page.context().newCDPSession(page);
    const ask = async (expression) => {
      let reply;
      try {
        reply = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      } catch (error) {
        if (state.halted()) throw state.stopped();
        // The browser still runs, so the page left the document it was asked in (a reload, a refresh, a new
        // location) before its answer came: the page's doing, as a navigation is for a render.
        if (state.browser?.isConnected()) throw new RenderError('page_load_failed', 'The page navigated away or closed while its sound was made');
        throw error;
      }
      if (reply.exceptionDetails) throw new RenderError('render_failed', 'The sound capture failed in the page');
      return reply.result?.value;
    };
    const answer = await unlessHeld(ask(`window.__awwoCaptureSound(${Number(request.seconds)})`), state, { kind: 'renderAudio' });
    left();
    const made = parseCapture(answer, request.seconds);
    const bytes = made.wanted * 4;
    // Written as it is read, part by part, so the worker holds one part at a time.
    try {
      handle = await open(request.file, 'w');
      await writeAll(handle, wavHeader(bytes, made.rate));
    } catch (error) {
      throw storageError(error);
    }
    for (let start = 0; start < bytes; start += SOUND_PART_BYTES) {
      left();
      const data = partBytes(await ask(`window.__awwoSoundPart(${start})`), start, bytes);
      if (!data) throw new RenderError('sound_failed', 'The sound could not be read from the page');
      try { await writeAll(handle, data); } catch (error) { throw storageError(error); }
    }
    left();
    // Closed and on disk at the length it says, or not a sound: the reply gives the length stored, not the one meant.
    try {
      await handle.close();
      handle = null;
      if ((await stat(request.file)).size !== 44 + bytes) throw new Error('The sound file is not the length written');
    } catch (error) {
      throw storageError(error);
    } finally {
      handle = null;
    }
    written = true;
    await page.close().catch(() => {});
    const warnings = [...state.warnings];
    if (made.invalid > 0) warnings.push(`sound_not_finite:${made.invalid}`);
    if (made.clipped > 0) warnings.push(`sound_clipped:${made.clipped}`);
    if (made.peak === 0) warnings.push('sound_silent');
    if (state.pageErrorCount > 0) warnings.push(`page_errors:${state.pageErrorCount}`);
    if (state.blocked > 0) warnings.push(`network_blocked:${state.blocked}`);
    return {
      renderId: request.renderId, sampleRate: made.rate, seconds: request.seconds, frames: made.wanted, peak: made.peak,
      file: request.file, bytes: 44 + bytes, warnings, pageErrors, elapsedMs: Date.now() - started,
    };
  } catch (error) {
    throw classify(error, state);
  } finally {
    clearTimeout(whole);
    clearTimeout(budget);
    signal?.removeEventListener('abort', forward);
    if (handle) await handle.close().catch(() => {});
    if (!written) await rm(request.file, { force: true }).catch(() => {});
    await state.browser?.close().catch(() => {});
  }
}

/**
 * Renders a validated request (config.mjs validateRenderRequest) into the reply the API stores. Rejects with a
 * RenderError: detail timeout (config.timeoutMs for the whole render), aborted (signal), page_load_failed,
 * output_too_large, ffmpeg_failed or render_failed; status 400 page_waits_on_timers (its renderAt waited on its own
 * clock); status 503 when the browser, ffmpeg or temporary space is missing.
 */
export async function renderPage(request, config, { signal, log = defaultLog } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', forward, { once: true });
  const pageErrors = [];
  const state = {
    signal: controller.signal, browser: null, encoder: null, watched: null, blocked: 0, crashed: false, navigated: false, timerLimit: false,
    pageErrorCount: 0, warnings: [], stills: new Map(),
    halted: () => controller.signal.aborted,
    stopped: () => (timedOut ? new RenderError('timeout', 'The render took too long') : new RenderError('aborted', 'The render was stopped')),
    notePageError: (message) => {
      state.pageErrorCount += 1;
      if (pageErrors.length < 3) pageErrors.push(String(message).slice(0, 200));
    },
    log: (message) => log(`render ${request.renderId}: ${message}`),
  };
  // Closing the browser is what interrupts a screenshot or evaluate in flight.
  controller.signal.addEventListener('abort', () => { state.browser?.close().catch(() => {}); }, { once: true });
  let dir;
  try {
    dir = await mkdtemp(path.join(config.tmp, 'awwo-render-')).catch((error) => {
      log(`render ${request.renderId}: temporary directory: ${error.message}`);
      throw new RenderError('tmp_unavailable', 'No temporary space for the render', 503);
    });
    const files = { mp4: path.join(dir, 'motion.mp4'), gif: path.join(dir, 'motion.gif'), contact: path.join(dir, 'contact-sheet.png') };
    const { page, contract } = await openPage(request, config, state);
    const distinctFrames = await encodeFrames(page, contract, request, config, state, files.mp4);
    await page.close().catch(() => {});
    const probe = await probeVideo(config, state, files.mp4);
    if ((await stat(files.mp4)).size > OUTPUT_LIMITS.mp4) throw new RenderError('output_too_large', 'The video is larger than 80 MiB');
    const mp4 = await readFile(files.mp4);
    const outputs = [output('mp4', 'video/mp4', mp4)];
    let total = mp4.length;
    const add = (kind, contentType, data, extra) => {
      if (!data) return;
      if (total + data.length > OUTPUT_LIMITS.total) {
        if (!state.warnings.includes(`${kind}_too_large`)) state.warnings.push(`${kind}_too_large`);
        return;
      }
      total += data.length;
      outputs.push(output(kind, contentType, data, extra));
    };
    if (request.outputs.includes('gif')) {
      const rate = gifRate(request);
      if (rate.reduced) state.warnings.push('gif_fps_reduced');
      add('gif', 'image/gif', await optionalOutput('gif', config.ffmpeg, gifArgs({ input: files.mp4, fps: rate.fps, loop: request.loop, output: files.gif }),
        files.gif, OUTPUT_LIMITS.gif, config, state));
    }
    if (request.outputs.includes('contact')) {
      add('contact', 'image/png', await optionalOutput('contact', config.ffmpeg, contactArgs({ input: files.mp4, frames: request.frames, output: files.contact }),
        files.contact, OUTPUT_LIMITS.contact, config, state));
    }
    for (const [frame, png] of state.stills) add('still', 'image/png', png, { frame });
    const warnings = [...state.warnings];
    if (distinctFrames === 1) warnings.push('static_page');
    if (state.pageErrorCount > 0) warnings.push(`page_errors:${state.pageErrorCount}`);
    if (state.blocked > 0) warnings.push(`network_blocked:${state.blocked}`);
    if (state.timerLimit) warnings.push('timer_limit');
    if (probe.frames !== request.frames) warnings.push(`probe_frames:${probe.frames}`);
    return {
      renderId: request.renderId, mode: contract ? 'contract' : 'virtual-time', frames: request.frames, fps: request.fps,
      width: request.width, height: request.height, seconds: request.seconds, distinctFrames, elapsedMs: Date.now() - started,
      probe, warnings, pageErrors, outputs,
    };
  } catch (error) {
    throw classify(error, state);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
    const child = state.encoder?.child;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await state.browser?.close().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
