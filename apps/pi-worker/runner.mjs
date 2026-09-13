import { parentObservability } from './usage.mjs';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveModelConfig } from './config.mjs';

export const TASK_URL = new URL('./pi-task.mjs', import.meta.url);

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

export async function startIsolatedRun({ config, request, onEvent, onExit }, { taskURL = TASK_URL } = {}) {
  const acceptedAt = performance.now();
  const acceptedAtNs = process.hrtime.bigint().toString();
  let firstDeltaMs;
  let childObservability;
  const modelConfig = resolveModelConfig(config, request.model);
  const directory = await mkdtemp(join(tmpdir(), 'awwo-pi-'));
  const agentDir = join(directory, 'agent');
  let child;
  try {
    await mkdir(agentDir, { mode: 0o700 });
    const provenance = `# Temporary Pi execution directory\n\nCreated by AWWO Pi worker on ${new Date().toISOString()}.\nScope: one isolated agent run; deleted after the child exits.\n`;
    await Promise.all([writeFile(join(directory, 'creator.md'), provenance), writeFile(join(agentDir, 'creator.md'), provenance)]);
    child = fork(taskURL, [], {
      cwd: directory,
      env: workerEnvironment(directory),
      execArgv: [],
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
    if (terminalEvent || !event || typeof event !== 'object') return;
    if (event.type === 'text_delta' && typeof event.delta === 'string') {
      if (cancellation) return;
      outputBytes += Buffer.byteLength(event.delta);
      if (outputBytes > config.maxOutputBytes) stop('output_limit');
      else { firstDeltaMs ??= performance.now() - acceptedAt; onEvent({ type: 'text_delta', delta: event.delta }); }
    } else if (['completed', 'failed', 'cancelled'].includes(event.type)) {
      childObservability = event.observability;
      if (cancellation) rememberTerminal(cancelledEvent());
      else if (event.type === 'completed' && typeof event.text === 'string' && Buffer.byteLength(event.text) <= config.maxOutputBytes) {
        rememberTerminal({ type: 'completed', text: event.text });
      } else if (event.type === 'cancelled') rememberTerminal({ type: 'cancelled' });
      else rememberTerminal({ type: 'failed', code: 'MODEL_ERROR', message: 'The model request failed. Check the server provider configuration.' });
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
      provider: modelConfig.provider, model: modelConfig.model, baseURL: modelConfig.baseURL, apiKey: modelConfig.apiKey,
      contextWindow: modelConfig.contextWindow, maxTokens: modelConfig.maxTokens, protocol: modelConfig.protocol,
    },
  }, (error) => { if (error) stop(); });
  return { cancel: stop, done, pid: child.pid, directory };
}
