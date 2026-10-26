import { authorizeWorkspace, workspaceAbilities, WORKSPACE_BODY_BYTES } from './workspace-protocol.ts';
import { createWorkspaceSandbox } from './workspace-sandbox.ts';
import { dispatchWorkspaceTool, validWorkspaceCall } from './workspace-rpc.ts';
import { parentObservability } from './usage.mjs';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { authorizeEffort, authorizeOutputContract, authorizeTools, fitsContextBudget, resolveModelConfig, validateRequest } from './config.mjs';
import { failureEvent, RuntimeError, sanitizeErrorDiagnostic } from './errors.mjs';
import { bedrockFactLine, createBedrockAuthResolver } from '../bedrock-bridge.ts';

export const TASK_URL = new URL('./agent-task.mjs', import.meta.url);
// The parent alone reads the AWS credential chain; a Bedrock child only ever receives the
// API key or the short-lived credentials resolved here, over the same private IPC as any key.
const resolveBedrockAuth = createBedrockAuthResolver(async () => (await import('@aws-sdk/credential-provider-node')).defaultProvider());

// Why a workspace snapshot failed, in closed words: the helper's message names paths a member made, which never reach a
// log. The words follow workspace-sandbox.ts's file helper.
export function snapshotFailure(error) {
  const message = String(error?.message ?? '');
  if (/symlink or special file/.test(message)) return 'link_or_special_file';
  if (/exceeds snapshot size limit|archive exceeds size limit/.test(message)) return 'workspace_too_large';
  if (/file exceeds size limit/i.test(message)) return 'file_too_large';
  if (/too many entries/i.test(message)) return 'too_many_files';
  if (/Invalid workspace path/.test(message)) return 'invalid_path';
  if (/timed out|cancelled|closed/i.test(message)) return 'interrupted';
  return 'other';
}

/**
 * AwwO 本地版's module guard (scripts/awwo-local-module-guard.cjs), when the local runtime that started this worker
 * names it (AWWO_LOCAL_MODULE_GUARD, the folders it guards in AWWO_LOCAL_MODULE_ROOTS): the run's Node.js loads it
 * first, as this worker's did, so that it loads no module from a node_modules folder above AwwO's own (where Node.js
 * looks for a package's absent optional dependency, and another account may have put one). It is the one Node option
 * the child gets, and the one variable beside workerEnvironment's. The hosted site sets neither: its runs start as
 * before.
 */
export function moduleGuardOptions(env = process.env) {
  if (!env.AWWO_LOCAL_MODULE_GUARD || !env.AWWO_LOCAL_MODULE_ROOTS) return { execArgv: [], env: {} };
  return { execArgv: ['--require', env.AWWO_LOCAL_MODULE_GUARD], env: { AWWO_LOCAL_MODULE_ROOTS: env.AWWO_LOCAL_MODULE_ROOTS } };
}

// Deliberately exclude HOME, NODE_OPTIONS, provider keys, proxy credentials,
// npm options, tracing configuration and the launching user's configuration.
export function workerEnvironment(directory, executable = process.execPath) {
  return {
    PATH: dirname(executable),
    TMPDIR: directory,
    LD_LIBRARY_PATH: dirname(executable),
    OPENAI_AGENTS_DISABLE_TRACING: '1',
    OPENAI_AGENTS_DONT_LOG_MODEL_DATA: '1',
    OPENAI_AGENTS_DONT_LOG_TOOL_DATA: '1',
    NO_COLOR: '1',
  };
}

// createSandbox defaults to the Docker workspace. Another host passes a factory with the same
// signature and WorkspaceSandbox contract.
export async function startIsolatedRun({ config, request, onEvent, onExit, onDiagnostic = (_diagnostic) => {} }, { taskURL = TASK_URL, bedrockAuth = resolveBedrockAuth, createSandbox = createWorkspaceSandbox } = {}) {
  validateRequest(request);
  authorizeTools(config, request);
  authorizeWorkspace(config.workspace, request);
  const acceptedAt = performance.now();
  const acceptedAtNs = process.hrtime.bigint().toString();
  let firstDeltaMs;
  let childObservability;
  const modelConfig = resolveModelConfig(config, request.model);
  authorizeEffort(modelConfig, request);
  authorizeOutputContract(modelConfig, request);
  if (!config.ready || !fitsContextBudget(request, modelConfig)) throw new Error('Invalid runtime admission');
  let auth;
  if (modelConfig.provider === 'bedrock') {
    // Resolved before any directory or process exists, so a missing credential leaves nothing behind.
    try { auth = await bedrockAuth(modelConfig.apiKey); } catch { throw new RuntimeError('MODEL_AUTHENTICATION'); }
  }
  const directory = await mkdtemp(join(tmpdir(), 'awwo-openai-agents-'));
  let child;
  let sandbox;
  const sandboxAbort = new AbortController();
  const maxOutput = request.workspace ? WORKSPACE_BODY_BYTES : config.maxOutputBytes;
  try {
    if (request.workspace) sandbox = await createSandbox(config.workspace, { workspaceId: request.workspace.id, runId: request.runId, inputs: request.workspace.inputs, snapshot: request.workspace.snapshot }, sandboxAbort.signal);
    const provenance = `# Temporary OpenAI Agents execution directory\n\nCreated by AWWO OpenAI Agents worker on ${new Date().toISOString()}.\nScope: one isolated agent run; deleted after the child exits.\n`;
    await writeFile(join(directory, 'creator.md'), provenance, { mode: 0o600 });
    const guard = moduleGuardOptions();
    child = fork(taskURL, [], {
      cwd: directory,
      env: { ...workerEnvironment(directory), ...guard.env },
      execArgv: guard.execArgv,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
  } catch (error) {
    if (sandbox) await sandbox.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  let terminalEvent;
  let terminalDiagnostic;
  let cancellation;
  let forceTimer;
  let exited = false;
  let outputBytes = 0;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const forceExitAfterGrace = () => {
    if (forceTimer) return;
    // A cancelled provider stream still has to settle its observed usage through
    // the bounded 10s callback before the trusted child can exit.
    const grace = request.workspace && cancellation ? Math.max(config.cancelGraceMs, 12_000) : config.cancelGraceMs;
    forceTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, grace);
    forceTimer.unref();
  };
  const rememberTerminal = (event) => {
    if (terminalEvent) return;
    terminalEvent = event;
    clearTimeout(timeout);
    // A terminal IPC message is a result, not proof that its process exited.
    // Bound teardown even when a child hangs after producing its final answer.
    forceExitAfterGrace();
  };
  const stop = (reason = 'cancelled') => {
    if (exited || cancellation || terminalEvent) return;
    cancellation = reason;
    sandboxAbort.abort();
    if (child.connected) child.send({ type: 'cancel' }, () => {});
    forceExitAfterGrace();
  };
  const timeout = setTimeout(() => stop('timeout'), config.timeoutMs);
  timeout.unref();
  const cancelledEvent = () => cancellation === 'timeout'
    ? { type: 'failed', code: 'DEADLINE_EXCEEDED', message: 'The model request timed out.' }
    : cancellation === 'output_limit'
      ? { type: 'failed', code: 'OUTPUT_LIMIT', message: 'The model output exceeded the configured limit.' }
      : { type: 'cancelled' };

  let toolPending = false;
  let toolSequence = 0;
  child.on('message', (event) => {
    if (event?.type === 'bedrock_fact') {
      // A Bedrock call's fallback to its model's other profile, or its failure by AWS error type: for this worker's log
      // only, rebuilt from closed labels (bedrockFactLine), never relayed.
      const line = bedrockFactLine('awwo-openai-agents-worker', request.runId, event.fact);
      if (line) console.error(line);
      return;
    }
    if (event?.type === 'workspace_call') {
      if (!sandbox || cancellation || terminalEvent || !validWorkspaceCall(event) || toolPending || event.sequence !== toolSequence + 1) { stop('cancelled'); return; }
      toolSequence = event.sequence;
      toolPending = true;
      dispatchWorkspaceTool(sandbox, event.name, event.args).then(result => {
        if (!cancellation && !terminalEvent && child.connected) child.send({ type: 'workspace_result', sequence: event.sequence, ok: true, result }, () => {});
      }, (error) => {
        if (!cancellation && !terminalEvent && child.connected) {
          // A run keeps the snapshot it started from when its workspace cannot be kept; the log says why, in closed words
          // only. A run being stopped ends as stopped, so it logs nothing here.
          if (event.name === 'snapshot') console.error(JSON.stringify({ service: 'awwo-openai-agents-worker', runId: request.runId, event: 'workspace_snapshot_failed', reason: snapshotFailure(error) }));
          child.send({ type: 'workspace_result', sequence: event.sequence, ok: false }, () => {});
        }
      }).finally(() => { toolPending = false; });
      return;
    }
    if (event?.type === 'workspace_activity' && sandbox && !cancellation && !terminalEvent) {
      if (Number.isSafeInteger(event.step) && event.step > 0 && event.step <= request.workspace.maxModelCalls && /^workspace_(list|read|write|exec|publish|archive)$/.test(event.tool)) onEvent({ type: 'workspace_activity', step: event.step, tool: event.tool });
      return;
    }
    if (terminalEvent || !event || typeof event !== 'object') return;
    if (event.type === 'text_delta' && typeof event.delta === 'string') {
      if (cancellation) return;
      outputBytes += Buffer.byteLength(event.delta);
      if (outputBytes > maxOutput) stop('output_limit');
      else { firstDeltaMs ??= performance.now() - acceptedAt; onEvent({ type: 'text_delta', delta: event.delta }); }
    } else if (event.type === 'reasoning') {
      // Only a well-formed count is relayed, rebuilt rather than passed through, so
      // nothing but the number can cross this boundary; nothing follows a stop.
      if (!cancellation && Number.isSafeInteger(event.characters) && event.characters >= 0) {
        onEvent({ type: 'reasoning', characters: event.characters });
      }
    } else if (['completed', 'failed', 'cancelled'].includes(event.type)) {
      childObservability = event.observability;
      if (cancellation) rememberTerminal(cancelledEvent());
      else if (event.type === 'completed' && typeof event.text === 'string' && Buffer.byteLength(event.text) <= maxOutput) {
        rememberTerminal({ type: 'completed', text: event.text, ...(sandbox ? { workspaceSnapshot: event.workspaceSnapshot } : {}) });
      } else if (event.type === 'completed' && typeof event.text === 'string') {
        rememberTerminal(failureEvent('OUTPUT_LIMIT'));
      } else if (event.type === 'cancelled') rememberTerminal({ type: 'cancelled' });
      else {
        terminalDiagnostic = sanitizeErrorDiagnostic(event.diagnostic);
        rememberTerminal(failureEvent(event.code));
      }
    }
  });
  child.on('error', () => {
    rememberTerminal(cancellation ? cancelledEvent() : { type: 'failed', code: 'WORKER_ERROR', message: 'The model worker could not start.' });
  });
  child.once('close', async () => {
    exited = true;
    clearTimeout(timeout);
    clearTimeout(forceTimer);
    terminalEvent ??= cancellation ? cancelledEvent() : { type: 'failed', code: 'WORKER_LOST', message: 'The model worker exited before completing.' };
    let cleanupFailed = false;
    try {
      if (sandbox) await sandbox.close();
    } catch {
      cleanupFailed = true;
      terminalDiagnostic = undefined;
      if (sandbox) terminalEvent = failureEvent('WORKSPACE_UNAVAILABLE');
      // Never include run contents or credentials in cleanup diagnostics.
      console.error('AWWO OpenAI Agents temporary directory cleanup failed.');
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {
        console.error('AWWO OpenAI Agents temporary directory cleanup failed.');
      });
      // Release the session and capacity before publishing the terminal event.
      // Its recipient may immediately submit the next turn on this session.
      try {
        onExit?.({ workspaceCleanupFailed: Boolean(sandbox && cleanupFailed) });
        terminalEvent.observability = parentObservability(childObservability, { totalMs: performance.now() - acceptedAt, firstDeltaMs, outcome: terminalEvent.type });
        if (terminalEvent.type === 'failed' && terminalDiagnostic) onDiagnostic(terminalDiagnostic);
        onEvent(terminalEvent);
      } finally { resolveDone(); }
    }
  });
  child.send({
    type: 'run',
    acceptedAtNs,
    request,
    ...(request.workspace ? { workspaceAbilities: workspaceAbilities(config.workspace) } : {}),
    modelConfig: {
      provider: modelConfig.provider, model: modelConfig.model, baseURL: modelConfig.baseURL,
      // A Bedrock key travels only inside its auth record, never as an OpenAI SDK key.
      apiKey: modelConfig.provider === 'bedrock' ? '' : modelConfig.apiKey,
      contextWindow: modelConfig.contextWindow, maxTokens: modelConfig.maxTokens, protocol: modelConfig.protocol,
      disableThinking: modelConfig.disableThinking === true,
      ...(modelConfig.provider === 'bedrock' ? { region: modelConfig.region, bedrockAuth: auth, ...(modelConfig.promptCache === true ? { promptCache: true } : {}),
        ...(modelConfig.fallbackModel ? { fallbackModel: modelConfig.fallbackModel } : {}) } : {}),
    },
  }, (error) => { if (error) stop(); });
  return { cancel: stop, done, pid: child.pid, directory };
}
