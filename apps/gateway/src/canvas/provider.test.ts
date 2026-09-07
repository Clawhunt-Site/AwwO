import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCanvasPlanner, parsePlannerOutput, resolveCodexCommand } from './provider.js';

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
afterEach(() => vi.useRealTimers());

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
