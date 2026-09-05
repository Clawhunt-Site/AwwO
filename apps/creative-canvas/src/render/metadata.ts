// P3b — pure composition-metadata derivation (no Remotion import, CI-testable).
// A CompositionPlan carries its own dimensions/fps/duration; Remotion's <Composition>
// needs those as metadata. This helper is the single source of truth used by both the
// Remotion Root (calculateMetadata) and any caller, and it fail-closes to safe values so
// a render can never be started with a zero/negative frame count or dimension.
import type { CompositionPlan } from '../engine/compositionPlan';

export interface CompositionMetadata {
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
}

export function deriveCompositionMetadata(plan: CompositionPlan): CompositionMetadata {
  const durationInFrames = Number.isFinite(plan.durationInFrames) && plan.durationInFrames > 0
    ? Math.floor(plan.durationInFrames)
    : 1;
  const fps = Number.isFinite(plan.fps) && plan.fps > 0 ? plan.fps : 30;
  const width = Number.isFinite(plan.width) && plan.width > 0 ? Math.floor(plan.width) : 1920;
  const height = Number.isFinite(plan.height) && plan.height > 0 ? Math.floor(plan.height) : 1080;
  return {
    durationInFrames,
    fps,
    width,
    height,
  };
}

const KIND_COLORS: Record<string, string> = {
  video: '#2f5fd0',
  audio: '#1f9d6b',
  text: '#c9922e',
  overlay: '#8a45c8',
};

/** Deterministic display color for a track kind (used by the composition rendering). */
export function trackKindColor(kind: string): string {
  return KIND_COLORS[kind] ?? '#3a56a8';
}
