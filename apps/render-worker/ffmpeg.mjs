// ffmpeg and ffprobe: the exact argument lists (pure, tested as arrays) and one way to run a program — no shell, an
// allowlisted environment (the worker's token and any other secret never reach a child), killed on abort.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

const GIF_MAX_FRAMES = 350;

/** PNG frames on stdin → H.264 MP4 that plays everywhere (yuv420p, even size, moov first). */
export function encodeArgs({ fps, output }) {
  return ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', '-an', output];
}

/** Every K-th frame goes on the 4×3 contact sheet, so twelve tiles span the whole render. */
export function contactStep(frames) {
  return Math.max(1, Math.floor(frames / 12));
}

export function contactArgs({ input, frames, output }) {
  return ['-y', '-i', input, '-vf', `select='not(mod(n\\,${contactStep(frames)}))',scale=400:-1,tile=4x3`, '-frames:v', '1', output];
}

/** A GIF keeps the render's rate unless that would exceed 350 frames; then it drops to floor(350 / seconds). */
export function gifRate({ frames, fps, seconds }) {
  if (frames <= GIF_MAX_FRAMES) return { fps, reduced: false };
  const rate = Math.max(1, Math.min(fps, Math.floor(GIF_MAX_FRAMES / seconds)));
  return { fps: rate, reduced: rate < fps };
}

export function gifArgs({ input, fps, loop, output }) {
  return ['-y', '-i', input, '-vf',
    `fps=${fps},scale='min(1200,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop', loop ? '0' : '-1', output];
}

export function probeArgs(input) {
  return ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames,width,height',
    '-show_entries', 'format=duration', '-of', 'json', input];
}

/** ffprobe's JSON → {frames, width, height, duration}; anything else is an encoder failure. */
export function parseProbe(stdout) {
  const parsed = JSON.parse(String(stdout));
  const stream = parsed?.streams?.[0];
  const probe = { frames: Number(stream?.nb_read_frames), width: Number(stream?.width), height: Number(stream?.height), duration: Number(parsed?.format?.duration) };
  if (!Object.values(probe).every(Number.isFinite)) throw new Error('ffprobe returned no video stream');
  return probe;
}

/** The only variables a child process (ffmpeg, ffprobe, the browser) is given. */
export const CHILD_ENV_NAMES = Object.freeze(['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'LANG']);

export function childEnv(source = process.env) {
  const env = {};
  for (const name of CHILD_ENV_NAMES) {
    const value = source[name];
    if (typeof value === 'string' && value !== '') env[name] = value;
  }
  return env;
}

/** Whether a command can be run: a path names an existing file; a bare name is looked up on PATH. */
export function findExecutable(command, env = process.env) {
  if (typeof command !== 'string' || command === '') return false;
  const isFile = (candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } };
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) return isFile(command);
  const dirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', ...String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  return dirs.some((dir) => exts.some((ext) => isFile(path.join(dir, command + ext))));
}

function processError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * Runs command with args (never through a shell). stdin: 'ignore' (default), 'pipe' (write to the returned
 * promise's .stdin, then end it) or a Buffer to send. Resolves {stdout, stderr} on exit code 0; rejects with
 * code PROCESS_SPAWN_FAILED (not runnable), PROCESS_FAILED (non-zero exit, stderr tail attached) or ABORTED.
 */
export function runProcess(command, args, { stdin = 'ignore', signal, env = childEnv(), maxStdout = 4 << 20 } = {}) {
  const piped = stdin === 'pipe' || Buffer.isBuffer(stdin);
  const name = path.basename(String(command));
  let child;
  try {
    child = spawn(command, args, { shell: false, windowsHide: true, env, stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const failed = Promise.reject(processError('PROCESS_SPAWN_FAILED', `${name} could not be started: ${error.message}`));
    return Object.assign(failed, { stdin: null, child: null });
  }
  const result = new Promise((resolve, reject) => {
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    const onAbort = () => { child.kill('SIGKILL'); };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on('data', (chunk) => { stdoutBytes += chunk.length; if (stdoutBytes <= maxStdout) stdout.push(chunk); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => { stderr = (stderr + text).slice(-8192); });
    if (child.stdin) {
      child.stdin.on('error', () => {}); // A child that exits early surfaces as its exit code, not as EPIPE.
      if (Buffer.isBuffer(stdin)) child.stdin.end(stdin);
    }
    child.on('error', (error) => finish(processError('PROCESS_SPAWN_FAILED', `${name} could not be started: ${error.message}`)));
    child.on('close', (exitCode, killedBy) => {
      if (signal?.aborted) return finish(processError('ABORTED', `${name} was stopped`));
      if (exitCode !== 0) return finish(processError('PROCESS_FAILED', `${name} exited with ${exitCode ?? killedBy}`, { exitCode, stderr }));
      if (stdoutBytes > maxStdout) return finish(processError('PROCESS_FAILED', `${name} wrote too much output`, { stderr }));
      finish(null, { stdout: Buffer.concat(stdout), stderr });
    });
  });
  return Object.assign(result, { stdin: child.stdin ?? null, child });
}

/** Writes one chunk to a child's stdin, waiting while the pipe is full; rejects if the child stopped reading. */
export async function writeChunk(stream, chunk) {
  const closed = () => processError('PROCESS_STDIN_CLOSED', 'The encoder stopped taking frames');
  if (!stream || stream.destroyed || stream.writableEnded) throw closed();
  if (stream.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const done = (error) => {
      stream.off('drain', onDrain);
      stream.off('close', onClose);
      if (error) reject(error); else resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(closed());
    stream.on('drain', onDrain);
    stream.on('close', onClose);
  });
}
