// The worker's programs (rea-video, ffprobe) run without a shell, with only the environment they are given, in a
// process group of their own: a timeout, an abort or the end of the program stops everything it started.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

const STDERR_TAIL = 8192;

/** Whether `command` names an executable file: a path, or a name found on `pathValue`. */
export function findExecutable(command, pathValue = process.env.PATH ?? '') {
  const usable = (file) => {
    try {
      if (!statSync(file).isFile()) return false;
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (!command) return false;
  if (command.includes('/') || command.includes('\\')) return usable(command);
  return pathValue.split(path.delimiter).filter(Boolean).some((dir) => usable(path.join(dir, command)));
}

function stopGroup(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Runs `command args` and resolves {code, signal, timedOut, aborted, stdout, stdoutTruncated, stderr} once it has
 * exited; stdout is kept up to maxStdoutBytes, stderr's last 8 KiB only (for the worker's log, never for a caller).
 * Rejects only when the program cannot be started.
 */
export function runChild(command, args, { cwd, env, signal, timeoutMs, maxStdoutBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, shell: false });
    } catch (error) {
      reject(Object.assign(new Error(`could not start ${path.basename(command)}`), { code: 'SPAWN_FAILED', cause: error }));
      return;
    }
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; stopGroup(child); }, Math.max(1, timeoutMs ?? 60_000));
    const onAbort = () => stopGroup(child);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      if (stdoutBytes < maxStdoutBytes) stdout.push(chunk.subarray(0, maxStdoutBytes - stdoutBytes));
      stdoutBytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL); });
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    child.on('error', (error) => finish(() => reject(Object.assign(new Error(`could not start ${path.basename(command)}`), { code: 'SPAWN_FAILED', cause: error }))));
    child.on('close', (code, exitSignal) => finish(() => {
      stopGroup(child); // whatever the program left running
      resolve({ code, signal: exitSignal, timedOut, aborted: Boolean(signal?.aborted), stdout: Buffer.concat(stdout).toString('utf8'), stdoutTruncated: stdoutBytes > maxStdoutBytes, stderr });
    }));
  });
}
