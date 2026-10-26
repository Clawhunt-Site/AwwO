// The one shape of an edit job (awwo.timeline/1) and its layout on the film's frames. Pure: validateEditManifest
// checks a job before any byte of its files arrives; placeTimeline, given each file's probe, places every item on
// whole frames and splits the picture into the pieces edit-run.mjs encodes. Tests pin every rule without ffmpeg.
import { pageShape } from './config.mjs';

const GIB = 1024 ** 3;
export const EDIT_LIMITS = Object.freeze({
  maxSecondsCeiling: 3600,
  maxVideoItems: 400,
  maxAudioItems: 600,
  maxSubtitles: 2000,
  maxCards: 40,
  maxCardSeconds: 20,
  maxCardHtmlBytes: 256 * 1024,
  maxFiles: 300,
  maxFileBytes: 4 * GIB,
  maxInputBytesCeiling: 64 * GIB,
  maxManifestBytes: 4 * 1024 * 1024,
  maxStills: 150,
  maxSilences: 200,
  maxCardSecondsTotal: 120,
  maxSoundPages: 8,
  maxSoundPageSeconds: 300,
  maxSubtitleBytes: 900 * 1024,
  maxSubtitleLines: 3,
  maxInputSide: 4096,
  maxInputSeconds: 4 * 3600,
  minFilmBytes: 1024 * 1024,
  maxFilmBytes: 8 * GIB,
  durationSlack: 0.05,
  atToleranceFrames: 2,
});

export const DIALOGUE_FX = Object.freeze(['dry', 'room', 'hall', 'radio', 'echo']);
const EDIT_ID = /^[A-Za-z0-9_-]{8,80}$/;
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}$/;
const ITEM_ID = /^[A-Za-z0-9_.-]{1,40}$/;
const STEM = /^[A-Za-z0-9_-]{1,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const AUDIO_TRACKS = Object.freeze(['dialogue', 'music', 'sfx']);

function invalid(field, message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_EDIT', field });
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A finite number in [min, max]; absent → fallback (undefined = required). */
function number(value, field, min, max, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw invalid(field, `${field} is required`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalid(field, `${field} must be a number from ${min} to ${max}`);
  }
  return value;
}

function integer(value, field, min, max, fallback) {
  const result = number(value, field, min, max, fallback);
  if (!Number.isInteger(result)) throw invalid(field, `${field} must be a whole number`);
  return result;
}

function optionalNumber(value, field, min, max) {
  return value === undefined || value === null ? undefined : number(value, field, min, max);
}

function array(value, field, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw invalid(field, `${field} must be a list of at most ${max} items`);
  return value;
}

/** The output settings, defaults filled in; width and height rounded down to even. */
export function normalizeOutput(raw) {
  const field = 'output';
  if (!isObject(raw)) throw invalid(field, 'output must be an object');
  const side = (value, name) => {
    const result = integer(value, `${field}.${name}`, 64, 1920);
    return result - (result % 2);
  };
  const fit = raw.fit ?? 'cover';
  if (fit !== 'cover' && fit !== 'contain') throw invalid(`${field}.fit`, 'output.fit is cover or contain');
  const stills = number(raw.stillsEverySeconds, `${field}.stillsEverySeconds`, 0, 60, 8);
  if (stills !== 0 && stills < 2) throw invalid(`${field}.stillsEverySeconds`, 'output.stillsEverySeconds is 0 or from 2 to 60');
  return {
    width: side(raw.width, 'width'),
    height: side(raw.height, 'height'),
    fit,
    fps: integer(raw.fps, `${field}.fps`, 12, 60, 24),
    crf: integer(raw.crf, `${field}.crf`, 14, 30, 18),
    loudnessLUFS: number(raw.loudnessLUFS, `${field}.loudnessLUFS`, -30, -10, -16),
    truePeakDb: number(raw.truePeakDb, `${field}.truePeakDb`, -9, 0, -1),
    stillsEverySeconds: stills,
  };
}

function transition(raw, field, first) {
  if (raw === undefined || raw === null) return { type: 'cut', seconds: 0 };
  if (!isObject(raw) || !['cut', 'crossfade', 'dip'].includes(raw.type)) {
    throw invalid(field, `${field}.type is cut, crossfade or dip`);
  }
  if (raw.type === 'cut') return { type: 'cut', seconds: 0 };
  if (first) throw invalid(field, 'the first video item cannot have a transition');
  return { type: raw.type, seconds: number(raw.seconds, `${field}.seconds`, 0.04, 10) };
}

function videoItem(raw, index, names, ids) {
  const field = `tracks.video[${index}]`;
  if (!isObject(raw)) throw invalid(field, `${field} must be an object`);
  const id = raw.id === undefined ? `video-${index + 1}` : raw.id;
  if (typeof id !== 'string' || !ITEM_ID.test(id) || ids.has(id)) throw invalid(`${field}.id`, `${field}.id must be unique: letters, digits, . _ -`);
  ids.add(id);
  const item = { id, index, transition: transition(raw.transition, `${field}.transition`, index === 0) };
  item.at = optionalNumber(raw.at, `${field}.at`, 0, EDIT_LIMITS.maxSecondsCeiling);
  if (raw.card !== undefined) {
    if (raw.source !== undefined) throw invalid(field, `${field} is a clip (source) or a card, not both`);
    const html = raw.card;
    if (typeof html !== 'string' || html.includes('\0') || Buffer.byteLength(html, 'utf8') > EDIT_LIMITS.maxCardHtmlBytes || !pageShape(html)) {
      throw invalid(`${field}.card`, `${field}.card must be a complete HTML document of at most 256 KiB`);
    }
    return { ...item, kind: 'card', html, seconds: number(raw.seconds, `${field}.seconds`, 0.5, EDIT_LIMITS.maxCardSeconds) };
  }
  if (typeof raw.source !== 'string' || !names.has(raw.source)) throw invalid(`${field}.source`, `${field}.source must name a wired file`);
  const start = number(raw.in, `${field}.in`, 0, EDIT_LIMITS.maxSecondsCeiling, 0);
  const end = optionalNumber(raw.out, `${field}.out`, 0, EDIT_LIMITS.maxSecondsCeiling);
  if (end !== undefined && end <= start) throw invalid(`${field}.out`, `${field}.out must be after its in`);
  const clipAudioDb = raw.clipAudioDb === undefined || raw.clipAudioDb === null ? null : number(raw.clipAudioDb, `${field}.clipAudioDb`, -60, 24);
  return { ...item, kind: 'clip', source: raw.source, in: start, out: end, clipAudioDb };
}

function placement(raw, field, anchors) {
  if (raw.anchor !== undefined) {
    if (raw.at !== undefined) throw invalid(field, `${field} is placed by at or by anchor, not both`);
    if (typeof raw.anchor !== 'string' || !anchors.has(raw.anchor)) throw invalid(`${field}.anchor`, `${field}.anchor must be a video item's id`);
    return { anchor: raw.anchor, offset: number(raw.offset, `${field}.offset`, -30, EDIT_LIMITS.maxSecondsCeiling, 0) };
  }
  return { at: number(raw.at, `${field}.at`, 0, EDIT_LIMITS.maxSecondsCeiling) };
}

/**
 * A sound made by a page instead of a wired file: `page` is a complete HTML document whose window.renderAudio
 * synthesizes it (edit-run.mjs renders it before the timeline is placed), `seconds` how long that sound is.
 */
function soundPage(raw, field) {
  if (raw.source !== undefined) throw invalid(field, `${field} is a wired file (source) or a page that makes its sound (page), not both`);
  const html = raw.page;
  if (typeof html !== 'string' || html.includes('\0') || Buffer.byteLength(html, 'utf8') > EDIT_LIMITS.maxCardHtmlBytes || !pageShape(html)) {
    throw invalid(`${field}.page`, `${field}.page must be a complete HTML document of at most 256 KiB`);
  }
  return { html, seconds: number(raw.seconds, `${field}.seconds`, 0.5, EDIT_LIMITS.maxSoundPageSeconds) };
}

function audioItem(raw, track, index, names, anchors) {
  const field = `tracks.${track}[${index}]`;
  if (!isObject(raw)) throw invalid(field, `${field} must be an object`);
  const page = raw.page === undefined ? null : soundPage(raw, field);
  if (!page && (typeof raw.source !== 'string' || !names.has(raw.source))) throw invalid(`${field}.source`, `${field}.source must name a wired file`);
  if (raw.id !== undefined && (typeof raw.id !== 'string' || !ITEM_ID.test(raw.id))) throw invalid(`${field}.id`, `${field}.id: letters, digits, . _ -`);
  const start = number(raw.in, `${field}.in`, 0, EDIT_LIMITS.maxSecondsCeiling, 0);
  const end = optionalNumber(raw.out, `${field}.out`, 0, EDIT_LIMITS.maxSecondsCeiling);
  if (end !== undefined && end <= start) throw invalid(`${field}.out`, `${field}.out must be after its in`);
  const loop = raw.loop === undefined ? false : raw.loop;
  if (typeof loop !== 'boolean' || (loop && track === 'dialogue')) throw invalid(`${field}.loop`, `${field}.loop is true or false (music and sfx only)`);
  if (loop && end === undefined) throw invalid(`${field}.out`, `${field}.out is required with loop (how long it plays)`);
  // A page's sound is exactly `seconds` long, so what it plays is known before it is rendered.
  if (page && start >= page.seconds) throw invalid(`${field}.in`, `${field}.in is past the end of its page's ${page.seconds} s sound`);
  if (page && !loop && end !== undefined && end > page.seconds + EDIT_LIMITS.durationSlack) {
    throw invalid(`${field}.out`, `${field}.out is past the end of its page's ${page.seconds} s sound`);
  }
  const fx = raw.fx === undefined ? 'dry' : raw.fx;
  if (track === 'dialogue' ? !DIALOGUE_FX.includes(fx) : raw.fx !== undefined) {
    throw invalid(`${field}.fx`, `${field}.fx is one of ${DIALOGUE_FX.join(', ')} (dialogue only)`);
  }
  return {
    id: raw.id ?? `${track}-${index + 1}`, track, ...(page ? { page, trackIndex: index } : { source: raw.source }), ...placement(raw, field, anchors),
    in: start, out: end, loop, fx,
    gainDb: number(raw.gainDb, `${field}.gainDb`, -60, 24, 0),
    fadeIn: number(raw.fadeIn, `${field}.fadeIn`, 0, 30, 0),
    fadeOut: number(raw.fadeOut, `${field}.fadeOut`, 0, 30, 0),
  };
}

/** A subtitle's text as the .srt gets it: one to three non-empty lines, none that reads as a cue's timing. */
function subtitleText(text, field) {
  // eslint-disable-next-line no-control-regex
  if (typeof text !== 'string' || text.length > 300 || /[\u0000-\u0009\u000b-\u001f]/.test(text)) {
    throw invalid(field, `${field} is 1–300 characters (line breaks allowed)`);
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > EDIT_LIMITS.maxSubtitleLines || lines.some((line) => line.includes('-->'))) {
    throw invalid(field, `${field} is one to ${EDIT_LIMITS.maxSubtitleLines} lines, none with -->`);
  }
  return lines.join('\n');
}

function subtitle(raw, index, anchors) {
  const field = `tracks.subtitles[${index}]`;
  if (!isObject(raw)) throw invalid(field, `${field} must be an object`);
  const text = subtitleText(raw.text, `${field}.text`);
  if (raw.speaker !== undefined && (typeof raw.speaker !== 'string' || raw.speaker.length > 40)) throw invalid(`${field}.speaker`, `${field}.speaker is at most 40 characters`);
  if (raw.anchor !== undefined) {
    const place = placement(raw, field, anchors);
    return { text, speaker: raw.speaker, ...place, seconds: number(raw.seconds, `${field}.seconds`, 0.2, 30) };
  }
  const start = number(raw.start, `${field}.start`, 0, EDIT_LIMITS.maxSecondsCeiling);
  const end = number(raw.end, `${field}.end`, 0, EDIT_LIMITS.maxSecondsCeiling);
  if (end <= start) throw invalid(`${field}.end`, `${field}.end must be after its start`);
  return { text, speaker: raw.speaker, start, end };
}

function normalizeMix(raw) {
  if (raw === undefined || raw === null) return { levels: null, ducking: null, silence: [] };
  if (!isObject(raw)) throw invalid('mix', 'mix must be an object');
  let levels = null;
  if (raw.levels !== undefined) {
    if (!isObject(raw.levels)) throw invalid('mix.levels', 'mix.levels must be an object');
    levels = Object.fromEntries(AUDIO_TRACKS.filter((track) => raw.levels[track] !== undefined)
      .map((track) => [track, number(raw.levels[track], `mix.levels.${track}`, -40, -6)]));
  }
  let ducking = null;
  if (raw.ducking !== undefined && raw.ducking !== null) {
    const d = raw.ducking;
    if (!isObject(d) || (d.under ?? 'dialogue') !== 'dialogue') throw invalid('mix.ducking', 'mix.ducking ducks under dialogue');
    ducking = {
      music: number(d.music, 'mix.ducking.music', -40, 0, -9),
      sfx: number(d.sfx, 'mix.ducking.sfx', -40, 0, -6),
      attack: number(d.attack, 'mix.ducking.attack', 0.01, 2, 0.12),
      release: number(d.release, 'mix.ducking.release', 0.01, 5, 0.5),
    };
  }
  const silence = array(raw.silence, 'mix.silence', EDIT_LIMITS.maxSilences).map((window, index) => {
    const field = `mix.silence[${index}]`;
    if (!isObject(window)) throw invalid(field, `${field} must be an object`);
    const start = number(window.start, `${field}.start`, 0, EDIT_LIMITS.maxSecondsCeiling);
    const end = number(window.end, `${field}.end`, 0, EDIT_LIMITS.maxSecondsCeiling);
    if (end <= start) throw invalid(`${field}.end`, `${field}.end must be after its start`);
    return { start, end };
  });
  return { levels, ducking, silence };
}

/** The timeline's structure checked against the job's file names (no durations needed yet). */
export function normalizeTimeline(raw, names) {
  if (!isObject(raw) || raw.schema !== 'awwo.timeline/1') throw invalid('schema', 'schema must be "awwo.timeline/1"');
  const name = raw.name === undefined ? 'edit' : raw.name;
  if (typeof name !== 'string' || !STEM.test(name)) throw invalid('name', 'name is 1–40 letters, digits, - or _');
  const output = normalizeOutput(raw.output);
  if (!isObject(raw.tracks)) throw invalid('tracks', 'tracks must be an object');
  const rawVideo = array(raw.tracks.video, 'tracks.video', EDIT_LIMITS.maxVideoItems);
  if (rawVideo.length === 0) throw invalid('tracks.video', 'tracks.video needs at least one clip or card');
  const ids = new Set();
  const video = rawVideo.map((item, index) => videoItem(item, index, names, ids));
  const cards = video.filter((item) => item.kind === 'card');
  if (cards.length > EDIT_LIMITS.maxCards) throw invalid('tracks.video', `at most ${EDIT_LIMITS.maxCards} cards`);
  if (cards.reduce((total, card) => total + card.seconds, 0) > EDIT_LIMITS.maxCardSecondsTotal) {
    throw invalid('tracks.video', `the cards add up to more than ${EDIT_LIMITS.maxCardSecondsTotal} s`);
  }
  const audio = AUDIO_TRACKS.flatMap((track) => array(raw.tracks[track], `tracks.${track}`, EDIT_LIMITS.maxAudioItems)
    .map((item, index) => audioItem(item, track, index, names, ids)));
  if (audio.filter((entry) => entry.page).length > EDIT_LIMITS.maxSoundPages) {
    throw invalid('tracks', `at most ${EDIT_LIMITS.maxSoundPages} sounds made by pages`);
  }
  const clipSounds = video.filter((item) => item.kind === 'clip' && item.clipAudioDb !== null).length;
  if (audio.length + clipSounds > EDIT_LIMITS.maxAudioItems) throw invalid('tracks', `at most ${EDIT_LIMITS.maxAudioItems} sounds in all (clips' own sound included)`);
  const subtitles = array(raw.tracks.subtitles, 'tracks.subtitles', EDIT_LIMITS.maxSubtitles).map((item, index) => subtitle(item, index, ids));
  if (subtitles.reduce((total, entry) => total + Buffer.byteLength(entry.text, 'utf8') + 40, 0) > EDIT_LIMITS.maxSubtitleBytes) {
    throw invalid('tracks.subtitles', 'the subtitles are more text than one .srt may hold (900 KiB)');
  }
  return { name, output, video, audio, subtitles, mix: normalizeMix(raw.mix) };
}

/** A job before its files arrive: {editId, files, timeline}, or throws {status 400, code INVALID_EDIT, field}. */
export function validateEditManifest(body, { maxInputBytes = 6 * GIB } = {}) {
  if (!isObject(body)) throw invalid('body', 'A JSON object is required');
  if (typeof body.editId !== 'string' || !EDIT_ID.test(body.editId)) throw invalid('editId', 'editId is 8–80 letters, digits, - or _');
  const rawFiles = array(body.files, 'files', EDIT_LIMITS.maxFiles);
  const names = new Set();
  let total = 0;
  const files = rawFiles.map((file, index) => {
    const field = `files[${index}]`;
    if (!isObject(file) || typeof file.name !== 'string' || !FILE_NAME.test(file.name) || names.has(file.name)) {
      throw invalid(`${field}.name`, `${field}.name must be a unique <node>/<file> name`);
    }
    names.add(file.name);
    const size = integer(file.size, `${field}.size`, 1, EDIT_LIMITS.maxFileBytes);
    if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) throw invalid(`${field}.sha256`, `${field}.sha256 must be 64 hex digits`);
    total += size;
    return { index, name: file.name, size, sha256: file.sha256 };
  });
  if (total > maxInputBytes) throw invalid('files', `the files add up to more than ${maxInputBytes} bytes`);
  let limits = { maxFilmBytes: null };
  if (body.limits !== undefined) {
    if (!isObject(body.limits)) throw invalid('limits', 'limits must be an object');
    const max = body.limits.maxFilmBytes;
    limits = { maxFilmBytes: max === undefined || max === null ? null : integer(max, 'limits.maxFilmBytes', EDIT_LIMITS.minFilmBytes, EDIT_LIMITS.maxFilmBytes) };
  }
  return { editId: body.editId, files, limits, timeline: normalizeTimeline(body.timeline, names) };
}

const frames = (seconds, fps) => Math.round(seconds * fps);

function clipFrames(item, probe, fps) {
  const field = `tracks.video[${item.index}]`;
  if (!probe?.video) throw invalid(`${field}.source`, `${item.source} has no picture`);
  if (probe.still) {
    if (item.out === undefined) throw invalid(`${field}.out`, `${field}.out is required for a picture: how long it is shown (from in)`);
    if (item.clipAudioDb !== null) throw invalid(`${field}.clipAudioDb`, `${item.source} is a picture: it has no sound`);
    return { ...item, frames: Math.max(1, frames(item.out - item.in, fps)) };
  }
  if (item.in >= probe.duration) throw invalid(`${field}.in`, `${field}.in is past the end of ${item.source} (${probe.duration.toFixed(3)} s)`);
  const end = item.out ?? probe.duration;
  if (end > probe.duration + EDIT_LIMITS.durationSlack) {
    throw invalid(`${field}.out`, `${field}.out is past the end of ${item.source} (${probe.duration.toFixed(3)} s)`);
  }
  const count = frames(Math.min(end, probe.duration) - item.in, fps);
  if (count < 1) throw invalid(`${field}.out`, `${field} is shorter than one frame`);
  return { ...item, out: item.in + count / fps, frames: count };
}

/** Every video item on whole frames: {items with start/frames/overlapIn/overlapOut, total frames}. */
export function placeVideo(video, probes, fps) {
  const items = video.map((item) => (item.kind === 'card'
    ? { ...item, frames: frames(item.seconds, fps) }
    : clipFrames(item, probes.get(item.source), fps)));
  let start = 0;
  items.forEach((item, index) => {
    const overlap = item.transition.type === 'cut' ? 0 : Math.max(1, frames(item.transition.seconds, fps));
    const field = `tracks.video[${index}].transition.seconds`;
    if (index > 0 && (overlap >= items[index - 1].frames || overlap >= item.frames)) {
      throw invalid(field, `${field} must be shorter than both items it joins`);
    }
    if (index > 0 && overlap + items[index - 1].overlapIn > items[index - 1].frames) {
      throw invalid(field, `tracks.video[${index - 1}] is too short for both of its transitions`);
    }
    item.overlapIn = overlap;
    item.start = index === 0 ? 0 : start - overlap;
    start = item.start + item.frames;
    if (index > 0) items[index - 1].overlapOut = overlap;
    if (item.at !== undefined && Math.abs(item.at * fps - item.start) > EDIT_LIMITS.atToleranceFrames) {
      throw invalid(`tracks.video[${index}].at`, `tracks.video[${index}] starts at ${(item.start / fps).toFixed(3)} s, not ${item.at}`);
    }
  });
  items[items.length - 1].overlapOut = 0;
  return { items, total: start };
}

/** The picture as pieces in order: each item's own span, and a piece for every transition (both its sides). */
export function pictureStream(items) {
  const pieces = [];
  items.forEach((item, index) => {
    if (index > 0 && item.overlapIn > 0) {
      const before = items[index - 1];
      pieces.push({
        type: 'transition', kind: item.transition.type === 'dip' ? 'fadeblack' : 'fade', frames: item.overlapIn,
        a: { item: index - 1, from: before.frames - item.overlapIn }, b: { item: index, from: 0 },
      });
    }
    const span = item.frames - item.overlapIn - item.overlapOut;
    if (span > 0) pieces.push({ type: 'span', item: index, from: item.overlapIn, frames: span });
  });
  return pieces;
}

function resolveAt(entry, anchors) {
  return entry.anchor === undefined ? entry.at : anchors.get(entry.anchor) + entry.offset;
}

function placeAudio(entry, probe, anchors, seconds, warnings) {
  const field = `tracks.${entry.track}`;
  if (!probe?.audio) throw invalid(`${field}.source`, `${entry.source} has no sound`);
  if (entry.in >= probe.duration) throw invalid(`${field}.in`, `${entry.id} starts past the end of ${entry.source}`);
  const end = entry.out ?? probe.duration;
  if (!entry.loop && end > probe.duration + EDIT_LIMITS.durationSlack) throw invalid(`${field}.out`, `${entry.id} ends past the end of ${entry.source}`);
  const at = resolveAt(entry, anchors);
  if (at >= seconds) { warnings.push(`audio_past_end:${entry.id}`); return null; }
  let length = (entry.loop ? end : Math.min(end, probe.duration)) - entry.in;
  if (at < 0) throw invalid(`${field}.offset`, `${entry.id} would start before the film`);
  if (at + length > seconds) { length = seconds - at; warnings.push(`audio_cut_at_end:${entry.id}`); }
  return { ...entry, at, length };
}

/** Where a clip keeps its own sound: placed with its picture, faded across its transitions. */
function clipSound(items, probes, fps, warnings) {
  return items.filter((item) => item.kind === 'clip' && item.clipAudioDb !== null).flatMap((item) => {
    if (!probes.get(item.source)?.audio) { warnings.push(`clip_audio_missing:${item.id}`); return []; }
    return [{
      id: `${item.id}-sound`, track: 'clip', source: item.source, at: item.start / fps, in: item.in, length: item.frames / fps,
      loop: false, fx: 'dry', gainDb: item.clipAudioDb, fadeIn: item.overlapIn / fps, fadeOut: item.overlapOut / fps,
    }];
  });
}

function placeSubtitles(subtitles, anchors, seconds, warnings) {
  return subtitles.flatMap((entry, index) => {
    const start = entry.anchor === undefined ? entry.start : anchors.get(entry.anchor) + entry.offset;
    const end = entry.anchor === undefined ? entry.end : start + entry.seconds;
    if (start < 0) throw invalid(`tracks.subtitles[${index}].offset`, `tracks.subtitles[${index}] would start before the film`);
    if (start >= seconds) { warnings.push(`subtitle_past_end:${index}`); return []; }
    return [{ text: entry.text, speaker: entry.speaker, start, end: Math.min(end, seconds) }];
  }).sort((a, b) => a.start - b.start);
}

/**
 * The timeline on the film's frames, given each file's probe ({duration, video, audio}): the picture's pieces, every
 * sound placed in seconds, the subtitles, the ducking windows and warnings; throws INVALID_EDIT naming the field.
 */
export function placeTimeline(timeline, probes, { maxSeconds = 1200, maxFilmBytes = null } = {}) {
  const { fps } = timeline.output;
  const { items, total } = placeVideo(timeline.video, probes, fps);
  const seconds = total / fps;
  if (seconds > maxSeconds) throw invalid('tracks.video', `the film is ${seconds.toFixed(1)} s, longer than ${maxSeconds} s`);
  const pieces = pictureStream(items);
  const output = { ...timeline.output, maxKbps: filmRateCap(maxFilmBytes, seconds, pieces.length) };
  const anchors = new Map(items.map((item) => [item.id, item.start / fps]));
  const warnings = [];
  const sounds = timeline.audio.map((entry) => placeAudio(entry, probes.get(entry.source), anchors, seconds, warnings)).filter(Boolean);
  const audio = [...clipSound(items, probes, fps, warnings), ...sounds];
  const subtitles = placeSubtitles(timeline.subtitles, anchors, seconds, warnings);
  const dialogue = audio.filter((entry) => entry.track === 'dialogue').map((entry) => ({ start: entry.at, end: entry.at + entry.length }));
  const silence = timeline.mix.silence.filter((window) => window.start < seconds).map((window) => ({ start: window.start, end: Math.min(window.end, seconds) }));
  return {
    name: timeline.name, output, frames: total, seconds, items, pieces, audio, subtitles,
    levels: timeline.mix.levels, ducking: timeline.mix.ducking, dialogueWindows: mergeWindows(dialogue, timeline.mix.ducking), silence, warnings,
  };
}

// The highest peak rate a film is given: x264 picks the H.264 level from the rate too (207 Mb/s makes a 720p film level
// 5.1, which some players refuse); at 50 Mb/s 720p and 1080p stay at level 4.1, 1080p at 60 fps at 4.2.
const FILM_PEAK_KBPS = 50_000;

/**
 * The picture's peak rate (kb/s) that keeps a film of `seconds` in `pieces` pieces under maxFilmBytes, the largest
 * file the API stores: 90 % of the budget less the sound's 192 kb/s, shared by the film's seconds and, for each piece
 * (its own encode, which may start with its one-second buffer full), 0.9 s more; at most FILM_PEAK_KBPS, and null when
 * there is no cap. A film that cannot fit at a watchable rate is refused before anything is rendered.
 */
export function filmRateCap(maxFilmBytes, seconds, pieces = 1) {
  if (!maxFilmBytes) return null;
  const kbps = Math.floor((maxFilmBytes * 8 * 0.9 - seconds * 192_000) / (seconds + 0.9 * pieces) / 1000);
  if (kbps < 300) {
    throw invalid('limits.maxFilmBytes', `a ${seconds.toFixed(1)} s film of ${pieces} pieces cannot be stored in ${maxFilmBytes} bytes: make it shorter or cut it less`);
  }
  return Math.min(kbps, FILM_PEAK_KBPS);
}

/** Dialogue windows merged where their ramps would touch, so the ducking gains can be summed without overlap. */
export function mergeWindows(windows, ducking) {
  if (!ducking || windows.length === 0) return [];
  const gap = ducking.attack + ducking.release;
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];
  for (const window of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (window.start - last.end <= gap) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  }
  return merged;
}
