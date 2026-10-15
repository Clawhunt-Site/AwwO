// One render: a fresh headless Chromium freezes the page at every frame time and ffmpeg encodes the frames.
// The browser may reach only the CDN allowlist (network.mjs), runs on the virtual clock (virtual-time.mjs) and
// is closed, with the render's own temporary directory removed, however the render ends.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { frameTimes } from './config.mjs';
import { childEnv, contactArgs, encodeArgs, gifArgs, gifRate, parseProbe, probeArgs, runProcess, writeChunk } from './ffmpeg.mjs';
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

/** A render that did not produce a video: 422 RENDER_FAILED with a detail, or 503 when the worker itself cannot. */
export class RenderError extends Error {
  constructor(detail, message, status = 422) {
    super(message);
    this.status = status;
    this.code = status === 503 ? 'RENDER_UNAVAILABLE' : 'RENDER_FAILED';
    this.detail = detail;
  }
}

// Runs in the page for every frame (serialized by Playwright, so it must stay self-contained): renderAt(t) for a
// contract page, the virtual clock to t in this frame and every same-origin child frame, each Web/CSS animation
// paused at t measured from the frame it first appeared in; then two real animation frames, so it is painted.
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
  const raf = window.__awwoRealRaf;
  if (typeof raf === 'function') await new Promise((resolve) => raf(() => raf(resolve)));
  return { errors, fired };
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

// Opens the page in a fresh browser: blocked requests are counted, page errors kept (count + first three).
async function openPage(request, config, state) {
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
  const page = await context.newPage();
  context.on('page', (other) => { if (other !== page) other.close().catch(() => {}); });
  page.on('pageerror', (error) => state.notePageError(error.message));
  page.on('crash', () => { state.crashed = true; });
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
    const step = await page.evaluate(stepFrame, { t, contract });
    for (const message of step.errors) state.notePageError(message);
    if (step.fired >= MAX_TIMER_FIRINGS) state.timerLimit = true;
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

/**
 * Renders a validated request (config.mjs validateRenderRequest) into the reply the API stores. Rejects with a
 * RenderError: detail timeout (config.timeoutMs for the whole render), aborted (signal), page_load_failed,
 * output_too_large, ffmpeg_failed or render_failed; status 503 when the browser, ffmpeg or temporary space is missing.
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
    signal: controller.signal, browser: null, encoder: null, blocked: 0, crashed: false, navigated: false, timerLimit: false,
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
