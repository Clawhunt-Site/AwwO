import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkspaceSandbox, validateWorkspacePath, workspaceDockerArgs, WORKSPACE_FILE_HELPER } from './workspace-sandbox.ts';
import type { WorkspaceDockerRunner } from './workspace-sandbox.ts';
import { EGRESS_FORWARDER, egressToken, loadWorkspaceEgress, loadWorkspaceInstance, parseWorkspaceTools, sandboxAbilities, WORKSPACE_SOFTWARE } from './workspace-sandbox.ts';
import { snapshotFailure } from './runner.mjs';
import { EMPTY_WORKSPACE_SNAPSHOT } from './workspace-runtime.ts';
import { excusable, EXCUSABLE_TYPES, globMatcher, MAX_PATH_LENGTH, parseMissingOk } from '../../deploy/saas/workspace/tools/missing-ok.mjs';
import { libraryFile, loadLibraries } from '../../deploy/saas/workspace/tools/libraries.mjs';

const config = { dockerExecutable: '/usr/bin/docker', image: 'awwo-workspace@sha256:' + 'a'.repeat(64) };
const digest = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
const metadata = (path: string, content: Buffer) => ({ path, content: content.toString('base64'), encoding: 'base64', byteLength: content.length, sha256: digest(content) });
const response = (value: unknown, code = 0, stderr = '') => ({ code, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.from(stderr) });

test('a workspace container takes the memory its worker is given, swap included, and nothing outside 256-4,096 MiB', () => {
  const args = workspaceDockerArgs('awwo-ws-test', config.image, undefined, 3072);
  assert.ok(args.includes('--memory=3072m') && args.includes('--memory-swap=3072m'));
  assert.ok(!args.includes('--memory=1g'));
  assert.ok(workspaceDockerArgs('awwo-ws-test', config.image, undefined, 1024).includes('--memory=1g'));
  for (const value of [255, 4097, 1.5]) assert.throws(() => workspaceDockerArgs('awwo-ws-test', config.image, undefined, value), /memory/);
});

test('a configured instance labels its containers, and nothing else changes without one', () => {
  const plain = workspaceDockerArgs('awwo-ws-test', config.image);
  assert.ok(!plain.some(value => value.startsWith('awwo.workspace-instance=')));
  const labelled = workspaceDockerArgs('awwo-ws-test', config.image, undefined, 1024, 'local-0123abcd');
  assert.deepEqual(labelled.filter(value => !plain.includes(value)), ['awwo.workspace-instance=local-0123abcd']);
  assert.equal(labelled[labelled.indexOf('awwo.workspace-instance=local-0123abcd') - 1], '--label');
  for (const bad of ['', 'Upper', 'has space', 'a,b', '-leading', 'x'.repeat(64)]) {
    assert.throws(() => workspaceDockerArgs('awwo-ws-test', config.image, undefined, 1024, bad), /instance/, bad);
  }
  assert.equal(loadWorkspaceInstance({}), undefined);
  assert.equal(loadWorkspaceInstance({ AWWO_WORKSPACE_INSTANCE: 'local-1' }), 'local-1');
  assert.throws(() => loadWorkspaceInstance({ AWWO_WORKSPACE_INSTANCE: 'Local 1' }), /AWWO_WORKSPACE_INSTANCE/);
});

test('container arguments enforce isolation without host mounts, inherited credentials or a shell', () => {
  const args = workspaceDockerArgs('awwo-ws-test', config.image);
  for (const flag of ['--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=1g', '--memory-swap=1g', '--cpus=1', '--pids-limit=128', '--pull=never']) assert.ok(args.includes(flag), flag);
  assert.ok(args.some(value => value.startsWith('/workspace:rw,nosuid,nodev,size=134217728')));
  assert.ok(args.includes('--entrypoint=python3'));
  assert.ok(!args.some(value => value.includes('docker.sock') || value === '--privileged' || value === '--mount' || value === '--volume'));
  assert.ok(!args.join(' ').includes(process.env.OPENAI_API_KEY ?? 'fixture-provider-secret'));
});

test('the web is a read-only proxy socket and a run password, never a network interface', async () => {
  // The same value backend/internal/egress derives (egress_test.go), and a new password each 12-hour period.
  const at = new Date(1_800_000_000_000);
  assert.equal(egressToken('k'.repeat(32), 'run-a', at), '8b412f26fe7dc28c6e9e94439690dcf5db39e168');
  assert.notEqual(egressToken('k'.repeat(32), 'run-a', new Date(at.getTime() + 12 * 3600_000)), egressToken('k'.repeat(32), 'run-a', at));
  const egress = { socketDir: '/var/lib/awwo/egress', secret: 's'.repeat(32) };
  const calls: string[][] = [];
  const runner: WorkspaceDockerRunner = async args => { calls.push(args); return response('ok'); };
  const sandbox = await createWorkspaceSandbox({ ...config, egress }, { workspaceId: 'tenant/session/node', runId: 'run1' }, undefined, runner);
  await sandbox.close();
  const args = calls[0];
  assert.ok(args.includes('--network=none') && !args.some(value => value.startsWith('--network=') && value !== '--network=none'));
  assert.equal(args[args.indexOf('--mount') + 1], 'type=bind,source=/var/lib/awwo/egress,target=/run/awwo-egress,readonly');
  assert.equal(args.filter(value => value === '--mount').length, 1);
  const proxy = new URL(args.find(value => value.startsWith('HTTPS_PROXY='))!.slice('HTTPS_PROXY='.length));
  const run = 'ws-' + digest(Buffer.from('tenant/session/node\0run1')).slice(0, 32);
  assert.deepEqual([proxy.protocol, proxy.hostname, proxy.port, proxy.username, proxy.password], ['http:', '127.0.0.1', '3128', run, egressToken(egress.secret, run)]);
  for (const key of ['HTTP_PROXY', 'http_proxy', 'https_proxy']) assert.ok(args.includes(`${key}=${proxy.href.replace(/\/$/, '')}`), key);
  assert.ok(args.includes('NO_PROXY=localhost,127.0.0.1,::1'));
  assert.equal(args.at(-1), EGRESS_FORWARDER);
  assert.ok(!args.join(' ').includes(egress.secret));
  // Without egress nothing of it is there.
  const plain = workspaceDockerArgs('awwo-ws-test', config.image);
  assert.ok(!plain.some(value => /PROXY|egress/i.test(value)));
  for (const bad of [{ socketDir: 'relative', secret: egress.secret }, { socketDir: '/a,readonly=false', secret: egress.secret }, { socketDir: '/a/../b', secret: egress.secret },
    { socketDir: '/run', secret: egress.secret }, { socketDir: '/var/run', secret: egress.secret }, { socketDir: '/./srv', secret: egress.secret }, { socketDir: '//srv', secret: egress.secret },
    { socketDir: '/run/user/1000/x', secret: egress.secret }, { socketDir: '/', secret: egress.secret }, { ...egress, secret: 'short' }, { ...egress, secret: 's'.repeat(40) + String.fromCharCode(10) }]) {
    await assert.rejects(createWorkspaceSandbox({ ...config, egress: bad }, { workspaceId: 'a', runId: 'b' }, undefined, runner), /egress/);
  }
});

test('egress and tools configuration is both-or-neither and names only known programs', async () => {
  assert.equal(loadWorkspaceEgress({}), undefined);
  assert.deepEqual(loadWorkspaceEgress({ AWWO_WORKSPACE_EGRESS_DIR: '/srv/egress', AWWO_WORKSPACE_EGRESS_SECRET: 'x'.repeat(40) }), { socketDir: '/srv/egress', secret: 'x'.repeat(40) });
  for (const env of [{ AWWO_WORKSPACE_EGRESS_DIR: '/srv/egress' }, { AWWO_WORKSPACE_EGRESS_SECRET: 'x'.repeat(40) }, { AWWO_WORKSPACE_EGRESS_DIR: '/srv/egress dir', AWWO_WORKSPACE_EGRESS_SECRET: 'x'.repeat(40) }])
    assert.throws(() => loadWorkspaceEgress(env), /AWWO_WORKSPACE_EGRESS/);
  assert.deepEqual([...parseWorkspaceTools(' rea , check-page ', 'X')], ['rea', 'check-page']);
  assert.deepEqual([...parseWorkspaceTools(undefined, 'X')], []);
  assert.throws(() => parseWorkspaceTools('rea,curl', 'AWWO_X'), /AWWO_X entry: curl/);
  const offline = sandboxAbilities(new Set(), false).join(' '), online = sandboxAbilities(new Set(['rea', 'check-page']), true).join(' ');
  assert.ok(offline.includes('no network') && !offline.includes('rea ') && !offline.includes('awwo-check-page'));
  // The check answers the three.js the image carries (deploy/saas/workspace/tools pins it), so agents are told that version.
  const three = JSON.parse(await readFile(fileURLToPath(new URL('../../deploy/saas/workspace/tools/package.json', import.meta.url)), 'utf8')).dependencies.three;
  assert.ok(online.includes(`three.js ${three}`) && online.includes(`cdn.jsdelivr.net/npm/three@${three}/`), three);
  assert.ok(online.includes("--missing-ok '**/*.glb'") && online.includes('awwo-check-page --help'));
  assert.ok(online.includes('HTTPS_PROXY') && !online.includes('no network') && online.includes('rea analyze-javascript-application') && online.includes('window.awwoSelfTest'));
  // Both name what the image has and how little room an install gets, so a data task uses the installed packages.
  for (const text of [offline, online]) assert.ok(text.startsWith(WORKSPACE_SOFTWARE) && ['pandas', 'matplotlib', 'openpyxl', '128 MiB'].every(word => text.includes(word)));
  assert.ok(online.includes('--system-site-packages') && !offline.includes('pip'));
});

test('--missing-ok patterns match paths as documented, refuse what can never match, and take bounded time', () => {
  const matches = (glob: string, path: string) => {
    const pattern = parseMissingOk(glob);
    assert.ok(typeof pattern === 'string', `${glob}: ${pattern}`);
    return globMatcher(pattern)(path);
  };
  const cases: [string, string, boolean][] = [
    ['**/*.glb', 'cv-mvcbspb9-10-6pr6/model-1.glb', true], ['**/*.glb', 'model.glb', true], ['**/*.glb', 'a/b/c/x.glb', true],
    ['**/*.glb', 'model.gltf', false], ['**/*.glb', 'x.glb.js', false], ['models/*.glb', 'models/hero.glb', true],
    ['models/*.glb', 'models/sub/hero.glb', false], ['models/*.glb', 'hero.glb', false], ['a/**/b.bin', 'a/b.bin', true],
    ['a/**/b.bin', 'a/x/y/b.bin', true], ['a/**', 'a/x/y', true], ['a/**', 'b/x', false], ['model-?.glb', 'model-1.glb', true],
    ['model-?.glb', 'model-10.glb', false], ['model-?.glb', 'model-/.glb', false], ['[x].js', '[x].js', true], ['[x].js', 'x.js', false],
    ['a+b(1).glb', 'a+b(1).glb', true], ['a.glb', 'aXglb', false], ['constructor/*.glb', 'constructor/a.glb', true],
    ['__proto__', '__proto__', true], ['$x^', '$x^', true], ['textures/*.png', 'models/hero.glb', false], ['./models/*.glb', 'models/hero.glb', true],
  ];
  for (const [glob, path, expected] of cases) assert.equal(matches(glob, path), expected, `${glob} ${path}`);
  for (const refused of ['', '/srv/*.glb', '../x', 'a/../b', 'a/./b', 'a\\b', 'a\u0000b', 'x'.repeat(201)]) assert.ok(parseMissingOk(refused) instanceof Error, JSON.stringify(refused));
  // A regular expression of these patterns backtracks for seconds on paths far shorter (2026-10-18: 1.2 s on 41 characters).
  const started = performance.now();
  assert.equal(matches('*-*-*-*-*-*.glb', '-'.repeat(MAX_PATH_LENGTH)), false);
  assert.equal(matches('**a**a**a**a**a**a**a**a', 'a'.repeat(MAX_PATH_LENGTH - 1) + 'b'), false);
  assert.equal(matches('**/'.repeat(10) + 'x', 'a/'.repeat(MAX_PATH_LENGTH / 2)), false);
  assert.ok(performance.now() - started < 2000, `${performance.now() - started} ms`);
  assert.equal(matches('**', 'x'.repeat(MAX_PATH_LENGTH + 1)), false);
  // Missing code always counts, whatever the patterns say: by request type, and by name however it was asked for.
  assert.ok(['fetch', 'image', 'media', 'font'].every(type => EXCUSABLE_TYPES.has(type)) && ['script', 'stylesheet', 'document', 'other'].every(type => !EXCUSABLE_TYPES.has(type)));
  for (const [type, path, expected] of [['fetch', 'models/hero.glb', true], ['image', 'textures/a.png', true], ['script', 'models/hero.glb', false],
    ['fetch', 'lib/decoder.wasm', false], ['fetch', 'mod.MJS', false], ['xhr', 'page.html', false], ['fetch', 'theme.css', false],
    ['fetch', 'x'.repeat(MAX_PATH_LENGTH + 1), false]] as const) assert.equal(excusable(type, path), expected, `${type} ${path.slice(0, 40)}`);
});

test('the page check answers exactly the three.js files the preview supplies, at the version the tools pin', async () => {
  const read = (path: string) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const list = JSON.parse(await read('../../deploy/saas/workspace/tools/three-preview-files.json'));
  const generated = await read('../web/src/canvas/previewModules.generated.ts');
  const supplied = Object.fromEntries([...generated.matchAll(/^ {2}"([^"]+)": \{ bytes: \d+, sha256: '([0-9a-f]{64})'/gm)].map(match => [match[1], match[2]]));
  // scripts/preview-modules.mjs writes both from the same list (--check fails when either is stale).
  assert.equal(list.version, /THREE_MODULES_VERSION = '([^']+)'/.exec(generated)?.[1]);
  assert.deepEqual(list.files, supplied);
  assert.ok(Object.keys(list.files).length > 50 && list.files['build/three.module.js']);
  assert.equal(JSON.parse(await read('../../deploy/saas/workspace/tools/package.json')).dependencies.three, list.version);
  const dockerfile = await read('../../deploy/saas/workspace/Dockerfile');
  assert.match(dockerfile, /npm ci [^\n]*\n[^\n]*\n\s*&& node \/opt\/awwo\/tools\/keep-preview-files\.mjs/);
  assert.match(dockerfile, /COPY tools\/awwo-check-page\.mjs tools\/libraries\.mjs tools\/missing-ok\.mjs tools\/held-clock\.mjs tools\/virtual-time\.mjs \/opt\/awwo\/tools\//);
  // The check names a file from a URL as the preview's pinnedModuleFile does (apps/web/tests/canvas-preview-modules.test.ts):
  // the four addresses on the default port, the path as written, a .min.js naming the same file.
  const libraries = new Map([['three', { name: 'three', version: list.version, files: new Set(Object.keys(list.files)), root: '/x' }]]);
  const named = (url: string) => { const found = libraryFile(new URL(url), libraries); return found === null ? null : found.file; };
  const base = `https://cdn.jsdelivr.net/npm/three@${list.version}/`;
  assert.equal(named(`${base}build/three.module.js`), 'build/three.module.js');
  assert.equal(named(`https://unpkg.com/three@${list.version}/examples/jsm/controls/OrbitControls.js?module`), 'examples/jsm/controls/OrbitControls.js');
  assert.equal(named(`${base}build/three.module.min.js`), 'build/three.module.js');
  assert.equal(named(`https://fastly.jsdelivr.net/npm/three@${list.version}/examples/jsm/math/SimplexNoise.min.js`), 'examples/jsm/math/SimplexNoise.js');
  assert.equal(named(`https://gcore.jsdelivr.net/npm/three@${list.version}/build/three.core.js`), 'build/three.core.js');
  // A file of the release the preview does not supply: named, but not one of its files ('').
  for (const file of ['examples/jsm/loaders/DRACOLoader.js', 'examples/jsm/libs/lil-gui.module.min.js', 'build/three.webgpu.js', 'build/three%2Emodule.js',
    'constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(named(`${base}${file}`), '', file);
  // Not the release at an address the preview knows: not a library request at all.
  for (const url of ['https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js', `https://esm.sh/three@${list.version}`, `http://cdn.jsdelivr.net/npm/three@${list.version}/build/three.module.js`,
    `https://cdn.jsdelivr.net:8443/npm/three@${list.version}/build/three.module.js`, `https://cdn.jsdelivr.net/three@${list.version}/build/three.module.js`,
    `https://unpkg.com/npm/three@${list.version}/build/three.module.js`, `https://cdn.jsdelivr.net/npm/constructor@${list.version}/x.js`]) assert.equal(named(url), null, url);
  // Without its list, or with another version installed, the check answers nothing.
  assert.equal(loadLibraries(fileURLToPath(new URL('.', import.meta.url))).size, 0);
});

test('the image installs every package the instructions name, in the Dockerfile the image is built from', async () => {
  const dockerfile = await readFile(new URL('../../deploy/saas/workspace/Dockerfile', import.meta.url), 'utf8');
  for (const name of ['python3-numpy', 'python3-pandas', 'python3-matplotlib', 'python3-openpyxl', 'python3-xlsxwriter', 'python3-pil', 'python3-pip', 'curl'])
    assert.match(dockerfile, new RegExp(`\\s${name}\\s`), name);
  assert.match(dockerfile, /MPLBACKEND=Agg/);
});

test('model paths are constrained before invoking the trusted helper', () => {
  for (const path of ['/etc/passwd', '../file', 'a/../../file', 'a\\b', 'a//b', 'a/./b', 'a\0b', 'a\nb', '']) assert.throws(() => validateWorkspacePath(path));
  assert.equal(validateWorkspacePath('项目/index.html'), '项目/index.html');
  assert.equal(validateWorkspacePath('.', true), '');
});

test('published bytes are verified, binary stays base64 and file metadata is derived on the host', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const runner: WorkspaceDockerRunner = async (args, options) => {
    calls.push({ args, input: options.input });
    if (args[0] !== 'exec') return response('ok');
    const input = JSON.parse(options.input!);
    return response(metadata(input.path, input.path === 'scene.glb' ? Buffer.from([0xff, 0, 1]) : Buffer.from('<h1>Hello</h1>')));
  };
  const sandbox = await createWorkspaceSandbox(config, { workspaceId: 'tenant/session/node', runId: 'run1' }, undefined, runner);
  const html = await sandbox.publish('index.html');
  assert.equal(html.content, '<h1>Hello</h1>'); assert.equal(html.encoding, 'utf8'); assert.equal(html.mimeType, 'text/html');
  const glb = await sandbox.publish('scene.glb');
  assert.equal(glb.content, '/wAB'); assert.equal(glb.encoding, 'base64'); assert.equal(glb.mimeType, 'model/gltf-binary');
  await assert.rejects(sandbox.write('inputs/data.txt', 'overwrite'), /read only/);
  await assert.rejects(sandbox.read('../etc/passwd'), /relative/);
  await sandbox.close(); await sandbox.close();
  assert.equal(calls.filter(call => call.args[0] === 'rm').length, 1);
  assert.equal(calls.filter(call => call.args[0] === 'exec').length, 2);
  assert.match(calls[0].args[calls[0].args.indexOf('--name') + 1], /^awwo-ws-[a-f0-9]{24}-[a-f0-9]{12}$/);
});

test('configuration, snapshots and inputs fail closed before Docker starts', async () => {
  let calls = 0;
  const runner: WorkspaceDockerRunner = async () => { calls++; return response('ok'); };
  for (const bad of [{ ...config, dockerExecutable: 'docker' }, { ...config, image: '--privileged' }, { ...config, dockerContext: '../context' }, { ...config, maxFileBytes: 3 * 1024 * 1024 }]) {
    await assert.rejects(createWorkspaceSandbox(bad, { workspaceId: 'a', runId: 'b' }, undefined, runner));
  }
  await assert.rejects(createWorkspaceSandbox(config, { workspaceId: 'a', runId: 'b', inputs: [{ name: 'a', content: 'hi', sha256: 'wrong' }] }, undefined, runner), /checksum/);
  await assert.rejects(createWorkspaceSandbox(config, { workspaceId: 'a', runId: 'b', inputs: [{ name: 'a', content: '???', encoding: 'base64' }] }, undefined, runner), /base64/);
  await assert.rejects(createWorkspaceSandbox(config, { workspaceId: 'a', runId: 'b', inputs: [{ name: 'a', content: 'one' }, { name: 'inputs/a', content: 'two' }] }, undefined, runner), /Duplicate/);
  await assert.rejects(createWorkspaceSandbox(config, { workspaceId: 'a', runId: 'b', snapshot: { content: 'aGk=', encoding: 'base64', sha256: 'bad' } }, undefined, runner), /checksum/);
  assert.equal(calls, 0);
});

test('input initialization is root-only before tools, snapshots use the non-root helper', async () => {
  const calls: { args: string[]; body?: any }[] = [];
  const snapshot = Buffer.from('fixture-zip');
  const runner: WorkspaceDockerRunner = async (args, options) => {
    calls.push({ args, body: options.input ? JSON.parse(options.input) : undefined });
    return response({ ok: true });
  };
  const sandbox = await createWorkspaceSandbox(config, { workspaceId: 'a', runId: 'b', inputs: [{ name: 'inputs/task.txt', content: 'approved' }], snapshot: { content: snapshot.toString('base64'), encoding: 'base64', sha256: digest(snapshot) } }, undefined, runner);
  assert.equal(calls[1].args[3], '0:0');
  assert.deepEqual(calls[1].body.inputs, [{ path: 'task.txt', content: Buffer.from('approved').toString('base64') }]);
  assert.equal(calls[2].args[3], '1000:1000'); assert.equal(calls[2].body.action, 'restore');
  await sandbox.close();
});

test('nonzero command exit is returned for repair; timeout removes the whole container', async () => {
  let commandCount = 0, removes = 0;
  const runner: WorkspaceDockerRunner = async (args, options) => {
    if (args[0] === 'rm') { removes++; return response('ok'); }
    if (args[0] !== 'exec') return response('ok');
    const command = JSON.parse(options.input!).command;
    assert.ok(!args.includes(command), 'untrusted command must only travel over stdin');
    if (++commandCount === 1) return response({ exitCode: 1, stdout: 'test failure', stderr: '', truncated: false });
    throw new Error('Workspace operation timed out');
  };
  const sandbox = await createWorkspaceSandbox(config, { workspaceId: 'a', runId: 'b' }, undefined, runner);
  assert.equal((await sandbox.exec('node test.js')).exitCode, 1);
  await assert.rejects(sandbox.exec('sleep 500'), /timed out/);
  assert.equal(removes, 1);
  await assert.rejects(sandbox.read('README.md'), /closed/);
  await sandbox.close();
});

test("a command's environment draws matplotlib to files and keeps its cache in /tmp, out of the workspace", async () => {
  // The helper sets each command's whole environment, so the image's own ENV lines never reach a command.
  let helper = '';
  const runner: WorkspaceDockerRunner = async (args, options) => {
    if (args[0] !== 'exec') return response('ok');
    if (JSON.parse(options.input!).command === 'true') helper = args.at(-1)!;
    return response({ exitCode: 0, stdout: '', stderr: '', truncated: false });
  };
  const sandbox = await createWorkspaceSandbox(config, { workspaceId: 'a', runId: 'b' }, undefined, runner);
  await sandbox.exec('true');
  await sandbox.close();
  assert.match(helper, /env = \{[^}]*'HOME':'\/workspace'[^}]*'MPLBACKEND':'Agg','MPLCONFIGDIR':'\/tmp\/matplotlib'\}/);
});

test('start timeout, invalid publish checksum and cancellation cannot leak a container', async () => {
  let removes = 0;
  const runner: WorkspaceDockerRunner = async (args) => {
    if (args[0] === 'run') throw new Error('startup timed out after daemon allocation');
    removes++; return response('ok');
  };
  await assert.rejects(createWorkspaceSandbox(config, { workspaceId: 'a', runId: 'b' }, undefined, runner), /timed out/);
  assert.equal(removes, 1);
  const controller = new AbortController();
  const sandbox = await createWorkspaceSandbox(config, { workspaceId: 'a', runId: 'b' }, controller.signal, async args => {
    if (args[0] === 'rm') removes++;
    return args[0] === 'exec' ? response({ ...metadata('file.txt', Buffer.from('data')), sha256: 'forged' }) : response('ok');
  });
  await assert.rejects(sandbox.publish('file.txt'), /verification/);
  controller.abort();
  await sandbox.close();
  assert.equal(removes, 2);
});

test('filesystem operations are serialized and queued work fails after close', async () => {
  let active = 0, maximum = 0;
  const sandbox = await createWorkspaceSandbox(config, { workspaceId: 'a', runId: 'b' }, undefined, async (args, options) => {
    if (args[0] !== 'exec') return response('ok');
    active++; maximum = Math.max(active, maximum);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return response(metadata(JSON.parse(options.input!).path, Buffer.from('ok')));
  });
  await Promise.all([sandbox.read('a'), sandbox.read('b')]);
  assert.equal(maximum, 1);
  await sandbox.close();
  await assert.rejects(sandbox.read('a'), /closed/);
});

async function python(code: string, payload: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', '-S', '-c', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function filesystemFixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'awwo-workspace-helper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), inputs = join(root, 'inputs');
  await mkdir(workspace); await mkdir(inputs);
  const script = WORKSPACE_FILE_HELPER.replace("WORKSPACE = '/workspace'", `WORKSPACE = ${JSON.stringify(workspace)}`).replace("INPUTS = '/inputs'", `INPUTS = ${JSON.stringify(inputs)}`);
  const call = async (action: string, body: Record<string, unknown> = {}) => {
    const result = await python(script, { action, fileLimit: 2 * 1024 * 1024, archiveLimit: 2 * 1024 * 1024, ...body });
    if (result.code !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, workspace, inputs, call };
}

test('real filesystem helper reads/writes bytes and restores a source ZIP without caches', async t => {
  const f = await filesystemFixture(t);
  const content = Buffer.from('<!doctype html><h1>可交付</h1>');
  await f.call('write', { path: 'site/index.html', content: content.toString('base64') });
  assert.deepEqual(await readFile(join(f.workspace, 'site/index.html')), content);
  assert.deepEqual(await f.call('read', { path: 'site/index.html' }), metadata('site/index.html', content));
  await mkdir(join(f.workspace, 'node_modules')); await writeFile(join(f.workspace, 'node_modules/cache'), 'omit');
  const zip = await f.call('archive');
  assert.equal(zip.sha256, digest(Buffer.from(zip.content, 'base64')));
  const restored = await filesystemFixture(t);
  await restored.call('restore', { content: zip.content });
  assert.deepEqual(await readFile(join(restored.workspace, 'site/index.html')), content);
  await assert.rejects(readFile(join(restored.workspace, 'node_modules/cache')), /ENOENT/);
});

test('a snapshot leaves out the package caches in HOME, and one made before them restores everything else', async t => {
  const f = await filesystemFixture(t);
  // npm's cache of one install of three.js (a tarball that does not compress) outgrew the 2 MiB snapshot: PALLWARD's
  // builders failed after their last answer (2026-10-18). Caches deeper in the project are the project's own files.
  for (const [path, size] of [['.npm/_cacache/content-v2/sha512/aa/bb/three', 3 * 1024 * 1024], ['.cache/pip/http/wheel', 1024],
    ['.local/lib/python3/site-packages/x.py', 64], ['.node-gyp/24.0.0/include/node.h', 64]] as const) {
    await mkdir(join(f.workspace, dirname(path)), { recursive: true });
    await writeFile(join(f.workspace, path), randomBytes(size));
  }
  await f.call('write', { path: 'src/main.js', content: Buffer.from('export const ok = 1;').toString('base64') });
  await f.call('write', { path: 'tool/.cache/state.json', content: Buffer.from('{}').toString('base64') });
  const zip = await f.call('archive');
  // The archive itself (also what workspace_archive publishes, which is never restored) names the sources only.
  const listed = await python('import base64,io,json,sys,zipfile; print(json.dumps(zipfile.ZipFile(io.BytesIO(base64.b64decode(json.load(sys.stdin)))).namelist()))', zip.content);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).sort(), ['src/main.js', 'tool/.cache/state.json']);
  const restored = await filesystemFixture(t);
  await restored.call('restore', { content: zip.content });
  assert.equal(await readFile(join(restored.workspace, 'src/main.js'), 'utf8'), 'export const ok = 1;');
  assert.equal(await readFile(join(restored.workspace, 'tool/.cache/state.json'), 'utf8'), '{}');
  await assert.rejects(readFile(join(restored.workspace, '.npm/_cacache/content-v2/sha512/aa/bb/three')), /ENOENT/);
  // A snapshot made before this release still holds npm's cache: the cache is left out, every other file comes back.
  const before = await craftedZip([{ path: '.npm/_cacache/index-v5/aa/bb/three' }, { path: '.cache/pip/selfcheck.json' }, { path: 'p01.js', content: 'part one' }]);
  const older = await filesystemFixture(t);
  await older.call('restore', { content: before });
  assert.equal(await readFile(join(older.workspace, 'p01.js'), 'utf8'), 'part one');
  await assert.rejects(readFile(join(older.workspace, '.npm/_cacache/index-v5/aa/bb/three')), /ENOENT/);
  await assert.rejects(readFile(join(older.workspace, '.cache/pip/selfcheck.json')), /ENOENT/);
});

test('the worker names why a snapshot failed in closed words, and the empty snapshot a run then keeps restores', async t => {
  // The helper's own messages, as the runner sees them (its log never carries the paths they name).
  const failure = async (prepare: (workspace: string) => Promise<void>) => {
    const f = await filesystemFixture(t);
    await prepare(f.workspace);
    return f.call('archive').then(() => 'archived', (error: Error) => snapshotFailure(error));
  };
  assert.equal(await failure(async w => { await writeFile(join(w, 'real'), 'x'); await symlink(join(w, 'real'), join(w, 'link')); }), 'link_or_special_file');
  assert.equal(await failure(async w => { await writeFile(join(w, 'big.bin'), randomBytes(2 * 1024 * 1024 + 1)); }), 'file_too_large');
  assert.equal(await failure(async w => { for (const name of ['a.bin', 'b.bin']) await writeFile(join(w, name), randomBytes(1536 * 1024)); }), 'workspace_too_large');
  assert.equal(snapshotFailure(new Error('Workspace sandbox is closed')), 'interrupted');
  assert.equal(snapshotFailure(undefined), 'other');
  const f = await filesystemFixture(t);
  assert.deepEqual(await f.call('restore', { content: EMPTY_WORKSPACE_SNAPSHOT.content }), { ok: true });
  assert.deepEqual(await readdir(f.workspace), []);
});

test('real filesystem helper rejects symlink files, symlink ancestors, special files and immutable inputs', async t => {
  const f = await filesystemFixture(t);
  await writeFile(join(f.root, 'host-secret'), 'never deliver');
  await symlink(join(f.root, 'host-secret'), join(f.workspace, 'secret'));
  await symlink(f.root, join(f.workspace, 'escape'));
  await assert.rejects(f.call('read', { path: 'secret' }), /symbolic|symlink|Too many/i);
  await assert.rejects(f.call('write', { path: 'secret', content: Buffer.from('overwrite').toString('base64') }), /ordinary/);
  await assert.rejects(f.call('write', { path: 'escape/host-secret', content: Buffer.from('overwrite').toString('base64') }), /directory|symbolic/i);
  assert.equal(await readFile(join(f.root, 'host-secret'), 'utf8'), 'never deliver');
  await assert.rejects(f.call('archive'), /symlink or special/);
  await assert.rejects(f.call('write', { path: 'inputs/task.txt', content: 'eA==' }), /read only/);
  await f.call('inputs', { inputs: [{ path: 'task.txt', content: Buffer.from('source').toString('base64') }] });
  assert.equal(Buffer.from((await f.call('read', { path: 'inputs/task.txt' })).content, 'base64').toString(), 'source');
});

async function craftedZip(entries: { path: string; content?: string; mode?: number; size?: number; compression?: number }[]) {
  const result = await python(`import json,sys,zipfile,io,base64
output=io.BytesIO()
with zipfile.ZipFile(output,'w') as z:
 for e in json.load(sys.stdin):
  i=zipfile.ZipInfo(e['path'])
  i.external_attr=e.get('mode',0o100644)<<16
  i.compress_type=e.get('compression',zipfile.ZIP_DEFLATED)
  z.writestr(i,('x'*e['size'] if 'size' in e else e.get('content','data')).encode())
print(base64.b64encode(output.getvalue()).decode())`, entries);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

test('snapshot restore rejects traversal, symlinks, duplicates, expansion and dependency injection', async t => {
  const f = await filesystemFixture(t);
  for (const entries of [
    [{ path: '../host-secret' }], [{ path: '/etc/passwd' }], [{ path: 'a/../../escape' }],
    [{ path: 'link', content: '/etc/passwd', mode: 0o120777 }],
    [{ path: 'same' }, { path: 'same' }], [{ path: 'huge.txt', size: 2 * 1024 * 1024 + 1 }],
    [{ path: '.git/config' }], [{ path: 'inputs/task.txt' }], [{ path: 'node_modules/payload.js' }],
  ]) {
    await assert.rejects(f.call('restore', { content: await craftedZip(entries) }));
  }
  // Validation occurs before writing the first entry: a late traversal does not leave a partial project.
  await assert.rejects(f.call('restore', { content: await craftedZip([{ path: 'early.txt' }, { path: '../late' }]) }));
  await assert.rejects(readFile(join(f.workspace, 'early.txt')), /ENOENT/);
});

test('real helper refuses overlarge output files instead of returning truncated artifacts', async t => {
  const f = await filesystemFixture(t);
  await writeFile(join(f.workspace, 'large.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(f.call('publish', { path: 'large.bin' }), /size limit/);
  await assert.rejects(f.call('archive'), /size limit/);
});

test('real helper does not follow hardlinks or block while opening a FIFO', async t => {
  const f = await filesystemFixture(t);
  await writeFile(join(f.workspace, 'regular'), 'same inode');
  await link(join(f.workspace, 'regular'), join(f.workspace, 'hardlink'));
  await assert.rejects(f.call('publish', { path: 'hardlink' }), /Hard linked/);
  await assert.rejects(f.call('write', { path: 'hardlink', content: 'eA==' }), /ordinary/);
  const result = await python('import os,json,sys; os.mkfifo(json.load(sys.stdin))', join(f.workspace, 'pipe'));
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(f.call('read', { path: 'pipe' }), /regular files/);
});

test('Docker smoke: execute, repair, publish, snapshot/restore, isolation and timeout cleanup',
  { skip: !process.env.AWWO_TEST_WORKSPACE_IMAGE || !process.env.AWWO_TEST_DOCKER_EXECUTABLE, timeout: 90_000 }, async () => {
    const realConfig = { dockerExecutable: process.env.AWWO_TEST_DOCKER_EXECUTABLE!, image: process.env.AWWO_TEST_WORKSPACE_IMAGE!, dockerContext: process.env.AWWO_TEST_DOCKER_CONTEXT, commandTimeoutMs: 10_000 };
    const sandbox = await createWorkspaceSandbox(realConfig, { workspaceId: 'local-security-smoke', runId: 'one', inputs: [{ name: 'task.txt', content: 'verified input' }] });
    let archive;
    try {
      await sandbox.write('site/index.html', '<h1>Real artifact</h1>');
      assert.equal((await sandbox.exec('node -e "process.exit(3)"')).exitCode, 3);
      const check = await sandbox.exec('node -e "const fs=require(\'fs\'); if(!fs.readFileSync(\'site/index.html\',\'utf8\').includes(\'Real artifact\'))process.exit(1)"');
      assert.equal(check.exitCode, 0);
      assert.equal((await sandbox.publish('site/index.html')).content, '<h1>Real artifact</h1>');
      assert.notEqual((await sandbox.exec('echo changed > /inputs/task.txt')).exitCode, 0);
      assert.equal((await sandbox.read('inputs/task.txt')).content, 'verified input');
      assert.notEqual((await sandbox.exec('touch /etc/awwo-must-not-write')).exitCode, 0);
      const networking = await sandbox.exec("python3 -c \"import socket; s=socket.socket(); s.settimeout(1); s.connect(('1.1.1.1',443))\"");
      assert.notEqual(networking.exitCode, 0);
      const environment = await sandbox.exec('env');
      assert.ok(!environment.stdout.includes('API_KEY=') && !environment.stdout.includes('AWS_ACCESS_KEY'));
      archive = await sandbox.archive();
    } finally { await sandbox.close(); }
    const restored = await createWorkspaceSandbox(realConfig, { workspaceId: 'local-security-smoke', runId: 'two', snapshot: archive });
    try {
      assert.equal((await restored.read('site/index.html')).content, '<h1>Real artifact</h1>');
      // A command that runs out of time is stopped and reported; the workspace and its files stay.
      const stopped = await restored.exec('sleep 30', { timeoutMs: 1000 });
      assert.equal(stopped.exitCode, 124);
      assert.match(stopped.stderr, /stopped this command after 1 s/);
      assert.equal((await restored.read('site/index.html')).content, '<h1>Real artifact</h1>');
    } finally { await restored.close(); }
  });

const TOOL_FIXTURES = fileURLToPath(new URL('../../deploy/saas/workspace/fixtures/', import.meta.url));

async function fixtureInputs(prefix = ''): Promise<{ path: string; content: string; encoding: 'base64' }[]> {
  const inputs: { path: string; content: string; encoding: 'base64' }[] = [];
  for (const entry of await readdir(join(TOOL_FIXTURES, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) inputs.push(...await fixtureInputs(path));
    else inputs.push({ path, content: (await readFile(join(TOOL_FIXTURES, path))).toString('base64'), encoding: 'base64' });
  }
  return inputs;
}

test('Docker smoke: rea and awwo-check-page work offline within the production command limit',
  { skip: !process.env.AWWO_TEST_WORKSPACE_IMAGE || !process.env.AWWO_TEST_DOCKER_EXECUTABLE, timeout: 600_000 }, async t => {
    // 30 s is the command limit both workers use in production; an overrun would remove the container.
    const realConfig = { dockerExecutable: process.env.AWWO_TEST_DOCKER_EXECUTABLE!, image: process.env.AWWO_TEST_WORKSPACE_IMAGE!, dockerContext: process.env.AWWO_TEST_DOCKER_CONTEXT, commandTimeoutMs: 30_000 };
    const sandbox = await createWorkspaceSandbox(realConfig, { workspaceId: 'local-tools-smoke', runId: 'one', inputs: await fixtureInputs() });
    const json = async (path: string) => JSON.parse((await sandbox.read(path)).content);
    try {
      const version = await sandbox.exec('rea --version');
      assert.equal(version.exitCode, 0, version.stderr);
      assert.match(version.stdout, /6\.5\.0/);
      const analysis = await sandbox.exec('rea analyze-javascript-application /inputs/rea-app --json > rea-report.json');
      assert.equal(analysis.exitCode, 0, analysis.stderr);
      const evidence = (await json('rea-report.json')).normalized_result;
      assert.equal(evidence.statistics.parsed_javascript_files, 3);
      const imports = evidence.graph.edges.filter((edge: any) => edge.relation === 'imports')
        .map((edge: any) => `${edge.properties.specifier} -> ${edge.properties.resolved_path ?? edge.properties.resolution_status}`);
      for (const expected of ['./lib/format -> lib/format.js', './lib/store -> lib/store.js', 'node:fs -> external']) assert.ok(imports.includes(expected), expected);

      const pages: Record<string, { exitCode: number; check: (report: any) => void }> = {
        pass: { exitCode: 0, check: report => {
          assert.deepEqual([report.selfTest.passed, report.selfTest.failed, report.selfTest.plantedTotal, report.selfTest.plantedRejected], [4, 0, 2, 2]);
          assert.equal(report.blank, false); assert.equal(report.errorCount, 0);
          assert.deepEqual([report.heldClock.ran, report.heldClock.why], [false, 'the page defines neither window.renderAt nor window.renderAudio']);
        } },
        // A page written for AwwO's renderer is loaded again on the clock the renderer gives it, its timers and frames held
        // until a frame is drawn: once for its first frame, once for its sound, each in a fresh page as the renderer opens
        // them. One whose kernel boots on a timer passes on real timers and fails there, as the renderer refuses it (its
        // __ready, which the renderer waits 10 s for and renders past, is only noted); one ready at once, whose frame and
        // sound share an OfflineAudioContext that a page may render once, passes both; one whose sound waits on a boot
        // that only its first frame or a timer starts fails in its own sound page; one that defines renderAt from a timer
        // fails; one made ready by a 7 s animation, with an interval waiting meanwhile, is waited for and passes.
        'held-timer': { exitCode: 1, check: report => {
          assert.deepEqual([report.selfTest.passed, report.errorCount, report.blank], [1, 0, false]);
          assert.deepEqual([report.heldClock.ran, report.heldClock.why, report.heldClock.unfinished], [true, 'the page defines window.renderAt', null]);
          assert.deepEqual(report.heldClock.steps.map((step: any) => [step.page, step.step, step.ok]), [['frame', 'window.__ready', false], ['frame', 'window.renderAt(0)', false]]);
          // Its __ready is waited for as the renderer waits for it, all 10 s, though the page is held from the first 5.
          assert.ok(report.heldClock.steps[0].ms >= 9500, `ready waited ${report.heldClock.steps[0].ms} ms`);
          assert.deepEqual(report.heldClock.steps[0].waiting, { setTimeout: 1, setInterval: 0, requestAnimationFrame: 0 });
          assert.deepEqual(report.heldClock.steps[1].waiting, { setTimeout: 1, setInterval: 0, requestAnimationFrame: 0 });
          assert.match(report.heldClock.failure, /^window\.renderAt\(0\) had not settled after 5 s, in which the page did no work the renderer could see while 1 setTimeout timer was waiting on its clock\. The renderer moves that clock only when it draws a frame/);
          assert.match(report.heldClock.note, /^window\.__ready was still not true after 5 s, .* renders the page before it is ready/);
          assert.ok(report.reasons.includes(`held clock: ${report.heldClock.failure}`), JSON.stringify(report.reasons));
        } },
        'held-ready': { exitCode: 0, check: report => {
          assert.deepEqual(report.heldClock.steps.map((step: any) => [step.page, step.step, step.ok]),
            [['frame', 'window.__ready', true], ['frame', 'window.renderAt(0)', true], ['sound', 'window.__ready', true], ['sound', 'window.renderAudio', true]]);
          assert.deepEqual([report.heldClock.why, report.heldClock.failure, report.heldClock.unfinished, report.heldClock.note], ['the page defines window.renderAt and window.renderAudio', null, null, null]);
        } },
        'held-sound': { exitCode: 1, check: report => {
          assert.deepEqual(report.heldClock.steps.map((step: any) => [step.page, step.step, step.ok]), [['frame', 'window.renderAt(0)', true], ['sound', 'window.renderAudio', false]]);
          assert.match(report.heldClock.failure, /^window\.renderAudio had not settled after 5 s, in which the page did no work the renderer could see while 1 setTimeout timer was waiting on its clock\./);
        } },
        'held-late': { exitCode: 1, check: report => assert.match(report.heldClock.failure, /^window\.renderAt is not defined on the held clock when the renderer looks for it \(once the page has loaded and is ready\), though it was in the first load/) },
        'held-animation': { exitCode: 0, check: report => {
          assert.deepEqual(report.heldClock.steps.map((step: any) => [step.page, step.step, step.ok]), [['frame', 'window.__ready', true], ['frame', 'window.renderAt(0)', true]]);
          assert.ok(report.heldClock.steps[0].ms >= 5500, `ready after ${report.heldClock.steps[0].ms} ms`);
          assert.deepEqual([report.heldClock.failure, report.heldClock.unfinished, report.heldClock.note], [null, null, null]);
        } },
        'failing-test': { exitCode: 1, check: report => {
          assert.deepEqual([report.selfTest.passed, report.selfTest.failed], [3, 1]);
          assert.ok(report.selfTest.items.tests.some((item: any) => item.name === '1900 is not a leap year' && item.ok === false));
        } },
        'planted-escape': { exitCode: 1, check: report => {
          assert.deepEqual([report.selfTest.failed, report.selfTest.plantedTotal, report.selfTest.plantedRejected], [0, 2, 1]);
        } },
        malformed: { exitCode: 1, check: report => assert.match(report.selfTest.malformed, /tests\[0\]/) },
        throws: { exitCode: 1, check: report => {
          assert.equal(report.errors[0].kind, 'uncaught'); assert.equal(report.errors[0].phase, 'load');
          assert.match(report.errors[0].message, /TypeError: Cannot read properties of undefined \(reading 'list'\)/);
        } },
        rejection: { exitCode: 1, check: report => {
          assert.ok(report.errors.some((error: any) => error.kind === 'unhandledrejection' && error.message.includes('fixture: the save slot is missing')));
        } },
        blank: { exitCode: 1, check: report => {
          assert.equal(report.blank, true); assert.equal(report.errorCount, 0); assert.equal(report.selfTest.present, false);
        } },
        network: { exitCode: 0, check: report => {
          const blocked = report.blockedRequests.map((request: any) => new URL(request.url).hostname);
          for (const host of ['fonts.googleapis.com', 'cdn.jsdelivr.net', 'api.example.com', 'live.example.com']) assert.ok(blocked.includes(host), host);
          assert.equal(report.selfTest.passed, 3);
        } },
        webgl: { exitCode: 0, check: report => assert.deepEqual([report.selfTest.passed, report.selfTest.failed], [2, 0]) },
        // The three.js 0.186.1 files AwwO's preview supplies, from jsDelivr (an addon from unpkg, a .min.js one from
        // fastly.jsdelivr.net), are answered from the image's copy; it draws a box. A file the preview does not supply
        // (lil-gui) stays blocked, with the reason.
        three: { exitCode: 0, check: report => {
          assert.deepEqual([report.selfTest.passed, report.selfTest.failed], [5, 0], JSON.stringify(report.selfTest.items));
          assert.equal(report.libraries.three, '0.186.1');
          const served = report.libraryRequests.map((request: any) => new URL(request.url).pathname);
          for (const expected of ['/npm/three@0.186.1/build/three.module.js', '/three@0.186.1/examples/jsm/math/ImprovedNoise.js', '/npm/three@0.186.1/examples/jsm/math/SimplexNoise.min.js']) assert.ok(served.includes(expected), `${expected} in ${JSON.stringify(served)}`);
          assert.ok(report.libraryRequests.every((request: any) => request.status === 200));
          assert.deepEqual(report.blockedRequests.map((request: any) => [new URL(request.url).pathname, /files AwwO's preview supplies/.test(request.reason)]), [['/npm/three@0.186.1/examples/jsm/libs/lil-gui.module.min.js', true]]);
        } },
        // Any other version, or an address the CDN does not serve, is blocked like every other request.
        'three-version': { exitCode: 0, check: report => {
          assert.deepEqual([report.selfTest.passed, report.selfTest.failed], [4, 0], JSON.stringify(report.selfTest.items));
          const blocked = report.blockedRequests.map((request: any) => request.url);
          for (const expected of ['https://cdn.jsdelivr.net/npm/three@0.150.0/', 'https://cdn.jsdelivr.net/three@0.186.1/', 'https://unpkg.com/npm/three@0.186.1/', 'https://cdn.jsdelivr.net:8443/npm/three@0.186.1/']) assert.ok(blocked.some((url: string) => url.startsWith(expected)), expected);
          assert.equal(report.libraryRequests.length, 0);
          assert.ok(report.blockedRequests.every((request: any) => request.reason === undefined));
        } },
        // Served from the page's directory over the check's private origin: modules, fetch and a worker all load.
        modules: { exitCode: 0, check: report => assert.deepEqual([report.selfTest.passed, report.selfTest.failed], [4, 0]) },
        cancelled: { exitCode: 1, check: report => {
          assert.equal(report.errorCount, 2);
          for (const message of ['the inventory failed to load', 'the save slot is missing']) assert.ok(report.errors.some((error: any) => error.message.includes(message) && error.message.includes('(cancelled by the page)')), message);
        } },
        noise: { exitCode: 0, check: report => { assert.ok(report.screenshotScale < 1); assert.equal(report.blank, false); } },
      };
      for (const [page, expected] of Object.entries(pages)) {
        const run = await sandbox.exec(`awwo-check-page /inputs/check-page/${page}.html --out checks/${page}`);
        assert.equal(run.exitCode, expected.exitCode, `${page}: ${run.stdout}${run.stderr}`);
        const report = await json(`checks/${page}/report.json`);
        assert.equal(report.exitCode, expected.exitCode);
        expected.check(report);
        t.diagnostic(`${page}: exit ${run.exitCode}, ${report.timings.totalMs} ms (launch ${report.timings.launchMs} ms), Chromium ${report.chromium.version}`);
      }
      // A missing local file is an error, unless --missing-ok names it and the page fetched it as data, a picture, sound,
      // video or a font: then it is listed and the page passes. Missing code always counts, and so does a page's own
      // error that only reads like the browser's entry for an allowed file.
      const check = async (name: string, page: string, flags = '') => {
        const run = await sandbox.exec(`awwo-check-page /inputs/check-page/${page}.html --out checks/${name} ${flags}`);
        return { run, report: await json(`checks/${name}/report.json`) };
      };
      const missing = await check('missing-model', 'missing-model');
      assert.equal(missing.run.exitCode, 1, missing.run.stdout);
      assert.ok(missing.report.errors.some((error: any) => /404/.test(error.message)));
      assert.equal((await check('missing-other', 'missing-model', "--missing-ok 'textures/*.png'")).run.exitCode, 1);
      const allowed = await check('missing-allowed', 'missing-model', "--missing-ok './models/*.glb'");
      assert.equal(allowed.run.exitCode, 0, allowed.run.stdout);
      assert.deepEqual([allowed.report.errorCount, allowed.report.selfTest.passed, allowed.report.missingOk], [0, 1, ['models/*.glb']]);
      assert.deepEqual(allowed.report.missingAllowed.map((entry: any) => [new URL(entry.url).pathname, entry.type]), [['/models/hero.glb', 'fetch']]);
      const code = await check('missing-code', 'missing-code', "--missing-ok 'models/*'");
      assert.equal(code.run.exitCode, 1, code.run.stdout);
      assert.ok(code.report.errors.some((error: any) => /404/.test(error.message) && error.message.includes('main.js')), JSON.stringify(code.report.errors));
      // models/boot was fetched as data (excused, listed) and then loaded as a script: one of its two 404s still counts.
      assert.equal(code.report.errorCount, 2, JSON.stringify(code.report.errors));
      assert.deepEqual(code.report.missingAllowed.map((entry: any) => new URL(entry.url).pathname).sort(), ['/models/boot', '/models/hero.glb']);
      // --no-held-clock skips the second load, --held-clock makes it for any page, and neither takes a value.
      const skipped = await check('held-off', 'held-timer', '--no-held-clock');
      assert.equal(skipped.run.exitCode, 0, skipped.run.stdout);
      assert.deepEqual([skipped.report.heldClock.ran, skipped.report.heldClock.why], [false, '--no-held-clock']);
      const forced = await check('held-on', 'pass', '--held-clock');
      assert.equal(forced.run.exitCode, 0, forced.run.stdout);
      assert.deepEqual([forced.report.heldClock.ran, forced.report.heldClock.steps], [true, []]);
      assert.equal((await sandbox.exec('awwo-check-page /inputs/check-page/pass.html --out checks/held-value --held-clock=on')).exitCode, 2);
      // A check on the held clock that the budget cuts short fails nothing and is no pass either: exit 4, not finished.
      const short = await check('held-short', 'held-timer', '--budget-ms 12000');
      assert.equal(short.run.exitCode, 4, short.run.stdout);
      assert.deepEqual([short.report.verdict, short.report.exitCode, short.report.reasons, short.report.heldClock.failure], ['unfinished', 4, [], null]);
      assert.match(short.report.heldClock.unfinished, /what --budget-ms had left|not within/);
      assert.match(short.run.stdout, /UNFINISHED[\s\S]*held clock: NOT FINISHED/);
      const spoof = await check('missing-spoof', 'missing-spoof', "--missing-ok 'models/*.glb'");
      assert.equal(spoof.run.exitCode, 1, spoof.run.stdout);
      assert.equal(spoof.report.errorCount, 1, JSON.stringify(spoof.report.errors));
      assert.ok(spoof.report.missingAllowed.some((entry: any) => entry.url.endsWith('/models/hero.glb')));
      for (const pattern of ['../x', '/srv/*.glb']) assert.equal((await sandbox.exec(`awwo-check-page /inputs/check-page/pass.html --out checks/bad-pattern --missing-ok '${pattern}'`)).exitCode, 2, pattern);
      const many = Array.from({ length: 21 }, (_, index) => `--missing-ok 'm${index}/*'`).join(' ');
      assert.equal((await sandbox.exec(`awwo-check-page /inputs/check-page/pass.html --out checks/bad-pattern ${many}`)).exitCode, 2);
      // A screenshot over 400,000 bytes is kept smaller, so the workspace snapshot keeps room.
      assert.ok((await sandbox.read('checks/noise/screenshot.png')).byteLength <= 400_000);
      const hang = await sandbox.exec('awwo-check-page /inputs/check-page/hang.html --out checks/hang --timeout-ms 1000');
      assert.equal(hang.exitCode, 1, hang.stdout);
      assert.equal((await json('checks/hang/report.json')).selfTest.timedOut, true);
      // A self-test timeout beyond the budget is cut to what the budget leaves; the check still ends in time.
      const budget = await sandbox.exec('awwo-check-page /inputs/check-page/hang.html --out checks/budget --timeout-ms 60000 --budget-ms 12000');
      assert.equal(budget.exitCode, 1, budget.stdout);
      const budgetReport = await json('checks/budget/report.json');
      assert.match(budgetReport.selfTest.error, /what --budget-ms had left/);
      assert.ok(budgetReport.timings.totalMs < 13_000, String(budgetReport.timings.totalMs));
      assert.equal((await sandbox.exec('awwo-check-page /inputs/check-page/pass.html --wait-ms 20000')).exitCode, 2);
      assert.equal((await sandbox.exec('awwo-check-page /inputs/check-page/missing.html --out checks/pass')).exitCode, 2);
      // The missing page's run removed the earlier report rather than leaving a stale pass behind.
      await assert.rejects(sandbox.read('checks/pass/report.json'));
      // The check cannot write its report into the read-only inputs, so it could not run.
      assert.equal((await sandbox.exec('awwo-check-page /inputs/check-page/pass.html --out /inputs/out')).exitCode, 3);
      const usage = await sandbox.exec('cat /sys/fs/cgroup/pids.peak /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes; ls -A /tmp');
      t.diagnostic(`peak tasks and memory bytes (cgroup v2; v1 has the memory peak only), then /tmp leftovers: ${usage.stdout.trim().replace(/\n/g, ' ')}`);
      // Chromium's profile and caches stay out of the workspace, so the snapshot is still a plain source archive.
      assert.deepEqual((await sandbox.list('')).map(entry => entry.path).sort(), ['checks', 'inputs', 'rea-report.json']);
      await sandbox.archive();
    } finally { await sandbox.close(); }
  });
