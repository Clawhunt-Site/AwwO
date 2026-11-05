import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BLENDER_KEEP_ALIVE, BLENDER_MCP_OUTPUT_BYTES, BLENDER_RESULT_CHARS, BLENDER_SCENE_LOST, BLENDER_SNAPSHOT_LEAVE_OUT, BLENDER_TOOL_NAMES, blenderArguments, blenderBridge, blenderCallResult, blenderGpu, blenderInstructions,
  blenderTools, loadWorkspaceBlender, type BlenderAbilities } from './workspace-blender.ts';
import { loadWorkspaceConfig } from './workspace-protocol.ts';
import { COMMAND_HELPER, createWorkspaceSandbox, WORKSPACE_FILE_HELPER, workspaceDockerArgs, type WorkspaceDockerRunner } from './workspace-sandbox.ts';
import { dispatchWorkspaceTool, validWorkspaceCall } from './workspace-rpc.ts';
import { executeWorkspaceAgent, inputsInstruction } from './workspace-runtime.ts';

const image = 'awwo-blender@sha256:' + 'b'.repeat(64);
const blender = { cpus: 8, callSeconds: 280, gpus: 'device=0' };
const response = (value: unknown, code = 0) => ({ code, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', title: 'x', properties, required });
// What the official MCP server (blmcp 1.0.3) lists, as mcp_call.py returns it: real names and schemas, shortened.
const listing = {
  ok: true, instructions: 'You have access to Blender tools to interact with a Blender scene directly.', server: { name: 'blender-mcp' },
  gpu: { device: 'GPU', backend: 'CUDA', names: ['NVIDIA GeForce RTX 4090 D'], eevee: 'software' },
  tools: [
    { name: 'execute_blender_code', description: 'Execute Python code in the connected Blender instance.', inputSchema: schema({ code: { title: 'Code', type: 'string' } }, ['code']) },
    { name: 'execute_blender_code_for_cli', description: 'Execute Python code in a background Blender process.', inputSchema: schema({ blend_file: { type: 'string' }, code: { type: 'string' } }, ['blend_file', 'code']) },
    { name: 'get_objects_summary', description: "Return the scene's collection hierarchy and their objects.", inputSchema: schema({}) },
    { name: 'search_api_docs', description: 'Full-text search over the bundled Blender Python API reference.', inputSchema: schema({
      query: { title: 'Query', type: 'string' }, max_results: { default: 20, title: 'Max Results', type: 'integer' },
      index: { anyOf: [{ type: 'integer' }, { type: 'null' }], default: null, title: 'Index' } }, ['query']) },
    { name: 'get_screenshot_of_area_as_image', description: 'Take a screenshot.', inputSchema: schema({ area_ui_type: { enum: ['VIEW_3D'], type: 'string' } }) },
    { name: 'render_viewport_to_path', description: 'Render the current scene to output_path.', inputSchema: schema({ output_path: { type: 'string' } }, ['output_path']) },
    { name: 'get_python_api_docs', description: 'Return the Blender Python API docs.', inputSchema: schema({ identifier: { type: 'array', items: { type: 'string' } } }, ['identifier']) },
  ],
};

test('the workstation is off unless switched on, and its options are bounded', () => {
  assert.equal(loadWorkspaceBlender({}), undefined);
  assert.equal(loadWorkspaceBlender({ AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER: 'off' }), undefined);
  assert.deepEqual(loadWorkspaceBlender({ AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER: 'on' }), { cpus: 8, callSeconds: 280 });
  assert.deepEqual(loadWorkspaceBlender({ AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER: 'on', AWWO_OPENAI_AGENTS_WORKSPACE_GPUS: 'device=0,1', AWWO_OPENAI_AGENTS_WORKSPACE_CPUS: '12',
    AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER_CALL_SECONDS: '120' }), { gpus: 'device=0,1', cpus: 12, callSeconds: 120 });
  for (const env of [{ AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER: 'yes' }, { AWWO_OPENAI_AGENTS_WORKSPACE_GPUS: 'all,--privileged' }, { AWWO_OPENAI_AGENTS_WORKSPACE_GPUS: 'device=a' },
    { AWWO_OPENAI_AGENTS_WORKSPACE_CPUS: '0' }, { AWWO_OPENAI_AGENTS_WORKSPACE_CPUS: '33' }, { AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER_CALL_SECONDS: '291' },
    { AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER_CALL_SECONDS: '9' }]) {
    assert.throws(() => loadWorkspaceBlender({ AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER: 'on', ...env }), /AWWO_OPENAI_AGENTS_WORKSPACE_/, JSON.stringify(env));
  }
});

test('the worker configuration takes the workstation with its larger bounds, a Docker context, and refuses it with the web', () => {
  const base = { AWWO_OPENAI_AGENTS_WORKSPACE_IMAGE: image, AWWO_OPENAI_AGENTS_WORKSPACE_CALLBACK_URL: 'http://127.0.0.1:8087/api/internal/workspace-calls' };
  const plain = loadWorkspaceConfig(base)!;
  assert.equal(plain.blender, undefined);
  assert.equal(plain.commandTimeoutMs, 30_000);
  assert.throws(() => loadWorkspaceConfig({ ...base, AWWO_OPENAI_AGENTS_WORKSPACE_MEMORY_MB: '8192' }), /256-4096/);
  const station = loadWorkspaceConfig({ ...base, AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER: 'on', AWWO_OPENAI_AGENTS_WORKSPACE_MEMORY_MB: '12288',
    AWWO_OPENAI_AGENTS_WORKSPACE_COMMAND_TIMEOUT_MS: '600000', AWWO_OPENAI_AGENTS_WORKSPACE_DOCKER_CONTEXT: 'awwo-gpu' })!;
  assert.deepEqual([station.blender, station.memoryMB, station.commandTimeoutMs, station.dockerContext], [{ cpus: 8, callSeconds: 280 }, 12288, 600_000, 'awwo-gpu']);
  assert.equal(loadWorkspaceConfig({ ...base, AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER: 'on' })!.commandTimeoutMs, 120_000);
  assert.throws(() => loadWorkspaceConfig({ ...base, AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER: 'on', AWWO_OPENAI_AGENTS_WORKSPACE_MEMORY_MB: '1024' }), /2048-32768/);
  assert.throws(() => loadWorkspaceConfig({ ...base, AWWO_OPENAI_AGENTS_WORKSPACE_COMMAND_TIMEOUT_MS: '600000' }), /1000-120000/);
  assert.throws(() => loadWorkspaceConfig({ ...base, AWWO_OPENAI_AGENTS_WORKSPACE_DOCKER_CONTEXT: 'ssh://host' }), /DOCKER_CONTEXT/);
  assert.throws(() => loadWorkspaceConfig({ ...base, AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER: 'on', AWWO_WORKSPACE_EGRESS_DIR: '/srv/egress',
    AWWO_WORKSPACE_EGRESS_SECRET: 'x'.repeat(40) }), /no web/);
});

test('a workstation container is a workspace container with the GPU, more room and Blender\'s supervisor as PID 1', () => {
  const plain = workspaceDockerArgs('awwo-ws-test', image);
  const args = workspaceDockerArgs('awwo-ws-test', image, undefined, undefined, undefined, blender);
  for (const flag of ['--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pull=never',
    '--memory=8192m', '--memory-swap=8192m', '--cpus=8', '--pids-limit=1024', '--ulimit=nofile=8192:8192']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--gpus') + 1], 'device=0');
  assert.ok(args.includes('NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics'));
  assert.ok(args.some(value => value.startsWith('/workspace:rw,nosuid,nodev,size=1073741824,nr_inodes=16384,')));
  assert.ok(args.some(value => value.startsWith('/tmp:rw,nosuid,nodev,noexec,size=1073741824,')));
  assert.deepEqual(args.slice(-4), [image, '-I', '-S', '/opt/awwo/blender/supervisor.py']);
  assert.ok(!args.some(value => value.includes('docker.sock') || value === '--privileged' || value === '--mount' || value === '--volume' || value.startsWith('--network=host')));
  // No GPU named, no GPU given; a workspace's own arguments stay as they were.
  const cpuOnly = workspaceDockerArgs('awwo-ws-test', image, undefined, 4096, undefined, { cpus: 4, callSeconds: 60 });
  assert.ok(!cpuOnly.includes('--gpus') && cpuOnly.includes('--cpus=4') && cpuOnly.includes('--memory=4096m'));
  assert.ok(plain.includes('--cpus=1') && plain.includes('--memory=1g') && !plain.includes('--gpus') && plain.at(-2) === '-c');
  assert.throws(() => workspaceDockerArgs('awwo-ws-test', image, undefined, 1024, undefined, blender), /memory/);
  assert.throws(() => workspaceDockerArgs('awwo-ws-test', image, { socketDir: '/srv/egress', proxyURL: 'http://x:y@127.0.0.1:3128' }, undefined, undefined, blender), /no web/);
  assert.throws(() => workspaceDockerArgs('awwo-ws-test', image, undefined, undefined, undefined, { ...blender, gpus: 'all --privileged' }), /GPUs/);
  // docker reads --gpus as CSV: a device list is one quoted field, or it is read as a device and a count.
  const two = workspaceDockerArgs('awwo-ws-test', image, undefined, undefined, undefined, { ...blender, gpus: 'device=0,1' });
  assert.equal(two[two.indexOf('--gpus') + 1], '"device=0,1"');
  const every = workspaceDockerArgs('awwo-ws-test', image, undefined, undefined, undefined, { ...blender, gpus: 'all' });
  assert.equal(every[every.indexOf('--gpus') + 1], 'all');
});

test('the offered tools are those that work without a window, with schemas a model is given as they are or not at all', () => {
  const { tools, instructions } = blenderTools(listing);
  assert.deepEqual(tools.map(tool => tool.name), ['execute_blender_code', 'get_objects_summary', 'render_viewport_to_path', 'search_api_docs']);
  assert.equal(instructions, listing.instructions);
  // pydantic's optional integer (anyOf integer/null, default null) is an integer a model may leave out.
  assert.deepEqual(tools.find(tool => tool.name === 'search_api_docs')!.inputSchema,
    { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer' }, index: { type: 'integer' } }, required: ['query'] });
  assert.ok(tools.every(tool => (BLENDER_TOOL_NAMES as readonly string[]).includes(tool.name)));
  assert.throws(() => blenderTools({ ...listing, tools: listing.tools.filter(tool => tool.name !== 'execute_blender_code') }), /execute_blender_code/);
  assert.throws(() => blenderTools({ ok: false }), /tool list/);
  assert.throws(() => blenderTools({ ok: true, tools: Array.from({ length: 65 }, () => listing.tools[0]) }), /tool list/);
  const long = blenderTools({ ...listing, instructions: 'i'.repeat(40_000), tools: [{ ...listing.tools[0], description: 'd'.repeat(10_000) }] });
  assert.equal(long.instructions.length, 16 * 1024);
  assert.equal(long.tools[0].description.length, 4096);
});

test('a model\'s arguments must fit the tool\'s schema exactly', () => {
  const tools = blenderTools(listing).tools;
  const code = tools.find(tool => tool.name === 'execute_blender_code')!, search = tools.find(tool => tool.name === 'search_api_docs')!;
  assert.deepEqual(blenderArguments(code, { code: 'result = {}' }), { code: 'result = {}' });
  assert.deepEqual(blenderArguments(search, { query: 'bmesh', max_results: 5 }), { query: 'bmesh', max_results: 5 });
  for (const [tool, value] of [[code, {}], [code, { code: 1 }], [code, { code: 'x', extra: 'y' }], [code, null], [code, ['code']],
    [search, { query: 'x', max_results: 1.5 }], [search, { query: 'x', max_results: Number.NaN }], [search, { query: 'x', index: '2' }]] as const) {
    assert.equal(blenderArguments(tool, value), undefined, JSON.stringify(value));
  }
});

test('an answer is text cut to size, and a failed call says what happened in closed words', () => {
  assert.deepEqual(blenderCallResult({ ok: true, content: [{ type: 'text', text: '{"status": "ok"}' }], isError: false }), { text: '{"status": "ok"}', isError: false, restarted: false });
  const big = blenderCallResult({ ok: true, content: [{ type: 'text', text: 'x'.repeat(BLENDER_RESULT_CHARS + 10) }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: true });
  assert.ok(big.isError && big.text.startsWith('x'.repeat(100)) && big.text.includes('cut: the answer was') && big.text.length < BLENDER_RESULT_CHARS + 200);
  assert.ok(!big.text.includes('AAAA'));
  const timedOut = blenderCallResult({ ok: false, error: 'timeout', restarted: true });
  assert.ok(timedOut.isError && timedOut.restarted && /ran out of time/.test(timedOut.text) && timedOut.text.startsWith(BLENDER_SCENE_LOST.during));
  // An answer too large to read (a local trial's code returned a lattice printed whole) says so, and that the scene
  // keeps what the code did, rather than that the server could not answer.
  const tooLarge = blenderCallResult({ ok: false, error: 'too large', restarted: false });
  assert.ok(tooLarge.isError && !tooLarge.restarted && /too large to read/.test(tooLarge.text) && /scene keeps what it did/.test(tooLarge.text));
  assert.ok(!/could not answer/.test(tooLarge.text));
  // Blender stopped after it sent the answer, or before the call: the scene is gone, and the answer does not say it is
  // kept (review round 10).
  for (const [value, lost] of [[{ ok: false, error: 'too large', restarted: true }, false], [{ ok: false, error: 'too large', restarted: false }, true]] as const) {
    const gone = blenderCallResult(value, lost);
    assert.ok(gone.isError && gone.restarted && /too large to read/.test(gone.text) && !/scene keeps/.test(gone.text), gone.text);
    assert.ok(gone.text.startsWith(value.restarted ? BLENDER_SCENE_LOST.during : BLENDER_SCENE_LOST.before));
  }
  // A call during which Blender stopped (the code exited or crashed it) says first that the scene is gone, so that a
  // shortened copy of the answer still says it; so does a call that found Blender started again since the last one.
  const crashed = blenderCallResult({ ok: true, content: [{ type: 'text', text: 'Socket error communicating with Blender' }], isError: true, restarted: true });
  assert.deepEqual(crashed, { isError: true, restarted: true, text: `${BLENDER_SCENE_LOST.during}\nSocket error communicating with Blender` });
  const after = blenderCallResult({ ok: true, content: [{ type: 'text', text: '{"status": "ok"}' }], isError: false, restarted: false }, true);
  assert.deepEqual(after, { isError: true, restarted: true, text: `${BLENDER_SCENE_LOST.before}\n{"status": "ok"}` });
  assert.ok(blenderCallResult({ ok: false, error: 'EOFError: x' }, true).text.startsWith(BLENDER_SCENE_LOST.before));
  assert.equal(blenderCallResult({ ok: true, content: [{ type: 'text', text: 'ok' }], isError: false, restarted: false }).restarted, false);
  const broken = blenderCallResult({ ok: false, error: 'EOFError: secret /internal/path', restarted: false });
  assert.ok(broken.isError && !broken.text.includes('/internal/path') && !broken.restarted);
  // Which Blender answered is read only in mcp_call.py's form.
  assert.equal(blenderBridge({ before: '41:123456' }, 'before'), '41:123456');
  for (const value of [{ before: '41' }, { before: 41 }, { before: '41:12; rm' }, null]) assert.equal(blenderBridge(value, 'before'), null);
  assert.throws(() => blenderCallResult({ ok: true }), /Invalid/);
  assert.throws(() => blenderCallResult('x'), /Invalid/);
});

test('the GPU is told as the container found it, and the instructions say how to work in the workstation', () => {
  assert.deepEqual(blenderGpu(listing.gpu), { cycles: 'CUDA: NVIDIA GeForce RTX 4090 D', eevee: 'software' });
  assert.deepEqual(blenderGpu({ device: 'GPU', backend: 'OPTIX', names: ['A$(rm -rf /)', 'L40S'], eevee: 'gpu' }), { cycles: 'OPTIX: L40S', eevee: 'gpu' });
  assert.deepEqual(blenderGpu({ device: 'CPU', backend: 'NONE', names: [] }), { cycles: 'none', eevee: 'software' });
  assert.deepEqual(blenderGpu(undefined), { cycles: 'none', eevee: 'software' });
  const abilities: BlenderAbilities = { ...blenderTools(listing), gpu: blenderGpu(listing.gpu), callSeconds: 280 };
  const text = blenderInstructions(abilities);
  for (const words of ['Blender 5.2.3', '280 s', 'scene.py', '/workspace/out/', 'workspace_publish', 'CUDA: NVIDIA GeForce RTX 4090 D', 'render with Cycles',
    "export_format='GLB'", 'no Draco', 'at most 2 MiB', 'awwo_param', 'no network', listing.instructions]) assert.ok(text.includes(words), words);
  const cpu = blenderInstructions({ ...abilities, gpu: { cycles: 'none', eevee: 'software' } });
  assert.ok(cpu.includes('no GPU') && !cpu.includes('CUDA'));
});

test('awwo_param offers every generator the instructions name', async () => {
  // The instructions promise these; the package in the image must have them (deploy/saas/blender/awwo_param).
  const init = await readFile(fileURLToPath(new URL('../../deploy/saas/blender/awwo_param/__init__.py', import.meta.url)), 'utf8');
  const text = blenderInstructions({ ...blenderTools(listing), gpu: blenderGpu(listing.gpu), callSeconds: 280 });
  const promised = /awwo_param` in execute_blender_code gives tested parametric generators \(([^)]*)\)/.exec(text)![1];
  for (const [words, module] of [['minimal surfaces', 'minimal'], ['Voronoi skins', 'voronoi'], ['attractor panels', 'attractors'], ['ice-crack tiling', 'icecrack'],
    ['phyllotaxis and spirals', 'spirals'], ['reciprocal frames', 'reciprocal'], ['slime-mould networks', 'slime']] as const) {
    assert.ok(promised.includes(words), words);
    assert.match(init, new RegExp(`\\b${module}\\b`), module);
  }
});

test('a workstation waits for Blender, lists its tools once, and calls only an offered tool with fitting arguments', async () => {
  const calls: { args: string[]; input?: string; timeoutMs: number }[] = [];
  const runner: WorkspaceDockerRunner = async (args, options) => {
    calls.push({ args, input: options.input, timeoutMs: options.timeoutMs });
    if (args.includes('/opt/awwo/blender/mcp_call.py')) {
      const request = JSON.parse(options.input!);
      if (request.op === 'list') return response(listing);
      return response({ ok: true, content: [{ type: 'text', text: JSON.stringify({ status: 'ok', result: { echo: request.arguments } }) }], isError: false });
    }
    if (args.includes(COMMAND_HELPER)) return response({ exitCode: 0, stdout: '', stderr: '', truncated: false });
    return response({ ok: true });
  };
  const sandbox = await createWorkspaceSandbox({ dockerExecutable: '/usr/bin/docker', image, blender }, { workspaceId: 'tenant/node', runId: 'run1' }, undefined, runner);
  assert.ok(calls[0].args.includes('/opt/awwo/blender/supervisor.py'));
  assert.ok(calls[1].args.includes('-c') && calls[1].args.at(-1)!.includes("create_connection(('127.0.0.1', 9876)"));
  const abilities = await sandbox.blender!.abilities();
  assert.equal(abilities.tools.length, 4);
  assert.deepEqual(abilities.gpu, { cycles: 'CUDA: NVIDIA GeForce RTX 4090 D', eevee: 'software' });
  assert.equal(abilities.callSeconds, 280);
  await sandbox.blender!.abilities();
  assert.equal(calls.filter(call => call.input?.includes('"op":"list"')).length, 1);
  const answer = await sandbox.blender!.call('execute_blender_code', { code: 'result = {}' });
  assert.equal(answer.isError, false);
  const sent = calls.at(-1)!;
  assert.deepEqual(JSON.parse(sent.input!), { op: 'call', name: 'execute_blender_code', arguments: { code: 'result = {}' }, timeoutSeconds: 280 });
  assert.equal(sent.timeoutMs, 300_000);
  assert.deepEqual(sent.args.slice(0, 5), ['exec', '--interactive', '--user', '1000:1000', sent.args[4]]);
  await assert.rejects(sandbox.blender!.call('execute_blender_code_for_cli', { blend_file: 'x', code: 'y' }), /Invalid Blender tool call/);
  await assert.rejects(sandbox.blender!.call('execute_blender_code', { code: 'x', blend_file: 'y' }), /Invalid Blender tool call/);
  // A command spares Blender's bridge; a snapshot leaves the outputs out.
  await sandbox.exec('ls');
  assert.equal(JSON.parse(calls.at(-1)!.input!).keepAlive, 'blender-bridge');
  // The node's snapshot leaves the outputs and binaries out; the project ZIP an agent publishes keeps every file.
  await dispatchWorkspaceTool(sandbox, 'snapshot', {}).catch(() => undefined);
  assert.deepEqual(JSON.parse(calls.at(-1)!.input!).snapshotLeaveOut, BLENDER_SNAPSHOT_LEAVE_OUT);
  await dispatchWorkspaceTool(sandbox, 'workspace_archive', { field: 'project' }).catch(() => undefined);
  assert.equal(JSON.parse(calls.at(-1)!.input!).snapshotLeaveOut, undefined);
  // The IPC relay reaches it only as blender_call, with a tool name and an arguments object.
  assert.ok(validWorkspaceCall({ type: 'workspace_call', sequence: 1, name: 'blender_call', args: { tool: 'get_objects_summary', arguments: {} } }));
  assert.ok(!validWorkspaceCall({ type: 'workspace_call', sequence: 1, name: 'execute_blender_code', args: {} }));
  const relayed = await dispatchWorkspaceTool(sandbox, 'blender_call', { tool: 'get_objects_summary', arguments: {} }) as { isError: boolean };
  assert.equal(relayed.isError, false);
  await assert.rejects(dispatchWorkspaceTool(sandbox, 'blender_call', { tool: 'get_objects_summary', arguments: [] }), /Unknown workspace operation/);
  await sandbox.close();
});

test('a call that finds another Blender than the one that answered last says the scene was lost in between', async () => {
  // mcp_call.py names the Blender running when a request came (before) and when it was answered (after); the sandbox
  // keeps the last answer's, outside the container.
  const bridges = [{ after: '7:100' }, { before: '7:100', after: '7:100' }, { before: '9:300', after: '9:300' }, { before: null, after: '11:400' },
    { before: '11:400', after: null }, { before: '12:500', after: '12:500' }, { before: '12:500', after: '12:500' }];
  let index = 0;
  const runner: WorkspaceDockerRunner = async (args, options) => {
    if (args.includes('/opt/awwo/blender/mcp_call.py')) {
      const request = JSON.parse(options.input!);
      const bridge = bridges[index++];
      if (request.op === 'list') return response({ ...listing, ...bridge });
      return response({ ok: true, content: [{ type: 'text', text: '{"status": "ok"}' }], isError: false, restarted: false, ...bridge });
    }
    return response({ ok: true });
  };
  const sandbox = await createWorkspaceSandbox({ dockerExecutable: '/usr/bin/docker', image, blender }, { workspaceId: 'tenant/node', runId: 'run2' }, undefined, runner);
  await sandbox.blender!.abilities();
  const lost: boolean[] = [];
  for (let call = 0; call < 6; call++) lost.push((await sandbox.blender!.call('get_objects_summary', {})).restarted);
  // The same Blender; another one (the last one stopped after its answer); none running when the call came (the last
  // one is gone); the same; then the last answer named none (Blender stopped during that call, which says so itself),
  // so there is nothing to compare; the same.
  assert.deepEqual(lost, [false, true, true, false, false, false]);
  await sandbox.close();
});

test('a workspace that is not a workstation has no Blender, and its commands and snapshots are as before', async () => {
  const inputs: string[] = [];
  const runner: WorkspaceDockerRunner = async (args, options) => {
    if (options.input) inputs.push(options.input);
    return args.includes(COMMAND_HELPER) ? response({ exitCode: 0, stdout: '', stderr: '', truncated: false }) : response({ ok: true });
  };
  const sandbox = await createWorkspaceSandbox({ dockerExecutable: '/usr/bin/docker', image }, { workspaceId: 'a', runId: 'b' }, undefined, runner);
  assert.equal(sandbox.blender, undefined);
  // The Docker workspace says where its commands run and find the inputs; a sandbox that does not (the AgentCore
  // trial's, whose commands run elsewhere) has its agent told the workspace tools' path alone.
  assert.deepEqual(sandbox.paths, { workspace: '/workspace', inputs: '/inputs' });
  assert.equal(inputsInstruction(), 'The workspace tools name an input inputs/<name>, which is read-only.');
  assert.equal(inputsInstruction(sandbox.paths),
    'The workspace tools name an input inputs/<name>; commands and code (in /workspace) open it at /inputs/<name>, which is read-only.');
  await sandbox.exec('ls');
  assert.equal(JSON.parse(inputs.at(-1)!).keepAlive, undefined);
  await assert.rejects(dispatchWorkspaceTool(sandbox, 'blender_call', { tool: 'execute_blender_code', arguments: { code: '' } }), /Unknown workspace operation/);
  await sandbox.close();
});

test('a workstation agent is offered the Blender tools, and its calls reach Blender through the broker', { timeout: 20_000 }, async t => {
  const checksum = (content: string) => createHash('sha256').update(content).digest('hex');
  const page = '<!doctype html><html><body>model</body></html>';
  const steps = [
    { name: 'execute_blender_code', arguments: { code: "result = {'objects': 3}" } },
    // Arguments that do not fit come back to the model as an error to correct; they never reach Blender.
    { name: 'search_api_docs', arguments: { query: 'bmesh', limit: 3 } },
    { name: 'workspace_publish', arguments: { field: 'page', path: 'out/index.html' } },
  ];
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    if (req.url === '/api/internal/workspace-calls') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ [value.operation === 'admit' ? 'admitted' : 'settled']: true, index: value.index })); return;
    }
    requests.push(value);
    const step = steps[requests.length - 1];
    res.setHeader('content-type', 'text/event-stream');
    const send = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: `c${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: 'assistant', ...(step ? { tool_calls: [{ index: 0, id: `tool_${requests.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] } : { content: '{"page":""}' }) }, null);
    send({}, step ? 'tool_calls' : 'stop');
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const brokered: { name: string; args: Record<string, unknown> }[] = [], events: Record<string, unknown>[] = [];
  const abilities: BlenderAbilities = { ...blenderTools(listing), gpu: blenderGpu(listing.gpu), callSeconds: 280 };
  await executeWorkspaceAgent({ request: { prompt: 'Model a ring and show it', messages: [], workspace: { version: 1, id: 'a'.repeat(64), maxModelCalls: 8,
    callbackURL: `${base}/api/internal/workspace-calls`, callbackToken: 'test-callback-credential-never-in-model-state', inputs: [], outputFields: [{ id: 'page', type: 'html', required: true }] } },
  modelConfig: { model: 'fixture', apiKey: 'k', baseURL: `${base}/v1`, protocol: 'chat_completions', contextWindow: 65_536, maxTokens: 4096 }, signal: new AbortController().signal,
  abilities: { tools: [], web: false, blender: abilities, paths: { workspace: '/workspace', inputs: '/inputs' } }, emit: async event => { events.push(event); },
  broker: async (name, args) => {
    brokered.push({ name, args });
    if (name === 'blender_call') return { text: '{"status": "ok", "result": {"objects": 3}}', isError: false, restarted: false };
    if (name === 'workspace_publish') return { path: 'out/index.html', content: page, encoding: 'utf8', byteLength: Buffer.byteLength(page), sha256: checksum(page) };
    if (name === 'snapshot') { const zip = Buffer.from('fixture'); return { path: 'workspace.zip', content: zip.toString('base64'), encoding: 'base64', byteLength: zip.length, sha256: createHash('sha256').update(zip).digest('hex') }; }
    throw new Error(`unexpected ${name}`);
  } });
  const offered = (requests[0].tools as { function: { name: string; parameters: unknown } }[]).map(tool => tool.function);
  assert.deepEqual(offered.map(tool => tool.name).filter(name => !name.startsWith('workspace_')), ['execute_blender_code', 'get_objects_summary', 'render_viewport_to_path', 'search_api_docs']);
  assert.deepEqual((offered.find(tool => tool.name === 'execute_blender_code')!.parameters as { required: string[] }).required, ['code']);
  const system = String((requests[0].messages as { role: string; content: unknown }[]).find(item => item.role === 'system')?.content);
  assert.ok(system.includes('Blender workstation') && system.includes(listing.instructions));
  // Blender and commands run in /workspace: an input is at /inputs/<name> for them (a trial lost five calls to inputs/).
  assert.ok(system.includes('commands and code (in /workspace) open it at /inputs/<name>'));
  assert.deepEqual(brokered.map(item => item.name), ['blender_call', 'workspace_publish', 'snapshot']);
  assert.deepEqual(brokered[0].args, { tool: 'execute_blender_code', arguments: { code: "result = {'objects': 3}" } });
  const toolReplies = (requests[2].messages as { role: string; content: unknown }[]).filter(item => item.role === 'tool').map(item => String(item.content));
  assert.ok(toolReplies[0].includes('"objects": 3'));
  assert.ok(toolReplies[1].includes('do not fit search_api_docs'));
  assert.ok(events.some(event => event.type === 'workspace_activity' && event.tool === 'workspace_blender'));
  assert.equal(events.at(-1)?.type, 'completed');
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

test('a workstation snapshot leaves out out/, .blend files and large files instead of failing, and keeps the scene script', async t => {
  const root = await mkdtemp(join(tmpdir(), 'awwo-blender-helper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), inputs = join(root, 'inputs');
  await mkdir(join(workspace, 'out/frames'), { recursive: true }); await mkdir(inputs); await mkdir(join(workspace, 'lib'));
  await writeFile(join(workspace, 'scene.py'), 'import bpy\n');
  await writeFile(join(workspace, 'lib/notes.md'), '# notes\n');
  await writeFile(join(workspace, 'scene.blend'), randomBytes(1024));
  await writeFile(join(workspace, 'scene.blend1'), randomBytes(1024));
  await writeFile(join(workspace, 'lib/texture.png'), randomBytes(300 * 1024));
  await writeFile(join(workspace, 'out/model.glb'), randomBytes(1500 * 1024));
  for (let index = 0; index < 1100; index++) await writeFile(join(workspace, `out/frames/f${index}.png`), 'x');
  // Nine 250 KiB textures beside the script, each under the size limit, would outgrow the 2 MiB snapshot together: a
  // binary leaves it, whatever its size or name; a text file under the limit stays.
  await mkdir(join(workspace, 'textures'));
  for (let index = 0; index < 9; index++) await writeFile(join(workspace, `textures/t${index}.jpg`), Buffer.concat([Buffer.from([0xff, 0xd8, 0, 0]), randomBytes(250 * 1024)]));
  await writeFile(join(workspace, 'lib/data.json'), JSON.stringify({ points: Array.from({ length: 2000 }, (_, i) => i) }));
  // Blender run from a command (HOME is the workspace there) leaves PulseAudio's runtime link and the NVIDIA driver's
  // cache, hundreds of folders deep; a program may leave a link or a pipe anywhere.
  await mkdir(join(workspace, '.config/pulse'), { recursive: true });
  await symlink('/tmp/pulse-x', join(workspace, '.config/pulse/0a1b-runtime'));
  await symlink('scene.py', join(workspace, 'lib/scene-link.py'));
  for (let index = 0; index < 300; index++) await mkdir(join(workspace, `.nv/ComputeCache/${index}`), { recursive: true });
  await writeFile(join(workspace, '.nv/ComputeCache/index'), randomBytes(64));
  const pipe = await python('import json,os,sys; os.mkfifo(json.load(sys.stdin))', join(workspace, 'lib/pipe'));
  assert.equal(pipe.code, 0, pipe.stderr);
  const script = WORKSPACE_FILE_HELPER.replace("WORKSPACE = '/workspace'", `WORKSPACE = ${JSON.stringify(workspace)}`).replace("INPUTS = '/inputs'", `INPUTS = ${JSON.stringify(inputs)}`);
  const archive = await python(script, { action: 'archive', fileLimit: 2 * 1024 * 1024, archiveLimit: 2 * 1024 * 1024, snapshotLeaveOut: BLENDER_SNAPSHOT_LEAVE_OUT });
  assert.equal(archive.code, 0, archive.stderr);
  const listed = await python('import base64,io,json,sys,zipfile; print(json.dumps(zipfile.ZipFile(io.BytesIO(base64.b64decode(json.load(sys.stdin)))).namelist()))', JSON.parse(archive.stdout).content);
  assert.deepEqual(JSON.parse(listed.stdout).sort(), ['lib/data.json', 'lib/notes.md', 'scene.py']);
  // A workspace's own snapshot still fails on what it cannot keep.
  const plain = await python(script, { action: 'archive', fileLimit: 2 * 1024 * 1024, archiveLimit: 2 * 1024 * 1024 });
  assert.notEqual(plain.code, 0);
  assert.match(plain.stderr, /symlink or special file: \.config\/pulse\/0a1b-runtime/);
});

test('Blender keeps its per-user state in /tmp, away from the workspace', async () => {
  // supervisor.py starts Blender with this environment (check.py too); the workspace stays the commands' HOME.
  const script = fileURLToPath(new URL('../../deploy/saas/blender/supervisor.py', import.meta.url));
  const probe = `import importlib.util, json, os, sys, tempfile
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(script)})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.BLENDER_HOME = os.path.join(tempfile.mkdtemp(), 'blender-home')
os.environ.update({'HOME': '/workspace', 'SECRET_TOKEN': 'x', 'NVIDIA_VISIBLE_DEVICES': 'all'})
env = module.environment()
print(json.dumps({'env': env, 'made': oct(os.stat(module.BLENDER_HOME).st_mode & 0o777)}))`;
  const done = await python(probe, null);
  assert.equal(done.code, 0, done.stderr);
  const { env, made } = JSON.parse(done.stdout);
  assert.match(env.HOME, /blender-home$/);
  assert.equal(made, '0o700');
  assert.equal(env.AWWO_KEEP_ALIVE, BLENDER_KEEP_ALIVE);
  assert.equal(env.NVIDIA_VISIBLE_DEVICES, 'all');
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.match(await readFile(script, 'utf8'), /^BLENDER_HOME = '\/tmp\/blender-home'$/m);
});

test('a command spares only the process that carries the keep-alive mark', () => {
  // The helper's sweep reads each process's environment; only the exact mark, as a whole variable, spares one.
  assert.match(COMMAND_HELPER, /keep = payload\.get\('keepAlive'\)/);
  assert.match(COMMAND_HELPER, /\('AWWO_KEEP_ALIVE=' \+ keep\)\.encode\(\) in handle\.read\(\)\.split\(b'\\0'\)/);
  assert.match(COMMAND_HELPER, /st_uid == os\.getuid\(\) and not kept\(item\)/);
  // ...and only the Blender the supervisor runs (its pid file), running before the command started: a process Blender
  // or the command starts inherits or claims the mark in vain.
  assert.match(COMMAND_HELPER, /before = set\(item for item in os\.listdir\('\/proc'\) if item\.isdigit\(\)\)/);
  assert.match(COMMAND_HELPER, /open\('\/tmp\/awwo-blender\.pid', encoding='ascii'\)/);
  assert.match(COMMAND_HELPER, /if not keep or pid not in before or pid != bridge: return False/);
});

test('mcp_call.py cuts a long answer itself, well under what the worker reads of it', async () => {
  // A huge answer (a mesh's vertex list) must come back as a cut answer, not overflow the worker's 4 MiB read, which
  // would cost the run its workstation.
  const script = fileURLToPath(new URL('../../deploy/saas/blender/mcp_call.py', import.meta.url));
  const probe = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('mcp_call', ${JSON.stringify(script)})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
content = [{'type': 'text', 'text': 'é' * 3000000}, {'type': 'image', 'data': 'QUFB' * 1000, 'mimeType': 'image/png'}, {'type': 'text', 'text': 'tail'}]
out = module.bounded(content)
line = json.dumps({'ok': True, 'content': out, 'isError': False}, ensure_ascii=True, separators=(',', ':'))
print(json.dumps({'bytes': len(line), 'first': len(out[0]['text']), 'cut': 'cut: the answer was longer' in out[0]['text'], 'kinds': [p['type'] for p in out], 'image_kept': 'QUFB' in line}))`;
  const run = await python(probe, {});
  assert.equal(run.code, 0, run.stderr);
  const facts = JSON.parse(run.stdout);
  assert.ok(facts.cut && facts.first < 270_000, JSON.stringify(facts));
  assert.ok(facts.bytes < BLENDER_MCP_OUTPUT_BYTES, JSON.stringify(facts));
  assert.deepEqual(facts.kinds, ['text', 'image', 'text']);
  assert.equal(facts.image_kept, false);
});

test('mcp_call.py names the running Blender by its pid and start time, and an exited one as none', async t => {
  // The pid file outlives the Blender it names until the supervisor starts the next one, and an exited Blender stays a
  // zombie until it is reaped: neither may pass for the one that took the call.
  const root = await mkdtemp(join(tmpdir(), 'awwo-blender-proc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../../deploy/saas/blender/mcp_call.py', import.meta.url));
  const probe = `import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location('mcp_call', ${JSON.stringify(script)})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
root = ${JSON.stringify(root)}
module.PID_FILE, module.PROC = os.path.join(root, 'pid'), os.path.join(root, 'proc')
os.makedirs(os.path.join(module.PROC, '1234'))
def stat(state):
    with open(os.path.join(module.PROC, '1234', 'stat'), 'w') as handle:
        handle.write('1234 (blender (bg) x) %s 1 1234 1234 0 -1 4194560 10 0 0 0 5 3 0 0 20 0 30 0 5678 123456 789' % state)
out = [module.bridge()]
with open(module.PID_FILE, 'w') as handle: handle.write('1234')
out.append(module.bridge())
stat('S'); out.append(module.bridge())
stat('Z'); out.append(module.bridge())
with open(module.PID_FILE, 'w') as handle: handle.write('99')
out.append(module.bridge())
print(json.dumps(out))`;
  const run = await python(probe, {});
  assert.equal(run.code, 0, run.stderr);
  // No pid file; no such process; running; a zombie; a pid whose process is gone.
  assert.deepEqual(JSON.parse(run.stdout), [null, null, '1234:5678', null, null]);
});
