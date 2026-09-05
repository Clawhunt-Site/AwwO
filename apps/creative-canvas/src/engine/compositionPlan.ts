// P3a — render-lane spine (pure). Maps a P1 TimelineDoc (seconds) into a frame-based
// CompositionPlan a Remotion composition consumes. Zero runtime deps, zero Remotion
// import (so the apps/web bundle never pulls Remotion), no rendering, no I/O.
// Design: docs/creative-canvas-timeline-design.md (P3).
import { inspectTimeline, TimelineError, type TimelineDoc, type TrackKind } from './timeline';

export interface PlanKeyframe {
  property: string;
  /** absolute frame within the clip (>= 0) */
  frame: number;
  value: number;
}

export interface PlanClip {
  id: string;
  sourceRef: string;
  /** start on the timeline, in frames */
  fromFrame: number;
  /** rendered length on the timeline, in frames (>= 1) */
  durationInFrames: number;
  /** source in-point, in frames */
  trimStartFrame: number;
  label?: string;
  keyframes: PlanKeyframe[];
}

export interface PlanTrack {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  clips: PlanClip[];
}

export interface CompositionPlan {
  id: string;
  width: number;
  height: number;
  fps: number;
  /** total composition length in frames (>= 1) */
  durationInFrames: number;
  tracks: PlanTrack[];
}

/** seconds -> whole frames, clamped to >= 0 (deterministic; round-half-up). */
export function secToFrames(sec: number, fps: number): number {
  if (!Number.isFinite(sec) || !Number.isFinite(fps) || fps <= 0) {
    throw new TimelineError('INVALID_ARG', `sec and fps must be finite; fps must be > 0`);
  }
  return Math.max(0, Math.round(sec * fps));
}

/**
 * buildCompositionPlan — deterministic TimelineDoc -> frame-based plan. The plan is a
 * plain serializable object (safe to pass as Remotion inputProps). Clips keep timeline
 * order per track (inspectTimeline already sorts by start time).
 */
export function buildCompositionPlan(doc: TimelineDoc): CompositionPlan {
  const fps = doc.fps;
  const view = inspectTimeline(doc);
  // Derive the composition length from actual clip frame-ends (not from a separately
  // rounded total-seconds value) so every clip is guaranteed to fit exactly in frame space.
  let maxEndFrame = 0;
  const tracks: PlanTrack[] = view.tracks.map((track) => ({
    id: track.id,
    kind: track.kind,
    name: track.name,
    muted: track.muted,
    clips: track.clips.map((clip) => {
      const fromFrame = secToFrames(clip.startSec, fps);
      const durationInFrames = Math.max(1, secToFrames(clip.durationSec, fps));
      maxEndFrame = Math.max(maxEndFrame, fromFrame + durationInFrames);
      return {
        id: clip.id,
        sourceRef: clip.sourceRef,
        fromFrame,
        durationInFrames,
        trimStartFrame: secToFrames(clip.inSec, fps),
        label: clip.label,
        keyframes: clip.keyframes.map((k) => ({
          property: k.property,
          frame: secToFrames(k.timeSec, fps),
          value: k.value,
        })),
      };
    }),
  }));
  return {
    id: doc.id,
    width: doc.width,
    height: doc.height,
    fps,
    durationInFrames: Math.max(1, maxEndFrame),
    tracks,
  };
}

/** Whether a plan has anything to render (at least one clip on any track). */
export function planHasClips(plan: CompositionPlan): boolean {
  return plan.tracks.some((t) => t.clips.length > 0);
}
