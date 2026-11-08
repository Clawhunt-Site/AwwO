// An analysis job's life on the worker, as an edit job's on the render worker (apps/render-worker/edit-jobs.mjs):
// created from its manifest (config.mjs validateAnalysisRequest), its one video streamed in (size and sha256 checked
// as it arrives, the container sniffed from the bytes), analysed once (analysis-run.mjs), its outputs read back, then
// removed by the API's DELETE or after config.idleMs without a request. Only the job's own directory is written or
// removed; at startup, what a stopped worker left is removed.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rename, rm, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AnalysisError, runAnalysis, sniffVideo } from './analysis-run.mjs';

const HEAD_BYTES = 64;
const SETTLE_WAIT_MS = 30_000;
const JOB_DIR = /^awwo-analysis-[A-Za-z0-9]{6}$/;

export class AnalysisRequestError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, ...extra });
  }
}

async function roomFor(root, need) {
  try {
    const info = await statfs(root);
    // The video, the stems rea-video writes (about 10 MB a minute each) and its frames: three times the video, 2 GiB spare.
    return Number(info.bavail) * Number(info.bsize) - need * 3 >= 2 * 1024 ** 3;
  } catch {
    return true;
  }
}

export async function createJob(manifest, config) {
  if (!(await roomFor(config.tmp, manifest.file.size))) {
    throw new AnalysisRequestError(503, 'ANALYSIS_UNAVAILABLE', 'Not enough free disk space for the analysis', { detail: 'disk_full' });
  }
  let dir;
  try {
    dir = await mkdtemp(path.join(config.tmp, 'awwo-analysis-'));
  } catch {
    throw new AnalysisRequestError(503, 'ANALYSIS_UNAVAILABLE', 'No temporary space for the analysis', { detail: 'tmp_unavailable' });
  }
  return {
    kind: 'analysis', analysisId: manifest.analysisId, dir, options: manifest.options,
    file: { ...manifest.file, path: null, received: false, receiving: false },
    state: 'uploading', result: null, controller: new AbortController(), requests: 0, idleTimer: null, settled: null, uploads: new Set(),
  };
}

/** Streams the job's video to a scratch name, checks it, and only then names it input.<ext>. */
export async function receiveFile(job, request) {
  const file = job.file;
  if (job.state !== 'uploading') throw new AnalysisRequestError(409, 'ANALYSIS_NOT_UPLOADING', 'The job no longer takes its file.');
  if (file.received || file.receiving) throw new AnalysisRequestError(409, 'ANALYSIS_FILE_RECEIVED', 'The file has already been received or is being received.');
  file.receiving = true;
  let received;
  const upload = new Promise((resolve) => { received = resolve; });
  job.uploads.add(upload);
  const scratch = path.join(job.dir, 'input.part');
  const hash = createHash('sha256');
  const head = [];
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, encoding, done) {
      bytes += chunk.length;
      if (bytes > file.size) return done(new AnalysisRequestError(400, 'ANALYSIS_FILE_MISMATCH', 'The file is larger than its manifest says.'));
      if (bytes - chunk.length < HEAD_BYTES) head.push(chunk.subarray(0, HEAD_BYTES));
      hash.update(chunk);
      return done(null, chunk);
    },
  });
  try {
    await pipeline(request, meter, createWriteStream(scratch, { flags: 'w' }), { signal: job.controller.signal });
    if (bytes !== file.size || hash.digest('hex') !== file.sha256) throw new AnalysisRequestError(400, 'ANALYSIS_FILE_MISMATCH', 'The file does not match its size and sha256.');
    const format = sniffVideo(Buffer.concat(head).subarray(0, HEAD_BYTES));
    if (!format) throw new AnalysisRequestError(400, 'ANALYSIS_FILE_UNSUPPORTED', 'The file is not a video the analysis takes (MP4, MOV, WebM, MKV, AVI, FLV or WMV).');
    const final = path.join(job.dir, `input.${format.ext}`);
    await rename(scratch, final);
    Object.assign(file, { path: final, received: true });
  } catch (error) {
    await unlink(scratch).catch(() => {});
    if (job.controller.signal.aborted) throw new AnalysisRequestError(409, 'ANALYSIS_STOPPED', 'The job was stopped.');
    if (error instanceof AnalysisRequestError) throw error;
    throw new AnalysisRequestError(500, 'ANALYSIS_UPLOAD_FAILED', 'The file could not be received.');
  } finally {
    file.receiving = false;
    job.uploads.delete(upload);
    received();
  }
}

/** Analyses the job once its file is in; resolves its {report, summary, outputs}. */
export async function analyseJob(job, config, { log, run = runAnalysis } = {}) {
  if (job.state !== 'uploading') throw new AnalysisRequestError(409, 'ANALYSIS_NOT_UPLOADING', 'The job has already been analysed or stopped.');
  if (!job.file.received) throw new AnalysisRequestError(409, 'ANALYSIS_FILE_MISSING', 'The file has not been received.');
  job.state = 'analysing';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; job.controller.abort(); }, Math.max(1, config.timeoutMs));
  const stopped = () => new AnalysisError(timedOut ? 'timeout' : 'aborted', timedOut ? 'The analysis took too long.' : 'The analysis was stopped.');
  const state = {
    signal: job.controller.signal, deadline: Date.now() + config.timeoutMs, halted: () => job.controller.signal.aborted, stopped,
    log: (message) => log?.(`analysis ${job.analysisId}: ${String(message).replace(/[\r\n]+/g, ' | ')}`),
  };
  let settle;
  job.settled = new Promise((resolve) => { settle = resolve; });
  try {
    job.result = await run(job, config, state);
    job.state = 'done';
    return job.result;
  } catch (error) {
    job.state = 'failed';
    if (job.controller.signal.aborted) throw stopped();
    if (error instanceof AnalysisError) throw error;
    state.log(`failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 300)}`);
    throw new AnalysisError('analysis_failed', 'The analysis failed.');
  } finally {
    clearTimeout(timer);
    settle();
  }
}

export function jobOutput(job, name) {
  if (job.state !== 'done') throw new AnalysisRequestError(409, 'ANALYSIS_NOT_DONE', 'The job has no outputs yet.');
  const output = job.result.outputs.find((entry) => entry.name === name);
  if (!output) throw new AnalysisRequestError(404, 'ANALYSIS_OUTPUT_NOT_FOUND', 'The job has no such output.');
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

/** Stops the job, waits (up to 30 s) for its upload and an analysis in progress to end, and removes its directory. */
export async function removeJob(job, log) {
  clearTimeout(job.idleTimer);
  job.controller.abort();
  const ending = [...job.uploads, ...(job.state === 'analysing' && job.settled ? [job.settled] : [])];
  if (ending.length) await Promise.race([Promise.all(ending), delay(SETTLE_WAIT_MS)]);
  job.state = 'removed';
  await removeDir(job.dir, log);
}

/** What a reply may show of the outputs (never the paths on the worker's disk). */
export function publicOutputs(outputs) {
  return outputs.map(({ name, kind, contentType, size, sha256 }) => ({ name, kind, contentType, size, sha256 }));
}

export async function sweepStale(config, log) {
  let names = [];
  try {
    names = await readdir(config.tmp);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (JOB_DIR.test(name) && (await removeDir(path.join(config.tmp, name), log))) removed += 1;
  }
  return removed;
}
