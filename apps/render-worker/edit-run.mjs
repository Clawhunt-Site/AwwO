// One edit: probe the job's files (each opened as the container its bytes show), place the timeline on the film's
// frames (edit-timeline.mjs), render its cards with the page renderer, encode the picture's pieces and join them by
// stream copy, mix the sound (one stem per track), mux, then the stills, the subtitles and a report. Every child is
// ffmpeg or ffprobe (edit-ffmpeg.mjs), run without a shell, with the allowlisted environment, at a lower CPU priority
// than the API, and killed when the edit stops. Free space is checked before each heavy step and every intermediate
// file is removed as soon as the next step has used it.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BATCH_INPUTS, MP4, batchArgs, combineArgs, concatArgs, concatList, inputProbeArgs, loudnessArgs, muxArgs, normalizeArgs,
  packetCountArgs, parseInputProbe, parseLoudness, parsePacketCount, silenceArgs, sourceMatrix, spanArgs, srt, stillsArgs, transitionArgs,
} from './edit-ffmpeg.mjs';
import { EDIT_LIMITS, placeTimeline } from './edit-timeline.mjs';
import { runProcess } from './ffmpeg.mjs';
import { renderPage } from './render.mjs';

const TRACK_ORDER = Object.freeze(['dialogue', 'clip', 'music', 'sfx']);
const CHILD_PRIORITY = 10;
const GIB = 1024 ** 3;
// A stereo float stem of the film's length (48 kHz × 2 channels × 4 bytes a second), and a generous film rate.
const STEM_BYTES_PER_SECOND = 48000 * 2 * 4;
const FILM_BYTES_PER_SECOND = 2_000_000;

/** An edit that did not produce a film: 422 EDIT_FAILED with a detail, or 503 when the worker itself cannot. */
export class EditError extends Error {
  constructor(detail, message, status = 422) {
    super(message);
    this.status = status;
    this.code = status === 503 ? 'EDIT_UNAVAILABLE' : 'EDIT_FAILED';
    this.detail = detail;
  }
}

function invalidFile(name, message) {
  return Object.assign(new Error(`${name} ${message}`), { status: 400, code: 'INVALID_EDIT', field: 'files' });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** Runs ffmpeg/ffprobe below the API's priority; a failure keeps its step's name and stderr tail for the log. */
function makeRunner(config, state) {
  return async (step, command, args) => {
    if (state.halted()) throw state.stopped();
    const running = runProcess(command, args, { signal: state.signal });
    if (running.child?.pid) {
      try { os.setPriority(running.child.pid, CHILD_PRIORITY); } catch { /* not permitted: keep the default */ }
    }
    try {
      return await running;
    } catch (error) {
      if (state.halted()) throw state.stopped();
      // An argument list past the system's limit for one argument (a filter graph of thousands of windows).
      if (/E2BIG/.test(String(error?.message))) throw new EditError('graph_too_large', `The ${step} step is too large to run`);
      if (error?.code === 'PROCESS_SPAWN_FAILED') throw new EditError('ffmpeg_unavailable', 'ffmpeg could not be started', 503);
      state.log(`${step}: ${error.message} ${String(error.stderr ?? '').slice(-400)}`);
      throw new EditError(`${step}_failed`, `ffmpeg failed at ${step}`);
    }
  };
}

/** Refuses the next step unless the job's disk keeps `need` bytes free beyond a 1 GiB floor. */
async function ensureSpace(dir, need) {
  let free;
  try {
    const info = await statfs(dir);
    free = Number(info.bavail) * Number(info.bsize);
  } catch {
    return; // unknown: the step itself fails if the disk is full
  }
  if (free - need < GIB) throw new EditError('disk_full', 'Not enough free disk space for the edit', 503);
}

async function probeFiles(job, config, run) {
  const probes = new Map();
  for (const file of job.files) {
    const { stdout } = await run('probe', config.ffprobe, inputProbeArgs(file.path, file.format));
    let probe;
    try {
      probe = parseInputProbe(stdout, { still: Boolean(file.format.still) });
    } catch {
      throw invalidFile(file.name, 'is not a media file ffmpeg can read');
    }
    if (probe.video && (probe.video.width > EDIT_LIMITS.maxInputSide || probe.video.height > EDIT_LIMITS.maxInputSide)) {
      throw invalidFile(file.name, `is larger than ${EDIT_LIMITS.maxInputSide} pixels on a side`);
    }
    if (!probe.still && probe.duration > EDIT_LIMITS.maxInputSeconds) throw invalidFile(file.name, 'is longer than 4 hours');
    probes.set(file.name, { ...probe, size: file.size });
  }
  return probes;
}

/** Each card rendered by the page renderer at the film's size and rate. */
async function renderCards(plan, job, config, state) {
  const files = new Map();
  for (const [index, item] of plan.items.entries()) {
    if (item.kind !== 'card') continue;
    const request = {
      renderId: `${job.editId.slice(0, 60)}-card${index}`, html: item.html, width: plan.output.width, height: plan.output.height,
      fps: plan.output.fps, seconds: item.frames / plan.output.fps, frames: item.frames, loop: false, outputs: ['mp4'], stills: [],
    };
    let reply;
    try {
      reply = await renderPage(request, config, { signal: state.signal, log: state.log });
    } catch (error) {
      if (state.halted()) throw state.stopped();
      throw new EditError(error?.status === 503 ? 'browser_unavailable' : 'card_failed', `Card ${item.id} could not be rendered`, error?.status === 503 ? 503 : 422);
    }
    const file = path.join(job.dir, `card-${String(index).padStart(3, '0')}.mp4`);
    await writeFile(file, Buffer.from(reply.outputs[0].data, 'base64'));
    if (reply.pageErrors.length) state.warnings.push(`card_page_errors:${item.id}`);
    files.set(index, file);
  }
  return files;
}

/** Where a piece reads an item from: a card's MP4, or a clip's file at its time, its measured picture stream and matrix. */
function pieceSource(plan, job, cards, probes, index, from) {
  const item = plan.items[index];
  if (item.kind === 'card') {
    return { source: cards.get(index), format: MP4, stream: 'v:0', matrix: sourceMatrix({ format: MP4, card: true }), start: from / plan.output.fps };
  }
  const file = job.byName.get(item.source);
  const { video } = probes.get(item.source);
  return { source: file.path, format: file.format, stream: String(video.index), matrix: sourceMatrix({ format: file.format, video }), start: item.in + from / plan.output.fps };
}

/** Encodes every piece, checks its frame count, joins them into the silent picture and removes the pieces. */
async function encodePicture(plan, job, cards, probes, config, run) {
  await ensureSpace(job.dir, 2.2 * plan.seconds * FILM_BYTES_PER_SECOND);
  const names = [];
  for (const [index, piece] of plan.pieces.entries()) {
    const name = `piece-${String(index).padStart(4, '0')}.mp4`;
    const file = path.join(job.dir, name);
    const args = piece.type === 'span'
      ? spanArgs({ ...pieceSource(plan, job, cards, probes, piece.item, piece.from), frames: piece.frames, output: plan.output, file })
      : transitionArgs({ a: pieceSource(plan, job, cards, probes, piece.a.item, piece.a.from), b: pieceSource(plan, job, cards, probes, piece.b.item, piece.b.from),
        frames: piece.frames, kind: piece.kind, output: plan.output, file });
    await run('picture', config.ffmpeg, args);
    const counted = parsePacketCount((await run('picture_check', config.ffprobe, packetCountArgs(file))).stdout);
    if (counted.frames !== piece.frames) throw new EditError('picture_frames', `Piece ${index} has ${counted.frames} frames, not ${piece.frames}`);
    names.push(name);
  }
  const list = path.join(job.dir, 'pieces.ffconcat');
  await writeFile(list, concatList(names));
  const picture = path.join(job.dir, 'picture.mp4');
  await run('join', config.ffmpeg, concatArgs({ list, file: picture }));
  await Promise.all([...names.map((name) => rm(path.join(job.dir, name), { force: true })), ...[...cards.values()].map((file) => rm(file, { force: true }))]);
  return picture;
}

/** The loudness of every file a levelled track uses, measured once per file. */
async function measureLevels(plan, job, probes, config, run, warnings) {
  const gains = new Map();
  if (!plan.levels) return gains;
  for (const name of new Set(plan.audio.filter((entry) => plan.levels[entry.track] !== undefined).map((entry) => entry.source))) {
    const file = job.byName.get(name);
    const stream = String(probes.get(name).audio.index);
    const measured = parseLoudness((await run('levels', config.ffmpeg, loudnessArgs({ input: file.path, format: file.format, stream }))).stderr);
    if (!Number.isFinite(measured.i) || measured.i < -70) { warnings.push(`level_unmeasured:${name}`); continue; }
    gains.set(name, measured.i);
  }
  return gains;
}

function levelled(entry, plan, measured) {
  const target = plan.levels?.[entry.track];
  const loudness = measured.get(entry.source);
  if (target === undefined || loudness === undefined) return entry.gainDb;
  return entry.gainDb + Math.max(-30, Math.min(30, target - loudness));
}

/** One track's sounds summed into its one stem, batch by batch (each batch also takes the stem so far). */
async function trackStem(track, entries, plan, job, config, run) {
  let stem = null;
  for (let offset = 0; offset < entries.length; offset += BATCH_INPUTS) {
    const file = path.join(job.dir, `stem-${track}-${offset / BATCH_INPUTS}.wav`);
    await run('sound', config.ffmpeg, batchArgs({ entries: entries.slice(offset, offset + BATCH_INPUTS), previous: stem, seconds: plan.seconds, file }));
    if (stem) await rm(stem, { force: true });
    stem = file;
  }
  return stem;
}

/** Every track's stem, then the mix of the stems (music and sfx ducked and muted); the stems are removed after. */
async function mixSound(plan, job, probes, config, run, warnings) {
  await ensureSpace(job.dir, 6 * plan.seconds * STEM_BYTES_PER_SECOND);
  const measured = await measureLevels(plan, job, probes, config, run, warnings);
  const stems = [];
  for (const track of TRACK_ORDER) {
    const entries = plan.audio.filter((entry) => entry.track === track).map((entry) => {
      const file = job.byName.get(entry.source);
      return { ...entry, gainDb: levelled(entry, plan, measured), file: file.path, format: file.format, stream: String(probes.get(entry.source).audio.index) };
    });
    if (entries.length) stems.push({ track, file: await trackStem(track, entries, plan, job, config, run) });
  }
  const premix = path.join(job.dir, 'premix.wav');
  if (stems.length === 0) {
    await run('sound', config.ffmpeg, silenceArgs({ seconds: plan.seconds, file: premix }));
    return { file: premix, silent: true };
  }
  await run('mix', config.ffmpeg, combineArgs({ stems, windows: plan.dialogueWindows, ducking: plan.ducking, silence: plan.silence, seconds: plan.seconds, file: premix }));
  await Promise.all(stems.map((stem) => rm(stem.file, { force: true })));
  return { file: premix, silent: false };
}

/** Two-pass loudness to the film's target; a silent mix is left as it is. */
async function normalizeSound(plan, job, mix, config, run, warnings) {
  if (mix.silent) return { file: mix.file, loudness: null };
  const target = { targetLUFS: plan.output.loudnessLUFS, truePeakDb: plan.output.truePeakDb };
  const first = parseLoudness((await run('loudness', config.ffmpeg, loudnessArgs({ input: mix.file, ...target }))).stderr);
  if (!Number.isFinite(first.i) || first.i < -70) {
    warnings.push('silent_mix');
    return { file: mix.file, loudness: null };
  }
  const file = path.join(job.dir, 'mix.wav');
  await run('loudness', config.ffmpeg, normalizeArgs({ input: mix.file, measured: first, ...target, seconds: plan.seconds, file }));
  await rm(mix.file, { force: true });
  const final = parseLoudness((await run('loudness_check', config.ffmpeg, loudnessArgs({ input: file, ...target }))).stderr);
  return { file, loudness: { integratedLUFS: final.i, truePeakDb: final.tp, rangeLU: final.lra } };
}

async function describe(file, kind, contentType) {
  const info = await stat(file);
  return { name: path.basename(file), kind, contentType, path: file, size: info.size, sha256: await sha256File(file) };
}

async function finishOutputs(plan, job, film, config, run) {
  const outputs = [await describe(film, 'video', 'video/mp4')];
  if (plan.subtitles.length) {
    const file = path.join(job.dir, 'out', `${plan.name}.srt`);
    await writeFile(file, srt(plan.subtitles), 'utf8');
    outputs.push(await describe(file, 'subtitles', 'application/x-subrip'));
  }
  const every = plan.output.stillsEverySeconds;
  if (every > 0) {
    const max = Math.min(EDIT_LIMITS.maxStills, Math.max(1, Math.ceil(plan.seconds / every)));
    await run('stills', config.ffmpeg, stillsArgs({ input: film, every, max, pattern: path.join(job.dir, 'out', 'still-%03d.jpg') }));
    const stills = (await readdir(path.join(job.dir, 'out'))).filter((name) => /^still-\d{3}\.jpg$/.test(name)).sort();
    for (const name of stills) outputs.push(await describe(path.join(job.dir, 'out', name), 'still', 'image/jpeg'));
  }
  return outputs;
}

function counts(plan) {
  return {
    video: plan.items.filter((item) => item.kind === 'clip').length, cards: plan.items.filter((item) => item.kind === 'card').length,
    transitions: plan.pieces.filter((piece) => piece.type === 'transition').length,
    dialogue: plan.audio.filter((entry) => entry.track === 'dialogue').length, music: plan.audio.filter((entry) => entry.track === 'music').length,
    sfx: plan.audio.filter((entry) => entry.track === 'sfx').length, clipSound: plan.audio.filter((entry) => entry.track === 'clip').length,
    subtitles: plan.subtitles.length,
  };
}

/** Renders one job whose files are all on disk: {report, outputs: [{name, kind, contentType, path, size, sha256}]}. */
export async function runEdit(job, config, state) {
  const started = Date.now();
  const run = makeRunner(config, state);
  const probes = await probeFiles(job, config, run);
  const plan = placeTimeline(job.timeline, probes, { maxSeconds: config.editMaxSeconds, maxFilmBytes: job.limits?.maxFilmBytes ?? null });
  state.warnings.push(...plan.warnings);
  const cards = await renderCards(plan, job, config, state);
  const picture = await encodePicture(plan, job, cards, probes, config, run);
  const mix = await normalizeSound(plan, job, await mixSound(plan, job, probes, config, run, state.warnings), config, run, state.warnings);
  const film = path.join(job.dir, 'out', `${plan.name}.mp4`);
  await ensureSpace(job.dir, plan.seconds * FILM_BYTES_PER_SECOND);
  await run('mux', config.ffmpeg, muxArgs({ video: picture, audio: mix.file, file: film }));
  await Promise.all([rm(picture, { force: true }), rm(mix.file, { force: true })]);
  const probe = parsePacketCount((await run('check', config.ffprobe, packetCountArgs(film))).stdout);
  if (probe.frames !== plan.frames) throw new EditError('film_frames', `The film has ${probe.frames} frames, not ${plan.frames}`);
  // The rate cap keeps a film under the API's limit; one that is over it all the same is refused here, before its stills.
  const cap = job.limits?.maxFilmBytes;
  if (cap && probe.size > cap) {
    throw new EditError('film_too_large', `The film is ${probe.size} bytes, more than the ${cap} the API stores: a higher crf or a smaller frame makes it smaller`);
  }
  const outputs = await finishOutputs(plan, job, film, config, run);
  const report = {
    schema: 'awwo.edit-report/1', name: plan.name, seconds: plan.seconds, frames: plan.frames, fps: plan.output.fps,
    width: probe.width, height: probe.height, bytes: probe.size, loudness: mix.loudness, counts: counts(plan),
    inputs: job.files.map((file) => ({ name: file.name, duration: probes.get(file.name).still ? null : probes.get(file.name).duration, picture: Boolean(probes.get(file.name).video), sound: Boolean(probes.get(file.name).audio) })),
    warnings: [...new Set(state.warnings)], elapsedMs: Date.now() - started,
  };
  const reportFile = path.join(job.dir, 'out', 'report.json');
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  outputs.push(await describe(reportFile, 'report', 'application/json'));
  return { report, outputs };
}
