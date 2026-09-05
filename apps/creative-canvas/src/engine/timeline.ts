// Multi-track timeline model for Creative Canvas — the agent-drivable NLE spine.
// Design: docs/creative-canvas-timeline-design.md (Option B; palmier-pro used ONLY as a
// tool-taxonomy reference — no palmier code, GPL-safe).
//
// P1 scope: a pure, framework-free, cross-platform data model + deterministic operations
// (return a NEW document, never mutate) + agent-facing READ helpers. No rendering, no I/O,
// no paid calls — those are later phases. This module has zero runtime dependencies.

export type TrackKind = 'video' | 'audio' | 'text' | 'overlay';

export interface TimelineKeyframe {
  id: string;
  /** seconds from the clip's own start */
  timeSec: number;
  /** e.g. 'opacity' | 'scale' | 'x' | 'y' | 'volume' */
  property: string;
  value: number;
}

export interface TimelineClip {
  id: string;
  trackId: string;
  /** media/asset id, or a seedance-prompt ref for a to-be-generated clip */
  sourceRef: string;
  /** position on the timeline, seconds (>= 0) */
  startSec: number;
  /** rendered length on the timeline, seconds (> 0) */
  durationSec: number;
  /** source in-point, seconds (>= 0) */
  inSec: number;
  /** source out-point, seconds (> inSec) */
  outSec: number;
  label?: string;
  keyframes: TimelineKeyframe[];
}

export interface TimelineTrack {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
}

export interface TimelineDoc {
  version: 1;
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
}

/** Fail-closed error with a stable machine code (never leak a silent bad-state). */
export class TimelineError extends Error {
  constructor(
    public code:
      | 'TRACK_NOT_FOUND'
      | 'CLIP_NOT_FOUND'
      | 'TRACK_LOCKED'
      | 'INVALID_ARG'
      | 'SPLIT_OUT_OF_RANGE',
    message: string,
  ) {
    super(message);
    this.name = 'TimelineError';
  }
}

let idCounter = 0;
/** Mirrors creativeId() in ./document; kept local so this stays a zero-dependency pure module. */
export function timelineId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export interface CreateTimelineOptions {
  name?: string;
  fps?: number;
  width?: number;
  height?: number;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new TimelineError('INVALID_ARG', `${name} must be finite (got ${value})`);
  }
}

export function createTimeline(opts: CreateTimelineOptions = {}): TimelineDoc {
  const fps = opts.fps ?? 30;
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  assertFinite(fps, 'fps');
  assertFinite(width, 'width');
  assertFinite(height, 'height');
  if (fps <= 0) throw new TimelineError('INVALID_ARG', `fps must be > 0 (got ${fps})`);
  if (width <= 0 || height <= 0) {
    throw new TimelineError('INVALID_ARG', `width/height must be > 0 (got ${width}x${height})`);
  }
  return {
    version: 1,
    id: timelineId('tl'),
    name: (opts.name ?? 'Untitled timeline').trim() || 'Untitled timeline',
    fps,
    width,
    height,
    tracks: [],
    clips: [],
  };
}

// --------------------------------------------------------------------------- //
// lookups (fail-closed)                                                        //
// --------------------------------------------------------------------------- //
function findTrack(doc: TimelineDoc, trackId: string): TimelineTrack {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) throw new TimelineError('TRACK_NOT_FOUND', `no track ${trackId}`);
  return track;
}

function findClip(doc: TimelineDoc, clipId: string): TimelineClip {
  const clip = doc.clips.find((c) => c.id === clipId);
  if (!clip) throw new TimelineError('CLIP_NOT_FOUND', `no clip ${clipId}`);
  return clip;
}

function assertTrackEditable(doc: TimelineDoc, trackId: string): void {
  if (findTrack(doc, trackId).locked) {
    throw new TimelineError('TRACK_LOCKED', `track ${trackId} is locked`);
  }
}

// --------------------------------------------------------------------------- //
// tracks                                                                       //
// --------------------------------------------------------------------------- //
export function addTrack(doc: TimelineDoc, kind: TrackKind, name?: string): TimelineDoc {
  if (!['video', 'audio', 'text', 'overlay'].includes(kind)) {
    throw new TimelineError('INVALID_ARG', `unsupported track kind ${kind}`);
  }
  const track: TimelineTrack = {
    id: timelineId('tr'),
    kind,
    name: (name ?? `${kind} ${doc.tracks.length + 1}`).trim() || kind,
    muted: false,
    locked: false,
  };
  return { ...doc, tracks: [...doc.tracks, track] };
}

// --------------------------------------------------------------------------- //
// clips                                                                        //
// --------------------------------------------------------------------------- //
export interface AddClipInput {
  trackId: string;
  sourceRef: string;
  startSec: number;
  durationSec: number;
  inSec?: number;
  outSec?: number;
  label?: string;
}

export function addClip(doc: TimelineDoc, input: AddClipInput): TimelineDoc {
  assertTrackEditable(doc, input.trackId);
  assertFinite(input.startSec, 'startSec');
  assertFinite(input.durationSec, 'durationSec');
  if (input.startSec < 0) throw new TimelineError('INVALID_ARG', `startSec must be >= 0`);
  if (input.durationSec <= 0) throw new TimelineError('INVALID_ARG', `durationSec must be > 0`);
  const inSec = input.inSec ?? 0;
  assertFinite(inSec, 'inSec');
  if (inSec < 0) throw new TimelineError('INVALID_ARG', `inSec must be >= 0`);
  const outSec = input.outSec ?? inSec + input.durationSec;
  assertFinite(outSec, 'outSec');
  if (outSec <= inSec) throw new TimelineError('INVALID_ARG', `outSec must be > inSec`);
  if (!input.sourceRef.trim()) throw new TimelineError('INVALID_ARG', `sourceRef required`);
  const clip: TimelineClip = {
    id: timelineId('cl'),
    trackId: input.trackId,
    sourceRef: input.sourceRef,
    startSec: input.startSec,
    durationSec: input.durationSec,
    inSec,
    outSec,
    label: input.label,
    keyframes: [],
  };
  return { ...doc, clips: [...doc.clips, clip] };
}

export interface MoveClipInput {
  trackId?: string;
  startSec?: number;
}

export function moveClip(doc: TimelineDoc, clipId: string, to: MoveClipInput): TimelineDoc {
  const clip = findClip(doc, clipId);
  assertTrackEditable(doc, clip.trackId);
  const nextTrackId = to.trackId ?? clip.trackId;
  if (to.trackId !== undefined) assertTrackEditable(doc, to.trackId);
  const nextStart = to.startSec ?? clip.startSec;
  assertFinite(nextStart, 'startSec');
  if (nextStart < 0) throw new TimelineError('INVALID_ARG', `startSec must be >= 0`);
  return {
    ...doc,
    clips: doc.clips.map((c) =>
      c.id === clipId ? { ...c, trackId: nextTrackId, startSec: nextStart } : c,
    ),
  };
}

/** Split a clip at an ABSOLUTE timeline time (must be strictly inside the clip span). */
export function splitClip(doc: TimelineDoc, clipId: string, atSec: number): TimelineDoc {
  const clip = findClip(doc, clipId);
  assertTrackEditable(doc, clip.trackId);
  assertFinite(atSec, 'atSec');
  const end = clip.startSec + clip.durationSec;
  if (!(atSec > clip.startSec && atSec < end)) {
    throw new TimelineError(
      'SPLIT_OUT_OF_RANGE',
      `atSec ${atSec} must be strictly within (${clip.startSec}, ${end})`,
    );
  }
  const offset = atSec - clip.startSec; // seconds into the clip
  const cutSource = clip.inSec + offset; // source point of the cut
  const left: TimelineClip = {
    ...clip,
    durationSec: offset,
    outSec: cutSource,
    keyframes: clip.keyframes.filter((k) => k.timeSec <= offset).map((k) => ({ ...k })),
  };
  const right: TimelineClip = {
    ...clip,
    id: timelineId('cl'),
    startSec: atSec,
    durationSec: end - atSec,
    inSec: cutSource,
    keyframes: clip.keyframes
      .filter((k) => k.timeSec > offset)
      .map((k) => ({ ...k, id: timelineId('kf'), timeSec: k.timeSec - offset })),
  };
  return {
    ...doc,
    clips: doc.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c])),
  };
}

export function removeClip(doc: TimelineDoc, clipId: string): TimelineDoc {
  const clip = findClip(doc, clipId); // fail-closed if missing
  assertTrackEditable(doc, clip.trackId);
  return { ...doc, clips: doc.clips.filter((c) => c.id !== clipId) };
}

export interface ClipPropertiesPatch {
  startSec?: number;
  durationSec?: number;
  inSec?: number;
  outSec?: number;
  label?: string;
  sourceRef?: string;
}

export function setClipProperties(
  doc: TimelineDoc,
  clipId: string,
  patch: ClipPropertiesPatch,
): TimelineDoc {
  const clip = findClip(doc, clipId);
  assertTrackEditable(doc, clip.trackId);
  const next: TimelineClip = { ...clip, ...stripUndefined(patch) };
  assertFinite(next.startSec, 'startSec');
  assertFinite(next.durationSec, 'durationSec');
  assertFinite(next.inSec, 'inSec');
  assertFinite(next.outSec, 'outSec');
  if (next.startSec < 0) throw new TimelineError('INVALID_ARG', `startSec must be >= 0`);
  if (next.durationSec <= 0) throw new TimelineError('INVALID_ARG', `durationSec must be > 0`);
  if (next.inSec < 0) throw new TimelineError('INVALID_ARG', `inSec must be >= 0`);
  if (next.outSec <= next.inSec) throw new TimelineError('INVALID_ARG', `outSec must be > inSec`);
  if (!next.sourceRef.trim()) throw new TimelineError('INVALID_ARG', `sourceRef required`);
  return { ...doc, clips: doc.clips.map((c) => (c.id === clipId ? next : c)) };
}

/** Upsert a keyframe by (property, timeSec); replaces value if one already exists there. */
export function setKeyframe(
  doc: TimelineDoc,
  clipId: string,
  kf: { property: string; timeSec: number; value: number },
): TimelineDoc {
  const clip = findClip(doc, clipId);
  assertTrackEditable(doc, clip.trackId);
  assertFinite(kf.timeSec, 'timeSec');
  assertFinite(kf.value, 'value');
  if (kf.timeSec < 0 || kf.timeSec > clip.durationSec) {
    throw new TimelineError('INVALID_ARG', `keyframe timeSec ${kf.timeSec} outside clip span`);
  }
  if (!kf.property.trim()) throw new TimelineError('INVALID_ARG', `keyframe property required`);
  const existing = clip.keyframes.find(
    (k) => k.property === kf.property && k.timeSec === kf.timeSec,
  );
  const keyframes = existing
    ? clip.keyframes.map((k) => (k === existing ? { ...k, value: kf.value } : k))
    : [...clip.keyframes, { id: timelineId('kf'), ...kf }];
  return {
    ...doc,
    clips: doc.clips.map((c) => (c.id === clipId ? { ...c, keyframes } : c)),
  };
}

// --------------------------------------------------------------------------- //
// read helpers (agent read tools: get_timeline / inspect_timeline)            //
// --------------------------------------------------------------------------- //
export function timelineDurationSec(doc: TimelineDoc): number {
  return doc.clips.reduce((max, c) => Math.max(max, c.startSec + c.durationSec), 0);
}

export interface TimelineSummary {
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  durationSec: number;
  trackCount: number;
  clipCount: number;
}

/** get_timeline — flat, serializable snapshot for an agent to read. */
export function getTimeline(doc: TimelineDoc): TimelineSummary {
  return {
    id: doc.id,
    name: doc.name,
    fps: doc.fps,
    width: doc.width,
    height: doc.height,
    durationSec: timelineDurationSec(doc),
    trackCount: doc.tracks.length,
    clipCount: doc.clips.length,
  };
}

export interface InspectedTrack extends TimelineTrack {
  clips: TimelineClip[];
}

/** inspect_timeline — per-track view with each track's clips ordered by start time. */
export function inspectTimeline(doc: TimelineDoc): {
  summary: TimelineSummary;
  tracks: InspectedTrack[];
} {
  return {
    summary: getTimeline(doc),
    tracks: doc.tracks.map((track) => ({
      ...track,
      clips: doc.clips
        .filter((c) => c.trackId === track.id)
        .sort((a, b) => a.startSec - b.startSec),
    })),
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
