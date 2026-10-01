import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkspaceSandbox, validateWorkspacePath, workspaceDockerArgs, WORKSPACE_FILE_HELPER } from './workspace-sandbox.ts';
import type { WorkspaceDockerRunner } from './workspace-sandbox.ts';

const config = { dockerExecutable: '/usr/bin/docker', image: 'awwo-workspace@sha256:' + 'a'.repeat(64) };
const digest = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
const metadata = (path: string, content: Buffer) => ({ path, content: content.toString('base64'), encoding: 'base64', byteLength: content.length, sha256: digest(content) });
const response = (value: unknown, code = 0, stderr = '') => ({ code, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.from(stderr) });

test('container arguments enforce isolation without host mounts, inherited credentials or a shell', () => {
  const args = workspaceDockerArgs('awwo-ws-test', config.image);
  for (const flag of ['--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=1g', '--memory-swap=1g', '--cpus=1', '--pids-limit=128', '--pull=never']) assert.ok(args.includes(flag), flag);
  assert.ok(args.some(value => value.startsWith('/workspace:rw,nosuid,nodev,size=134217728')));
  assert.ok(args.includes('--entrypoint=python3'));
  assert.ok(!args.some(value => value.includes('docker.sock') || value === '--privileged' || value === '--mount' || value === '--volume'));
  assert.ok(!args.join(' ').includes(process.env.OPENAI_API_KEY ?? 'fixture-provider-secret'));
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
      await assert.rejects(restored.exec('sleep 30', { timeoutMs: 100 }), /timed out|failed/);
      await assert.rejects(restored.read('site/index.html'), /closed/);
    } finally { await restored.close(); }
  });
