#!/usr/bin/env node
// awwo-check-page: opens one HTML file in the image's Chromium with every network request blocked, then reports the
// page's errors, the result of its own self-test (window.awwoSelfTest) and whether it rendered anything at all.
// Protocol and report format: deploy/saas/workspace/README.md (the --help text carries the essentials).
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const CHROMIUM = '/usr/lib/chromium/chromium-headless-shell';
const EXIT = { pass: 0, fail: 1, usage: 2, error: 3 };
const MAX = { errors: 50, text: 2000, name: 200, items: 200, blocked: 50, selfTestJson: 1_000_000 };
// A sandbox command gets 30 s and overrunning it removes the whole container, so each step is bounded below that.
const STEP_MS = { launch: 15_000, load: 10_000, probe: 5_000, screenshot: 5_000, close: 5_000 };
const DEFAULTS = { out: 'check-out', waitMs: 1500, timeoutMs: 15_000, width: 1280, height: 800 };
const USAGE = 'usage: awwo-check-page <page.html> [--out <dir>] [--wait-ms N] [--timeout-ms N] [--viewport WxH]';
const HELP = `${USAGE}

Opens the page in headless Chromium with the network blocked (local files load; http, https and WebSocket
requests are aborted and listed), waits --wait-ms (1500), screenshots the viewport (--viewport, 1280x800),
then calls window.awwoSelfTest() if the page defines it, for at most --timeout-ms (15000). It must resolve to
  { tests: [{ name: string, ok: boolean, detail?: string }],
    planted?: [{ name: string, rejected: boolean, detail?: string }] }
where planted lists deliberately wrong variants of the code that the page's own tests must reject.
Uncaught errors, unhandled rejections and console.error count as page errors (console errors logged while
the self-test runs are only listed). Writes <out>/report.json and <out>/screenshot.png (out: ./check-out).
Exit 0: it loaded, no page errors, every test ok, every planted variant rejected, not blank.
1: the page failed. 2: usage error. 3: the check itself could not run (for example Chromium did not start).`;
// The container is the sandbox: Chromium's own needs user namespaces or setuid, which the container drops
// (Playwright adds --no-sandbox). WebGL runs on SwiftShader. Name resolution and proxies are off as a second wall
// behind the request router.
const ARGS = ['--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--hide-scrollbars', '--force-color-profile=srgb', '--no-first-run', '--no-default-browser-check',
  '--host-resolver-rules=MAP * ~NOTFOUND', '--no-proxy-server', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];

class UsageError extends Error {}
const clip = (value, limit = MAX.text) => { const text = String(value); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const firstLine = error => clip(String(error?.message ?? error).replace(/^\w+\.\w+: /, '').split('\n')[0], 500);
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const integer = (flag, raw, min, max) => {
    if (!/^\d+$/.test(raw ?? '') || Number(raw) < min || Number(raw) > max) throw new UsageError(`${flag} takes an integer from ${min} to ${max}`);
    return Number(raw);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].startsWith('--') ? argv[index].split(/=(.*)/s, 2) : [argv[index]];
    const value = () => inline ?? argv[++index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--out') {
      options.out = value();
      if (!options.out) throw new UsageError('--out takes a directory');
    } else if (flag === '--wait-ms') options.waitMs = integer(flag, value(), 0, 60_000);
    else if (flag === '--timeout-ms') options.timeoutMs = integer(flag, value(), 100, 600_000);
    else if (flag === '--viewport') {
      const match = /^(\d{2,4})x(\d{2,4})$/.exec(value() ?? '');
      if (!match || [match[1], match[2]].some(side => Number(side) < 64 || Number(side) > 4096)) throw new UsageError('--viewport takes WIDTHxHEIGHT, each 64 to 4096');
      [options.width, options.height] = [Number(match[1]), Number(match[2])];
    } else if (flag.startsWith('-')) throw new UsageError(`unknown option ${flag}`);
    else if (options.page === undefined) options.page = flag;
    else throw new UsageError('give one page');
  }
  if (options.page === undefined) throw new UsageError('missing <page.html>');
  return options;
}

// Settles to { ok, value } / { ok: false, error } / { ok: false, timedOut } within ms; a late rejection is swallowed.
async function within(promise, ms) {
  const timer = new AbortController();
  promise.catch(() => {});
  try {
    return await Promise.race([promise.then(value => ({ ok: true, value }), error => ({ ok: false, error })),
      delay(ms, { ok: false, timedOut: true }, { signal: timer.signal }).catch(() => ({ ok: false, timedOut: true }))]);
  } finally { timer.abort(); }
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
  const tests = entries(value.tests, 'ok', 'tests');
  if (!tests.length) throw new Error('"tests" is empty');
  return { tests, planted: value.planted === undefined ? [] : entries(value.planted, 'rejected', 'planted') };
}

async function runSelfTest(page, timeoutMs) {
  const result = { present: true, ok: false, passed: 0, failed: 0, plantedTotal: 0, plantedRejected: 0, items: null };
  const presence = await within(page.evaluate(() => typeof window.awwoSelfTest === 'function'), STEP_MS.probe);
  if (presence.ok && !presence.value) return { ...result, present: false, ok: true };
  if (!presence.ok) return { ...result, present: null, error: presence.timedOut ? 'the page stopped responding before awwoSelfTest could be looked up' : firstLine(presence.error) };
  const started = Date.now();
  const outcome = await within(page.evaluate(async limit => {
    const json = JSON.stringify(await window.awwoSelfTest()) ?? 'null';
    return json.length > limit ? { tooLarge: json.length } : { json };
  }, MAX.selfTestJson), timeoutMs);
  result.durationMs = Date.now() - started;
  if (outcome.timedOut) return { ...result, timedOut: true, error: `awwoSelfTest() did not settle within ${timeoutMs} ms` };
  if (!outcome.ok) return { ...result, error: `awwoSelfTest() threw: ${firstLine(outcome.error)}` };
  if (outcome.value.tooLarge) return { ...result, malformed: `the result is ${outcome.value.tooLarge} characters of JSON (limit ${MAX.selfTestJson})` };
  let items;
  try { items = validateSelfTest(JSON.parse(outcome.value.json)); } catch (error) { return { ...result, malformed: firstLine(error) }; }
  const passed = items.tests.filter(test => test.ok).length, plantedRejected = items.planted.filter(item => item.rejected).length;
  return { ...result, ok: passed === items.tests.length && plantedRejected === items.planted.length, passed,
    failed: items.tests.length - passed, plantedTotal: items.planted.length, plantedRejected, items };
}

// Pixel statistics of the screenshot downscaled 4x with smoothing, measured in a fresh context so that the page under
// test (its routes, its errors, a busy main thread) cannot affect them.
async function pixelStats(browser, png) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await page.evaluate(async base64 => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const width = Math.max(1, Math.round(image.naturalWidth / 4)), height = Math.max(1, Math.round(image.naturalHeight / 4));
      const graphics = new OffscreenCanvas(width, height).getContext('2d');
      graphics.imageSmoothingQuality = 'high';
      graphics.drawImage(image, 0, 0, width, height);
      const data = graphics.getImageData(0, 0, width, height).data, colours = new Set();
      let sum = 0, squares = 0;
      for (let index = 0; index < data.length; index += 4) {
        colours.add(((data[index] >> 4) << 8) | ((data[index + 1] >> 4) << 4) | (data[index + 2] >> 4));
        const luma = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
        sum += luma; squares += luma * luma;
      }
      const count = data.length / 4, mean = sum / count;
      return { sampleWidth: width, sampleHeight: height, distinctColours: colours.size,
        lumaStdDev: Math.round(Math.sqrt(Math.max(0, squares / count - mean * mean)) * 100) / 100 };
    }, png.toString('base64'));
  } finally { await context.close().catch(() => {}); }
}

async function checkPage(browser, file, out, options, report) {
  const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1,
    serviceWorkers: 'block', acceptDownloads: false });
  const block = (url, type) => {
    if (report.blockedRequests.length < MAX.blocked) report.blockedRequests.push({ url: clip(url, 500), type });
    else report.blockedDropped += 1;
  };
  // Local files (the page and what sits next to it) load; any network URL is aborted.
  await context.route('**/*', route => {
    const request = route.request();
    if (/^(?:file|data|blob|about):/i.test(request.url())) return route.continue().catch(() => {});
    block(request.url(), request.resourceType());
    return route.abort('blockedbyclient').catch(() => {});
  });
  await context.routeWebSocket(/.*/, socket => { block(socket.url(), 'websocket'); socket.close().catch(() => {}); });
  const page = await context.newPage();
  let phase = 'load';
  const note = (kind, message) => {
    // A self-test may exercise error paths that log; its own verdict covers them, so they are listed but not counted.
    if (kind === 'console' && phase === 'selftest') report.selfTestConsoleErrorCount += 1;
    else report.errorCount += 1;
    if (report.errors.length < MAX.errors) report.errors.push({ kind, phase, message: clip(message) });
    else report.errorsDropped += 1;
  };
  // Runtime.exceptionThrown tells an uncaught exception ("Uncaught") from an unhandled rejection ("Uncaught (in promise)").
  const cdp = await context.newCDPSession(page);
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: details }) => {
    const exception = details.exception ?? {};
    const body = exception.description ?? ('value' in exception ? String(exception.value) : details.text);
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

  let started = Date.now();
  const loaded = await within(page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: STEP_MS.load }), STEP_MS.load + 1000);
  report.load = loaded.ok ? { ok: true } : { ok: false, error: loaded.timedOut ? `the page did not load within ${STEP_MS.load} ms` : firstLine(loaded.error) };
  report.timings.loadMs = Date.now() - started;
  if (report.load.ok) await delay(options.waitMs);
  report.timings.waitMs = report.load.ok ? options.waitMs : 0;
  // The screenshot comes before the self-test: the blank signal judges what the page draws on its own, and a
  // self-test that hangs the page cannot take the screenshot with it.
  started = Date.now();
  const screenshot = path.join(out, 'screenshot.png');
  const shot = await within(page.screenshot({ path: screenshot, timeout: STEP_MS.screenshot }), STEP_MS.screenshot + 1000);
  if (!shot.ok) report.screenshotError = shot.timedOut ? 'the screenshot timed out' : firstLine(shot.error);
  report.timings.screenshotMs = Date.now() - started;
  if (report.load.ok) {
    phase = 'selftest';
    started = Date.now();
    report.selfTest = await runSelfTest(page, options.timeoutMs);
    report.timings.selfTestMs = Date.now() - started;
  }
  // Closing the page first keeps its renderer and the measuring one from running at once (the container has 128 PIDs).
  await within(context.close(), STEP_MS.close);
  if (shot.ok) {
    const measured = await within(pixelStats(browser, shot.value), STEP_MS.probe);
    if (!measured.ok) throw new Error(`could not measure the screenshot: ${measured.timedOut ? 'timed out' : firstLine(measured.error)}`);
    report.screenshot = screenshot;
    report.pixels = measured.value;
    report.blank = report.pixels.distinctColours <= 2 && report.pixels.lumaStdDev < 1;
  }
}

function verdict(report) {
  const reasons = [], test = report.selfTest;
  if (!report.load.ok) reasons.push(`the page did not load: ${report.load.error}`);
  if (report.errorCount) reasons.push(`${report.errorCount} page error${report.errorCount === 1 ? '' : 's'}`);
  if (test.error || test.malformed) reasons.push(`self-test: ${test.error ?? `malformed result: ${test.malformed}`}`);
  if (test.failed) reasons.push(`self-test: ${test.failed} of ${test.passed + test.failed} tests failed`);
  if (test.plantedRejected < test.plantedTotal) reasons.push(`self-test: ${test.plantedTotal - test.plantedRejected} of ${test.plantedTotal} planted variants were not rejected`);
  if (report.blank) reasons.push('blank render: the screenshot is a single flat colour');
  if (report.blank === null) reasons.push(`no screenshot: ${report.screenshotError}`);
  return reasons;
}

function summary(report) {
  const relative = file => path.relative(process.cwd(), file) || '.';
  const test = report.selfTest, lines = [`awwo-check-page: ${report.verdict.toUpperCase()} ${relative(report.page)}`
    + `${report.chromium ? ` (Chromium ${report.chromium.version})` : ''}, ${(report.timings.totalMs / 1000).toFixed(1)} s`];
  for (const reason of report.reasons) lines.push(`  - ${reason}`);
  for (const error of report.errors.slice(0, 5)) lines.push(`  ${error.kind} [${error.phase}]: ${clip(error.message.replace(/\s+/g, ' '), 300)}`);
  if (test.items) {
    lines.push(`  self-test: ${test.passed}/${test.passed + test.failed} tests passed, ${test.plantedRejected}/${test.plantedTotal} planted variants rejected`);
    for (const item of [...test.items.tests.filter(entry => !entry.ok), ...test.items.planted.filter(entry => !entry.rejected)].slice(0, 5)) {
      lines.push(`    not as expected: ${item.name}${item.detail ? ` (${clip(item.detail, 200)})` : ''}`);
    }
  } else if (test.present === false) lines.push('  self-test: none (window.awwoSelfTest is not defined)');
  if (report.pixels) lines.push(`  render: ${report.blank ? 'BLANK' : 'not blank'} (${report.pixels.distinctColours} colours, luma sd ${report.pixels.lumaStdDev})`);
  if (report.blockedRequests.length) lines.push(`  network: ${report.blockedRequests.length + report.blockedDropped} request(s) blocked, first ${report.blockedRequests[0].url}`);
  if (report.reportFile) lines.push(`  report: ${relative(report.reportFile)}${report.screenshot ? `, screenshot: ${relative(report.screenshot)}` : ''}`);
  return lines.join('\n');
}

async function main(argv) {
  let options;
  try { options = parseArgs(argv); } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`awwo-check-page: ${error.message}\n${USAGE}`);
    return EXIT.usage;
  }
  if (options.help) { console.log(HELP); return EXIT.pass; }
  const file = path.resolve(options.page), out = path.resolve(options.out);
  if (!(await stat(file).catch(() => null))?.isFile()) { console.error(`awwo-check-page: no such file: ${options.page}\n${USAGE}`); return EXIT.usage; }
  const begun = Date.now();
  const report = { tool: 'awwo-check-page', schemaVersion: 1, page: file, verdict: 'error', exitCode: EXIT.error, reasons: [],
    errorCount: 0, selfTestConsoleErrorCount: 0, errors: [], errorsDropped: 0, blockedRequests: [], blockedDropped: 0,
    load: { ok: false }, selfTest: { present: null, ok: false, passed: 0, failed: 0, plantedTotal: 0, plantedRejected: 0, items: null },
    blank: null, pixels: null, screenshot: null, viewport: { width: options.width, height: options.height }, timings: {}, chromium: null };
  // Chromium's profile, caches and NSS database, and Playwright's own temporary directories (os.tmpdir() reads TMPDIR),
  // go to a private directory under /tmp that is removed afterwards, never into the workspace.
  const scratch = await mkdtemp(path.join(tmpdir(), 'awwo-check-page-'));
  const home = path.join(scratch, 'home');
  process.env.TMPDIR = scratch;
  let browser;
  try {
    await mkdir(out, { recursive: true });
    const started = Date.now();
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, chromiumSandbox: false, args: ARGS, timeout: STEP_MS.launch,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache') },
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false })
      .catch(error => { throw new Error(`Chromium did not start: ${firstLine(error)}`); });
    report.timings.launchMs = Date.now() - started;
    report.chromium = { version: browser.version(), executable: CHROMIUM };
    await checkPage(browser, file, out, options, report);
    report.reasons = verdict(report);
    report.verdict = report.reasons.length ? 'fail' : 'pass';
    report.exitCode = report.reasons.length ? EXIT.fail : EXIT.pass;
  } catch (error) {
    report.reasons = [`the check could not run: ${firstLine(error)}`];
  } finally {
    if (browser) await within(browser.close(), STEP_MS.close);
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  report.timings.totalMs = Date.now() - begun;
  const reportFile = path.join(out, 'report.json');
  try {
    await writeFile(reportFile, `${JSON.stringify({ ...report, reportFile }, null, 2)}\n`);
    report.reportFile = reportFile;
  } catch (error) {
    console.error(`awwo-check-page: cannot write ${reportFile}: ${firstLine(error)}`);
    report.exitCode = EXIT.error;
  }
  console.log(summary(report));
  return report.exitCode;
}

process.exit(await main(process.argv.slice(2)).catch(error => { console.error(`awwo-check-page: ${firstLine(error)}`); return EXIT.error; }));
