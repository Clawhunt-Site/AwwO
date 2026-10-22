import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkspaceSandbox, sandboxAbilities, type WorkspaceSandbox } from '../openai-agents-worker/workspace-sandbox.ts';
import { type WorkerConfig, WORKER_DIR, coreInstalled } from './config.ts';
import { TOOLS, closeServer, createTransport, listenLocal, modelToolName, type CapturedCall } from './transport.ts';
import { WorkerError, boundedText, hash, record, responseJSON, safeMessage, type ApprovalAnswer, type RunRequest, type WorkerEvent } from './protocol.ts';
import { diagnostic, safeFailureDetails, type RuntimeStage } from './diagnostics.ts';

// How long the core waits for any byte of one model call. Every hop to the model answers in one piece (the API proxy, the
// workers and the Converse bridge gather the stream), so this is the time the whole answer may take: at 120 s a task whose
// model wrote a long file stopped part-way (2026-10-16, CORE_EXECUTION_FAILED at stage poll). 10 minutes matches the API
// proxy's computerModelCallTimeout and the workers' own per-call limit.
export const CORE_MODEL_IDLE_TIMEOUT_MS = '600000';
/** How the pinned core said it stopped a failed turn: it records an `error: <message>` activity (server/index.ts), with its
 *  chat driver's messages at UPSTREAM_REVISION (server/drivers/openai-chat.ts). Only these closed labels reach a log,
 *  never the text: a turn stopped at the core's 16 rounds is the task's call budget (transport.ts CORE_MODEL_ROUNDS),
 *  which the API reads as such (computer_call_budget) instead of a platform failure. */
const CORE_STOPS: ReadonlyArray<readonly [string, string]> = [
  ['error: model-call limit reached before a final response', 'CORE_ROUND_LIMIT'],
  ['error: One or more tool operations failed or were denied', 'CORE_TOOL_FAILED'],
  ['error: provider did not finish the response', 'CORE_UNFINISHED_RESPONSE'],
  ['error: provider returned an empty response', 'CORE_EMPTY_RESPONSE'],
];
export function coreStopReason(messages: unknown[]): string {
  const stop = messages.findLast((message: unknown) => record(message) && message.kind === 'activity' && record(message.tool)
    && typeof message.tool.name === 'string' && message.tool.name.startsWith('error: '));
  if (!record(stop) || !record(stop.tool) || typeof stop.tool.name !== 'string') return 'UNCLASSIFIED';
  const name = stop.tool.name;
  return CORE_STOPS.find(([prefix]) => name.startsWith(prefix))?.[1] ?? 'CORE_ERROR';
}
/** The code of a turn the core failed: the task's call budget when it used its calls up, by the transport's count or
 *  at the core's own rounds; else the core's failure. */
export function failedTurnCode(modelCalls: number, request: Pick<RunRequest, 'maxModelCalls'>, stop: string): string {
  return modelCalls > request.maxModelCalls || stop === 'CORE_ROUND_LIMIT' ? 'MODEL_BUDGET_EXCEEDED' : 'CORE_EXECUTION_FAILED';
}
/** What the agent is told about its workspace: the files it was given, the tools its image has and whether it reaches
 *  the web, as the deployment configured them (config.ts); without any, what it was always told. */
export function workspaceSoul(config: Pick<WorkerConfig, 'tools'> & { sandbox: Pick<WorkerConfig['sandbox'], 'egress'> }, request: Pick<RunRequest, 'inputs'>): string {
  const parts = ['\nUse only AwwO workspace tools. Files and commands exist inside an isolated Docker workspace.'];
  if (request.inputs.length) parts.push(`The files the user attached are read-only in /inputs: ${request.inputs.map(input => input.name).join(', ')}.`);
  parts.push(...sandboxAbilities(config.tools, !!config.sandbox.egress));
  parts.push('No desktop, live browser, host shell, peers, skills or external integrations are available. Publish files you actually created; never claim unrun tests passed.');
  parts.push('A tool result with failed: true did nothing: correct the call, or say in your answer what failed. Only published: true delivered a file.');
  return parts.join(' ');
}

/** AwwO 本地版's module guard (scripts/awwo-local-module-guard.cjs), when the local runtime that started this worker
 *  names it (AWWO_LOCAL_MODULE_GUARD, the folders it guards in AWWO_LOCAL_MODULE_ROOTS): the core's Node.js and the MCP
 *  shim it starts load it first, as this worker's did, so that they load no module from a node_modules folder above
 *  AwwO's own (where Node.js looks for a package's absent optional dependency, and another account may have put one).
 *  The hosted site sets neither: both start as before. */
export function moduleGuardOptions(env: NodeJS.ProcessEnv = process.env): { execArgv: string[]; env: Record<string, string> } {
  if (!env.AWWO_LOCAL_MODULE_GUARD || !env.AWWO_LOCAL_MODULE_ROOTS) return { execArgv: [], env: {} };
  return { execArgv: ['--require', env.AWWO_LOCAL_MODULE_GUARD], env: { AWWO_LOCAL_MODULE_ROOTS: env.AWWO_LOCAL_MODULE_ROOTS } };
}

export function coreEnvironment(home: string, port: string, webhookPort: string): NodeJS.ProcessEnv {
  return { PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: home, TMPDIR: join(home, 'tmp'),
    OMB_DATA_DIR: home, OMB_PORT: port, OMB_WEBHOOK_PORT: webhookPort, OMB_LOOPBACK_TRUST: 'service', OMB_CLI_OWNER_STDIN: '1',
    NODE_ENV: 'production', NO_COLOR: '1', OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS: CORE_MODEL_IDLE_TIMEOUT_MS };
}
async function freePort(): Promise<string> { const server = createServer(); const url = await listenLocal(server); await closeServer(server); return new URL(url).port; }
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const kill = (signal: NodeJS.Signals) => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } };
  kill('SIGTERM'); await Promise.race([exit, delay(1500)]);
  if (child.exitCode === null && child.signalCode === null) { kill('SIGKILL'); await Promise.race([exit, delay(3000).then(() => { throw new WorkerError('CORE_CLEANUP_FAILED', 500); })]); }
}
/** The names the core can open a card for or ask a question with: the workspace tools it mounts, and its own ask_user. */
const ADVERTISED = new Set<string>([...TOOLS.map(tool => modelToolName(tool.name)), 'ask_user']);
/** A captured call paired with its card: one whose arguments could be taken. */
export type PairedCall = CapturedCall & { arguments: Record<string, unknown> };
/** The captured call a tool's approval card is for. The pinned core takes an answer's tool calls one at a time, in order
 *  (server/drivers/openai-chat.ts at UPSTREAM_REVISION), and every call it takes leaves an activity naming the model's
 *  call id (tool.itemId): at once for a call it refuses before any card (arguments that are not a JSON object or do not
 *  fit its tool's schema) and for a question, and only once its card is answered for a call with a card. So while a card
 *  is open, the call it is for is the first captured call with no activity and no card. A call to a tool the core does
 *  not advertise is refused before any card, and may leave no activity (none is written for a name ending in __ask_bot,
 *  server/index.ts), so it is passed over. A card is paired with that call only when it names the same tool, no other
 *  captured call has its id, and its arguments could be taken; anything else stops the task, since a card must never
 *  show another call's arguments, nor let them be allowed (2026-10-18: paired first-in-first-out by tool name, a card
 *  could carry those of a call the core had refused). */
export function cardCall(calls: readonly CapturedCall[], messages: readonly unknown[], tool: unknown): PairedCall {
  const taken = new Set<string>();
  for (const message of messages) {
    if (record(message) && message.kind === 'activity' && record(message.tool) && typeof message.tool.itemId === 'string') taken.add(message.tool.itemId);
  }
  const call = calls.find(call => call.card === undefined && !taken.has(call.id) && ADVERTISED.has(call.tool));
  if (!call || call.tool !== tool || calls.some(other => other !== call && other.id === call.id)) throw new WorkerError('APPROVAL_CALL_UNMATCHED');
  if (!call.arguments) throw new WorkerError('APPROVAL_ARGUMENTS_UNAVAILABLE');
  return call as PairedCall;
}
/** A JSON value with its objects' keys in one order, so two values compare equal exactly when they are the same value. */
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
/** The allowed call the core may run now: the same tool with the same arguments (the core passes on the JSON it parsed,
 *  unchanged), if any. */
export function allowedCall(allowed: Iterable<CapturedCall>, name: string, args: unknown): CapturedCall | undefined {
  const tool = modelToolName(name), value = JSON.stringify(canonical(args));
  for (const call of allowed) if (call.tool === tool && JSON.stringify(canonical(call.arguments)) === value) return call;
  return undefined;
}
type Approval = { kind: 'approval' | 'question'; call?: PairedCall; answer?: string; pending?: Promise<void> };
export function approvalDisplay(kind: Approval['kind'], card: Record<string, unknown>, capturedTool: string | undefined, secrets: string[]) {
  const title = boundedText(safeMessage(String(kind === 'approval' && capturedTool ? capturedTool : card.title || card.tool || 'Workspace approval'), secrets), 200);
  // The complete, original arguments travel separately. Upstream tool subtitles
  // are the same JSON (sometimes truncated), so rendering both obscures review.
  const description = boundedText(safeMessage(kind === 'approval'
    ? '批准后将在隔离工作区执行此工具。请核对下方完整参数。'
    : String(card.subtitle || ''), secrets), 8192);
  return { title: title.text, description: description.text, truncated: title.truncated || description.truncated };
}
export class ManagedRun {
  readonly controller = new AbortController();
  readonly approvals = new Map<string, Approval>();
  /** The calls whose cards were allowed and that have not run: each allow runs one call (authorize). */
  private readonly allowed = new Set<CapturedCall>();
  private coreURL = ''; private coreToken = ''; private botId = ''; private threadId = '';
  private finished = false;
  readonly request: RunRequest; readonly config: WorkerConfig; readonly emit: (event: WorkerEvent) => void;
  private readonly createSandbox: typeof createWorkspaceSandbox;
  /** `createSandbox` is the Docker workspace; tests give a stand-in. */
  constructor(request: RunRequest, config: WorkerConfig, emit: (event: WorkerEvent) => void, createSandbox = createWorkspaceSandbox) {
    this.request = request; this.config = config; this.emit = emit; this.createSandbox = createSandbox;
  }
  cancel() { this.controller.abort(new WorkerError('CANCELLED')); }
  async respond(answer: ApprovalAnswer): Promise<void> {
    const approval = this.approvals.get(answer.requestId);
    if (!approval) throw new WorkerError('APPROVAL_NOT_FOUND', 404);
    const fingerprint = JSON.stringify(answer);
    if (approval.answer) { if (approval.answer !== fingerprint) throw new WorkerError('APPROVAL_ALREADY_ANSWERED', 409); return approval.pending; }
    if (this.finished || this.controller.signal.aborted) throw new WorkerError('RUN_NOT_ACTIVE', 409);
    if (approval.kind === 'question' && answer.behavior === 'allow' && !answer.message?.trim()) throw new WorkerError('QUESTION_REQUIRES_ANSWER');
    approval.answer = fingerprint;
    // An allow is for the arguments its card showed: their call may run once, from before the core can take the answer.
    const allow = approval.kind === 'approval' && answer.behavior === 'allow' ? approval.call : undefined;
    if (allow) this.allowed.add(allow);
    approval.pending = (async () => {
      let outcome = '';
      try {
        const result = await this.api(`/api/bots/${this.botId}/respond`, {
          threadId: this.threadId, requestId: answer.requestId,
          behavior: approval.kind === 'question' && answer.behavior === 'allow' ? 'answer' : answer.behavior, message: answer.message,
        });
        outcome = record(result) ? String(result.outcome) : '';
      } finally {
        // An allow the core did not take (its card had gone), or may not have, runs nothing; the API already holds such
        // an answer as unknown, which a task cannot complete with.
        if (allow && outcome !== 'allowed-once') this.allowed.delete(allow);
      }
      if (!['allowed-once', 'rejected', 'answered'].includes(outcome)) throw new WorkerError('APPROVAL_UNAVAILABLE', 409);
    })();
    // A failed/uncertain write is never repeated; subsequent identical calls observe the same result.
    return approval.pending;
  }
  /** A workspace tool runs only as a card allowed it: the core's call must have the tool and exactly the arguments of a
   *  call whose card was allowed, and each allow runs one call. In Ask mode the core runs nothing no card allowed, so
   *  anything else does not run and stops the task. */
  private authorize(name: string, args: unknown) {
    const call = allowedCall(this.allowed, name, args);
    if (!call) { const error = new WorkerError('TOOL_CALL_NOT_ALLOWED'); this.controller.abort(error); throw error; }
    this.allowed.delete(call);
  }
  private async api(path: string, body?: unknown, owner?: string): Promise<unknown> {
    const response = await fetch(this.coreURL + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...(owner ? { 'x-openmausbot-cli-owner': owner } : this.coreToken ? { authorization: `Bearer ${this.coreToken}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) { await response.body?.cancel(); throw new WorkerError(`CORE_HTTP_${response.status}`, 502); }
    return responseJSON(response);
  }
  async execute(): Promise<void> {
    let home = '', child: ChildProcess | undefined, sandbox: WorkspaceSandbox | undefined, transport: Awaited<ReturnType<typeof createTransport>> | undefined;
    let result: WorkerEvent = { type: 'failed', code: 'RUN_FAILED', message: 'OpenMaus task failed.' };
    let stage: RuntimeStage = 'sandbox';
    let failure: { stage: RuntimeStage; errorName: string; reason: string } | undefined;
    let coreStop = '';
    const timer = setTimeout(() => this.controller.abort(new WorkerError('TIMEOUT')), this.request.timeoutMs);
    const signal = this.controller.signal;
    try {
      if (!coreInstalled(this.config)) throw new WorkerError('CORE_NOT_INSTALLED', 503);
      await mkdir(this.config.dataRoot, { recursive: true, mode: 0o700 });
      home = await mkdtemp(join(this.config.dataRoot, 'run-'));
      await mkdir(join(home, 'tmp'), { mode: 0o700 });
      sandbox = await this.createSandbox(this.config.sandbox, { workspaceId: hash(this.request.tenantId + '\0' + this.request.sessionId), runId: this.request.runId,
        inputs: this.request.inputs.map(input => ({ name: input.name, content: input.content, encoding: input.encoding, sha256: input.sha256 })) }, signal);
      transport = await createTransport(this.request, sandbox, signal, this.emit, (name, args) => this.authorize(name, args));
      stage = 'core_health';
      const owner = randomBytes(32).toString('base64url');
      const [port, webhookPort] = await Promise.all([freePort(), freePort()]);
      this.coreURL = `http://127.0.0.1:${port}`;
      const guard = moduleGuardOptions();
      const generatedConfig = {
        instances: { awwo: { driver: 'openai-compat', enabled: true, config: { url: transport.url + '/v1', key: transport.token, model: 'awwo-model', managedModels: ['awwo-model'], tools: true, provider: '' } } },
        defaultModelSelection: { instanceId: 'awwo', model: 'awwo-model' },
        features: { browser: false, sharedComputers: false, skillAuthoring: false, autoRecall: false, llmThreadTitles: false, claudeUserMcp: false, cloudOverflow: false },
        mcpServers: { awwo_workspace: { command: process.execPath, args: [...guard.execArgv, join(WORKER_DIR, 'mcp-shim.ts')], env: { AWWO_WORKSPACE_URL: transport.url + '/mcp', AWWO_WORKSPACE_TOKEN: transport.token, ...guard.env }, enabled: true } },
      };
      await writeFile(join(home, 'config.json'), JSON.stringify(generatedConfig), { mode: 0o600 });
      signal.throwIfAborted();
      child = spawn(process.execPath, [...guard.execArgv, this.config.corePath], { cwd: home, env: { ...coreEnvironment(home, port, webhookPort), ...guard.env }, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      let exited = false;
      child.on('error', () => { exited = true; }); child.on('exit', () => { exited = true; });
      child.stdout?.resume(); child.stderr?.resume(); child.stdin?.on('error', () => {});
      child.stdin?.end(owner + '\n');
      const start = Date.now(); let healthy = false;
      while (Date.now() - start < Math.min(60_000, this.request.timeoutMs)) {
        signal.throwIfAborted();
        if (exited) throw new WorkerError('CORE_START_FAILED', 503);
        try { const health = await this.api('/api/health'); if (record(health) && health.app === 'openmausbot' && (health.pid === undefined || health.pid === child.pid)) { healthy = true; break; } } catch { signal.throwIfAborted(); }
        await delay(150, undefined, { signal });
      }
      if (!healthy) throw new WorkerError('CORE_START_TIMEOUT', 503);
      stage = 'pairing';
      const pairing = await this.api('/api/auth/pairing', { scopes: ['admin', 'client'], label: 'AwwO managed run' }, owner);
      if (!record(pairing) || typeof pairing.code !== 'string') throw new WorkerError('CORE_PAIRING_FAILED');
      const paired = await this.api('/api/auth/pair', { code: pairing.code, label: 'AwwO managed run' });
      if (!record(paired) || typeof paired.token !== 'string') throw new WorkerError('CORE_PAIRING_FAILED');
      this.coreToken = paired.token;
      stage = 'create_bot';
      const created = await this.api('/api/bots', { name: 'AwwO workspace', soul: this.request.instructions + workspaceSoul(this.config, this.request),
        modelSelection: { instanceId: 'awwo', model: 'awwo-model' }, requireAvailableModel: true, computer: 'off', browser: false, composio: false, peers: [], mcpServers: ['awwo_workspace'], approvalMode: 'ask', chiefOfStaff: false });
      if (!record(created) || !record(created.bot) || typeof created.bot.id !== 'string' || typeof created.bot.threadId !== 'string') throw new WorkerError('CORE_BOT_FAILED');
      this.botId = created.bot.id; this.threadId = created.bot.threadId;
      const sendId = randomBytes(24).toString('base64url');
      stage = 'send';
      await this.api(`/api/bots/${this.botId}/messages/guarded`, { threadId: this.threadId, sendId, text: this.request.prompt, expectedActiveLeafId: created.bot.activeLeafId ?? null, expectedApprovalMode: 'ask' });
      stage = 'poll';
      const seen = new Map<string, string>(), secrets = [this.coreToken, owner, transport.token, this.request.modelProxyToken, home, ...(sandbox?.secrets ?? [])];
      while (true) {
        signal.throwIfAborted(); if (exited) throw new WorkerError('CORE_EXITED');
        const snapshot = await this.api(`/api/bots/${this.botId}/requests/${sendId}?threadId=${encodeURIComponent(this.threadId)}`);
        if (!record(snapshot) || !Array.isArray(snapshot.messages)) throw new WorkerError('CORE_SNAPSHOT_INVALID');
        for (const message of snapshot.messages) {
          if (!record(message) || typeof message.id !== 'string') continue;
          if (message.kind === 'text' && typeof message.text === 'string' && seen.get(message.id) !== message.text) {
            seen.set(message.id, message.text);
            const text = boundedText(safeMessage(message.text, secrets), 64 * 1024);
            this.emit({ type: 'computer_message', id: message.id, role: message.role === 'user' ? 'user' : 'assistant', ...text });
          }
          if (record(message.card) && typeof message.card.requestId === 'string' && !message.card.answered && !message.card.dismissed && !message.card.expired && !this.approvals.has(message.card.requestId)) {
            const card = message.card, requestId = card.requestId as string;
            if (card.questionRequest) {
              // A question carries its own questions.
              this.approvals.set(requestId, { kind: 'question' });
              this.emit({ type: 'computer_approval', requestId, ...approvalDisplay('question', card, undefined, secrets), kind: 'question',
                arguments: record(card.questionRequest) ? card.questionRequest : {} });
            } else {
              // A tool's card carries the arguments of the very call it is for, and never any others.
              const call = cardCall(transport.calls, snapshot.messages, card.tool);
              call.card = requestId;
              this.approvals.set(requestId, { kind: 'approval', call });
              this.emit({ type: 'computer_approval', requestId, ...approvalDisplay('approval', card, call.tool, secrets), kind: 'approval', arguments: call.arguments });
            }
          }
        }
        if (snapshot.phase === 'settled') {
          const terminal = snapshot.messages.findLast((message: unknown) => record(message) && message.turnTerminal === true && message.turnSucceeded === true && typeof message.text === 'string');
          if (!record(terminal) || typeof terminal.text !== 'string') throw new WorkerError('CORE_RESULT_UNVERIFIED');
          const output = boundedText(safeMessage(terminal.text, secrets), 256 * 1024);
          result = { type: 'completed', output: output.text, truncated: output.truncated }; break;
        }
        if (snapshot.phase === 'untracked' || snapshot.messages.some((message: unknown) => record(message) && message.turnSucceeded === false)) {
          coreStop = coreStopReason(snapshot.messages);
          throw new WorkerError(failedTurnCode(transport.modelCalls(), this.request, coreStop));
        }
        await delay(200, undefined, { signal });
      }
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      const code = reason instanceof WorkerError ? reason.code : 'RUN_FAILED';
      failure = { stage, ...safeFailureDetails(reason) };
      // A turn the core failed says why in its own words, which only reach the log as a label.
      if (coreStop && failure.reason === 'UNCLASSIFIED' && !signal.aborted) failure.reason = coreStop;
      result = code === 'CANCELLED' ? { type: 'cancelled' } : { type: 'failed', code, message: `OpenMaus task stopped (${code}).` };
    } finally {
      this.finished = true; clearTimeout(timer);
      if (!signal.aborted) this.controller.abort(new WorkerError('FINISHED'));
      const cleanup = await Promise.allSettled([child ? stopProcess(child) : Promise.resolve(), transport?.close(), sandbox?.close()]);
      const cleanupFailure = cleanup.find(entry => entry.status === 'rejected');
      if (cleanupFailure?.status === 'rejected') { result = { type: 'failed', code: 'CLEANUP_FAILED', message: 'Task stopped, but isolation cleanup could not be confirmed.' }; failure = { stage: 'cleanup', ...safeFailureDetails(cleanupFailure.reason) }; }
      if (home) { try { await rm(home, { recursive: true, force: true }); } catch (error) { result = { type: 'failed', code: 'CLEANUP_FAILED', message: 'Temporary task data cleanup failed.' }; failure = { stage: 'cleanup', ...safeFailureDetails(error) }; } }
    }
    if (result.type === 'failed') diagnostic('run_failed', this.request.runId, String(result.code), undefined, failure);
    this.emit(result);
  }
}
