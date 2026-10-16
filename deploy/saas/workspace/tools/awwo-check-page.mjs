#!/usr/bin/env node
// awwo-check-page: serves an HTML page and its directory to the image's Chromium from a private https origin, blocks every
// other request, and reports the page's errors, its own self-test (window.awwoSelfTest) and whether it rendered anything.
// Protocol and report: deploy/saas/workspace/README.md.
import { rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const CHROMIUM = '/usr/lib/chromium/chromium-headless-shell';
const ORIGIN = 'https://awwo-check.invalid';
const EXIT = { pass: 0, fail: 1, usage: 2, error: 3 };
const MAX = { errors: 50, text: 2000, name: 200, items: 200, blocked: 50, selfTestJson: 1_000_000, screenshotBytes: 400_000 };
// A sandbox command gets 30 s (120 s when the workspace has the web) and is stopped when it overruns. So each step has its
// own bound and also fits the --budget-ms counted from process start, less FINISH_MS kept back for closing and writing the report.
const STEP_MS = { launch: 15_000, load: 10_000, probe: 5_000, screenshot: 5_000 };
const FINISH_MS = 3000;
const DEFAULTS = { out: 'check-out', waitMs: 1500, timeoutMs: 15_000, budgetMs: 25_000, width: 1280, height: 800 };
const NUMBERS = { '--wait-ms': ['waitMs', 0, 60_000], '--timeout-ms': ['timeoutMs', 100, 600_000], '--budget-ms': ['budgetMs', 5000, 900_000] };
const USAGE = 'usage: awwo-check-page <page.html> [--out <dir>] [--wait-ms N] [--timeout-ms N] [--budget-ms N] [--viewport WxH]';
const HELP = `${USAGE}
Serves the page and the files of its directory from a private https origin to headless Chromium (any other request is blocked
and listed), waits --wait-ms (1500), screenshots the viewport (1280x800) and calls window.awwoSelfTest(), if the page defines it,
for at most --timeout-ms (15000). It must resolve to { tests: [{ name, ok: boolean, detail? }], planted?: [{ name, rejected:
boolean, detail? }] }, planted listing deliberately wrong variants of the code that the page's own tests must reject. Uncaught
errors, unhandled rejections (cancelled ones too) and console.error fail the page; while the self-test runs, console errors and
errors the page cancels are only listed. The check ends within --budget-ms (25000). Writes <out>/report.json and <out>/screenshot.png (out: ./check-out).
Exit 0: pass. 1: the page failed (an error, a test, a planted variant, a blank render). 2: usage. 3: the check could not run.`;
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
    if (flag === '--out') options.out = value() || '';
    else if (NUMBERS[flag]) {
      const [key, min, max] = NUMBERS[flag], raw = value() ?? '';
      if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new UsageError(`${flag} takes an integer from ${min} to ${max}`);
      options[key] = Number(raw);
    } else if (flag === '--viewport') {
      const match = /^(\d{2,4})x(\d{2,4})$/.exec(value() ?? '');
      if (!match || [match[1], match[2]].some(side => Number(side) < 64 || Number(side) > 2560)) throw new UsageError('--viewport takes WIDTHxHEIGHT, each 64 to 2560');
      [options.width, options.height] = [Number(match[1]), Number(match[2])];
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
  const presence = await within(page.evaluate(() => typeof window.awwoSelfTest === 'function'), left(STEP_MS.probe));
  if (presence.ok && !presence.value) return { ...result, present: false, ok: true };
  if (!presence.ok) return { ...result, present: null, error: presence.timedOut ? 'the page stopped responding before awwoSelfTest could be looked up' : firstLine(presence.error) };
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

async function checkPage(browser, file, out, options, report) {
  const root = await realpath(path.dirname(file));
  const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
  const block = (url, type) => { if (report.blockedRequests.length < MAX.blocked) report.blockedRequests.push({ url: clip(url, 500), type }); else report.blockedDropped += 1; };
  // A real origin, unlike file://, lets module imports, fetch and workers work: it serves the page's directory only.
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (/^(?:data|blob|about):$/.test(url.protocol)) return route.continue().catch(() => {});
    if (url.origin !== ORIGIN || !['GET', 'HEAD'].includes(request.method())) {
      block(request.url(), request.resourceType());
      return route.abort('blockedbyclient').catch(() => {});
    }
    let target = '';
    try { target = await realpath(path.join(root, decodeURIComponent(url.pathname))); } catch { /* missing or malformed: 404 */ }
    const inside = target === root || target.startsWith(root + path.sep);
    return (inside ? route.fulfill({ path: target }) : Promise.reject()).catch(() => route.fulfill({ status: 404, body: '' })).catch(() => {});
  });
  await context.routeWebSocket(/.*/, socket => { block(socket.url(), 'websocket'); socket.close().catch(() => {}); });
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
    note('console', url ? `${message.text()} (${url.split('/').pop()}:${lineNumber + 1})` : message.text());
  });
  page.on('crash', () => note('crash', 'the page crashed (it may have run out of memory)'));
  report.url = `${ORIGIN}/${encodeURIComponent(path.basename(file))}`;
  let started = Date.now(), bound = left(STEP_MS.load);
  const loaded = await within(page.goto(report.url, { waitUntil: 'load', timeout: bound }), bound + 500);
  report.load = loaded.ok ? { ok: true } : { ok: false, error: loaded.timedOut ? `the page did not load within ${bound} ms` : firstLine(loaded.error) };
  Object.assign(report.timings, { loadMs: Date.now() - started, waitMs: report.load.ok ? left(options.waitMs, FINISH_MS + STEP_MS.screenshot) : 0 });
  await delay(report.timings.waitMs);
  // Screenshot first: the blank signal judges what the page draws on its own, and a hanging self-test cannot spoil it.
  [started, bound] = [Date.now(), left(STEP_MS.screenshot)];
  const shot = await within(page.screenshot({ timeout: bound }), bound + 500);
  if (!shot.ok) report.screenshotError = shot.timedOut ? 'the screenshot timed out' : firstLine(shot.error);
  report.timings.screenshotMs = Date.now() - started;
  if (report.load.ok) {
    [phase, started] = ['selftest', Date.now()];
    report.selfTest = await runSelfTest(page, options.timeoutMs);
    report.timings.selfTestMs = Date.now() - started;
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

function verdict(report) {
  const test = report.selfTest;
  return [!report.load.ok && `the page did not load: ${report.load.error}`,
    report.errorCount && `${report.errorCount} page error${report.errorCount === 1 ? '' : 's'}`,
    (test.error || test.malformed) && `self-test: ${test.error ?? `malformed result: ${test.malformed}`}`,
    test.failed && `self-test: ${test.failed} of ${test.passed + test.failed} tests failed`,
    test.plantedRejected < test.plantedTotal && `self-test: ${test.plantedTotal - test.plantedRejected} of ${test.plantedTotal} planted variants were not rejected`,
    report.blank && 'blank render: the screenshot is a single flat colour',
    report.blank === null && !report.measureError && `no screenshot: ${report.screenshotError}`].filter(Boolean);
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
    listedOnlyCount: 0, errors: [], errorsDropped: 0, blockedRequests: [], blockedDropped: 0, load: { ok: false },
    selfTest: { present: null, ok: false, passed: 0, failed: 0, plantedTotal: 0, plantedRejected: 0, items: null }, blank: null, pixels: null,
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
    report.reasons = verdict(report);
    if (!report.reasons.length && report.measureError) throw new Error(report.measureError);
    Object.assign(report, report.reasons.length ? { verdict: 'fail', exitCode: EXIT.fail } : { verdict: 'pass', exitCode: EXIT.pass });
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
