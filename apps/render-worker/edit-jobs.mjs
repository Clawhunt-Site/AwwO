// An edit job's life on the worker: created from its manifest (edit-timeline.mjs validateEditManifest), its files
// streamed in one by one (size and sha256 checked as they arrive, the container sniffed from the bytes: a file of no
// container the edit takes is refused), rendered once (edit-run.mjs), its outputs read back, then removed — by the
// API's DELETE, or after config.editIdleMs without a request; a job still receiving or rendering is stopped and waited
// for first.
// Only the job's own directory is ever written or removed; at startup, what a stopped worker left is removed.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { sniffFormat } from './edit-ffmpeg.mjs';
import { EditError, runEdit } from './edit-run.mjs';

const HEAD_BYTES = 64;
const SETTLE_WAIT_MS = 30_000;

export class EditRequestError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, ...extra });
  }
}

/** Whether the temporary root keeps `need` bytes free beyond a 2 GiB floor (unknown: yes; the writes say so). */
async function roomFor(root, need) {
  try {
    const info = await statfs(root);
    return Number(info.bavail) * Number(info.bsize) - need >= 2 * 1024 ** 3;
  } catch {
    return true;
  }
}

/** A new job (its directory made, nothing received yet) for a validated manifest, if its files fit on the disk. */
export async function createJob(manifest, config) {
  if (!(await roomFor(config.tmp, manifest.files.reduce((total, file) => total + file.size, 0)))) {
    throw new EditRequestError(503, 'EDIT_UNAVAILABLE', 'Not enough free disk space for the edit', { detail: 'disk_full' });
  }
  let dir;
  try {
    dir = await mkdtemp(path.join(config.tmp, 'awwo-edit-'));
    await mkdir(path.join(dir, 'out'));
  } catch {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new EditRequestError(503, 'EDIT_UNAVAILABLE', 'No temporary space for the edit', { detail: 'tmp_unavailable' });
  }
  const files = manifest.files.map((file) => ({ ...file, path: null, format: null, received: false, receiving: false }));
  return {
    kind: 'edit', editId: manifest.editId, dir, files, byName: new Map(files.map((file) => [file.name, file])), timeline: manifest.timeline,
    limits: manifest.limits, state: 'uploading', result: null, controller: new AbortController(), requests: 0, idleTimer: null, settled: null,
    uploads: new Set(),
  };
}

/** Streams one file of the job to a scratch name, checks it, and only then gives it its name (in-NNN.<ext>). */
export async function receiveFile(job, index, request) {
  const file = job.files[index];
  if (!file) throw new EditRequestError(404, 'EDIT_FILE_NOT_FOUND', 'The job has no such file.');
  if (job.state !== 'uploading') throw new EditRequestError(409, 'EDIT_NOT_UPLOADING', 'The job no longer takes files.');
  if (file.received || file.receiving) throw new EditRequestError(409, 'EDIT_FILE_RECEIVED', 'This file has already been received or is being received.');
  file.receiving = true;
  let received;
  const upload = new Promise((resolve) => { received = resolve; });
  job.uploads.add(upload);
  const scratch = path.join(job.dir, `in-${String(file.index).padStart(3, '0')}.part`);
  const hash = createHash('sha256');
  const head = [];
  let bytes = 0;
  // Counts, hashes and keeps the first bytes of what passes; refuses more than the manifest's size.
  const meter = new Transform({
    transform(chunk, encoding, done) {
      bytes += chunk.length;
      if (bytes > file.size) return done(new EditRequestError(400, 'EDIT_FILE_MISMATCH', 'The file is larger than its manifest says.'));
      if (bytes - chunk.length < HEAD_BYTES) head.push(chunk.subarray(0, HEAD_BYTES));
      hash.update(chunk);
      return done(null, chunk);
    },
  });
  try {
    // receiving makes this the only writer of the scratch name; a refused try's leftover is overwritten. The pipeline
    // carries any stream's error (a full disk, the caller leaving, the job stopped) to here and closes the others.
    await pipeline(request, meter, createWriteStream(scratch, { flags: 'w' }), { signal: job.controller.signal });
    if (bytes !== file.size || hash.digest('hex') !== file.sha256) throw new EditRequestError(400, 'EDIT_FILE_MISMATCH', 'The file does not match its size and sha256.');
    const format = sniffFormat(Buffer.concat(head).subarray(0, HEAD_BYTES));
    if (!format) {
      throw new EditRequestError(400, 'EDIT_FILE_UNSUPPORTED', `${file.name} is not a file an edit takes (MP4, MOV, WebM, MP3, WAV, Ogg, FLAC, PNG, JPEG, WebP or GIF).`);
    }
    const final = path.join(job.dir, `in-${String(file.index).padStart(3, '0')}.${format.ext}`);
    await rename(scratch, final);
    Object.assign(file, { path: final, format, received: true });
  } catch (error) {
    await unlink(scratch).catch(() => {});
    if (job.controller.signal.aborted) throw new EditRequestError(409, 'EDIT_STOPPED', 'The job was stopped.');
    if (error instanceof EditRequestError) throw error;
    throw new EditRequestError(500, 'EDIT_UPLOAD_FAILED', 'The file could not be received.');
  } finally {
    file.receiving = false;
    job.uploads.delete(upload);
    received();
  }
}

function classify(error, job, timedOut) {
  if (job.controller.signal.aborted) return new EditError(timedOut ? 'timeout' : 'aborted', timedOut ? 'The edit took too long' : 'The edit was stopped');
  if (error instanceof EditError || error?.code === 'INVALID_EDIT') return error;
  return new EditError('edit_failed', 'The edit failed');
}

/** Renders the job once all its files are in; resolves its {report, outputs} or rejects with EditError/INVALID_EDIT. */
export async function renderJob(job, config, { log, run = runEdit } = {}) {
  const missing = job.files.filter((file) => !file.received).map((file) => file.index);
  if (job.state !== 'uploading') throw new EditRequestError(409, 'EDIT_NOT_UPLOADING', 'The job has already been rendered or stopped.');
  if (missing.length) throw new EditRequestError(409, 'EDIT_FILES_MISSING', 'Some files have not been received.', { missing: missing.slice(0, 50) });
  job.state = 'rendering';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; job.controller.abort(); }, Math.max(1, config.editTimeoutMs));
  const state = {
    signal: job.controller.signal, warnings: [], limits: job.limits,
    halted: () => job.controller.signal.aborted,
    stopped: () => new EditError(timedOut ? 'timeout' : 'aborted', timedOut ? 'The edit took too long' : 'The edit was stopped'),
    log: (message) => log(`edit ${job.editId}: ${String(message).replace(/[\r\n]+/g, ' | ')}`),
  };
  let settle;
  job.settled = new Promise((resolve) => { settle = resolve; });
  try {
    job.result = await run(job, config, state);
    job.state = 'done';
    return job.result;
  } catch (error) {
    job.state = 'failed';
    if (!(error instanceof EditError) && error?.code !== 'INVALID_EDIT') state.log(`failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`);
    throw classify(error, job, timedOut);
  } finally {
    clearTimeout(timer);
    settle();
  }
}

/** The output named `name` of a rendered job, as {path, size, contentType}. */
export function jobOutput(job, name) {
  if (job.state !== 'done') throw new EditRequestError(409, 'EDIT_NOT_DONE', 'The job has no outputs yet.');
  const output = job.result.outputs.find((entry) => entry.name === name);
  if (!output) throw new EditRequestError(404, 'EDIT_OUTPUT_NOT_FOUND', 'The job has no such output.');
  return output;
}

export function streamOutput(output) {
  return createReadStream(output.path);
}

async function removeDir(dir, log) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (attempt === 5) log?.(`could not remove ${path.basename(dir)}: ${error.code ?? error.message}`);
      await delay(200 * attempt);
    }
  }
  return false;
}

/** Stops the job, waits (up to 30 s) for its uploads and a render in progress to end, and removes its directory. */
export async function removeJob(job, log) {
  clearTimeout(job.idleTimer);
  job.controller.abort();
  const ending = [...job.uploads, ...(job.state === 'rendering' && job.settled ? [job.settled] : [])];
  if (ending.length) await Promise.race([Promise.all(ending), delay(SETTLE_WAIT_MS)]);
  job.state = 'removed';
  await removeDir(job.dir, log);
}

/** What a reply may show of the job's outputs (never the paths on the worker's disk). */
export function publicOutputs(outputs) {
  return outputs.map(({ name, kind, contentType, size, sha256 }) => ({ name, kind, contentType, size, sha256 }));
}

/** At startup no job or render runs: what a stopped worker left in its temporary root is removed. */
export async function sweepStale(config, log) {
  let names = [];
  try {
    names = await readdir(config.tmp);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^awwo-(edit|render)-[A-Za-z0-9]{6}$/.test(name)) continue;
    if (await removeDir(path.join(config.tmp, name), log)) removed += 1;
  }
  return removed;
}
