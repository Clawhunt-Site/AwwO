// One analysis: probe the video, run rea-video on it (decompose, then summary, then review) and collect what it wrote.
// rea-video runs as its own program with only the environment childEnv names: its models from the read-only
// AWWO_ANALYSIS_MODELS, its memory of corrections and preferences inside the job's own directory (so nothing one
// workspace's video taught it reaches another's), no VLM settings (the worker has no network and holds no provider
// key) and no shell. Its outputs name the job's directory in places; every text output is rewritten without it, so no
// reply or file shows a path on the worker's disk.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from './config.mjs';
import { runChild } from './children.mjs';

export class AnalysisError extends Error {
  constructor(detail, message, status = 422, extra = {}) {
    super(message);
    Object.assign(this, { detail, status, ...extra });
  }
}

const ASF_GUID = Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex');

/** The container of a video from its first bytes, or null: MP4/MOV/M4V, WebM/MKV, AVI, FLV and WMV are taken. */
export function sniffVideo(head) {
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') return { ext: head.toString('latin1', 8, 10) === 'qt' ? 'mov' : 'mp4' };
  if (head.length >= 8 && ['moov', 'mdat', 'wide', 'free', 'skip'].includes(head.toString('latin1', 4, 8))) return { ext: 'mov' };
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return { ext: 'mkv' };
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'AVI ') return { ext: 'avi' };
  if (head.length >= 3 && head.toString('latin1', 0, 3) === 'FLV') return { ext: 'flv' };
  if (head.length >= 16 && head.subarray(0, 16).equals(ASF_GUID)) return { ext: 'wmv' };
  return null;
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Whether every model rea-video loads is in config.models with its pinned sha256 (read once, at startup). */
export async function verifyModels(config) {
  if (!config.models) return false;
  for (const model of config.modelFiles) {
    try {
      if ((await sha256File(path.join(config.models, model.name))) !== model.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The only environment rea-video and ffprobe get. */
export function childEnv(config, job) {
  const home = path.join(job.dir, 'home');
  const threads = String(config.threads);
  return {
    PATH: config.path, HOME: home, TMPDIR: path.join(job.dir, 'tmp'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
    REA_VIDEO_HOME: path.join(home, 'rea-video'),
    ...(config.models ? { REA_VIDEO_MODELS: config.models } : {}),
    OMP_NUM_THREADS: threads, OPENBLAS_NUM_THREADS: threads, MKL_NUM_THREADS: threads,
  };
}

/** The video's length and size from ffprobe; refuses one without a picture, too long or too large. */
export async function probeVideo(config, job, state) {
  const result = await runChild(config.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', job.file.path], {
    cwd: job.dir, env: childEnv(config, job), signal: state.signal, timeoutMs: 60_000, maxStdoutBytes: 256 * 1024,
  });
  if (state.halted()) throw state.stopped();
  let info;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    info = null;
  }
  if (result.code !== 0 || !info) {
    state.log(`ffprobe failed (${result.code ?? result.signal}): ${result.stderr.split('\n').slice(-3).join(' | ')}`);
    throw new AnalysisError('probe_failed', 'The video could not be read.', 400, { field: 'file' });
  }
  const video = (info.streams ?? []).find((stream) => stream.codec_type === 'video');
  if (!video) throw new AnalysisError('no_video', 'The file has no picture.', 400, { field: 'file' });
  const seconds = Number(info.format?.duration);
  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new AnalysisError('probe_failed', 'The video has no readable length.', 400, { field: 'file' });
  if (seconds > config.maxSeconds) throw new AnalysisError('too_long', `The video is ${Math.round(seconds)} s long; at most ${config.maxSeconds} s are analysed.`, 400, { field: 'file' });
  if (!(width > 0 && height > 0) || Math.max(width, height) > config.maxSide) {
    throw new AnalysisError('too_large', `The picture is ${width}x${height}; at most ${config.maxSide} pixels a side are analysed.`, 400, { field: 'file' });
  }
  return { seconds, width, height, sound: (info.streams ?? []).some((stream) => stream.codec_type === 'audio') };
}

export function decomposeArgs(input, out, options) {
  const args = ['decompose', input, '-o', out, '--lang', options.lang];
  if (!options.ocr) args.push('--no-ocr');
  else if (options.ocrLang === 'ja') args.push('--ocr-lang', 'ja');
  if (!options.packaging) args.push('--no-packaging');
  return args;
}

const TEXT_TYPES = Object.freeze({ '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.srt': 'application/x-subrip', '.ass': 'text/x-ssa; charset=utf-8', '.txt': 'text/plain; charset=utf-8' });
const BINARY_TYPES = Object.freeze({ '.jpg': 'image/jpeg', '.png': 'image/png', '.wav': 'audio/wav' });
const OUTPUT_NAME = /^(?:(shots|packaging|stems)\/)?[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/;
const TOP_LEVEL = new Set(['breakdown.json', 'report.html', 'report.md', 'storyboard.jpg', 'audio.png', 'review_tasks.json', 'review_answers.json', 'summary.txt']);

/** Which of rea-video's files a caller gets: the report files, shot sheets, packaging files and, when asked, the stems. */
export function outputWanted(name, options) {
  const match = OUTPUT_NAME.exec(name);
  if (!match) return false;
  const ext = path.extname(name).toLowerCase();
  if (!TEXT_TYPES[ext] && !BINARY_TYPES[ext]) return false;
  if (!match[1]) return TOP_LEVEL.has(name);
  if (match[1] === 'shots') return ext === '.jpg';
  if (match[1] === 'packaging') return ['.srt', '.ass', '.json', '.jpg', '.png'].includes(ext);
  return options.stems && ext === '.wav';
}

/** text without the job directory's path: an output's path becomes its output name, the input's input.<ext>. */
export function scrubText(text, dir) {
  if (!text.includes(dir)) return text;
  const out = path.join(dir, 'out');
  return text.split(`${out}${path.sep}`).join('').split(`${dir}${path.sep}`).join('').split(out).join('.').split(dir).join('.');
}

/** Rewrites a text output without the job directory's path. */
export async function scrubFile(file, dir) {
  const text = await readFile(file, 'utf8');
  const clean = scrubText(text, dir);
  if (clean !== text) await writeFile(file, clean, 'utf8');
}

async function listFiles(root) {
  const names = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile()) names.push(entry.name);
    else if (entry.isDirectory() && ['shots', 'packaging', 'stems'].includes(entry.name)) {
      for (const inner of await readdir(path.join(root, entry.name), { withFileTypes: true })) {
        if (inner.isFile()) names.push(`${entry.name}/${inner.name}`);
      }
    }
  }
  return names.sort();
}

/** The outputs a caller may fetch, each scrubbed (text) and described: name, kind, contentType, size, sha256. */
export async function collectOutputs(out, dir, options) {
  const outputs = [];
  let total = 0;
  for (const name of await listFiles(out)) {
    if (!outputWanted(name, options)) continue;
    const file = path.join(out, ...name.split('/'));
    const ext = path.extname(name).toLowerCase();
    if (TEXT_TYPES[ext]) await scrubFile(file, dir);
    const { size } = await stat(file);
    total += size;
    if (outputs.length >= LIMITS.maxOutputs || total > LIMITS.maxOutputBytes) {
      throw new AnalysisError('output_too_large', 'The analysis wrote more files than a reply may carry.');
    }
    const kind = name.includes('/') ? name.split('/')[0] : path.basename(name, ext);
    outputs.push({ name, kind, contentType: TEXT_TYPES[ext] ?? BINARY_TYPES[ext], size, sha256: await sha256File(file), path: file });
  }
  return outputs;
}

/** The public part of breakdown.json: what a node shows and the API keeps, never a path or the whole document. */
export function publicReport(breakdown, probe, options, warnings) {
  const summary = breakdown.summary ?? {};
  const source = breakdown.source ?? {};
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const text = (value, limit = 2000) => (typeof value === 'string' ? value.slice(0, limit) : null);
  return {
    schema: text(breakdown.schema, 80), tool: { name: text(breakdown.tool?.name, 40), version: text(breakdown.tool?.version, 40) },
    lang: options.lang,
    video: { seconds: number(source.duration) ?? probe.seconds, width: number(source.width) ?? probe.width, height: number(source.height) ?? probe.height,
      fps: number(source.fps), aspect: text(source.aspect_ratio, 20), sound: typeof source.has_audio === 'boolean' ? source.has_audio : probe.sound },
    verdict: text(summary.verdict), shots: number(summary.shots), confidence: number(summary.confidence), averageShotSeconds: number(summary.avg_shot_s),
    production: text(summary.production), vlm: 'off', warnings,
  };
}

/** Runs the job's analysis; resolves {report, summary, outputs} or rejects with AnalysisError (or state.stopped()). */
export async function runAnalysis(job, config, state) {
  const out = path.join(job.dir, 'out');
  await mkdir(path.join(job.dir, 'home', 'rea-video'), { recursive: true });
  await mkdir(path.join(job.dir, 'tmp'), { recursive: true });
  const probe = await probeVideo(config, job, state);
  const env = childEnv(config, job);
  const left = () => Math.max(1, state.deadline - Date.now());
  const warnings = [];

  const decompose = await runChild(config.rea, decomposeArgs(job.file.path, out, job.options), { cwd: job.dir, env, signal: state.signal, timeoutMs: left() });
  if (state.halted()) throw state.stopped();
  if (decompose.timedOut) throw new AnalysisError('timeout', 'The analysis took too long.');
  if (decompose.code !== 0) {
    state.log(`rea-video decompose exited ${decompose.code ?? decompose.signal}: ${decompose.stderr.split('\n').slice(-6).join(' | ')}`);
    throw new AnalysisError('analysis_failed', 'The video could not be analysed.');
  }
  let breakdown;
  try {
    breakdown = JSON.parse(await readFile(path.join(out, 'breakdown.json'), 'utf8'));
  } catch {
    throw new AnalysisError('analysis_failed', 'The analysis wrote no readable breakdown.');
  }
  if (typeof breakdown?.schema !== 'string' || !breakdown.schema.startsWith('rea_video.breakdown.')) {
    throw new AnalysisError('analysis_failed', 'The analysis wrote a breakdown of an unknown schema.');
  }

  const summaryRun = await runChild(config.rea, ['summary', path.join(out, 'breakdown.json')], { cwd: job.dir, env, signal: state.signal, timeoutMs: Math.min(left(), 120_000), maxStdoutBytes: LIMITS.maxSummaryBytes });
  if (state.halted()) throw state.stopped();
  let summary = null;
  if (summaryRun.code === 0) {
    summary = scrubText(summaryRun.stdout, job.dir);
    if (summaryRun.stdoutTruncated) warnings.push('summary_truncated');
    await writeFile(path.join(out, 'summary.txt'), summary, 'utf8');
  } else {
    warnings.push('summary_failed');
  }

  if (job.options.review) {
    const review = await runChild(config.rea, ['review', out], { cwd: job.dir, env, signal: state.signal, timeoutMs: Math.min(left(), 300_000), maxStdoutBytes: 64 * 1024 });
    if (state.halted()) throw state.stopped();
    if (review.code !== 0) warnings.push('review_failed');
  }

  const outputs = await collectOutputs(out, job.dir, job.options);
  return { report: publicReport(breakdown, probe, job.options, warnings), summary, outputs };
}
