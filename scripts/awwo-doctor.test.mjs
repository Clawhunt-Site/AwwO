import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  DATABASE_TIMEOUT_MS, PROBE_TIMEOUT_MS, REPO_ROOT, checkChrome, checkGo, checkMediaTool, checkNode, checkPackages, chromeCandidates,
  compareVersions, connectProbe, databaseAddress, envValue, findOnPath, firstLine, formatAddress, formatTable,
  main, parseDevNodeRequirement, parseGoModVersion, parseGoVersionOutput, parseMinimumVersion, parseVersion,
  probeEnvironment, runChecks, runProbe, summarize, versionLine, wrapText,
} from './awwo-doctor.mjs';

const ROOT = path.join(path.sep, 'repo');
const at = (...parts) => path.join(ROOT, ...parts);
const DEV_SCRIPT = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'awwo-saas-dev.mjs'), 'utf8');

/** A context whose file system, processes and sockets are all in memory. */
function fakeContext({ platform = 'linux', env = {}, nodeVersion = '24.11.0', files = {}, dirs = [], listings = {}, run, connect } = {}) {
  const calls = [];
  const fileMap = new Map(Object.entries(files));
  const dirSet = new Set(dirs);
  return {
    calls, root: ROOT, platform, env, nodeVersion,
    exists: target => fileMap.has(target) || dirSet.has(target) || (platform === 'win32' && /npm-cli\.js$/.test(target)),
    isFile: target => fileMap.has(target),
    readText: target => (fileMap.has(target) ? fileMap.get(target) : null),
    listDir: target => listings[target] ?? [],
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return run ? run(command, args, options) : { ok: false, missing: true, stdout: '', stderr: '', error: 'ENOENT' };
    },
    connect: async (host, port, timeoutMs) => {
      calls.push({ connect: [host, port, timeoutMs] });
      return connect ? connect(host, port) : { ok: false, error: 'ECONNREFUSED' };
    },
  };
}

const ok = stdout => ({ ok: true, stdout, stderr: '' });
const manifest = (dependencies, devDependencies = {}) => JSON.stringify({ dependencies, devDependencies });

function repoFiles({ engines = '>=22.19.0', goMod = 'module awwo/backend\n\ngo 1.27.1\n' } = {}) {
  return {
    [at('apps', 'pi-worker', 'package.json')]: JSON.stringify({ engines: { node: engines }, dependencies: { '@earendil-works/pi-ai': '0.85.1' } }),
    [at('scripts', 'awwo-saas-dev.mjs')]: DEV_SCRIPT,
    [at('backend', 'go.mod')]: goMod,
  };
}

function healthyLinux() {
  const files = {
    ...repoFiles(),
    [at('apps', 'web', 'package.json')]: manifest({ react: '19' }, { vite: '7' }),
    [at('apps', 'web', 'node_modules', 'react', 'package.json')]: '{}',
    [at('apps', 'web', 'node_modules', 'vite', 'package.json')]: '{}',
    [at('apps', 'pi-worker', 'node_modules', '@earendil-works', 'pi-ai', 'package.json')]: '{}',
    [at('apps', 'openai-agents-worker', 'package.json')]: manifest({ zod: '4' }),
    [at('apps', 'openai-agents-worker', 'node_modules', 'zod', 'package.json')]: '{}',
    [at('.local', 'awwo-saas', '.env')]: 'AWWO_LOCAL_DB_PASSWORD=never-read\n',
  };
  for (const tool of ['go', 'psql', 'pg_ctl', 'ffmpeg', 'ffprobe', 'google-chrome']) files[`/usr/bin/${tool}`] = '';
  const outputs = {
    npm: '10.9.2\n', '/usr/bin/go': 'go version go1.27.1 linux/amd64\n', '/usr/bin/psql': 'psql (PostgreSQL) 16.4\n',
    '/usr/bin/pg_ctl': 'pg_ctl (PostgreSQL) 16.4\n', '/usr/bin/google-chrome': 'Google Chrome 141.0.7390.54\n',
    '/usr/bin/ffmpeg': 'ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers\nbuilt with gcc\n',
    '/usr/bin/ffprobe': 'ffprobe version 7.1 Copyright (c) 2007-2024 the FFmpeg developers\n',
  };
  return fakeContext({
    files,
    dirs: ['apps/web', 'apps/pi-worker', 'apps/openai-agents-worker'].flatMap(dir => [at(...dir.split('/')), at(...dir.split('/'), 'node_modules')]),
    env: {
      PATH: '/usr/local/bin:/usr/bin', HOME: '/home/dev', GOPATH: '/home/dev/go', AWWO_RENDER_CHROME: '/usr/bin/google-chrome',
      AWWO_DATABASE_URL: 'postgres://awwo:s3cret-pass@127.0.0.1:55483/awwo?sslmode=disable',
      AWWO_PI_API_KEY: 'provider-secret', OPENAI_API_KEY: 'openai-secret', GITHUB_TOKEN: 'gh-secret',
    },
    run: command => (outputs[command] ? ok(outputs[command]) : { ok: false, missing: true, stdout: '', stderr: '', error: 'ENOENT' }),
    connect: () => ({ ok: true }),
  });
}

test('versions parse from tool output and compare numerically, prereleases first', () => {
  assert.deepEqual(parseVersion('v22.16.0'), { major: 22, minor: 16, patch: 0, prerelease: false });
  assert.deepEqual(parseVersion('go version go1.27.1 windows/amd64'), { major: 1, minor: 27, patch: 1, prerelease: false });
  assert.deepEqual(parseVersion('24'), { major: 24, minor: 0, patch: 0, prerelease: false });
  assert.equal(parseVersion('1.28rc1').prerelease, true);
  assert.equal(parseVersion('no digits here'), null);
  assert.equal(compareVersions(parseVersion('22.9.0'), parseVersion('22.19.0')), -1);
  assert.equal(compareVersions(parseVersion('22.19.0'), parseVersion('22.19')), 0);
  assert.equal(compareVersions(parseVersion('1.28rc1'), parseVersion('1.28.0')), -1);
  assert.equal(compareVersions(parseVersion('26.3.0'), parseVersion('24')), 1);
});

test('engines ranges are read only in the >= form; anything else is not guessed', () => {
  assert.deepEqual(parseMinimumVersion('>=22.19.0'), parseVersion('22.19.0'));
  assert.deepEqual(parseMinimumVersion(' >= 24 '), parseVersion('24'));
  assert.deepEqual(parseMinimumVersion('>=v22.19'), parseVersion('22.19'));
  for (const range of ['^22.19.0', '>=22 <26', '22.x', '', undefined, null]) assert.equal(parseMinimumVersion(range), null, String(range));
});

test('go.mod, go version output and the dev launcher requirement are parsed', () => {
  assert.equal(parseGoModVersion('module awwo/backend\n\ngo 1.27.1\n\nrequire (\n)\n'), '1.27.1');
  assert.equal(parseGoModVersion('module x\ngo 1.24\ntoolchain go1.25.3\n'), '1.24');
  assert.equal(parseGoModVersion('module x\n'), null);
  assert.equal(parseGoModVersion(null), null);
  assert.equal(parseGoVersionOutput('go version go1.27.1 windows/amd64\n'), '1.27.1');
  assert.equal(parseGoVersionOutput('go version devel go1.28-abcdef Mon linux/amd64'), '1.28');
  assert.equal(parseGoVersionOutput('go version go1.28rc1 linux/amd64'), '1.28rc1');
  assert.equal(parseGoVersionOutput(''), null);
  // Read from the real launcher, so a rewrite of its check that this parser no longer sees fails here.
  assert.equal(parseDevNodeRequirement(DEV_SCRIPT), 24);
  assert.equal(parseDevNodeRequirement("if (Number(process.versions.node.split(\".\")[0]) < 26) throw x"), 26);
  assert.equal(parseDevNodeRequirement('nothing'), null);
});

test('banners shrink to their version line', () => {
  assert.equal(versionLine('ffmpeg version 8.0.1-essentials Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with gcc'), 'ffmpeg version 8.0.1-essentials');
  assert.equal(firstLine('\n\n  psql (PostgreSQL) 16.4  \nmore'), 'psql (PostgreSQL) 16.4');
  assert.equal(firstLine(undefined), '');
});

test('a database URL yields only its host and port, never its credentials', () => {
  const cases = [
    ['postgres://awwo:s3cret@127.0.0.1:55483/awwo?sslmode=disable', { host: '127.0.0.1', port: 55483 }],
    ['postgresql://user:p%40ss@db.example.test/awwo', { host: 'db.example.test', port: 5432 }],
    ['postgres://u:pw@[::1]:6000/awwo', { host: '::1', port: 6000 }],
    ['host=10.0.0.5 port=6432 user=awwo password=s3cret dbname=awwo', { host: '10.0.0.5', port: 6432 }],
    ["host='db.local' password=s3cret", { host: 'db.local', port: 5432 }],
    ['postgres:///awwo', { socket: true }],
    ['postgres://u:pw@/awwo?host=/var/run/postgresql', { socket: true }],
    ['postgres://u:pw@/awwo?host=%2Ftmp', { socket: true }],
    ['postgres://%2Fvar%2Frun%2Fpostgresql/awwo', { socket: true }],
    ['postgres://u:pw@/awwo?host=db.local', { host: 'db.local', port: 5432 }],
    ['postgres://u:pw@h1:5433,h2:5434/awwo', { host: 'h1', port: 5433, firstOfSeveral: true }],
    ['postgres://u:p@ss@h3/awwo', { host: 'h3', port: 5432 }],
    ['host=/tmp port=5432 password=s3cret', { socket: true }],
    ['user=awwo password=s3cret', { error: 'no host= in the connection string' }],
    ['postgres://u:s3cret@host:notaport/awwo', { error: 'not a valid postgres:// URL' }],
    ['', { error: 'empty' }],
  ];
  for (const [value, expected] of cases) {
    const address = databaseAddress(value);
    assert.deepEqual(address, expected, value);
    assert.doesNotMatch(JSON.stringify(address), /s3cret|p%40ss|pw/, value);
  }
  assert.equal(formatAddress({ host: '::1', port: 6000 }), '[::1]:6000');
  assert.equal(formatAddress({ host: 'db', port: 5432 }), 'db:5432');
});

test('probe processes get no AwwO, AWS, telemetry or secret-looking variables', () => {
  const env = {
    PATH: '/usr/bin', HOME: '/home/dev', GOPATH: '/home/dev/go', GOTOOLCHAIN: 'auto', SystemRoot: 'C:\\Windows',
    AWWO_DATABASE_URL: 'postgres://u:p@h/db', VITE_AWWO_API: 'x', AWS_PROFILE: 'prod', OTEL_EXPORTER_OTLP_ENDPOINT: 'x',
    OPENAI_API_KEY: 'k', GITHUB_TOKEN: 't', DB_PASSWORD: 'p', CLIENT_SECRET: 's', 'npm_config_//registry/:_authToken': 'a',
    GOAUTH: 'netrc', UNSET: undefined,
  };
  assert.deepEqual(probeEnvironment(env), { PATH: '/usr/bin', HOME: '/home/dev', GOPATH: '/home/dev/go', GOTOOLCHAIN: 'auto', SystemRoot: 'C:\\Windows' });
});

test('environment names are case-insensitive on Windows only', () => {
  const env = { Path: 'C:\\bin', ProgramFiles: 'C:\\PF' };
  assert.equal(envValue(env, 'PATH', 'win32'), 'C:\\bin');
  assert.equal(envValue(env, 'PROGRAMFILES', 'win32'), 'C:\\PF');
  assert.equal(envValue(env, 'PATH', 'linux'), undefined);
});

test('PATH lookup finds executables the way they can be spawned without a shell', () => {
  const windows = new Set(['C:\\tools\\ffmpeg.exe', 'C:\\Program Files\\Go\\bin\\go.exe', 'C:\\npm\\npm.cmd']);
  const winContext = { platform: 'win32', env: { Path: 'C:\\npm;"C:\\Program Files\\Go\\bin";;C:\\tools' }, isFile: file => windows.has(file) };
  assert.equal(findOnPath('ffmpeg', winContext), 'C:\\tools\\ffmpeg.exe');
  assert.equal(findOnPath('go', winContext), 'C:\\Program Files\\Go\\bin\\go.exe');
  assert.equal(findOnPath('npm', winContext), null, 'a .cmd cannot be spawned without a shell');
  const linux = new Set(['/usr/bin/go']);
  assert.equal(findOnPath('go', { platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' }, isFile: file => linux.has(file) }), '/usr/bin/go');
  assert.equal(findOnPath('go', { platform: 'linux', env: {}, isFile: () => true }), null);
});

test('Chrome candidates cover the usual install locations per platform', () => {
  const windows = chromeCandidates('win32', { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' });
  assert.equal(windows[0], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.ok(windows.includes('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(windows.includes('C:\\Users\\dev\\AppData\\Local\\Chromium\\Application\\chrome.exe'));
  assert.ok(chromeCandidates('darwin', { HOME: '/Users/dev' }).includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(chromeCandidates('linux', {}).includes('/usr/bin/chromium'));
});

test('wrapText breaks on spaces and splits words longer than the width', () => {
  assert.deepEqual(wrapText('a bb ccc dddd', 6), ['a bb', 'ccc', 'dddd']);
  assert.deepEqual(wrapText('abcdefgh', 3), ['abc', 'def', 'gh']);
  assert.deepEqual(wrapText('x abcdefgh', 4), ['x', 'abcd', 'efgh']);
  assert.deepEqual(wrapText('', 5), ['']);
  assert.deepEqual(wrapText(undefined, 5), ['']);
});

test('the table aligns columns and wraps long cells onto continuation lines', () => {
  const table = formatTable([
    { check: 'node', status: 'ok', detail: 'v24.11.0', fix: '' },
    { check: 'psql', status: 'warn', detail: 'psql is not on PATH at all', fix: 'install it' },
  ], { detailWidth: 12, fixWidth: 10 });
  assert.equal(table, [
    'CHECK  STATUS  DETAIL        HOW TO FIX',
    '-----  ------  ------------  ----------',
    'node   ok      v24.11.0',
    'psql   warn    psql is not   install it',
    '               on PATH at',
    '               all',
    '',
  ].join('\n'));
});

test('summarize counts statuses and fails only when a check failed', () => {
  assert.deepEqual(summarize([{ status: 'ok' }, { status: 'warn' }, { status: 'warn' }]), { ok: 1, warn: 2, fail: 0, exitCode: 0 });
  assert.deepEqual(summarize([{ status: 'ok' }, { status: 'fail' }]), { ok: 1, warn: 0, fail: 1, exitCode: 1 });
  assert.deepEqual(summarize([]), { ok: 0, warn: 0, fail: 0, exitCode: 0 });
});

test('node: fail below the workers minimum, warn below the dev launcher requirement, ok above both', async () => {
  const status = async (nodeVersion, engines) => {
    const result = await checkNode(fakeContext({ nodeVersion, files: repoFiles({ engines }) }));
    return [result.status, result.detail];
  };
  assert.equal((await status('22.16.0', '>=22.19.0'))[0], 'fail');
  assert.match((await status('22.16.0', '>=22.19.0'))[1], /older than the workers' >=22\.19\.0.*dev:saas needs 24\+/);
  assert.equal((await status('22.19.0', '>=22.19.0'))[0], 'warn');
  assert.equal((await status('24.0.0', '>=22.19.0'))[0], 'ok');
  assert.equal((await status('24.0.0', '^22'))[0], 'warn');
  const noManifest = await checkNode(fakeContext({ nodeVersion: '24.0.0', files: { [at('scripts', 'awwo-saas-dev.mjs')]: DEV_SCRIPT } }));
  assert.equal(noManifest.status, 'warn');
  assert.match(noManifest.detail, /engines\.node is missing/);
});

test('go: compares the toolchain backend/ would use, and never lets go download one', async () => {
  const files = { ...repoFiles(), '/usr/bin/go': '' };
  const env = { PATH: '/usr/bin', GOTOOLCHAIN: 'auto', AWWO_PI_TOKEN: 'secret' };
  const answer = selected => (command, args, options) => (options.env.GOTOOLCHAIN === 'local' ? ok('go version go1.27.0 linux/amd64\n') : selected);
  let ctx = fakeContext({ files, env, run: answer(ok('go version go1.27.1 linux/amd64\n')) });
  let result = await checkGo(ctx);
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /go1\.27\.1 builds backend\/ \(installed go1\.27\.0, switched by GOTOOLCHAIN\)/);
  const [local, selected] = ctx.calls;
  assert.equal(local.options.env.GOTOOLCHAIN, 'local');
  assert.equal(selected.options.env.GOPROXY, 'off');
  for (const call of ctx.calls) {
    assert.equal(call.options.cwd, at('backend'));
    assert.equal(call.options.env.AWWO_PI_TOKEN, undefined);
    assert.equal(call.options.shell, undefined);
  }
  result = await checkGo(fakeContext({ files, env, run: answer({ ok: false, stdout: '', stderr: 'go: downloading go1.27.1 (linux/amd64)\ngo: download go1.27.1 for linux/amd64: toolchain not available\n', error: 'exit code 1' }) }));
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /not downloaded yet/);
  result = await checkGo(fakeContext({ files, env, run: answer(ok('go version go1.22.1 linux/amd64\n')) }));
  assert.equal(result.status, 'fail');
  result = await checkGo(fakeContext({ files, env, run: answer({ ok: false, stdout: '', stderr: '', timedOut: true, error: 'signal SIGTERM' }) }));
  assert.equal(result.status, 'warn');
  result = await checkGo(fakeContext({ files: { ...files, [at('backend', 'go.mod')]: 'module x\n' }, env }));
  assert.equal(result.status, 'warn');
  result = await checkGo(fakeContext({ files: repoFiles(), env }));
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /go is not on PATH; backend\/go\.mod needs go 1\.27\.1/);
});

test('chrome on Windows is identified from its version folders and never executed', async () => {
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const options = {
    platform: 'win32', files: { [chrome]: '' },
    listings: { 'C:\\Program Files\\Google\\Chrome\\Application': ['SetupMetrics', '154.0.1.2', '155.0.8059.79', 'chrome.exe'] },
  };
  const set = fakeContext({ ...options, env: { ProgramFiles: 'C:\\Program Files', AWWO_RENDER_CHROME: chrome } });
  const configured = await checkChrome(set);
  assert.equal(configured.status, 'ok');
  assert.equal(configured.detail, `Chrome 155.0.8059.79 at ${chrome} (AWWO_RENDER_CHROME)`);
  assert.equal(set.calls.length, 0);
  // The render worker never looks for a browser itself, so an installed but unconfigured one is only a hint.
  const unset = fakeContext({ ...options, env: { ProgramFiles: 'C:\\Program Files' } });
  const hint = await checkChrome(unset);
  assert.equal(hint.status, 'warn');
  assert.match(hint.detail, /AWWO_RENDER_CHROME is not set in this shell, so the render worker stays not ready; Chrome 155\.0\.8059\.79 is installed/);
  assert.equal(hint.fix, `Set AWWO_RENDER_CHROME to ${chrome}.`);
  assert.equal(unset.calls.length, 0);
  const missing = await checkChrome(fakeContext({ platform: 'win32', env: {} }));
  assert.equal(missing.status, 'warn');
  assert.match(missing.detail, /no Chrome or Chromium was found/);
});

test('chrome elsewhere is also found on PATH, and its version comes from --version', async () => {
  const ctx = fakeContext({ env: { PATH: '/opt/bin' }, files: { '/opt/bin/chromium': '' }, run: () => ok('Chromium 141.0.7390.54\n') });
  const result = await checkChrome(ctx);
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /Chromium 141\.0\.7390\.54 is installed at \/opt\/bin\/chromium/);
  assert.deepEqual(ctx.calls.map(call => [call.command, call.args]), [['/opt/bin/chromium', ['--version']]]);
});

test('a healthy environment passes, and the database URL secret appears nowhere', async () => {
  const ctx = healthyLinux();
  const rows = await runChecks(ctx);
  const byCheck = Object.fromEntries(rows.map(entry => [entry.check, entry]));
  assert.deepEqual(rows.map(entry => entry.check), [
    'node', 'npm', 'go', 'psql', 'pg_ctl', 'database', 'apps/web deps', 'apps/pi-worker deps', 'apps/openai-agents-worker deps',
    'render: chrome', 'render: ffmpeg', 'render: ffprobe', 'apps/render-worker deps', '.local/awwo-saas/.env',
  ]);
  for (const entry of rows) assert.equal(entry.status, 'ok', `${entry.check}: ${entry.detail}`);
  assert.equal(summarize(rows).exitCode, 0);
  assert.equal(byCheck.database.detail, '127.0.0.1:55483 accepts TCP connections (nothing was sent, credentials unused)');
  assert.equal(byCheck['render: ffmpeg'].detail, 'ffmpeg version 7.1 at /usr/bin/ffmpeg');
  assert.equal(byCheck['render: chrome'].detail, 'Google Chrome 141.0.7390.54 at /usr/bin/google-chrome (AWWO_RENDER_CHROME)');
  assert.equal(byCheck['apps/web deps'].detail, 'all 2 declared packages are installed');
  assert.equal(byCheck['apps/pi-worker deps'].detail, 'its 1 declared package is installed');
  assert.equal(byCheck['apps/render-worker deps'].detail, 'apps/render-worker is not in this checkout; nothing to install');
  assert.doesNotMatch(JSON.stringify(rows), /s3cret-pass|provider-secret|openai-secret|gh-secret|never-read/);
  const connects = ctx.calls.filter(call => call.connect);
  assert.deepEqual(connects, [{ connect: ['127.0.0.1', 55483, DATABASE_TIMEOUT_MS] }]);
  for (const call of ctx.calls.filter(entry => entry.command)) {
    assert.equal(call.options.shell, undefined, call.command);
    for (const name of ['AWWO_DATABASE_URL', 'AWWO_PI_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(call.options.env[name], undefined, `${call.command} got ${name}`);
  }
});

test('a broken environment reports each problem with the right status and exits 1', async () => {
  const chromeVariable = 'D:\\nowhere\\chrome.exe';
  const files = {
    ...repoFiles(),
    'C:\\tools\\bin\\ffmpeg.exe': '',
    [at('apps', 'web', 'package.json')]: manifest({ react: '19' }, { vite: '7' }),
    [at('apps', 'web', 'node_modules', 'react', 'package.json')]: '{}',
    [at('apps', 'openai-agents-worker', 'package.json')]: '{ not json',
    [at('apps', 'render-worker', 'package.json')]: manifest({ 'puppeteer-core': '24' }),
  };
  const dirs = [at('apps', 'web'), at('apps', 'web', 'node_modules'), at('apps', 'pi-worker'), at('apps', 'openai-agents-worker'), at('apps', 'render-worker')];
  const ctx = fakeContext({
    platform: 'win32', nodeVersion: '22.16.0', files, dirs,
    env: { Path: 'C:\\tools\\bin', npm_execpath: 'C:\\npm\\bin\\npm-cli.js', AWWO_RENDER_CHROME: chromeVariable, AWWO_DATABASE_URL: 'postgres://u:hunter2@db.internal:6543/awwo' },
    run: command => (command === process.execPath ? ok('10.9.2\n') : command.endsWith('ffmpeg.exe') ? ok('ffmpeg version 8.0.1 Copyright x\n') : { ok: false, missing: true, stdout: '', stderr: '', error: 'ENOENT' }),
  });
  const rows = await runChecks(ctx);
  const status = Object.fromEntries(rows.map(entry => [entry.check, entry.status]));
  assert.deepEqual(status, {
    node: 'fail', npm: 'ok', go: 'fail', psql: 'warn', pg_ctl: 'warn', database: 'fail', 'apps/web deps': 'fail',
    'apps/pi-worker deps': 'fail', 'apps/openai-agents-worker deps': 'fail', 'render: chrome': 'fail', 'render: ffmpeg': 'ok',
    'render: ffprobe': 'warn', 'apps/render-worker deps': 'warn', '.local/awwo-saas/.env': 'warn',
  });
  const detail = Object.fromEntries(rows.map(entry => [entry.check, entry.detail]));
  assert.equal(detail.database, 'db.internal:6543 from AWWO_DATABASE_URL: ECONNREFUSED');
  assert.match(detail['apps/web deps'], /1 of 2 declared packages is not installed \(vite\)/);
  assert.match(detail['apps/pi-worker deps'], /node_modules is missing/);
  assert.match(detail['apps/openai-agents-worker deps'], /not valid JSON/);
  assert.match(detail['render: chrome'], /AWWO_RENDER_CHROME is D:\\nowhere\\chrome\.exe, which is not a file/);
  assert.doesNotMatch(JSON.stringify(rows), /hunter2/);
  assert.equal(summarize(rows).exitCode, 1);
  const npmCall = ctx.calls.find(call => call.command === process.execPath);
  assert.equal(npmCall.args.at(-1), '--version');
  assert.match(npmCall.args[0], /npm-cli\.js$/);
});

test('ffmpeg tools: a set variable must name a working file, PATH problems only warn', async () => {
  const check = options => checkMediaTool(fakeContext(options), 'ffmpeg', 'AWWO_RENDER_FFMPEG');
  const broken = { ok: false, stdout: '', stderr: '', error: 'exit code 1' };
  let result = await check({ env: { AWWO_RENDER_FFMPEG: '/nowhere/ffmpeg' } });
  assert.deepEqual([result.status, result.detail], ['fail', 'AWWO_RENDER_FFMPEG is /nowhere/ffmpeg, which is not a file']);
  result = await check({ env: { AWWO_RENDER_FFMPEG: '/opt/ffmpeg' }, files: { '/opt/ffmpeg': '' }, run: () => broken });
  assert.equal(result.status, 'fail');
  result = await check({ env: { AWWO_RENDER_FFMPEG: '/opt/ffmpeg' }, files: { '/opt/ffmpeg': '' }, run: () => ok('ffmpeg version 8.0 Copyright x\n') });
  assert.deepEqual([result.status, result.detail], ['ok', 'ffmpeg version 8.0 at /opt/ffmpeg (AWWO_RENDER_FFMPEG)']);
  result = await check({ env: { PATH: '/usr/bin' }, files: { '/usr/bin/ffmpeg': '' }, run: () => broken });
  assert.equal(result.status, 'warn');
  result = await check({ env: { PATH: '/usr/bin' } });
  assert.deepEqual([result.status, result.detail], ['warn', 'ffmpeg is not on PATH; the render worker cannot encode video']);
});

test('a required package missing from the checkout fails; an optional one has nothing to install', async () => {
  const required = await checkPackages(fakeContext(), { dir: 'apps/web', required: true });
  assert.deepEqual([required.status, required.detail], ['fail', 'apps/web is not in this checkout']);
  const optional = await checkPackages(fakeContext(), { dir: 'apps/render-worker', required: false });
  assert.deepEqual([optional.status, optional.detail], ['ok', 'apps/render-worker is not in this checkout; nothing to install']);
  const noDependencies = await checkPackages(fakeContext({ dirs: [at('apps', 'tool')], files: { [at('apps', 'tool', 'package.json')]: '{}' } }), { dir: 'apps/tool', required: true });
  assert.deepEqual([noDependencies.status, noDependencies.detail], ['ok', 'declares no npm dependencies']);
});

test('main prints JSON or a table, and exits 1 only for a failed check, 2 for a bad argument', async () => {
  const capture = () => {
    const out = { text: '' };
    return [out, { write: chunk => { out.text += chunk; return true; } }];
  };
  let [out, stdout] = capture();
  assert.equal(await main(['--json'], { context: healthyLinux(), stdout }), 0);
  const report = JSON.parse(out.text);
  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, { ok: 14, warn: 0, fail: 0 });
  assert.equal(report.checks.length, 14);
  [out, stdout] = capture();
  const broken = fakeContext({ files: repoFiles(), nodeVersion: '20.0.0' });
  assert.equal(await main([], { context: broken, stdout }), 1);
  assert.match(out.text, /^CHECK +STATUS +DETAIL +HOW TO FIX\n/);
  assert.match(out.text, /\d+ ok, \d+ warn, \d+ fail - fix the failed checks above\.\n$/);
  const [err, stderr] = capture();
  assert.equal(await main(['--verbose'], { context: broken, stdout, stderr }), 2);
  assert.match(err.text, /unknown argument --verbose/);
  [out, stdout] = capture();
  assert.equal(await main(['--help'], { context: broken, stdout }), 0);
  assert.match(out.text, /^Usage: node scripts\/awwo-doctor\.mjs \[--json\]/);
});

test('runProbe runs without a shell, reports a missing command, and kills a hung one', async () => {
  const answered = await runProbe(process.execPath, ['-e', 'console.log("probe ok")']);
  assert.equal(answered.ok, true);
  assert.equal(answered.stdout.trim(), 'probe ok');
  // sh would expand $HOME and split on ";", cmd.exe would split on "&"; execFile passes one literal argument.
  const literal = await runProbe(process.execPath, ['-e', 'console.log(process.argv[1])', '$HOME;echo one&echo two']);
  assert.equal(literal.stdout.trim(), '$HOME;echo one&echo two');
  const missing = await runProbe('awwo-doctor-no-such-command', ['--version']);
  assert.equal(missing.ok, false);
  assert.equal(missing.missing, true);
  const hung = await runProbe(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeout: 300 });
  assert.equal(hung.ok, false);
  assert.equal(hung.timedOut, true);
  assert.equal(PROBE_TIMEOUT_MS, 5000);
});

test('connectProbe connects and closes without sending a byte, and reports a refused port', async () => {
  let received = 0;
  const closed = new Promise(resolve => {
    const server = net.createServer(socket => {
      socket.on('data', chunk => { received += chunk.length; });
      socket.on('close', () => server.close(resolve));
    });
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      assert.deepEqual(await connectProbe('127.0.0.1', port, 2000), { ok: true });
    });
  });
  await closed;
  assert.equal(received, 0);
  const unused = await new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const refused = await connectProbe('127.0.0.1', unused, 2000);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /ECONNREFUSED|no connection within/);
});
