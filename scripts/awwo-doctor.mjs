#!/usr/bin/env node
// AwwO environment doctor for local SaaS development and the render worker.
//
// Usage: node scripts/awwo-doctor.mjs [--json]
// One row per check: check, status (ok | warn | fail), detail, how to fix. The exit code is 1 only when a check
// fails; warnings never fail. The checks only observe:
//   - child processes run through execFile (never a shell) with a 5 s timeout and an environment from which
//     AWWO_*, AWS_*, OTEL_* and secret-looking variables are removed;
//   - the Go check runs with GOPROXY=off, so it can report a missing toolchain but never start a download;
//   - the database check opens a TCP connection to AWWO_DATABASE_URL's host:port and closes it without
//     sending a byte, so no credential leaves this process, and the URL itself is never printed;
//   - .local/awwo-saas/.env is checked for presence only and never read;
//   - Chrome is never executed on Windows (there `chrome --version` opens a browser instead of printing).
//
// Dependency-free on purpose: it is what you run when `npm ci` or the toolchain is the problem.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand } from './awwo-saas-lib.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROBE_TIMEOUT_MS = 5000;
export const DATABASE_TIMEOUT_MS = 2000;
export const STATUSES = Object.freeze(['ok', 'warn', 'fail']);
/** Packages whose node_modules npm run dev:saas needs (required) or the render worker needs (optional). */
export const PACKAGE_DIRECTORIES = Object.freeze([
  { dir: 'apps/web', required: true },
  { dir: 'apps/pi-worker', required: true },
  { dir: 'apps/openai-agents-worker', required: true },
  { dir: 'apps/render-worker', required: false },
]);

// ---------- pure helpers ----------

/** "v22.16.0", "go1.27.1", "24", "1.28rc1" -> {major, minor, patch, prerelease}; null when there is no number. */
export function parseVersion(text) {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:-|\.)?(?:rc|beta|alpha|pre)\w*)?/i.exec(String(text ?? ''));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0), prerelease: Boolean(match[4]) };
}

/** -1, 0 or 1; a prerelease sorts before the release with the same numbers. */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease ? -1 : 1;
}

/** The minimum of an engines range written as ">=x[.y[.z]]"; null for any other form, which is not guessed at. */
export function parseMinimumVersion(range) {
  const match = /^\s*>=\s*v?(\d+(?:\.\d+){0,2})\s*$/.exec(String(range ?? ''));
  return match ? parseVersion(match[1]) : null;
}

/** The `go` directive of a go.mod ("1.27.1"), or null. */
export function parseGoModVersion(text) {
  return /^go\s+(\d+\.\d+(?:\.\d+)?(?:rc\d+)?)\s*$/m.exec(String(text ?? ''))?.[1] ?? null;
}

/** "go version go1.27.1 windows/amd64" -> "1.27.1"; also reads devel builds ("go1.28-abcdef"). */
export function parseGoVersionOutput(text) {
  return /\bgo(\d+\.\d+(?:\.\d+)?(?:(?:rc|beta)\d+)?)/.exec(String(text ?? ''))?.[1] ?? null;
}

/** The Node major version awwo-saas-dev.mjs refuses to run below, read from its own check; null if absent. */
export function parseDevNodeRequirement(source) {
  const match = /process\.versions\.node\.split\(\s*['"]\.['"]\s*\)\[0\]\)\s*<\s*(\d+)/.exec(String(source ?? ''));
  return match ? Number(match[1]) : null;
}

export function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
}

/** The useful part of a `-version` banner: "ffmpeg version 8.0.1 Copyright (c) ..." -> "ffmpeg version 8.0.1". */
export function versionLine(text) {
  return firstLine(text).replace(/\s+Copyright\b.*$/i, '');
}

function stripQuotes(value) {
  return value.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// libpq URIs allow forms WHATWG URL rejects (an empty host before ?host=/socket), so the authority is read by
// hand: postgres://[user[:password]@][host[:port][,host2...]][/database][?params].
function urlAddress(text) {
  const queryStart = text.indexOf('?');
  const query = queryStart < 0 ? '' : text.slice(queryStart + 1).split('#')[0];
  const queryHost = new URLSearchParams(query).get('host');
  if (queryHost && queryHost.startsWith('/')) return { socket: true };
  const authority = /^postgres(?:ql)?:\/\/([^/?#]*)/i.exec(text)[1];
  const hosts = authority.slice(authority.lastIndexOf('@') + 1);
  if (!hosts) return queryHost ? { host: queryHost, port: 5432 } : { socket: true };
  const first = hosts.split(',')[0];
  const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(first) ?? /^([^:[\]]+)(?::(\d+))?$/.exec(first);
  if (!match) return { error: 'not a valid postgres:// URL' };
  const host = safeDecode(match[1]);
  if (host.startsWith('/')) return { socket: true };
  return { host, port: match[2] ? Number(match[2]) : 5432, ...(hosts.includes(',') ? { firstOfSeveral: true } : {}) };
}

/**
 * Where a PostgreSQL connection string points: {host, port}, {socket: true} for a Unix socket, or {error}.
 * Nothing derived from the user, password or the rest of the string is ever returned.
 */
export function databaseAddress(value) {
  const text = String(value ?? '').trim();
  if (!text) return { error: 'empty' };
  if (/^postgres(?:ql)?:\/\//i.test(text)) return urlAddress(text);
  const host = /(?:^|\s)host\s*=\s*('[^']*'|"[^"]*"|\S+)/.exec(text)?.[1];
  const port = /(?:^|\s)port\s*=\s*'?(\d+)'?/.exec(text)?.[1];
  if (!host) return { error: 'no host= in the connection string' };
  const unquoted = stripQuotes(host);
  if (unquoted.startsWith('/')) return { socket: true };
  return { host: unquoted, port: port ? Number(port) : 5432 };
}

export function formatAddress({ host, port }) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Reads an environment variable; on Windows names are case-insensitive, as they are for the OS. */
export function envValue(env, name, platform = process.platform) {
  if (Object.hasOwn(env, name)) return env[name];
  if (platform !== 'win32') return undefined;
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|DATABASE_URL|DSN/i;
const SERVICE_PREFIX = /^(?:AWWO_|VITE_AWWO_|AWS_|OTEL_)/i;

/** The environment probe processes get: everything but AwwO, AWS and telemetry settings and secret-looking names. */
export function probeEnvironment(env) {
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || SERVICE_PREFIX.test(name) || SECRET_NAME.test(name)) continue;
    result[name] = value;
  }
  return result;
}

/** The first executable named `name` on PATH, or null. Windows looks for .exe and .com (what runs without a shell). */
export function findOnPath(name, { env, platform, isFile }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32' && !paths.extname(name) ? ['.exe', '.com'] : [''];
  for (const raw of String(envValue(env, 'PATH', platform) ?? '').split(delimiter)) {
    const directory = stripQuotes(raw.trim());
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = paths.join(directory, `${name}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Usual install locations of Chrome and Chromium, most common first. */
export function chromeCandidates(platform, env) {
  if (platform === 'win32') {
    const join = path.win32.join;
    const programFiles = envValue(env, 'ProgramFiles', platform) || 'C:\\Program Files';
    const programFilesX86 = envValue(env, 'ProgramFiles(x86)', platform) || 'C:\\Program Files (x86)';
    const localAppData = envValue(env, 'LOCALAPPDATA', platform);
    return [
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...(localAppData ? [join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(localAppData, 'Chromium', 'Application', 'chrome.exe')] : []),
    ];
  }
  if (platform === 'darwin') {
    const home = envValue(env, 'HOME', platform);
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ...(home ? [path.posix.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')] : []),
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium', '/opt/google/chrome/chrome'];
}

/** Counts per status and the exit code: 1 only when something failed. */
export function summarize(rows) {
  const counts = Object.fromEntries(STATUSES.map(status => [status, rows.filter(row => row.status === status).length]));
  return { ...counts, exitCode: counts.fail > 0 ? 1 : 0 };
}

/** Greedy word wrap; a word longer than the width (a path, say) is split across lines. Always returns a line. */
export function wrapText(text, width) {
  const lines = [];
  let current = '';
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > width) {
      if (current) lines.push(current);
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
      current = '';
    }
    if (!current) current = rest;
    else if (current.length + 1 + rest.length <= width) current += ` ${rest}`;
    else {
      lines.push(current);
      current = rest;
    }
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}

/** A plain-text table with wrapped detail and fix columns. */
export function formatTable(rows, { detailWidth = 56, fixWidth = 48 } = {}) {
  const checkWidth = Math.max('CHECK'.length, ...rows.map(row => row.check.length));
  const statusWidth = Math.max('STATUS'.length, ...rows.map(row => row.status.length));
  const lines = [];
  const render = (check, status, detail, fix) => {
    const height = Math.max(detail.length, fix.length);
    for (let index = 0; index < height; index += 1) {
      const cells = [index ? '' : check, index ? '' : status, detail[index] ?? '', fix[index] ?? ''];
      lines.push(`${cells[0].padEnd(checkWidth)}  ${cells[1].padEnd(statusWidth)}  ${cells[2].padEnd(detailWidth)}  ${cells[3]}`.trimEnd());
    }
  };
  render('CHECK', 'STATUS', ['DETAIL'], ['HOW TO FIX']);
  lines.push([checkWidth, statusWidth, detailWidth, fixWidth].map(width => '-'.repeat(width)).join('  '));
  for (const row of rows) render(row.check, row.status, wrapText(row.detail, detailWidth), wrapText(row.fix, fixWidth));
  return `${lines.join('\n')}\n`;
}

// ---------- checks (each takes the context and returns one row) ----------

const row = (check, status, detail, fix = '') => ({ check, status, detail, fix });

function readJson(ctx, relative) {
  const text = ctx.readText(path.join(ctx.root, relative));
  if (text == null) return { missing: true };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { invalid: true };
  }
}

export async function checkNode(ctx) {
  const actual = parseVersion(ctx.nodeVersion);
  const engines = readJson(ctx, 'apps/pi-worker/package.json').value?.engines?.node;
  const minimum = parseMinimumVersion(engines);
  const devMajor = parseDevNodeRequirement(ctx.readText(path.join(ctx.root, 'scripts', 'awwo-saas-dev.mjs')));
  const version = `v${ctx.nodeVersion}`;
  const fix = `Install Node.js ${devMajor ?? 24} or newer (nvm-windows, fnm or volta can switch versions).`;
  if (!actual) return row('node', 'fail', `cannot read the running Node version "${ctx.nodeVersion}"`, fix);
  if (!minimum) {
    const declared = engines ? `"${engines}", not a >= range` : 'missing';
    return row('node', 'warn', `${version}; apps/pi-worker/package.json engines.node is ${declared}, so the workers' minimum is unknown`,
      'Declare engines.node as ">=x.y.z" in apps/pi-worker/package.json.');
  }
  const dev = devMajor ? `; npm run dev:saas needs ${devMajor}+` : '';
  if (compareVersions(actual, minimum) < 0) {
    return row('node', 'fail', `${version} is older than the workers' ${engines} (apps/pi-worker/package.json)${dev}`, fix);
  }
  if (devMajor && actual.major < devMajor) {
    return row('node', 'warn', `${version} meets the workers' ${engines}, but npm run dev:saas needs Node ${devMajor}+ (managed execution)`, fix);
  }
  return row('node', 'ok', `${version} (workers need ${engines}${devMajor ? `, dev:saas ${devMajor}+` : ''})`);
}

export async function checkNpm(ctx) {
  let resolved;
  try {
    resolved = resolveCommand('npm', ['--version'], ctx.platform, ctx.exists, ctx.env);
  } catch {
    return row('npm', 'fail', 'npm cannot be started without a shell here: no npm-cli.js next to node or in npm_execpath',
      'Reinstall Node.js with its bundled npm, or run the doctor through npm (npm run doctor:saas).');
  }
  const result = await ctx.run(resolved.command, resolved.args, { cwd: ctx.root, env: probeEnvironment(ctx.env) });
  if (result.ok) return row('npm', 'ok', `npm ${firstLine(result.stdout)}`);
  const why = result.missing ? 'npm is not on PATH' : `npm --version failed (${result.timedOut ? 'timed out' : result.error})`;
  return row('npm', 'fail', `${why}; npm run setup:saas installs every package with npm ci`, 'Install Node.js with npm (nodejs.org) and open a new shell.');
}

export async function checkGo(ctx) {
  const required = parseGoModVersion(ctx.readText(path.join(ctx.root, 'backend', 'go.mod')));
  const want = required ? `go ${required}` : 'a Go toolchain';
  const go = findOnPath('go', ctx);
  if (!go) return row('go', 'fail', `go is not on PATH; backend/go.mod needs ${want}`, 'Install Go from https://go.dev/dl and open a new shell.');
  if (!required) return row('go', 'warn', `found ${go}, but backend/go.mod has no go line to compare against`, 'Check backend/go.mod.');
  const cwd = path.join(ctx.root, 'backend');
  const base = probeEnvironment(ctx.env);
  // GOTOOLCHAIN=local reports the installed Go; GOPROXY=off reports the Go that would build backend/, from the
  // module cache only, so this check never downloads a toolchain.
  const [local, selected] = await Promise.all([
    ctx.run(go, ['version'], { cwd, env: { ...base, GOTOOLCHAIN: 'local' } }),
    ctx.run(go, ['version'], { cwd, env: { ...base, GOPROXY: 'off' } }),
  ]);
  const installed = local.ok ? parseGoVersionOutput(local.stdout) : null;
  const fix = `Install Go ${required} or newer, or leave GOTOOLCHAIN=auto so go fetches it.`;
  if (selected.ok) {
    const used = parseGoVersionOutput(selected.stdout);
    if (!used) return row('go', 'warn', `cannot read "${firstLine(selected.stdout)}"`, 'Run go version in backend/.');
    const switched = installed && installed !== used ? ` (installed go${installed}, switched by GOTOOLCHAIN)` : '';
    if (compareVersions(parseVersion(used), parseVersion(required)) >= 0) {
      return row('go', 'ok', `go${used} builds backend/${switched}; go.mod needs ${required}`);
    }
    return row('go', 'fail', `go${used} is older than backend/go.mod's go ${required}`, fix);
  }
  if (selected.timedOut) {
    return row('go', 'warn', `go version in backend/ did not answer within ${PROBE_TIMEOUT_MS / 1000} s`,
      'Run go version in backend/ and look at what it prints.');
  }
  if (/toolchain|download/i.test(selected.stderr)) {
    return row('go', 'warn', `backend/go.mod needs go ${required}; installed go${installed ?? '?'} fetches it on the first build (not downloaded yet)`,
      'Run go version in backend/ once with network access, or install Go directly.');
  }
  return row('go', 'fail', `go version failed in backend/: ${firstLine(selected.stderr) || selected.error}`, fix);
}

export async function checkPostgresTool(ctx, name) {
  const tool = findOnPath(name, ctx);
  const fix = 'Install the PostgreSQL client and server tools (pg_ctl, initdb, psql, createdb), or run the stack in WSL as README.md describes.';
  if (!tool) return row(name, 'warn', `${name} is not on PATH; npm run dev:saas starts its own database with it unless AWWO_DATABASE_URL is set`, fix);
  const result = await ctx.run(tool, ['--version'], { env: probeEnvironment(ctx.env) });
  if (result.ok) return row(name, 'ok', firstLine(result.stdout));
  return row(name, 'warn', `${tool} --version failed (${result.timedOut ? 'timed out' : result.error})`, fix);
}

export async function checkDatabase(ctx) {
  const value = envValue(ctx.env, 'AWWO_DATABASE_URL', ctx.platform);
  if (!value) {
    return row('database', 'ok', 'AWWO_DATABASE_URL is not set in this shell; npm run dev:saas uses .local/awwo-saas/.env or starts its own PostgreSQL');
  }
  const address = databaseAddress(value);
  if (address.socket) return row('database', 'warn', 'AWWO_DATABASE_URL uses a Unix socket; not checked', 'Use a host:port URL to have it checked.');
  if (address.error) {
    return row('database', 'fail', `AWWO_DATABASE_URL is set but its host and port cannot be read (${address.error})`,
      'Use the form postgres://user:password@host:port/database.');
  }
  const result = await ctx.connect(address.host, address.port, DATABASE_TIMEOUT_MS);
  const where = `${formatAddress(address)}${address.firstOfSeveral ? ' (the first of several hosts)' : ''}`;
  if (result.ok) return row('database', 'ok', `${where} accepts TCP connections (nothing was sent, credentials unused)`);
  return row('database', 'fail', `${where} from AWWO_DATABASE_URL: ${result.error}`,
    'Start PostgreSQL (in WSL: sudo service postgresql start) or point AWWO_DATABASE_URL at a running server.');
}

function chromeVersion(ctx, file) {
  if (ctx.platform === 'win32') {
    // Chrome for Windows keeps a folder per installed version next to chrome.exe.
    const versions = ctx.listDir(path.win32.dirname(file)).filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => compareVersions(parseVersion(b), parseVersion(a)) || (b > a ? 1 : -1));
    return Promise.resolve(versions[0] ? `Chrome ${versions[0]}` : '');
  }
  return ctx.run(file, ['--version'], { env: probeEnvironment(ctx.env) }).then(result => (result.ok ? firstLine(result.stdout) : ''));
}

// The render worker never looks for a browser itself: without AWWO_RENDER_CHROME it stays "not ready"
// (apps/render-worker/config.mjs). So an installed Chrome is only a hint at what to set.
export async function checkChrome(ctx) {
  const check = 'render: chrome';
  const configured = envValue(ctx.env, 'AWWO_RENDER_CHROME', ctx.platform);
  if (configured) {
    if (!ctx.isFile(configured)) {
      return row(check, 'fail', `AWWO_RENDER_CHROME is ${configured}, which is not a file`, 'Point AWWO_RENDER_CHROME at the Chrome or Chromium executable.');
    }
    const version = await chromeVersion(ctx, configured);
    return row(check, 'ok', `${version ? `${version} at ` : ''}${configured} (AWWO_RENDER_CHROME)`);
  }
  let found = chromeCandidates(ctx.platform, ctx.env).find(candidate => ctx.isFile(candidate));
  if (!found && ctx.platform !== 'win32') {
    found = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(name => findOnPath(name, ctx)).find(Boolean);
  }
  if (!found) {
    return row(check, 'warn', 'AWWO_RENDER_CHROME is not set and no Chrome or Chromium was found; the render worker stays not ready',
      'Install Google Chrome or Chromium and set AWWO_RENDER_CHROME to its executable.');
  }
  const version = await chromeVersion(ctx, found);
  const installed = `${version || 'a browser'} is installed at ${found}`;
  return row(check, 'warn', `AWWO_RENDER_CHROME is not set in this shell, so the render worker stays not ready; ${installed}`,
    `Set AWWO_RENDER_CHROME to ${found}.`);
}

export async function checkMediaTool(ctx, name, variable) {
  const check = `render: ${name}`;
  const configured = envValue(ctx.env, variable, ctx.platform);
  if (configured && !ctx.isFile(configured)) {
    return row(check, 'fail', `${variable} is ${configured}, which is not a file`, `Correct ${variable}, or unset it to use ${name} from PATH.`);
  }
  const tool = configured || findOnPath(name, ctx);
  const fix = `Install FFmpeg (it ships ${name}), put it on PATH or set ${variable}.`;
  if (!tool) return row(check, 'warn', `${name} is not on PATH; the render worker cannot ${name === 'ffprobe' ? 'inspect' : 'encode'} video`, fix);
  const result = await ctx.run(tool, ['-version'], { env: probeEnvironment(ctx.env) });
  if (result.ok) return row(check, 'ok', `${versionLine(result.stdout)} at ${tool}${configured ? ` (${variable})` : ''}`);
  const why = `${tool} -version failed (${result.timedOut ? 'timed out' : result.error})`;
  return row(check, configured ? 'fail' : 'warn', why, fix);
}

export async function checkPackages(ctx, { dir, required }) {
  const check = `${dir} deps`;
  const missingStatus = required ? 'fail' : 'warn';
  const install = required ? `Run npm run setup:saas (or npm ci --prefix ${dir}).` : `Run npm ci --prefix ${dir}.`;
  if (!ctx.exists(path.join(ctx.root, dir))) {
    // An optional package that this checkout does not have yet has nothing to install.
    return required ? row(check, 'fail', `${dir} is not in this checkout`, 'This checkout is incomplete; restore the directory.')
      : row(check, 'ok', `${dir} is not in this checkout; nothing to install`);
  }
  const manifest = readJson(ctx, `${dir}/package.json`);
  if (manifest.missing) return row(check, missingStatus, `${dir}/package.json is missing`, 'Restore the package manifest.');
  if (manifest.invalid) return row(check, 'fail', `${dir}/package.json is not valid JSON`, 'Fix the package manifest.');
  const declared = Object.keys({ ...manifest.value.dependencies, ...manifest.value.devDependencies });
  if (declared.length === 0) return row(check, 'ok', 'declares no npm dependencies');
  const modules = path.join(ctx.root, dir, 'node_modules');
  if (!ctx.exists(modules)) return row(check, missingStatus, `${dir}/node_modules is missing`, install);
  const absent = declared.filter(name => !ctx.exists(path.join(modules, ...name.split('/'), 'package.json')));
  if (absent.length) {
    const names = absent.slice(0, 3).join(', ') + (absent.length > 3 ? ', ...' : '');
    const verb = absent.length === 1 ? 'is' : 'are';
    return row(check, missingStatus, `${absent.length} of ${declared.length} declared packages ${verb} not installed (${names})`, install);
  }
  return row(check, 'ok', declared.length === 1 ? 'its 1 declared package is installed' : `all ${declared.length} declared packages are installed`);
}

export async function checkLocalEnv(ctx) {
  const relative = '.local/awwo-saas/.env';
  if (ctx.isFile(path.join(ctx.root, '.local', 'awwo-saas', '.env'))) return row(relative, 'ok', 'present (contents not read)');
  return row(relative, 'warn', 'missing; npm run dev:saas writes it with fresh local secrets on first start',
    'Run npm run dev:saas once, or create it from .env.example; never commit it.');
}

/** Runs every check concurrently and returns the rows in a fixed order. */
export async function runChecks(ctx) {
  return Promise.all([
    checkNode(ctx), checkNpm(ctx), checkGo(ctx), checkPostgresTool(ctx, 'psql'), checkPostgresTool(ctx, 'pg_ctl'),
    checkDatabase(ctx), ...PACKAGE_DIRECTORIES.filter(entry => entry.required).map(entry => checkPackages(ctx, entry)),
    checkChrome(ctx), checkMediaTool(ctx, 'ffmpeg', 'AWWO_RENDER_FFMPEG'), checkMediaTool(ctx, 'ffprobe', 'AWWO_RENDER_FFPROBE'),
    ...PACKAGE_DIRECTORIES.filter(entry => !entry.required).map(entry => checkPackages(ctx, entry)),
    checkLocalEnv(ctx),
  ]);
}

// ---------- the real environment ----------

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** execFile without a shell; resolves (never rejects) with what happened. */
export function runProbe(command, args, { cwd, env, timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    execFile(command, args, { cwd, env, timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, stdout, stderr });
        return;
      }
      resolve({
        ok: false, stdout: stdout ?? '', stderr: stderr ?? '', missing: error.code === 'ENOENT',
        timedOut: Boolean(error.killed && error.signal),
        error: typeof error.code === 'string' ? error.code : error.signal ? `signal ${error.signal}` : `exit code ${error.code}`,
      });
    });
  });
}

/** Opens a TCP connection and closes it; never writes to the socket. */
export function connectProbe(host, port, timeoutMs = DATABASE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const finish = result => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no connection within ${timeoutMs / 1000} s` }), timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('error', error => finish({ ok: false, error: error.code || 'connection failed' }));
  });
}

export function createContext({ root = REPO_ROOT, env = process.env, platform = process.platform } = {}) {
  return {
    root, env, platform, nodeVersion: process.versions.node,
    exists: target => fs.existsSync(target),
    isFile,
    readText: target => {
      try {
        return fs.readFileSync(target, 'utf8');
      } catch {
        return null;
      }
    },
    listDir: target => {
      try {
        return fs.readdirSync(target);
      } catch {
        return [];
      }
    },
    run: runProbe,
    connect: connectProbe,
  };
}

export const USAGE = `Usage: node scripts/awwo-doctor.mjs [--json]
Checks the local tools AwwO SaaS development and the render worker need. Exit code 1 only when a check fails.
`;

/** The CLI without process globals. Returns the exit code: 0, 1 when a check failed, 2 for a usage error. */
export async function main(argv, { context = createContext(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const unknown = argv.filter(argument => !['--json', '--help', '-h'].includes(argument));
  if (unknown.length) {
    stderr.write(`awwo-doctor: unknown argument ${unknown[0]}\n${USAGE}`);
    return 2;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(USAGE);
    return 0;
  }
  const checks = await runChecks(context);
  const summary = summarize(checks);
  if (argv.includes('--json')) {
    const { exitCode, ...counts } = summary;
    stdout.write(`${JSON.stringify({ ok: exitCode === 0, summary: counts, checks }, null, 2)}\n`);
  } else {
    stdout.write(formatTable(checks));
    stdout.write(`\n${summary.ok} ok, ${summary.warn} warn, ${summary.fail} fail${summary.fail ? ' - fix the failed checks above' : ''}.\n`);
  }
  return summary.exitCode;
}

// Compared through realpath (and case-folded on Windows) so another spelling of this path cannot skip the run.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const invoked = fs.realpathSync(path.resolve(process.argv[1]));
    return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = await main(process.argv.slice(2));
