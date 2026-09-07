import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createCodexModelCatalog, loadCodexCatalogConfig } from './model-catalog.js';

const config = { cliPath: 'codex', timeoutMs: 1000 };
const model = (id = 'actual-model', levels = ['low', 'high']) => ({ model: id, supportedReasoningEfforts: levels.map(reasoningEffort => ({ reasoningEffort, description: 'not forwarded' })), defaultReasoningEffort: levels[0] ?? '' });
function harness(answer: (request: { id: number; method: string; params?: any }) => unknown = () => ({ data: [model()], nextCursor: null }), account: unknown = { account: { type: 'chatgpt', email: 'never-return-this@example.invalid' } }) {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const messages: { id?: number; method: string; params?: any }[] = [];
  child.stdin.on('data', raw => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    if (!message.id) return;
    const result = message.method === 'initialize' ? {} : message.method === 'account/read' ? account : answer(message);
    if (result !== undefined) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`));
  });
  const launch = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  const terminate = vi.fn(async () => { child.emit('close', null); });
  const resolveCommand = vi.fn(async () => ({ executable: 'native-codex', prefixArgs: [] }));
  return { child, messages, launch, terminate, resolveCommand };
}

describe('host Codex model catalog', () => {
  it('uses one configuration schema and the planner CLI path in every environment', () => {
    for (const APP_ENV of ['development', 'staging', 'production']) {
      expect(loadCodexCatalogConfig({ APP_ENV })).toEqual({ cliPath: 'codex', timeoutMs: 8000 });
    }
    expect(loadCodexCatalogConfig({ SUPERCLAW_CANVAS_PLANNER_CLI_PATH: '/installed/codex', SUPERCLAW_CODEX_CATALOG_TIMEOUT_MS: '15000' })).toEqual({ cliPath: '/installed/codex', timeoutMs: 15000 });
    for (const value of ['0', '999', '30001', '1.5', 'SECRET']) expect(() => loadCodexCatalogConfig({ SUPERCLAW_CODEX_CATALOG_TIMEOUT_MS: value })).toThrow('SUPERCLAW_CODEX_CATALOG_TIMEOUT_MS must be');
  });
  it('only requests a visible model catalog and shares concurrent reads until process cleanup', async () => {
    const deps = harness();
    const catalog = createCodexModelCatalog(config, deps);
    const first = catalog.read();
    expect(catalog.read()).toBe(first);
    expect(await first).toEqual({ source: 'codex_app_server', models: [{ id: 'actual-model', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }] });
    expect(deps.launch).toHaveBeenCalledOnce();
    expect(deps.launch).toHaveBeenCalledWith('native-codex', ['app-server'], expect.objectContaining({ shell: false, windowsHide: true }));
    expect(deps.messages.map(item => item.method)).toEqual(['initialize', 'initialized', 'account/read', 'model/list']);
    expect(deps.messages[2]?.params).toEqual({ refreshToken: false });
    expect(deps.messages[3]?.params).toEqual({ limit: 100, includeHidden: false });
    expect(deps.terminate).toHaveBeenCalledOnce();
  });
  it('does not cache across reads, so a new login cannot inherit an old catalog', async () => {
    let current = 'account-a-model';
    const launches = [harness(() => ({ data: [model(current)] })), harness(() => ({ data: [model(current)] }))];
    const deps = { resolveCommand: launches[0]!.resolveCommand, launch: vi.fn(() => launches.shift()!.child as unknown as ChildProcessWithoutNullStreams), terminate: vi.fn(async () => {}) };
    const catalog = createCodexModelCatalog(config, deps);
    expect((await catalog.read()).models[0]?.id).toBe('account-a-model');
    current = 'account-b-model';
    expect((await catalog.read()).models[0]?.id).toBe('account-b-model');
    expect(deps.launch).toHaveBeenCalledTimes(2);
  });
  it('follows bounded pagination and preserves per-model effort without merging fallback models', async () => {
    const deps = harness(request => request.params.cursor ? { data: [model('second', ['medium'])], nextCursor: null } : { data: [model('first', ['low'])], nextCursor: 'page-2' });
    const result = await createCodexModelCatalog(config, deps).read();
    expect(result.models).toEqual([
      { id: 'first', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' },
      { id: 'second', reasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' },
    ]);
    expect(deps.messages[4]?.params.cursor).toBe('page-2');
  });
  it.each([{ account: null }, { account: { type: 'unknown' } }, { account: { type: ['chatgpt'] } }, { account: 'SECRET' }])('rejects unauthenticated or malformed account state before requesting models', async account => {
    const deps = harness(() => ({ data: [model('bundled-model')] }), account);
    await expect(createCodexModelCatalog(config, deps).read()).rejects.toThrow('codex_catalog_unavailable');
    expect(deps.messages.map(item => item.method)).not.toContain('model/list');
    expect(deps.terminate).toHaveBeenCalledOnce();
  });
  it('accepts the native API-key account mode without exposing identity details', async () => {
    const deps = harness(undefined, { account: { type: 'apiKey' } });
    expect((await createCodexModelCatalog(config, deps).read()).models[0]?.id).toBe('actual-model');
  });
  it.each([
    { data: [] },
    { data: [model(), model()] },
    { data: [{ ...model(), defaultReasoningEffort: 'unsupported' }] },
    { data: [{ ...model(), supportedReasoningEfforts: ['invented'] }] },
    { data: [{ ...model(), model: 'SECRET\npath' }] },
    { data: [model()], nextCursor: { value: 'wrong-shape' } },
  ])('fails closed on malformed or empty catalog data', async response => {
    const deps = harness(() => response);
    deps.child.stderr.write('SECRET authentication diagnostics');
    await expect(createCodexModelCatalog(config, deps).read()).rejects.toMatchObject({ message: 'codex_catalog_unavailable' });
    expect(deps.terminate).toHaveBeenCalledOnce();
  });
  it('rejects repeated cursors instead of serving a partial catalog', async () => {
    let page = 0;
    const deps = harness(() => ({ data: [model(`model-${++page}`)], nextCursor: 'same-cursor' }));
    await expect(createCodexModelCatalog(config, deps).read()).rejects.toThrow('codex_catalog_unavailable');
    expect(deps.messages.filter(item => item.method === 'model/list')).toHaveLength(2);
  });
  it('bounds total pages and never returns a truncated success', async () => {
    let page = 0;
    const deps = harness(() => ({ data: [model(`model-${++page}`)], nextCursor: `cursor-${page}` }));
    await expect(createCodexModelCatalog(config, deps).read()).rejects.toThrow('codex_catalog_unavailable');
    expect(deps.messages.filter(item => item.method === 'model/list')).toHaveLength(5);
  });
  it('bounds stalled RPC and terminates its process tree', async () => {
    const deps = harness(() => undefined);
    await expect(createCodexModelCatalog({ ...config, timeoutMs: 30 }, deps).read()).rejects.toThrow('codex_catalog_unavailable');
    expect(deps.terminate).toHaveBeenCalledOnce();
  });
  it.each(['oversized', 'invalid-json', 'rpc-error', 'exit'])('rejects %s output and cleans up without disclosing diagnostics', async mode => {
    const deps = harness(() => undefined);
    const promise = createCodexModelCatalog(config, deps).read();
    const rejected = expect(promise).rejects.toMatchObject({ message: 'codex_catalog_unavailable' });
    await vi.waitFor(() => expect(deps.messages.some(item => item.method === 'model/list')).toBe(true));
    if (mode === 'oversized') deps.child.stdout.write('x'.repeat(1024 * 1024 + 1));
    if (mode === 'invalid-json') deps.child.stdout.write('SECRET raw auth failure\n');
    if (mode === 'rpc-error') deps.child.stdout.write(`${JSON.stringify({ id: 3, error: { code: -1, message: 'SECRET key' } })}\n`);
    if (mode === 'exit') deps.child.emit('close', 1);
    await rejected;
    expect(deps.terminate).toHaveBeenCalledOnce();
  });
  it('rejects missing and failed executables safely', async () => {
    const deps = harness();
    await expect(createCodexModelCatalog(config, { ...deps, resolveCommand: async () => null }).read()).rejects.toThrow('codex_catalog_unavailable');
    expect(deps.launch).not.toHaveBeenCalled();
    await expect(createCodexModelCatalog(config, { ...deps, launch: () => { throw new Error('SECRET path'); } }).read()).rejects.toThrow('codex_catalog_unavailable');
  });
});
