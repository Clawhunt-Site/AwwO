import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCanvasPlanner, createCodexProgress, parsePlannerOutput, resolveCodexCommand, type PlannerProgress } from './provider.js';

const plan = { version: 1, summary: 'Create a frontend node', operations: [{ type: 'add_node', ref: 'web', templateId: 'frontend' }] };
const output = (text: string) => `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n${JSON.stringify({ type: 'turn.completed' })}\n`;
const config = { provider: 'codex' as const, cliPath: 'codex', timeoutMs: 1000 };
const usageLimitMessage = "You've hit your usage limit. Visit https://example.invalid/private-usage to purchase more credits or try again later. SECRET diagnostics";
const usageLimitEvents = [
  { type: 'error', message: usageLimitMessage },
  { type: 'turn.failed', error: { message: usageLimitMessage } },
];
function harness() {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const launch = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  const terminate = vi.fn(async () => { child.emit('close', null); });
  const resolveCommand = vi.fn(async () => ({ executable: process.execPath, prefixArgs: ['codex.js'] }));
  return { child, launch, terminate, resolveCommand };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
// Private scratchpad text a model reasons with; it must never leave the planner.
const REASONING = 'weigh 权衡 the private ledger 44102 first';
const line = (event: unknown) => `${JSON.stringify(event)}\n`;

describe('planning output', () => {
  it('parses only a completed Codex assistant message as an object', () => {
    expect(parsePlannerOutput(output(JSON.stringify(plan)))).toEqual(plan);
    expect(parsePlannerOutput(output(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``))).toEqual(plan);
  });
  it('rejects malformed, incomplete, oversized or wrong-version output', () => {
    for (const raw of ['', output('not JSON'), output('[]'), output('{"version":2,"operations":[]}'), output('{"version":1,"operations":{}}'), output('x'.repeat(120001)), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(plan) } })]) {
      expect(() => parsePlannerOutput(raw)).toThrow();
    }
  });
  it.each(usageLimitEvents)('recognizes the known Codex usage-limit event: $type', event => {
    expect(() => parsePlannerOutput(JSON.stringify(event))).toThrow(expect.objectContaining({ code: 'usage_limit_exceeded', message: 'usage_limit_exceeded' }));
  });
  it('does not classify arbitrary errors or assistant content as a usage limit', () => {
    for (const event of [
      { type: 'error', message: 'HTTP 429, retry request later' },
      { type: 'error', message: `Quoted text: ${usageLimitMessage}` },
      { type: 'turn.failed', error: { message: 'Authentication required' } },
      { type: 'turn.failed', error: { message: { text: usageLimitMessage } } },
    ]) {
      expect(() => parsePlannerOutput(JSON.stringify(event))).toThrow(expect.objectContaining({ code: 'execution_failed' }));
    }
    expect(() => parsePlannerOutput(usageLimitMessage)).toThrow(expect.objectContaining({ code: 'invalid_output' }));
    const quotedPlan = { ...plan, summary: usageLimitMessage };
    expect(parsePlannerOutput(output(JSON.stringify(quotedPlan)))).toEqual(quotedPlan);
  });
});

describe('planning progress', () => {
  it('projects Codex events onto counts and never keeps their text', () => {
    const seen: PlannerProgress[] = [];
    const observe = createCodexProgress(progress => seen.push(progress));
    observe(JSON.stringify({ type: 'thread.started', thread_id: 't' }));
    observe(JSON.stringify({ type: 'turn.started' }));
    observe('{not json');
    observe(JSON.stringify({ type: 'item.started', item: { id: 'r1', type: 'reasoning', text: '' } }));
    observe(JSON.stringify({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: REASONING } }));
    // An unchanged observation is not reported twice.
    observe(JSON.stringify({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: REASONING } }));
    observe(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: JSON.stringify(plan) } }));
    expect(seen).toEqual([
      { stage: 'running', characters: 0, nodes: 0, edges: 0, reasoning: 0 },
      { stage: 'thinking', characters: 0, nodes: 0, edges: 0, reasoning: 0 },
      { stage: 'thinking', characters: 0, nodes: 0, edges: 0, reasoning: [...REASONING].length },
      { stage: 'streaming', characters: JSON.stringify(plan).length, nodes: 1, edges: 0, reasoning: [...REASONING].length, template: 'frontend' },
    ]);
    expect(JSON.stringify(seen)).not.toContain('44102');
    // Without a reporter it is a no-op rather than an error.
    expect(() => createCodexProgress()(JSON.stringify({ type: 'turn.started' }))).not.toThrow();
  });
  it('reports Codex progress from lines split across chunks and survives a reporter that throws', async () => {
    const deps = harness();
    const seen: PlannerProgress[] = [];
    let calls = 0;
    const result = createCanvasPlanner(config, deps).plan({ prompt: 'x', context: 'y' }, undefined, progress => {
      seen.push(progress);
      if (++calls === 1) throw new Error('reporter failure');
    });
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledOnce());
    const text = line({ type: 'turn.started' }) + line({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: REASONING } }) + output(JSON.stringify(plan));
    for (let at = 0; at < text.length; at += 7) deps.child.stdout.write(text.slice(at, at + 7));
    await vi.waitFor(() => expect(seen.at(-1)?.stage).toBe('streaming'));
    deps.child.emit('close', 0);
    await expect(result).resolves.toEqual(plan);
    expect(seen.map(item => item.stage)).toEqual(['running', 'thinking', 'streaming']);
    expect(seen.at(-1)).toMatchObject({ nodes: 1, edges: 0, template: 'frontend', reasoning: [...REASONING].length });
  });
});

describe('OpenAI-compatible planning', () => {
  const openai = { provider: 'openai' as const, cliPath: 'codex', timeoutMs: 1000, baseUrl: 'https://planner.invalid/v1', apiKey: 'test-key', model: 'fixture-model' };
  // A string starting with ':' is an SSE comment line, as providers send for keep-alive.
  const sse = (...chunks: unknown[]) => new Response(chunks.map(chunk => typeof chunk === 'string' && chunk.startsWith(':')
    ? `${chunk}\n\n` : `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const delta = (value: Record<string, unknown>) => ({ choices: [{ index: 0, delta: value }] });
  it('streams the plan, counts reasoning without keeping it, and validates the whole answer', async () => {
    const text = JSON.stringify({ ...plan, operations: [...plan.operations, { type: 'add_node', ref: 'api', templateId: 'backend' },
      { type: 'connect', fromNode: 'web', fromField: 'api', toNode: 'api', toField: 'brief' }] });
    // Cut inside the first templateId pair, then again after it, so each node's template is
    // seen in its own chunk and the split pair still has to be joined across chunks.
    const pair = text.indexOf('"templateId":"frontend"');
    const cuts = [0, pair + 5, pair + 30, text.length];
    const fetch = vi.fn(async () => sse(delta({ role: 'assistant', reasoning_content: REASONING.slice(0, 9) }), delta({ reasoning_content: REASONING.slice(9) }),
      delta({ content: text.slice(cuts[0], cuts[1]) }), ': keep-alive comment', delta({ content: text.slice(cuts[1], cuts[2]) }),
      delta({ content: text.slice(cuts[2], cuts[3]) }), '[DONE]'));
    vi.stubGlobal('fetch', fetch);
    const seen: PlannerProgress[] = [];
    await expect(createCanvasPlanner(openai).plan({ prompt: 'x', context: 'y' }, undefined, progress => seen.push(progress))).resolves.toEqual(JSON.parse(text));
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.stream).toBe(true);
    expect(seen.map(item => item.stage).filter((stage, index, all) => stage !== all[index - 1])).toEqual(['thinking', 'streaming']);
    expect(seen.at(-1)).toEqual({ stage: 'streaming', characters: text.length, nodes: 2, edges: 1, reasoning: [...REASONING].length, template: 'backend' });
    // A template is only ever an identifier named by the plan, never other model text, and a
    // new node never borrows its predecessor's template while its own is still unwritten.
    expect(new Set(seen.map(item => item.template).filter(Boolean))).toEqual(new Set(['frontend', 'backend']));
    for (const item of seen) if (item.nodes === 2 && item.template === 'frontend') throw new Error('node 2 showed node 1\'s template');
    expect(JSON.stringify(seen)).not.toContain('44102');
  });
  it('still accepts a server that ignores streaming and answers with one JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { headers: { 'content-type': 'application/json' } })));
    await expect(createCanvasPlanner(openai).plan({ prompt: 'x', context: 'y' })).resolves.toEqual(plan);
  });
  it('names a node only by its own closed-set template, however the stream is cut', async () => {
    // node 1 is followed by an operation that writes templateId before its "type"; the second
    // node also carries a template outside the set and a nested templateId key.
    const text = JSON.stringify({ version: 1, summary: 's', operations: [] }).replace('[]',
      '[{"type":"add_node","ref":"a","templateId":"data"},{"templateId":"users","type":"add_node","ref":"b"},'
      + '{"type":"add_node","ref":"c","inputValues":{"templateId":"review"},"templateId":"private_role"}]');
    for (let cut = 1; cut < text.length; cut += 3) {
      vi.stubGlobal('fetch', vi.fn(async () => sse(delta({ content: text.slice(0, cut) }), delta({ content: text.slice(cut) }), '[DONE]')));
      const seen: PlannerProgress[] = [];
      await createCanvasPlanner(openai).plan({ prompt: 'x', context: 'y' }, undefined, progress => seen.push(progress)).catch(() => undefined);
      for (const item of seen) {
        if (item.template !== undefined) expect([item.nodes, item.template]).toEqual([1, 'data']);
      }
    }
  });
  it('rejects a malformed or empty stream instead of inventing a plan', async () => {
    for (const response of [() => sse('{broken'), () => sse(delta({ reasoning_content: REASONING }), '[DONE]'), () => sse(delta({ content: 'not a plan' }))]) {
      vi.stubGlobal('fetch', vi.fn(async () => response()));
      await expect(createCanvasPlanner(openai).plan({ prompt: 'x', context: 'y' })).rejects.toMatchObject({ code: 'invalid_output' });
    }
  });
  it('keeps provider failures classified and their bodies unread into errors', async () => {
    for (const [status, code] of [[429, 'usage_limit_exceeded'], [401, 'execution_failed'], [500, 'execution_failed'], [400, 'invalid_output']] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('SECRET provider diagnostics', { status })));
      await expect(createCanvasPlanner(openai).plan({ prompt: 'x', context: 'y' })).rejects.toMatchObject({ code });
    }
  });
});

describe('isolated Codex planning process', () => {
  it('resolves known npm wrappers without evaluating their shell script', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'awwo-codex-wrapper-'));
    try {
      const entry = join(folder, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      await mkdir(join(folder, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
      await writeFile(entry, '');
      const wrapper = join(folder, 'codex.cmd');
      await writeFile(wrapper, '@node "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
      expect(await resolveCodexCommand(wrapper)).toEqual({ executable: process.execPath, prefixArgs: [entry] });
      await writeFile(wrapper, '@echo arbitrary script must not be evaluated');
      expect(await resolveCodexCommand(wrapper)).toBeNull();
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('sends context through stdin, never invokes a shell or Agent dispatcher, and removes its temporary cwd', async () => {
    const deps = harness();
    const provider = createCanvasPlanner(config, deps);
    const result = provider.plan({ prompt: '需求 $(do-not-execute)', context: 'actual graph' });
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledOnce());
    const [, args, options] = deps.launch.mock.calls[0] as unknown as [string, string[], { cwd: string; shell: boolean; windowsHide: boolean }];
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('read-only');
    expect(args).toContain('shell_tool');
    expect(args).toContain('plugins');
    expect(args).not.toContain('--ignore-rules');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    expect(options.cwd).not.toBe(process.cwd());
    expect(deps.child.stdin.read().toString()).toContain('需求 $(do-not-execute)');
    deps.child.stdout.write(output(JSON.stringify(plan)));
    deps.child.emit('close', 0);
    await expect(result).resolves.toEqual(plan);
    await expect(access(options.cwd)).rejects.toThrow();
  });
  it('disabled and missing binaries never launch a process', async () => {
    const deps = harness();
    const disabled = createCanvasPlanner({ ...config, provider: 'disabled' }, deps);
    expect((await disabled.status()).available).toBe(false);
    await expect(disabled.plan({ prompt: 'x', context: 'y' })).rejects.toThrow();
    const missing = createCanvasPlanner(config, { ...deps, resolveCommand: async () => null });
    expect((await missing.status()).available).toBe(false);
    await expect(missing.plan({ prompt: 'x', context: 'y' })).rejects.toThrow();
    expect(deps.launch).not.toHaveBeenCalled();
  });
  it.each(usageLimitEvents)('keeps the usage-limit classification when $type exits nonzero', async event => {
    const deps = harness();
    const result = createCanvasPlanner(config, deps).plan({ prompt: 'x', context: 'y' });
    const rejected = expect(result).rejects.toMatchObject({ code: 'usage_limit_exceeded', message: 'usage_limit_exceeded' });
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledOnce());
    deps.child.stderr.write('SECRET authentication diagnostics');
    deps.child.stdout.write(`${JSON.stringify(event)}\n`);
    deps.child.emit('close', 1);
    await rejected;
  });
  it.each([
    output(JSON.stringify(plan)),
    usageLimitMessage,
    JSON.stringify({ type: 'error', message: 'HTTP 429, retry request later' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: usageLimitMessage } }),
  ])('never accepts a plan or infers quota from other output after a failed exit', async raw => {
    const deps = harness();
    const result = createCanvasPlanner(config, deps).plan({ prompt: 'x', context: 'y' });
    const rejected = expect(result).rejects.toMatchObject({ code: 'execution_failed', message: 'execution_failed' });
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledOnce());
    deps.child.stderr.write(JSON.stringify(usageLimitEvents[0]));
    deps.child.stdout.write(raw);
    deps.child.emit('close', 1);
    await rejected;
  });
  it('aborting kills the child and keeps cancellation distinct', async () => {
    const deps = harness(); const controller = new AbortController();
    const result = createCanvasPlanner(config, deps).plan({ prompt: 'x', context: 'y' }, controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledOnce());
    controller.abort();
    await rejection;
    expect(deps.terminate).toHaveBeenCalledOnce();
  });
  it('timeout kills the child and suppresses stderr details', async () => {
    const deps = harness();
    const result = createCanvasPlanner({ ...config, timeoutMs: 30 }, deps).plan({ prompt: 'x', context: 'y' });
    const rejection = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledOnce(), { interval: 1 });
    deps.child.stderr.write('SECRET credentials');
    await rejection;
    expect(deps.terminate).toHaveBeenCalledOnce();
  });
  it('a request cancelled before launch cannot start the CLI', async () => {
    const deps = harness(); const controller = new AbortController(); controller.abort();
    await expect(createCanvasPlanner(config, deps).plan({ prompt: 'x', context: 'y' }, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(deps.launch).not.toHaveBeenCalled();
  });
  it('terminates excessive output and reports a safe failure', async () => {
    const deps = harness();
    const result = createCanvasPlanner(config, deps).plan({ prompt: 'x', context: 'y' });
    const rejected = expect(result).rejects.toMatchObject({ code: 'invalid_output' });
    await vi.waitFor(() => expect(deps.launch).toHaveBeenCalledOnce());
    deps.child.stdout.write('x'.repeat(1024 * 1024 + 1));
    await rejected;
    expect(deps.terminate).toHaveBeenCalledOnce();
  });
});
