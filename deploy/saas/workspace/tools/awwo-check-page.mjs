#!/usr/bin/env node
// awwo-check-page: serves an HTML page and its directory to the image's Chromium from a private https origin, blocks every
// other request, and reports the page's errors, its own self-test (window.awwoSelfTest) and whether it rendered anything;
// then, for a page written for AwwO's renderer, loads it again on the renderer's held clock and reports whether the renderer
// would be left waiting on it. Protocol and report: deploy/saas/workspace/README.md.
import { rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { HELD_CLOCK_MS, heldClockMessage, openWatch, watchHeldClock } from './held-clock.mjs';
import { libraryFile, loadLibraries } from './libraries.mjs';
import { excusable, globMatcher, MAX_PATTERNS, parseMissingOk } from './missing-ok.mjs';
import { VIRTUAL_TIME_SCRIPT } from './virtual-time.mjs';

const CHROMIUM = '/usr/lib/chromium/chromium-headless-shell';
const ORIGIN = 'https://awwo-check.invalid';
// The library files AwwO's running preview supplies to a page that loads them from a CDN, as a three.js page does
// through an import map (tools/libraries.mjs): a request for one of them, at its version and at an address the preview
// knows, is answered from the image's copy and listed; any other file, version or address stays blocked, as the
// preview's page would find it. PALLWARD's integration tester could not run its game in the check at all while three.js
// 0.186.1 came only from cdn.jsdelivr.net (2026-10-18).
const LIBRARIES = loadLibraries(path.dirname(fileURLToPath(import.meta.url)));
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const EXIT = { pass: 0, fail: 1, usage: 2, error: 3, unfinished: 4 };
const MAX = { errors: 50, text: 2000, name: 200, items: 200, blocked: 50, selfTestJson: 1_000_000, screenshotBytes: 400_000, allowedMissing: 2000, allowedUrl: 4096 };
// A sandbox command gets 30 s (120 s when the workspace has the web) and is stopped when it overruns. So each step has its
// own bound and also fits the --budget-ms counted from process start, less FINISH_MS kept back for closing and writing the report.
// A heavy WebGL page on SwiftShader and one CPU can keep its main thread busy for seconds: PALLWARD's world took more
// than 5 s to screenshot (2026-10-18), so the probe and the screenshot get 10 and 20 s, always within the budget. The wait
// keeps only SCREENSHOT_RESERVE_MS back for the screenshot, which seldom takes long, so the default budget still waits;
// a page that did not load gets only that long for its screenshot, as before.
const STEP_MS = { launch: 15_000, load: 10_000, probe: 10_000, screenshot: 20_000 };
const FINISH_MS = 3000, SCREENSHOT_RESERVE_MS = 5000;
// On the held clock, as the renderer waits: window.__ready up to 10 s, then the first frame and the sound, each until it
// settles or the page is held (HELD_CLOCK_MS, held-clock.mjs) and at most HELD_STEP_MS, always within the budget.
const READY_MS = 10_000, HELD_STEP_MS = 15_000;
// The window the render worker makes a page's sound in (render.mjs SOUND_VIEWPORT); a frame's is --viewport.
const SOUND_VIEWPORT = { width: 640, height: 360 };
const DEFAULTS = { out: 'check-out', waitMs: 1500, timeoutMs: 15_000, budgetMs: 25_000, width: 1280, height: 800, missingOk: [], heldClock: 'auto' };
const NUMBERS = { '--wait-ms': ['waitMs', 0, 60_000], '--timeout-ms': ['timeoutMs', 100, 600_000], '--budget-ms': ['budgetMs', 5000, 900_000] };
const SWITCHES = { '--held-clock': 'on', '--no-held-clock': 'off' };
const USAGE = 'usage: awwo-check-page <page.html> [--out <dir>] [--wait-ms N] [--timeout-ms N] [--budget-ms N] [--viewport WxH] [--missing-ok GLOB]... [--held-clock | --no-held-clock]';
const HELP = `${USAGE}
Serves the page and the files of its directory from a private https origin to headless Chromium (any other request is blocked
and listed, except the three.js 0.186.1 files AwwO's preview supplies, answered from the image's copy at the jsDelivr and
unpkg addresses the preview knows), waits --wait-ms (1500), screenshots the viewport (1280x800) and calls window.awwoSelfTest(), if the page defines it,
for at most --timeout-ms (15000). It must resolve to { tests: [{ name, ok: boolean, detail? }], planted?: [{ name, rejected:
boolean, detail? }] }, planted listing deliberately wrong variants of the code that the page's own tests must reject. Uncaught
errors, unhandled rejections (cancelled ones too) and console.error fail the page; while the self-test runs, console errors and
errors the page cancels are only listed. A missing local file (a 404) is an error unless the page fetched it as data, a picture,
sound, video or a font and its path, relative to the page, matches a --missing-ok pattern (* and ? within a directory, ** across
them: **/*.glb is any .glb; at most ${MAX_PATTERNS}); those are only listed. A missing script or stylesheet always counts.
A page that defines window.renderAt or window.renderAudio (--held-clock: any page; --no-held-clock: none) is then loaded
again on the clock AwwO's renderer gives it, where timers and animation frames run only when a frame is drawn, once for
its first frame and once for its sound, as the renderer opens it: window.__ready is waited for (noted when the renderer would
render the page before it is ready), then window.renderAt(0), or window.renderAudio({ seconds: 1, sampleRate: 48000 }). The
page fails when one of those throws, when the renderer would not find it, or when it waits ${HELD_CLOCK_MS / 1000} s on nothing the renderer can see
but its own clock, which the renderer refuses; a wait the budget cuts short is reported as not finished. The check ends
within --budget-ms (25000). Writes <out>/report.json and <out>/screenshot.png (out: ./check-out).
Exit 0: pass. 1: the page failed (an error, a test, a planted variant, a blank render, a failure on the held clock).
2: usage. 3: the check could not run. 4: nothing failed, but the check on the held clock did not finish, so the page
was not shown to render (heldClock.unfinished says where it stopped; a larger --budget-ms may let it finish).`;
// The container is the sandbox: Chromium's own needs user namespaces or setuid, which the container drops (Playwright
// adds --no-sandbox). WebGL runs on SwiftShader. No name resolution or proxy: a second wall behind the request router.
const ARGS = ['--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--hide-scrollbars', '--force-color-profile=srgb', '--no-first-run', '--no-default-browser-check',
  '--host-resolver-rules=MAP * ~NOTFOUND', '--no-proxy-server', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
// Chromium reports no error event or rejection that the page cancels (onerror returning true, preventDefault), so a
// capture listener installed before the page's code reports those once their dispatch is over.
const CANCELLED_ERRORS = `(() => { const report = window.__awwoCheckCancelled;
  for (const [type, kind] of [['error', 'uncaught'], ['unhandledrejection', 'unhandledrejection']]) addEventListener(type, event => {
    if (type === 'error' && !(event instanceof ErrorEvent)) return;
    setTimeout(() => { if (event.defaultPrevented && typeof report === 'function') report(kind, String(event.error?.stack ?? event.reason?.stack ?? event.message ?? event.reason)); });
  }, true); })();`;

class UsageError extends Error {}
const clip = (value, limit = MAX.text) => { const text = String(value); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const firstLine = error => clip(String(error?.message ?? error).replace(/^\w+\.\w+: /, '').split('\n')[0], 500);
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
let deadline = Infinity;
// What a step may take: its own bound, within what the budget has left after the reserve (at least 1 ms).
const left = (ms, reserve = FINISH_MS) => Math.max(1, Math.min(ms, deadline - Date.now() - reserve));

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].startsWith('--') ? argv[index].split(/=(.*)/s, 2) : [argv[index]];
    const value = () => inline ?? argv[++index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (SWITCHES[flag]) {
      if (inline !== undefined) throw new UsageError(`${flag} takes no value`);
      options.heldClock = SWITCHES[flag];
    } else if (flag === '--out') options.out = value() || '';
    else if (NUMBERS[flag]) {
      const [key, min, max] = NUMBERS[flag], raw = value() ?? '';
      if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new UsageError(`${flag} takes an integer from ${min} to ${max}`);
      options[key] = Number(raw);
    } else if (flag === '--viewport') {
      const match = /^(\d{2,4})x(\d{2,4})$/.exec(value() ?? '');
      if (!match || [match[1], match[2]].some(side => Number(side) < 64 || Number(side) > 2560)) throw new UsageError('--viewport takes WIDTHxHEIGHT, each 64 to 2560');
      [options.width, options.height] = [Number(match[1]), Number(match[2])];
    } else if (flag === '--missing-ok') {
      const pattern = parseMissingOk(value() ?? '');
      if (pattern instanceof Error) throw new UsageError(pattern.message);
      if (options.missingOk.length >= MAX_PATTERNS) throw new UsageError(`--missing-ok can be given at most ${MAX_PATTERNS} times`);
      options.missingOk = [...options.missingOk, pattern];
    } else if (flag.startsWith('-')) throw new UsageError(`unknown option ${flag}`);
    else if (options.page === undefined) options.page = flag;
    else throw new UsageError('give one page');
  }
  if (!options.out) throw new UsageError('--out takes a directory');
  if (options.page === undefined) throw new UsageError('missing <page.html>');
  if (options.waitMs + 10_000 > options.budgetMs) throw new UsageError('--wait-ms must leave at least 10000 ms of --budget-ms for the check');
  return options;
}

// Settles to { ok, value } / { ok: false, error } / { ok: false, timedOut } within ms; a late rejection is swallowed.
async function within(promise, ms) {
  const timer = new AbortController(), late = delay(ms, { ok: false, timedOut: true }, { signal: timer.signal }).catch(() => ({ ok: false, timedOut: true }));
  promise.catch(() => {});
  try { return await Promise.race([promise.then(value => ({ ok: true, value }), error => ({ ok: false, error })), late]); } finally { timer.abort(); }
}

// Checks the shape of awwoSelfTest()'s result; nothing malformed counts as a pass.
function validateSelfTest(value) {
  const entries = (list, field, label) => {
    if (!Array.isArray(list) || list.length > MAX.items) throw new Error(`"${label}" must be an array of at most ${MAX.items} entries`);
    return list.map((entry, index) => {
      const detail = entry?.detail ?? undefined;
      if (!isObject(entry) || typeof entry.name !== 'string' || !entry.name.trim() || typeof entry[field] !== 'boolean'
        || (detail !== undefined && typeof detail !== 'string')) throw new Error(`${label}[${index}] must be { name: string, ${field}: boolean, detail?: string }`);
      return { name: clip(entry.name, MAX.name), [field]: entry[field], ...(detail === undefined ? {} : { detail: clip(detail) }) };
    });
  };
  if (!isObject(value)) throw new Error('awwoSelfTest() must resolve to { tests: [...], planted?: [...] }');
  const tests = entries(value.tests, 'ok', 'tests'); if (!tests.length) throw new Error('"tests" is empty');
  return { tests, planted: value.planted === undefined ? [] : entries(value.planted, 'rejected', 'planted') };
}

async function runSelfTest(page, timeoutMs) {
  const result = { present: true, ok: false, passed: 0, failed: 0, plantedTotal: 0, plantedRejected: 0, items: null };
  const probe = left(STEP_MS.probe);
  const presence = await within(page.evaluate(() => typeof window.awwoSelfTest === 'function'), probe);
  if (presence.ok && !presence.value) return { ...result, present: false, ok: true };
  if (!presence.ok) {
    const clipped = probe < STEP_MS.probe ? ` (${probe} ms, what --budget-ms had left)` : ` (${probe} ms)`;
    return { ...result, present: null, error: presence.timedOut ? `the page did not answer while awwoSelfTest was looked up${clipped}` : firstLine(presence.error) };
  }
  const allowed = left(timeoutMs), started = Date.now();
  const outcome = await within(page.evaluate(async limit => {
    const json = JSON.stringify(await window.awwoSelfTest()) ?? 'null';
    return json.length > limit ? { tooLarge: json.length } : { json };
  }, MAX.selfTestJson), allowed);
  result.durationMs = Date.now() - started;
  if (outcome.timedOut) return { ...result, timedOut: true, error: `awwoSelfTest() did not settle within ${allowed} ms${allowed < timeoutMs ? ' (what --budget-ms had left)' : ''}` };
  if (!outcome.ok) return { ...result, error: `awwoSelfTest() threw: ${firstLine(outcome.error)}` };
  if (outcome.value.tooLarge) return { ...result, malformed: `the result is ${outcome.value.tooLarge} characters of JSON (limit ${MAX.selfTestJson})` };
  let items;
  try { items = validateSelfTest(JSON.parse(outcome.value.json)); } catch (error) { return { ...result, malformed: firstLine(error) }; }
  const passed = items.tests.filter(test => test.ok).length, plantedRejected = items.planted.filter(item => item.rejected).length;
  return { ...result, ok: passed === items.tests.length && plantedRejected === items.planted.length, passed, failed: items.tests.length - passed, plantedTotal: items.planted.length, plantedRejected, items };
}

// In a fresh context, so the page under test cannot affect it: pixel statistics of the screenshot downscaled 4x, and a
// smaller copy when the screenshot is over MAX.screenshotBytes, so a busy picture does not fill the workspace snapshot.
async function measure(browser, png) {
  const context = await browser.newContext();
  try {
    return await (await context.newPage()).evaluate(async ({ base64, limit }) => {
      const image = Object.assign(new Image(), { src: `data:image/png;base64,${base64}` });
      await image.decode();
      const draw = scale => {
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.naturalWidth * scale)), Math.max(1, Math.round(image.naturalHeight * scale)));
        const graphics = Object.assign(canvas.getContext('2d'), { imageSmoothingQuality: 'high' });
        graphics.drawImage(image, 0, 0, canvas.width, canvas.height);
        return { canvas, graphics };
      };
      const { canvas, graphics } = draw(1 / 4), data = graphics.getImageData(0, 0, canvas.width, canvas.height).data, colours = new Set();
      let sum = 0, squares = 0;
      for (let index = 0; index < data.length; index += 4) {
        colours.add(((data[index] >> 4) << 8) | ((data[index + 1] >> 4) << 4) | (data[index + 2] >> 4));
        const luma = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
        sum += luma; squares += luma * luma;
      }
      const count = data.length / 4, mean = sum / count, bytes = base64.length * 0.75;
      const scale = bytes > limit ? Math.max(1 / 8, Math.sqrt(limit / bytes) * 0.8) : 1; // PNG size roughly follows the pixel count
      const smaller = scale < 1 ? await draw(scale).canvas.convertToBlob({ type: 'image/png' }) : null;
      const written = smaller && await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(smaller); });
      const lumaStdDev = Math.round(Math.sqrt(Math.max(0, squares / count - mean * mean)) * 100) / 100;
      return { pixels: { sampleWidth: canvas.width, sampleHeight: canvas.height, distinctColours: colours.size, lumaStdDev }, scale, written };
    }, { base64: png.toString('base64'), limit: MAX.screenshotBytes });
  } finally { await context.close().catch(() => {}); }
}

// Serves the page's directory from ORIGIN and the library files AwwO's preview supplies, and blocks everything else.
// `listing` takes what the report lists (blocked and library requests, excused missing files); without it, as on the held
// clock's second load of the same page, nothing is listed.
async function routePage(context, root, listing) {
  const { block, served, missing } = listing ?? { block: () => {}, served: () => {}, missing: () => {} };
  // A request for a library file the preview supplies, at its version, answered from the image (CORS open: a page's
  // module imports are cross-origin); a .min.js names the same file, as in the preview. Any other file of that version
  // is blocked like every other request, with the reason, because the preview's page could not load it either.
  const library = async (route, url, type) => {
    const found = libraryFile(url, LIBRARIES);
    if (!found) return false;
    const { library: carried, file: supplied } = found;
    if (!supplied) {
      block(url.href, type, `not one of the ${carried.files.size} ${carried.name} ${carried.version} files AwwO's preview supplies`);
      await route.abort('blockedbyclient').catch(() => {});
      return true;
    }
    const target = await realpath(path.join(carried.root, supplied)).catch(() => '');
    const inside = target.startsWith(carried.root + path.sep);
    served(url.href, inside ? 200 : 404);
    await (inside ? route.fulfill({ path: target, headers: { 'access-control-allow-origin': '*', 'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream' } })
      : route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' })).catch(() => {});
    return true;
  };
  // A real origin, unlike file://, lets module imports, fetch and workers work: it serves the page's directory only.
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (/^(?:data|blob|about):$/.test(url.protocol)) return route.continue().catch(() => {});
    if (['GET', 'HEAD'].includes(request.method()) && await library(route, url, request.resourceType())) return;
    if (url.origin !== ORIGIN || !['GET', 'HEAD'].includes(request.method())) {
      block(request.url(), request.resourceType());
      return route.abort('blockedbyclient').catch(() => {});
    }
    let target = '';
    try { target = await realpath(path.join(root, decodeURIComponent(url.pathname))); } catch { /* missing or malformed: 404 */ }
    const inside = target === root || target.startsWith(root + path.sep);
    return (inside ? route.fulfill({ path: target }) : Promise.reject()).catch(() => {
      missing(url, request.resourceType());
      return route.fulfill({ status: 404, body: '' });
    }).catch(() => {});
  });
  await context.routeWebSocket(/.*/, socket => { block(socket.url(), 'websocket'); socket.close().catch(() => {}); });
}

async function checkPage(browser, file, out, options, report) {
  const root = await realpath(path.dirname(file));
  // allowedMissing: for each URL, how many excused 404s still have Chromium's console entry to come (one each).
  const missingOk = options.missingOk.map(globMatcher), allowedMissing = new Map();
  const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
  await routePage(context, root, {
    block: (url, type, reason) => {
      if (report.blockedRequests.length < MAX.blocked) report.blockedRequests.push({ url: clip(url, 500), type, ...(reason ? { reason } : {}) }); else report.blockedDropped += 1;
    },
    served: (url, status) => { if (report.libraryRequests.length < MAX.blocked) report.libraryRequests.push({ url: clip(url, 500), status }); else report.libraryRequestsDropped += 1; },
    // Data, a picture, sound, video or a font the caller said may be missing (--missing-ok, e.g. the models a sandbox
    // does not have) is listed, not counted; missing code (a script, a stylesheet, a worker) always counts. The URLs
    // excused are bounded, in number and length: past that, a missing file counts.
    missing: (url, type) => {
      let relative = '';
      try { relative = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { /* malformed: counted */ }
      if (relative && excusable(type, relative) && url.href.length <= MAX.allowedUrl && (allowedMissing.has(url.href) || allowedMissing.size < MAX.allowedMissing)
        && missingOk.some(matches => matches(relative))) {
        allowedMissing.set(url.href, (allowedMissing.get(url.href) ?? 0) + 1);
        if (report.missingAllowed.length < MAX.blocked) report.missingAllowed.push({ url: clip(url.href, 500), type }); else report.missingAllowedDropped += 1;
      }
    },
  });
  let phase = 'load';
  const note = (kind, message, handled = kind === 'console') => {
    // A self-test may exercise error paths that log or that it handles; its own verdict covers them, so it lists them only.
    report[handled && phase === 'selftest' ? 'listedOnlyCount' : 'errorCount'] += 1;
    if (report.errors.length < MAX.errors) report.errors.push({ kind, phase, message: clip(message) }); else report.errorsDropped += 1;
  };
  await context.exposeBinding('__awwoCheckCancelled', (_source, kind, message) => note(kind, `${message} (cancelled by the page)`, true));
  await context.addInitScript(CANCELLED_ERRORS);
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  // Runtime.exceptionThrown tells an uncaught exception ("Uncaught") from an unhandled rejection ("Uncaught (in promise)").
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: details }) => {
    const exception = details.exception ?? {}, body = exception.description ?? ('value' in exception ? String(exception.value) : details.text);
    const where = details.url ? ` (${details.url.split('/').pop()}:${details.lineNumber + 1}:${details.columnNumber + 1})` : '';
    note(/in promise/i.test(details.text) ? 'unhandledrejection' : 'uncaught', body.includes('\n    at ') ? body : body + where);
  });
  await cdp.send('Runtime.enable');
  page.on('console', message => {
    if (message.type() !== 'error' || /net::ERR_BLOCKED_BY_CLIENT/.test(message.text())) return;
    const { url, lineNumber } = message.location();
    // Chromium's own entry for an excused missing file: it comes with no arguments, which a page's console call has, and
    // each excused 404 takes one entry for its URL away, so a missing script at the same URL still counts once.
    const excused = allowedMissing.get(url) ?? 0;
    if (excused && !message.args().length && /status of 404/.test(message.text())) { allowedMissing.set(url, excused - 1); return; }
    note('console', url ? `${message.text()} (${url.split('/').pop()}:${lineNumber + 1})` : message.text());
  });
  page.on('crash', () => note('crash', 'the page crashed (it may have run out of memory)'));
  report.url = `${ORIGIN}/${encodeURIComponent(path.basename(file))}`;
  let started = Date.now(), bound = left(STEP_MS.load);
  const loaded = await within(page.goto(report.url, { waitUntil: 'load', timeout: bound }), bound + 500);
  // Playwright's own timeout (the bound) mostly fires before within's (the bound + 500 ms): either is the step's timeout.
  const timedOut = outcome => outcome.timedOut || outcome.error?.name === 'TimeoutError';
  const cut = (ms, allowed) => `${ms} ms${ms < allowed ? ', what --budget-ms had left' : ''}`;
  report.load = loaded.ok ? { ok: true } : { ok: false, error: timedOut(loaded) ? `the page did not load within ${cut(bound, STEP_MS.load)}` : firstLine(loaded.error) };
  Object.assign(report.timings, { loadMs: Date.now() - started, waitMs: report.load.ok ? left(options.waitMs, FINISH_MS + SCREENSHOT_RESERVE_MS) : 0 });
  await delay(report.timings.waitMs);
  // Screenshot first: the blank signal judges what the page draws on its own, and a hanging self-test cannot spoil it.
  const allowed = report.load.ok ? STEP_MS.screenshot : SCREENSHOT_RESERVE_MS;
  [started, bound] = [Date.now(), left(allowed)];
  const shot = await within(page.screenshot({ timeout: bound }), bound + 500);
  if (!shot.ok) report.screenshotError = timedOut(shot) ? `the screenshot timed out (${cut(bound, allowed)})` : firstLine(shot.error);
  report.timings.screenshotMs = Date.now() - started;
  // Whether the page is written for AwwO's renderer, which the held clock's pass checks it for: asked before the self-test
  // (which may hang) and, when the page was too busy to answer then, once more after it.
  const declares = async () => {
    const answer = await within(page.evaluate(() => [typeof window.renderAt, typeof window.renderAudio]), left(2000));
    if (answer.ok && Array.isArray(answer.value)) report.heldClock.declares = { renderAt: answer.value[0] === 'function', renderAudio: answer.value[1] === 'function' };
  };
  if (report.load.ok) {
    await declares();
    [phase, started] = ['selftest', Date.now()];
    report.selfTest = await runSelfTest(page, options.timeoutMs);
    report.timings.selfTestMs = Date.now() - started;
    if (!report.heldClock.declares) await declares();
  }
  // Closing the page first keeps its renderer and the measuring one from running at once (the container has 128 PIDs).
  await within(context.close(), left(2000, 0));
  if (!shot.ok) return;
  const measured = await within(measure(browser, shot.value), left(STEP_MS.probe, 500));
  if (!measured.ok) { report.measureError = `could not measure the screenshot: ${measured.timedOut ? 'timed out' : firstLine(measured.error)}`; return; }
  const { pixels, scale, written } = measured.value;
  Object.assign(report, { screenshot: path.join(out, 'screenshot.png'), screenshotScale: scale, pixels, blank: pixels.distinctColours <= 2 && pixels.lumaStdDev < 1 });
  await writeFile(report.screenshot, written ? Buffer.from(written, 'base64') : shot.value);
}

// Whether the held clock's pass runs, and why (report.heldClock.why).
function heldClockWanted(options, report) {
  const { declares } = report.heldClock;
  if (options.heldClock === 'off') return [false, '--no-held-clock'];
  if (!report.load.ok) return [false, 'the page did not load'];
  if (options.heldClock === 'on') return [true, '--held-clock'];
  if (!declares) return [false, 'the page did not answer whether it defines window.renderAt or window.renderAudio'];
  const names = ['renderAt', 'renderAudio'].filter(name => declares[name]).map(name => `window.${name}`);
  return names.length ? [true, `the page defines ${names.join(' and ')}`] : [false, 'the page defines neither window.renderAt nor window.renderAudio'];
}

// The page loaded once more for one of the renderer's two uses of it (`use`: 'frame' or 'sound'), in a fresh context on
// the clock AwwO's renderer gives it (virtual-time.mjs: its timers and animation frames run only when a frame is drawn),
// as the render worker opens a fresh page for a render and another for each sound, and waited on as the renderer waits,
// with its watch (held-clock.mjs): window.__ready, until it is true and up to READY_MS (a page held there is noted, not
// failed: the renderer renders it then, before it is ready), then window.renderAt(0), the first frame, or
// window.renderAudio({ seconds: 1, sampleRate: 48000 }). Answers what the page defines once it is ready, or null when it
// got no further.
async function heldVisit(browser, root, options, report, use) {
  const held = report.heldClock, name = use === 'frame' ? 'renderAt' : 'renderAudio', call = use === 'frame' ? 'window.renderAt(0)' : 'window.renderAudio';
  const viewport = use === 'sound' ? SOUND_VIEWPORT : { width: options.width, height: options.height };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
  try {
    await routePage(context, root, null);
    await context.addInitScript(VIRTUAL_TIME_SCRIPT);
    const opening = left(5000), page = await context.newPage(), watched = await openWatch(context, page, { timeoutMs: opening });
    // A watch that could not be opened, or that DevTools will not tell of Web Audio or media, never holds a page: the
    // check could only sit out its bounds and then say nothing true of a page held on its clock.
    if (!watched || !watched.activity.known) {
      const why = watched ? 'DevTools would not report the page\'s Web Audio or media'
        : `DevTools did not open its sessions within ${opening} ms${opening < 5000 ? ' (what --budget-ms had left)' : ''}`;
      held.unfinished = `the held clock could not be watched: ${why}`;
      return null;
    }
    const bound = left(STEP_MS.load);
    const loaded = await within(page.goto(report.url, { waitUntil: 'load', timeout: bound }), bound + 500);
    if (!loaded.ok) {
      held.unfinished = `the page did not load on the held clock: ${loaded.timedOut || loaded.error?.name === 'TimeoutError' ? `not within ${bound} ms` : firstLine(loaded.error)}`;
      return null;
    }
    await within(page.evaluate(() => document.fonts.ready.then(() => true)), left(STEP_MS.probe));
    // One of the renderer's waits, as a step of the report, and what `work` settled to: or that the page was held on its
    // clock (`held`, the renderer's reason), or that it ran out of `ms` (or what the budget had left).
    const wait = async (step, work, ms, kind) => {
      const watch = watchHeldClock(watched), from = Date.now(), allowed = left(ms);
      try {
        const outcome = await within(Promise.race([work.then(value => ({ value })), watch.held.then(waiting => ({ waiting }))]), allowed);
        const entry = { page: use, step, ms: Date.now() - from };
        held.steps.push(entry);
        if (outcome.ok && outcome.value.waiting) return [Object.assign(entry, { ok: false, waiting: outcome.value.waiting, held: heldClockMessage(kind, outcome.value.waiting) })];
        if (outcome.ok) return [Object.assign(entry, { ok: true }), outcome.value.value];
        if (outcome.timedOut) return [Object.assign(entry, { ok: false, unfinished: `${step} had not settled after ${allowed} ms${allowed < ms ? ' (what --budget-ms had left)' : ''}` })];
        return [Object.assign(entry, { ok: false, unfinished: `${step} could not be waited for: ${firstLine(outcome.error)}` })];
      } finally { watch.stop(); }
    };
    const asks = await within(page.evaluate(() => '__ready' in window), left(STEP_MS.probe));
    if (!asks.ok) return void (held.unfinished = 'the page did not answer on the held clock');
    if (asks.value) {
      // As the renderer waits: until it is true, for up to READY_MS, whatever the watch finds meanwhile (a page may turn
      // ready by work no watch can see); what it finds only words the note on a page that never did.
      const watch = watchHeldClock(watched), from = Date.now(), allowed = left(READY_MS);
      let waiting = null, ready = false, failed = null;
      watch.held.then(value => { waiting = value; });
      try {
        for (const until = from + allowed; !ready && Date.now() < until;) {
          const answer = await within(page.evaluate(() => window.__ready === true), Math.max(1, until - Date.now()));
          if (answer.ok && answer.value === true) ready = true;
          else if (answer.ok || answer.timedOut) await delay(100);
          else { failed = answer.error; break; }
        }
      } finally { watch.stop(); }
      const step = { page: use, step: 'window.__ready', ms: Date.now() - from, ok: ready, ...(!ready && waiting ? { waiting } : {}) };
      held.steps.push(step);
      if (failed) return void (held.unfinished = step.unfinished = `window.__ready could not be waited for: ${firstLine(failed)}`);
      if (!ready && allowed < READY_MS) return void (held.unfinished = step.unfinished = `window.__ready had not settled after ${allowed} ms (what --budget-ms had left)`);
      if (!ready) held.note ??= waiting ? heldClockMessage({ kind: 'ready' }, waiting) : `window.__ready was not true within ${READY_MS / 1000} s, where the renderer warns (ready_timeout) and renders on`;
    }
    const shape = await within(page.evaluate(() => [typeof window.renderAt, typeof window.renderAudio]), left(STEP_MS.probe));
    if (!shape.ok || !Array.isArray(shape.value)) return void (held.unfinished = 'the page did not answer on the held clock once it was ready');
    const defines = { renderAt: shape.value[0] === 'function', renderAudio: shape.value[1] === 'function' };
    if (!defines[name]) {
      // Defined in the first load, whose timers run, but not here when the renderer looks for it.
      if (held.declares?.[name]) {
        held.failure = `window.${name} is not defined on the held clock when the renderer looks for it (once the page has loaded and is ready), `
          + `though it was in the first load, whose timers run: the page defines it only after a timer or some other wait, so the renderer would ${use === 'frame' ? 'render the page without it' : 'refuse its sound'}.`;
      }
      return defines;
    }
    const [step, threw] = await wait(call, page.evaluate(async use => {
      try { await (use === 'frame' ? window.renderAt(0) : window.renderAudio({ seconds: 1, sampleRate: 48000 })); return null; } catch (error) { return String(error?.message ?? error).slice(0, 300); }
    }, use), HELD_STEP_MS, use === 'frame' ? { kind: 'renderAt', t: 0 } : { kind: 'renderAudio' });
    // The renderer counts a throw of renderAt as a page error on every frame it happens on, and refuses a sound whose
    // renderAudio throws.
    if (step.ok && typeof threw === 'string') Object.assign(step, { ok: false, failure: `${call} threw on the held clock: ${threw}` });
    if (step.held) held.failure = step.failure = step.held;
    else if (step.failure) held.failure = step.failure;
    else if (step.unfinished) held.unfinished = step.unfinished;
    return defines;
  } finally {
    await within(context.close(), left(2000, 0));
  }
}

// After the first load's page and measuring page are closed, one renderer at a time (the container has 128 PIDs): the
// first frame's page, where the page defines window.renderAt (or with --held-clock), then the sound's, where it defines
// window.renderAudio. The page fails when its renderAt(0) or renderAudio waits on nothing but its own clock, which the
// renderer refuses; when either throws there; or when the renderer would not find it. A wait cut short by HELD_STEP_MS
// or the budget is reported as not finished, and fails nothing.
async function checkHeldClock(browser, file, options, report) {
  const held = report.heldClock, started = Date.now();
  held.ran = true;
  try {
    const root = await realpath(path.dirname(file));
    let sound = Boolean(held.declares?.renderAudio);
    if (held.mode === 'on' || held.declares?.renderAt) {
      const defines = await heldVisit(browser, root, options, report, 'frame');
      if (held.mode === 'on' && defines?.renderAudio) sound = true;
    }
    if (sound && !held.failure && !held.unfinished) await heldVisit(browser, root, options, report, 'sound');
  } finally {
    held.ms = Date.now() - started;
  }
}

function verdict(report) {
  const test = report.selfTest;
  return [!report.load.ok && `the page did not load: ${report.load.error}`,
    report.errorCount && `${report.errorCount} page error${report.errorCount === 1 ? '' : 's'}`,
    (test.error || test.malformed) && `self-test: ${test.error ?? `malformed result: ${test.malformed}`}`,
    test.failed && `self-test: ${test.failed} of ${test.passed + test.failed} tests failed`,
    test.plantedRejected < test.plantedTotal && `self-test: ${test.plantedTotal - test.plantedRejected} of ${test.plantedTotal} planted variants were not rejected`,
    report.blank && 'blank render: the screenshot is a single flat colour',
    report.blank === null && !report.measureError && `no screenshot: ${report.screenshotError}`,
    report.heldClock.failure && `held clock: ${report.heldClock.failure}`].filter(Boolean);
}

function summary(report) {
  const relative = file => path.relative(process.cwd(), file) || '.', test = report.selfTest;
  const lines = [`awwo-check-page: ${report.verdict.toUpperCase()} ${relative(report.page)}${report.chromium ? ` (Chromium ${report.chromium.version})` : ''}, ${(report.timings.totalMs / 1000).toFixed(1)} s`,
    ...report.reasons.map(reason => `  - ${reason}`),
    ...report.errors.slice(0, 5).map(error => `  ${error.kind} [${error.phase}]: ${clip(error.message.replace(/\s+/g, ' '), 300)}`)];
  const unexpected = test.items ? [...test.items.tests.filter(entry => !entry.ok), ...test.items.planted.filter(entry => !entry.rejected)] : [];
  if (test.items) lines.push(`  self-test: ${test.passed}/${test.passed + test.failed} tests passed, ${test.plantedRejected}/${test.plantedTotal} planted variants rejected`,
    ...unexpected.slice(0, 5).map(item => `    not as expected: ${item.name}${item.detail ? ` (${clip(item.detail, 200)})` : ''}`));
  else if (test.present === false) lines.push('  self-test: none (window.awwoSelfTest is not defined)');
  if (report.pixels) lines.push(`  render: ${report.blank ? 'BLANK' : 'not blank'} (${report.pixels.distinctColours} colours, luma sd ${report.pixels.lumaStdDev})`);
  const held = report.heldClock, settled = [...new Set(held.steps.filter(step => step.ok).map(step => step.step))];
  if (held.ran && held.unfinished) lines.push(`  held clock: NOT FINISHED, ${held.unfinished}`);
  else if (held.ran && !held.failure) {
    const list = settled.length > 1 ? `${settled.slice(0, -1).join(', ')} and ${settled.at(-1)}` : settled[0];
    lines.push(`  held clock: ${list ? `${list} settled` : 'nothing for the renderer to wait on'} as AwwO's renderer runs the page`);
  } else if (!held.ran && (held.mode === 'on' || (held.mode === 'auto' && report.load.ok && !held.declares))) lines.push(`  held clock: not checked (${held.why})`);
  if (held.note) lines.push(`  held clock note: ${held.note}`);
  if (report.libraryRequests.length) lines.push(`  libraries: ${report.libraryRequests.length + report.libraryRequestsDropped} request(s) answered from the image's copy (${Object.entries(report.libraries).map(([name, version]) => `${name} ${version}`).join(', ')})`);
  const unsupplied = report.blockedRequests.filter(request => request.reason);
  if (unsupplied.length) lines.push(`  not supplied by AwwO's preview, so blocked: ${unsupplied.length} library file(s), first ${unsupplied[0].url}`);
  if (report.missingAllowed.length) lines.push(`  missing, allowed by --missing-ok: ${report.missingAllowed.length + report.missingAllowedDropped} file(s), first ${report.missingAllowed[0].url}`);
  if (report.blockedRequests.length) lines.push(`  network: ${report.blockedRequests.length + report.blockedDropped} request(s) blocked, first ${report.blockedRequests[0].url}`);
  if (report.reportFile) lines.push(`  report: ${relative(report.reportFile)}${report.screenshot ? `, screenshot: ${relative(report.screenshot)}` : ''}`);
  return lines.join('\n');
}

async function main(argv) {
  let options;
  try { options = parseArgs(argv); } catch (error) { if (error instanceof UsageError) { console.error(`awwo-check-page: ${error.message}\n${USAGE}`); return EXIT.usage; } throw error; }
  if (options.help) { console.log(HELP); return EXIT.pass; }
  deadline = performance.timeOrigin + options.budgetMs;
  const file = path.resolve(options.page), out = path.resolve(options.out), reportFile = path.join(out, 'report.json');
  // An earlier check's outputs go first, so no stale report survives a run that cannot write one.
  await Promise.all(['report.json', 'screenshot.png'].map(name => rm(path.join(out, name), { force: true }))).catch(() => {});
  if (!(await stat(file).catch(() => null))?.isFile()) { console.error(`awwo-check-page: no such file: ${options.page}\n${USAGE}`); return EXIT.usage; }
  const report = { tool: 'awwo-check-page', schemaVersion: 1, page: file, url: null, verdict: 'error', exitCode: EXIT.error, reasons: [], errorCount: 0,
    listedOnlyCount: 0, errors: [], errorsDropped: 0, blockedRequests: [], blockedDropped: 0,
    libraries: Object.fromEntries([...LIBRARIES.values()].map(library => [library.name, library.version])), libraryRequests: [], libraryRequestsDropped: 0,
    missingOk: options.missingOk, missingAllowed: [], missingAllowedDropped: 0,
    load: { ok: false },
    selfTest: { present: null, ok: false, passed: 0, failed: 0, plantedTotal: 0, plantedRejected: 0, items: null }, blank: null, pixels: null,
    heldClock: { mode: options.heldClock, declares: null, ran: false, why: null, steps: [], failure: null, unfinished: null, note: null },
    screenshot: null, viewport: { width: options.width, height: options.height }, timings: {}, chromium: null };
  const finish = () => {
    clearTimeout(watchdog); // set just below, before anything can finish
    report.timings.totalMs = Math.round(performance.now());
    try { writeFileSync(reportFile, `${JSON.stringify({ ...report, reportFile }, null, 2)}\n`); report.reportFile = reportFile; }
    catch (error) { console.error(`awwo-check-page: cannot write ${reportFile}: ${firstLine(error)}`); report.exitCode = EXIT.error; }
    console.log(summary(report));
    return report.exitCode;
  };
  let browser, scratch;
  // The last resort when a step without a bound of its own hangs: report, clean up and exit inside the command limit.
  const watchdog = setTimeout(async () => {
    Object.assign(report, { verdict: 'error', exitCode: EXIT.error, reasons: [...report.reasons, `the check ran out of its ${options.budgetMs} ms budget`] });
    const code = finish();
    if (browser) await within(browser.close(), 1000);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    process.exit(code);
  }, deadline - Date.now() + 1000).unref();
  try {
    await mkdir(out, { recursive: true });
    // Chromium's profile, caches and NSS database and Playwright's temporary files go to a private /tmp directory.
    scratch = await mkdtemp(path.join(tmpdir(), 'awwo-check-page-'));
    const home = path.join(scratch, 'home'), started = Date.now();
    process.env.TMPDIR = scratch;
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, chromiumSandbox: false, args: ARGS, timeout: left(STEP_MS.launch),
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache') },
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }).catch(error => { throw new Error(`Chromium did not start: ${firstLine(error)}`); });
    report.timings.launchMs = Date.now() - started;
    report.chromium = { version: browser.version(), executable: CHROMIUM };
    await checkPage(browser, file, out, options, report);
    // After the first load's page and measuring page are closed: one renderer at a time (the container has 128 PIDs).
    const [heldRuns, why] = heldClockWanted(options, report);
    report.heldClock.why = why;
    if (heldRuns) {
      await checkHeldClock(browser, file, options, report);
      report.timings.heldClockMs = report.heldClock.ms;
    }
    report.reasons = verdict(report);
    if (!report.reasons.length && report.measureError) throw new Error(report.measureError);
    // A check on the held clock that did not finish is not a pass: the page was not shown to render.
    Object.assign(report, report.reasons.length ? { verdict: 'fail', exitCode: EXIT.fail }
      : report.heldClock.unfinished ? { verdict: 'unfinished', exitCode: EXIT.unfinished } : { verdict: 'pass', exitCode: EXIT.pass });
  } catch (error) {
    report.reasons = [`the check could not run: ${firstLine(error)}`];
  } finally {
    if (browser) await within(browser.close(), left(2000, 0));
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return finish();
}

// Anything unexpected is the check failing, never the page: exit 3, not Node's 1.
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => { console.error(`awwo-check-page: ${firstLine(error)}`); process.exit(EXIT.error); });
process.exit(await main(process.argv.slice(2)).catch(error => { console.error(`awwo-check-page: ${firstLine(error)}`); return EXIT.error; }));
