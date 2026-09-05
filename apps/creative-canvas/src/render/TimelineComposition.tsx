// P3b — the Remotion composition that renders a CompositionPlan to video frames.
// Imports `remotion` (isolated under render/ — NEVER imported by the apps/web bundle or
// tests, so CI never pulls Remotion/Chromium). Sources are placeholder-visual for the
// render smoke: each clip shows as a colored panel + its label on its track, animated by
// the clip's opacity keyframes. Real media (Img/OffthreadVideo from resolved asset URLs)
// is a follow-up; this proves the timeline -> mp4 pipeline. Design: docs/creative-canvas-timeline-design.md.
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion';

import type { CompositionPlan, PlanClip } from '../engine/compositionPlan';
import { trackKindColor } from './metadata';

/** Opacity for a clip at a given LOCAL frame, driven by its 'opacity' keyframes (default 1).
 *  Dedupes by frame (last value wins) so the frame list is strictly increasing — Remotion's
 *  interpolate() throws on duplicate/non-monotonic inputs, which two distinct timeSec values
 *  rounding to the same frame would otherwise produce. */
function clipOpacity(clip: PlanClip, localFrame: number): number {
  const byFrame = new Map<number, number>();
  for (const k of clip.keyframes) {
    if (k.property === 'opacity') byFrame.set(k.frame, clamp01(k.value));
  }
  if (byFrame.size === 0) return 1;
  const frames = [...byFrame.keys()].sort((a, b) => a - b);
  if (frames.length === 1) return byFrame.get(frames[0]!)!;
  const values = frames.map((f) => byFrame.get(f)!);
  return interpolate(localFrame, frames, values, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

function ClipPanel({ clip, color }: { clip: PlanClip; color: string }) {
  const frame = useCurrentFrame(); // local to the enclosing Sequence
  const opacity = clipOpacity(clip, frame);
  return (
    <AbsoluteFill
      style={{
        backgroundColor: color,
        opacity,
        justifyContent: 'center',
        alignItems: 'center',
        color: '#ffffff',
        fontFamily: 'sans-serif',
        fontSize: 64,
        fontWeight: 700,
      }}
    >
      {clip.label ?? clip.sourceRef}
    </AbsoluteFill>
  );
}

export function TimelineComposition({ plan }: { plan: CompositionPlan }) {
  return (
    <AbsoluteFill style={{ backgroundColor: '#08081a' }}>
      {plan.tracks.filter((track) => !track.muted).map((track) => (
        <AbsoluteFill key={track.id}>
          {track.clips.map((clip) => (
            <Sequence
              key={clip.id}
              from={clip.fromFrame}
              durationInFrames={clip.durationInFrames}
              layout="none"
            >
              <ClipPanel clip={clip} color={trackKindColor(track.kind)} />
            </Sequence>
          ))}
        </AbsoluteFill>
      ))}
    </AbsoluteFill>
  );
}
