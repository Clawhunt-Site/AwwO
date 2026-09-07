import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { loadCanvasPlannerConfig } from './config.js';
import { resolveCodexCommand, terminateProcess, type PlannerCommand } from './provider.js';

export interface CodexCatalogConfig { cliPath: string; timeoutMs: number }
export interface CodexModel { id: string; reasoningEfforts: string[]; defaultReasoningEffort: string }
export interface CodexCatalog { models: CodexModel[]; source: 'codex_app_server' }
export interface CodexModelCatalog { read(): Promise<CodexCatalog> }
export class CatalogError extends Error { constructor() { super('codex_catalog_unavailable'); } }
interface CatalogDeps {
  resolveCommand?: (cliPath: string) => Promise<PlannerCommand | null>;
  launch?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  terminate?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
}

export function loadCodexCatalogConfig(env: NodeJS.ProcessEnv = process.env): CodexCatalogConfig {
  // Share the configured host CLI and inherited CODEX_HOME with the planner.
  const { cliPath } = loadCanvasPlannerConfig(env);
  const timeoutMs = Number(env.SUPERCLAW_CODEX_CATALOG_TIMEOUT_MS?.trim() || 8000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new Error('SUPERCLAW_CODEX_CATALOG_TIMEOUT_MS must be between 1000 and 30000');
  return { cliPath, timeoutMs };
}

const MAX_BYTES = 1024 * 1024;
const MAX_PAGES = 5;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(value);
}
function modelsFromPage(value: unknown): { models: CodexModel[]; cursor: string | null } {
  if (!record(value) || !Array.isArray(value.data) || value.data.length > 100) throw new CatalogError();
  if (value.nextCursor != null && (!identifier(value.nextCursor) || value.nextCursor.length > 200)) throw new CatalogError();
  const models: CodexModel[] = [];
  for (const item of value.data) {
    if (!record(item) || !identifier(item.model) || !Array.isArray(item.supportedReasoningEfforts) || item.supportedReasoningEfforts.length > 20) throw new CatalogError();
    if (item.hidden === true) continue;
    const levels = item.supportedReasoningEfforts.map(effort => {
      if (!record(effort) || typeof effort.reasoningEffort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort.reasoningEffort)) throw new CatalogError();
      return effort.reasoningEffort;
    });
    const defaultEffort = item.defaultReasoningEffort;
    if (typeof defaultEffort !== 'string' || (levels.length ? !levels.includes(defaultEffort) : defaultEffort !== '')) throw new CatalogError();
    models.push({ id: item.model, reasoningEfforts: [...new Set(levels)], defaultReasoningEffort: defaultEffort });
  }
  return { models, cursor: typeof value.nextCursor === 'string' ? value.nextCursor : null };
}

/** Only initialization, account/read and model/list are sent. No inference or raw diagnostics. */
export function createCodexModelCatalog(config: CodexCatalogConfig, deps: CatalogDeps = {}): CodexModelCatalog {
  const resolveCommand = deps.resolveCommand || resolveCodexCommand;
  const launch = deps.launch || ((command, args, options) => spawn(command, args, { ...options, stdio: 'pipe' }));
  const terminate = deps.terminate || terminateProcess;
  let inFlight: Promise<CodexCatalog> | undefined;
  async function read(): Promise<CodexCatalog> {
    const command = await resolveCommand(config.cliPath).catch(() => null);
    if (!command) throw new CatalogError();
    let child: ChildProcessWithoutNullStreams;
    try { child = launch(command.executable, [...command.prefixArgs, 'app-server'], { shell: false, windowsHide: true, detached: process.platform !== 'win32' }); }
    catch { throw new CatalogError(); }
    let id = 0;
    let bytes = 0;
    let buffer = '';
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: CatalogError) => void }>();
    const fail = () => {
      stopped = true;
      for (const item of pending.values()) item.reject(new CatalogError());
      pending.clear();
    };
    const request = (method: 'initialize' | 'account/read' | 'model/list', params: unknown) => new Promise<unknown>((resolve, reject) => {
      if (stopped) { reject(new CatalogError()); return; }
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
    child.on('error', fail);
    child.on('close', fail);
    child.stdin.on('error', fail);
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BYTES) { fail(); return; }
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let response: unknown;
        try { response = JSON.parse(line); } catch { fail(); return; }
        if (!record(response)) { fail(); return; }
        if (typeof response.id !== 'number') continue;
        const item = pending.get(response.id);
        if (!item) continue;
        pending.delete(response.id);
        if (response.error || !Object.hasOwn(response, 'result')) { item.reject(new CatalogError()); fail(); return; }
        item.resolve(response.result);
      }
    });
    timer = setTimeout(fail, config.timeoutMs);
    try {
      await request('initialize', { clientInfo: { name: 'awwo_model_catalog', version: '0.3.0' } });
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      // A logged-out CLI may still list bundled models. Never call that an authenticated catalog.
      const account = await request('account/read', { refreshToken: false });
      if (!record(account) || !record(account.account) || (account.account.type !== 'chatgpt' && account.account.type !== 'apiKey')) throw new CatalogError();
      const models = new Map<string, CodexModel>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const parsed = modelsFromPage(await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }));
        for (const model of parsed.models) {
          if (models.has(model.id)) throw new CatalogError();
          models.set(model.id, model);
        }
        if (!parsed.cursor) {
          if (!models.size || stopped) throw new CatalogError();
          return { models: [...models.values()], source: 'codex_app_server' };
        }
        if (cursors.has(parsed.cursor)) throw new CatalogError();
        cursors.add(parsed.cursor);
        cursor = parsed.cursor;
      }
      throw new CatalogError();
    } catch { throw new CatalogError(); }
    finally {
      clearTimeout(timer);
      fail();
      child.stdin.end();
      await terminate(child).catch(() => undefined);
    }
  }
  return {
    read() {
      // Concurrent UI inventory/model reads share one process; no stale cross-login cache.
      if (!inFlight) inFlight = read().finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}
