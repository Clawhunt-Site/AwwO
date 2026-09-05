import { addTrack, createTimeline, type TimelineDoc, type TimelineTrack } from './timeline';

export const TIMELINE_STORAGE_KEY = 'superclaw.creative-canvas.timeline.v1';

const TRACK_KINDS = new Set<TimelineTrack['kind']>(['video', 'audio', 'text', 'overlay']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function createDefaultTimeline(): TimelineDoc {
  return addTrack(createTimeline({ name: '新建时间线' }), 'video', '视频 1');
}

export function isTimelineDocument(value: unknown): value is TimelineDoc {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || !isFiniteNumber(value.fps)
    || value.fps <= 0
    || !isFiniteNumber(value.width)
    || value.width <= 0
    || !isFiniteNumber(value.height)
    || value.height <= 0
    || !Array.isArray(value.tracks)
    || !Array.isArray(value.clips)) return false;

  const trackIds = new Set<string>();
  for (const track of value.tracks) {
    if (!isRecord(track)
      || typeof track.id !== 'string'
      || trackIds.has(track.id)
      || typeof track.name !== 'string'
      || typeof track.kind !== 'string'
      || !TRACK_KINDS.has(track.kind as TimelineTrack['kind'])
      || typeof track.muted !== 'boolean'
      || typeof track.locked !== 'boolean') return false;
    trackIds.add(track.id);
  }

  const clipIds = new Set<string>();
  return value.clips.every((clip) => {
    if (!isRecord(clip)
      || typeof clip.id !== 'string'
      || clipIds.has(clip.id)
      || typeof clip.trackId !== 'string'
      || !trackIds.has(clip.trackId)
      || typeof clip.sourceRef !== 'string'
      || clip.sourceRef.trim().length === 0
      || (clip.label !== undefined && typeof clip.label !== 'string')
      || !isFiniteNumber(clip.startSec)
      || clip.startSec < 0
      || !isFiniteNumber(clip.durationSec)
      || clip.durationSec <= 0
      || !isFiniteNumber(clip.inSec)
      || clip.inSec < 0
      || !isFiniteNumber(clip.outSec)
      || clip.outSec <= clip.inSec
      || !Array.isArray(clip.keyframes)) return false;
    clipIds.add(clip.id);
    const keyframeIds = new Set<string>();
    return clip.keyframes.every((keyframe) => {
      if (!isRecord(keyframe)
        || typeof keyframe.id !== 'string'
        || keyframeIds.has(keyframe.id)
        || typeof keyframe.property !== 'string'
        || keyframe.property.trim().length === 0
        || !isFiniteNumber(keyframe.timeSec)
        || keyframe.timeSec < 0
        || keyframe.timeSec > (clip.durationSec as number)
        || !isFiniteNumber(keyframe.value)) return false;
      keyframeIds.add(keyframe.id);
      return true;
    });
  });
}

export function loadTimelineDocument(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): TimelineDoc {
  try {
    const raw = storage?.getItem(TIMELINE_STORAGE_KEY);
    if (!raw) return createDefaultTimeline();
    const parsed: unknown = JSON.parse(raw);
    return isTimelineDocument(parsed) ? parsed : createDefaultTimeline();
  } catch {
    return createDefaultTimeline();
  }
}

export function saveTimelineDocument(
  document: TimelineDoc,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(TIMELINE_STORAGE_KEY, JSON.stringify(document));
  } catch {
    // Storage can be disabled or full; the current editing session stays usable.
  }
}
