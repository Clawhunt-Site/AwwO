import { parentObservability } from './usage.mjs';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveModelConfig } from './config.mjs';
import { bedrockFactLine, createBedrockAuthResolver } from '../bedrock-bridge.ts';

export const TASK_URL = new URL('./pi-task.mjs', import.meta.url);
// The failures a child names that keep their code (pi-task.mjs), each with the words the other workers give it
// (openai-agents-worker errors.mjs), never the child's: a provider's refusal of the request as larger than its model's
// window, so the API settles it as that refusal; a stop at the model's output cap; a stop that declined the request;
// and a provider's refusal of a credential, its rate limit and its outage. Any other failure is the model's, whatever
// the child said.
const CHILD_FAILURES = Object.freeze({
  MODEL_CONTEXT_LIMIT: 'The model service refused the request as larger than the model\'s context window.',
  MODEL_OUTPUT_LIMIT: 'The model response reached its configured output limit.',
  MODEL_REFUSAL: 'The model declined the request.',
  MODEL_AUTHENTICATION: 'The model service rejected its configured credentials.',
  MODEL_RATE_LIMIT: 'The model service is rate limited.',
  MODEL_UNAVAILABLE: 'The model service is unavailable.',
});
export const BEDROCK_CALL_URL = new URL('./bedrock-call.mjs', import.meta.url);
// The parent alone reads the AWS credential chain; a Bedrock child only ever receives the
// API key or the short-lived credentials resolved here, over the same private IPC as any key.
// Managed-execution calls (server.mjs) are made the same way (bedrockComputerCall).
export const resolveBedrockAuth = createBedrockAuthResolver(async () => (await import('@aws-sdk/credential-provider-node')).defaultProvider());

/**
 * AwwO 本地版's module guard (scripts/awwo-local-module-guard.cjs), when the local runtime that started this worker
 * names it (AWWO_LOCAL_MODULE_GUARD, the folders it guards in AWWO_LOCAL_MODULE_ROOTS): a child's Node.js loads it
 * first, as this worker's did, so that it loads no module from a node_modules folder above AwwO's own (where Node.js
 * looks for a package's absent optional dependency, and another account may have put one). It is the one Node option
 * a child gets, and the one variable beside workerEnvironment's. The hosted site sets neither: its children start as
 * before.
 */
export function moduleGuardOptions(env = process.env) {
  if (!env.AWWO_LOCAL_MODULE_GUARD || !env.AWWO_LOCAL_MODULE_ROOTS) return { execArgv: [], env: {} };
  return { execArgv: ['--require', env.AWWO_LOCAL_MODULE_GUARD], env: { AWWO_LOCAL_MODULE_ROOTS: env.AWWO_LOCAL_MODULE_ROOTS } };
}

// Deliberately exclude HOME, NODE_OPTIONS, provider keys, proxy credentials,
// npm options, and the launching user's Pi/extension configuration.
export function workerEnvironment(directory, executable = process.execPath) {
  return {
    PATH: dirname(executable),
    TMPDIR: directory,
    PI_CODING_AGENT_DIR: join(directory, 'agent'),
    PI_OFFLINE: '1',
    NO_COLOR: '1',
  };
}

export async function startIsolatedRun({ config, request, onEvent, onExit }, { taskURL = TASK_URL, bedrockAuth = resolveBedrockAuth } = {}) {
  const acceptedAt = performance.now();
  const acceptedAtNs = process.hrtime.bigint().toString();
  let firstDeltaMs;
  let childObservability;
  const modelConfig = resolveModelConfig(config, request.model);
  let auth;
  if (modelConfig.provider === 'bedrock') {
    // Resolved before any directory or process exists, so a missing credential leaves nothing behind.
    try { auth = await bedrockAuth(modelConfig.apiKey); } catch { throw Object.assign(new Error('Bedrock credentials are unavailable'), { code: 'MODEL_AUTHENTICATION' }); }
  }
  const directory = await mkdtemp(join(tmpdir(), 'awwo-pi-'));
  const agentDir = join(directory, 'agent');
  let child;
  try {
    await mkdir(agentDir, { mode: 0o700 });
    const provenance = `# Temporary Pi execution directory\n\nCreated by AWWO Pi worker on ${new Date().toISOString()}.\nScope: one isolated agent run; deleted after the child exits.\n`;
    await Promise.all([writeFile(join(directory, 'creator.md'), provenance), writeFile(join(agentDir, 'creator.md'), provenance)]);
    const guard = moduleGuardOptions();
    child = fork(taskURL, [], {
      cwd: directory,
      env: { ...workerEnvironment(directory), ...guard.env },
      execArgv: guard.execArgv,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  let terminalEvent;
  let cancellation;
  let forceTimer;
  let exited = false;
  let outputBytes = 0;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const forceExitAfterGrace = () => {
    if (forceTimer) return;
    forceTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, config.cancelGraceMs);
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

  child.on('message', (event) => {
    if (event?.type === 'bedrock_fact') {
      // A Bedrock call's fallback to its model's other profile, or its failure by AWS error type: for this worker's log
      // only, rebuilt from closed labels (bedrockFactLine), never relayed.
      const line = bedrockFactLine('awwo-pi-worker', request.runId, event.fact);
      if (line) console.error(line);
      return;
    }
    if (terminalEvent || !event || typeof event !== 'object') return;
    if (event.type === 'text_delta' && typeof event.delta === 'string') {
      if (cancellation) return;
      outputBytes += Buffer.byteLength(event.delta);
      if (outputBytes > config.maxOutputBytes) stop('output_limit');
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
      else if (event.type === 'completed' && typeof event.text === 'string' && Buffer.byteLength(event.text) <= config.maxOutputBytes) {
        rememberTerminal({ type: 'completed', text: event.text });
      } else if (event.type === 'cancelled') rememberTerminal({ type: 'cancelled' });
      else if (event.type === 'failed' && typeof event.code === 'string' && Object.hasOwn(CHILD_FAILURES, event.code)) {
        rememberTerminal({ type: 'failed', code: event.code, message: CHILD_FAILURES[event.code] });
      } else rememberTerminal({ type: 'failed', code: 'MODEL_ERROR', message: 'The model request failed. Check the server provider configuration.' });
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
    try { await rm(directory, { recursive: true, force: true }); } catch {
      // Never include run contents or credentials in cleanup diagnostics.
      console.error('AWWO Pi temporary directory cleanup failed.');
    } finally {
      // Release the session and capacity before publishing the terminal event.
      // Its recipient may immediately submit the next turn on this session.
      try {
        onExit?.();
        terminalEvent.observability = parentObservability(childObservability, { totalMs: performance.now() - acceptedAt, firstDeltaMs, outcome: terminalEvent.type });
        onEvent(terminalEvent);
      } finally { resolveDone(); }
    }
  });
  child.send({
    type: 'run',
    acceptedAtNs,
    request,
    directory,
    agentDir,
    modelConfig: {
      provider: modelConfig.provider, model: modelConfig.model, baseURL: modelConfig.baseURL,
      // A Bedrock key travels only inside its auth record, never as a provider API key.
      apiKey: modelConfig.provider === 'bedrock' ? '' : modelConfig.apiKey,
      contextWindow: modelConfig.contextWindow, maxTokens: modelConfig.maxTokens, protocol: modelConfig.protocol,
      input: [...(modelConfig.input ?? ['text'])],
      ...(modelConfig.disableThinking === true ? { disableThinking: true } : {}),
      ...(modelConfig.provider === 'bedrock' ? { region: modelConfig.region, bedrockAuth: auth, ...(modelConfig.thinkingBudget ? { thinkingBudget: modelConfig.thinkingBudget } : {}),
        ...(modelConfig.promptCache === true ? { promptCache: true } : {}),
        ...(modelConfig.fallbackModel ? { fallbackModel: modelConfig.fallbackModel } : {}),
        // The efforts the model offers, for the child's bridge: the run's effort (request.effort) must be one of them.
        ...(modelConfig.reasoningEfforts?.length ? { reasoningEfforts: [...modelConfig.reasoningEfforts] } : {}) } : {}),
    },
  }, (error) => { if (error) stop(); });
  return { cancel: stop, done, pid: child.pid, directory };
}


/**
 * One managed-execution Bedrock call in an isolated child (bedrock-call.mjs), as a Bedrock run's calls are made: the
 * credentials are resolved here, the child gets them and the request over private IPC, with no Node options and only
 * workerEnvironment's variables (AwwO 本地版's module guard aside, moduleGuardOptions), so this process's environment
 * never reaches the AWS SDK. Resolves the gathered Chat
 * Completions answer; rejects with an Error whose `reason` names what failed. An abort stops the child.
 */
export async function bedrockComputerCall(model, body, signal, { auth = resolveBedrockAuth, childURL = BEDROCK_CALL_URL, graceMs = 2_000 } = {}) {
  const failure = (reason) => Object.assign(new Error('The Bedrock call failed'), { reason });
  let credentials;
  try { credentials = await auth(model.apiKey); } catch { throw failure('credentials'); }
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'awwo-pi-bedrock-'));
  let child;
  try {
    const guard = moduleGuardOptions();
    child = fork(childURL, [], { cwd: directory, env: { ...workerEnvironment(directory), ...guard.env }, execArgv: guard.execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw failure('child-start');
  }
  // 'close' comes after every message the child sent, so a call that ended without an answer is told apart.
  const closed = new Promise((resolve) => child.once('close', (code, signalName) => resolve(signalName ?? code)));
  void closed.then(() => rm(directory, { recursive: true, force: true })).catch(() => {});
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (done) => { if (settled) return; settled = true; signal?.removeEventListener('abort', onAbort); done(); };
    const onAbort = () => settle(() => {
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, graceMs).unref();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('message', (answer) => settle(() => {
      // The call's content-free facts (a fallback to the model's other profile, a failure's AWS error type) go to the log.
      for (const fact of Array.isArray(answer?.facts) ? answer.facts.slice(0, 4) : []) {
        const line = bedrockFactLine('awwo-pi-worker', undefined, fact);
        if (line) console.error(line);
      }
      if (answer?.ok === true && answer.raw && typeof answer.raw === 'object' && !Array.isArray(answer.raw)) resolve(answer.raw);
      else reject(failure(typeof answer?.reason === 'string' ? answer.reason.slice(0, 120) : 'unknown'));
    }));
    child.once('error', () => settle(() => reject(failure('child-error'))));
    void closed.then((how) => settle(() => reject(failure(`child-exit:${how}`))));
    child.send({ region: model.region, model: model.model, auth: credentials, promptCache: model.promptCache === true,
      ...(model.fallbackModel ? { fallbackModel: model.fallbackModel } : {}),
      ...(model.reasoningEfforts?.length ? { reasoningEfforts: [...model.reasoningEfforts] } : {}),
      url: `${model.baseURL.replace(/\/+$/, '')}/chat/completions`, body: JSON.stringify(body) },
    (error) => { if (error) settle(() => { child.kill('SIGKILL'); reject(failure('child-send')); }); });
  });
}
