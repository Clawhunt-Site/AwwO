import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkspaceSandbox, type WorkspaceSandbox } from '../openai-agents-worker/workspace-sandbox.ts';
import { type WorkerConfig, WORKER_DIR, coreInstalled } from './config.ts';
import { closeServer, createTransport, listenLocal } from './transport.ts';
import { WorkerError, boundedText, hash, record, responseJSON, safeMessage, type ApprovalAnswer, type RunRequest, type WorkerEvent } from './protocol.ts';
import { diagnostic, safeFailureDetails, type RuntimeStage } from './diagnostics.ts';

export function coreEnvironment(home: string, port: string, webhookPort: string): NodeJS.ProcessEnv {
  return { PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: home, TMPDIR: join(home, 'tmp'),
    OMB_DATA_DIR: home, OMB_PORT: port, OMB_WEBHOOK_PORT: webhookPort, OMB_LOOPBACK_TRUST: 'service', OMB_CLI_OWNER_STDIN: '1',
    NODE_ENV: 'production', NO_COLOR: '1', OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS: '120000' };
}
async function freePort(): Promise<string> { const server = createServer(); const url = await listenLocal(server); await closeServer(server); return new URL(url).port; }
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const kill = (signal: NodeJS.Signals) => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } };
  kill('SIGTERM'); await Promise.race([exit, delay(1500)]);
  if (child.exitCode === null && child.signalCode === null) { kill('SIGKILL'); await Promise.race([exit, delay(3000).then(() => { throw new WorkerError('CORE_CLEANUP_FAILED', 500); })]); }
}
type Approval = { kind: 'approval' | 'question'; answer?: string; pending?: Promise<void> };
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
  private coreURL = ''; private coreToken = ''; private botId = ''; private threadId = '';
  private finished = false;
  readonly request: RunRequest; readonly config: WorkerConfig; readonly emit: (event: WorkerEvent) => void;
  constructor(request: RunRequest, config: WorkerConfig, emit: (event: WorkerEvent) => void) { this.request = request; this.config = config; this.emit = emit; }
  cancel() { this.controller.abort(new WorkerError('CANCELLED')); }
  async respond(answer: ApprovalAnswer): Promise<void> {
    const approval = this.approvals.get(answer.requestId);
    if (!approval) throw new WorkerError('APPROVAL_NOT_FOUND', 404);
    const fingerprint = JSON.stringify(answer);
    if (approval.answer) { if (approval.answer !== fingerprint) throw new WorkerError('APPROVAL_ALREADY_ANSWERED', 409); return approval.pending; }
    if (this.finished || this.controller.signal.aborted) throw new WorkerError('RUN_NOT_ACTIVE', 409);
    if (approval.kind === 'question' && answer.behavior === 'allow' && !answer.message?.trim()) throw new WorkerError('QUESTION_REQUIRES_ANSWER');
    approval.answer = fingerprint;
    approval.pending = (async () => {
      const result = await this.api(`/api/bots/${this.botId}/respond`, {
        threadId: this.threadId, requestId: answer.requestId,
        behavior: approval.kind === 'question' && answer.behavior === 'allow' ? 'answer' : answer.behavior, message: answer.message,
      });
      if (!record(result) || !['allowed-once', 'rejected', 'answered'].includes(String(result.outcome))) throw new WorkerError('APPROVAL_UNAVAILABLE', 409);
    })();
    // A failed/uncertain write is never repeated; subsequent identical calls observe the same result.
    return approval.pending;
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
    const timer = setTimeout(() => this.controller.abort(new WorkerError('TIMEOUT')), this.request.timeoutMs);
    const signal = this.controller.signal;
    try {
      if (!coreInstalled(this.config)) throw new WorkerError('CORE_NOT_INSTALLED', 503);
      await mkdir(this.config.dataRoot, { recursive: true, mode: 0o700 });
      home = await mkdtemp(join(this.config.dataRoot, 'run-'));
      await mkdir(join(home, 'tmp'), { mode: 0o700 });
      sandbox = await createWorkspaceSandbox(this.config.sandbox, { workspaceId: hash(this.request.tenantId + '\0' + this.request.sessionId), runId: this.request.runId }, signal);
      transport = await createTransport(this.request, sandbox, signal, this.emit);
      stage = 'core_health';
      const owner = randomBytes(32).toString('base64url');
      const [port, webhookPort] = await Promise.all([freePort(), freePort()]);
      this.coreURL = `http://127.0.0.1:${port}`;
      const generatedConfig = {
        instances: { awwo: { driver: 'openai-compat', enabled: true, config: { url: transport.url + '/v1', key: transport.token, model: 'awwo-model', managedModels: ['awwo-model'], tools: true, provider: '' } } },
        defaultModelSelection: { instanceId: 'awwo', model: 'awwo-model' },
        features: { browser: false, sharedComputers: false, skillAuthoring: false, autoRecall: false, llmThreadTitles: false, claudeUserMcp: false, cloudOverflow: false },
        mcpServers: { awwo_workspace: { command: process.execPath, args: [join(WORKER_DIR, 'mcp-shim.ts')], env: { AWWO_WORKSPACE_URL: transport.url + '/mcp', AWWO_WORKSPACE_TOKEN: transport.token }, enabled: true } },
      };
      await writeFile(join(home, 'config.json'), JSON.stringify(generatedConfig), { mode: 0o600 });
      signal.throwIfAborted();
      child = spawn(process.execPath, [this.config.corePath], { cwd: home, env: coreEnvironment(home, port, webhookPort), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
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
      const created = await this.api('/api/bots', { name: 'AwwO workspace', soul: this.request.instructions + '\nUse only AwwO workspace tools. Files and commands exist inside an isolated Docker workspace. No desktop, browser, host shell, peers, skills or external integrations are available. Publish files you actually created; never claim unrun tests passed.',
        modelSelection: { instanceId: 'awwo', model: 'awwo-model' }, requireAvailableModel: true, computer: 'off', browser: false, composio: false, peers: [], mcpServers: ['awwo_workspace'], approvalMode: 'ask', chiefOfStaff: false });
      if (!record(created) || !record(created.bot) || typeof created.bot.id !== 'string' || typeof created.bot.threadId !== 'string') throw new WorkerError('CORE_BOT_FAILED');
      this.botId = created.bot.id; this.threadId = created.bot.threadId;
      const sendId = randomBytes(24).toString('base64url');
      stage = 'send';
      await this.api(`/api/bots/${this.botId}/messages/guarded`, { threadId: this.threadId, sendId, text: this.request.prompt, expectedActiveLeafId: created.bot.activeLeafId ?? null, expectedApprovalMode: 'ask' });
      stage = 'poll';
      const seen = new Map<string, string>(), secrets = [this.coreToken, owner, transport.token, this.request.modelProxyToken, home];
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
            const card = message.card, kind = card.questionRequest ? 'question' : 'approval';
            const index = transport.calls.findIndex(call => call.tool === card.tool);
            const captured = index >= 0 ? transport.calls.splice(index, 1)[0] : undefined;
            if (kind === 'approval' && !captured) throw new WorkerError('APPROVAL_ARGUMENTS_UNAVAILABLE');
            this.approvals.set(card.requestId as string, { kind });
            this.emit({ type: 'computer_approval', requestId: card.requestId,
              ...approvalDisplay(kind, card, captured?.tool, secrets), kind, arguments: captured?.arguments ?? (record(card.questionRequest) ? card.questionRequest : {}) });
          }
        }
        if (snapshot.phase === 'settled') {
          const terminal = snapshot.messages.findLast((message: unknown) => record(message) && message.turnTerminal === true && message.turnSucceeded === true && typeof message.text === 'string');
          if (!record(terminal) || typeof terminal.text !== 'string') throw new WorkerError('CORE_RESULT_UNVERIFIED');
          const output = boundedText(safeMessage(terminal.text, secrets), 256 * 1024);
          result = { type: 'completed', output: output.text, truncated: output.truncated }; break;
        }
        if (snapshot.phase === 'untracked' || snapshot.messages.some((message: unknown) => record(message) && message.turnSucceeded === false)) throw new WorkerError(transport.modelCalls() > this.request.maxModelCalls ? 'MODEL_BUDGET_EXCEEDED' : 'CORE_EXECUTION_FAILED');
        await delay(200, undefined, { signal });
      }
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      const code = reason instanceof WorkerError ? reason.code : 'RUN_FAILED';
      failure = { stage, ...safeFailureDetails(reason) };
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
