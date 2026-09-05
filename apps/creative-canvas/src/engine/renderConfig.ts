// P3a — render-invocation config builder (pure, fail-closed). Produces the parameters a
// @remotion/renderer renderMedia() call needs, WITHOUT importing Remotion and WITHOUT
// rendering (rendering needs Chromium + is a governed, explicit, later-phase action).
// Keeping this pure means it is fully unit-testable and never pulls the heavy renderer
// into the apps/web bundle or CI. Design: docs/creative-canvas-timeline-design.md (P3).
import { planHasClips, type CompositionPlan } from './compositionPlan';

export type RenderCodec = 'h264' | 'h265' | 'vp8' | 'vp9';

export interface RenderInvocation {
  compositionId: string;
  codec: RenderCodec;
  /** output file path with the codec-correct extension enforced */
  outputLocation: string;
  /** serializable props handed to the Remotion composition */
  inputProps: { plan: CompositionPlan };
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
}

export interface RenderOptions {
  outputLocation: string;
  codec?: RenderCodec;
  compositionId?: string;
}

export class RenderConfigError extends Error {
  constructor(
    public code:
      | 'EMPTY_TIMELINE'
      | 'INVALID_OUTPUT'
      | 'INVALID_DIMENSIONS'
      | 'INVALID_TIMELINE'
      | 'INVALID_CODEC',
    message: string,
  ) {
    super(message);
    this.name = 'RenderConfigError';
  }
}

const CODEC_EXT: Record<RenderCodec, string> = {
  h264: '.mp4',
  h265: '.mp4',
  vp8: '.webm',
  vp9: '.webm',
};

export const DEFAULT_COMPOSITION_ID = 'Timeline';

/**
 * buildRenderInvocation — fail-closed. Rejects an empty timeline (nothing to render), a
 * blank output path, or non-positive dimensions BEFORE any render is attempted, and
 * normalizes the output extension to match the codec container.
 */
export function buildRenderInvocation(plan: CompositionPlan, opts: RenderOptions): RenderInvocation {
  const codec = opts.codec ?? 'h264';
  const output = opts.outputLocation.trim();
  if (!output) {
    throw new RenderConfigError('INVALID_OUTPUT', 'outputLocation is required');
  }
  if (!Object.prototype.hasOwnProperty.call(CODEC_EXT, codec)) {
    throw new RenderConfigError('INVALID_CODEC', `unsupported codec ${codec}`);
  }
  if (!Number.isInteger(plan.width) || !Number.isInteger(plan.height) || plan.width <= 0 || plan.height <= 0) {
    throw new RenderConfigError('INVALID_DIMENSIONS', `width/height must be positive integers (got ${plan.width}x${plan.height})`);
  }
  if (!Number.isFinite(plan.fps) || plan.fps <= 0 || !Number.isInteger(plan.durationInFrames) || plan.durationInFrames <= 0) {
    throw new RenderConfigError('INVALID_TIMELINE', 'fps must be finite and positive; durationInFrames must be a positive integer');
  }
  if (!planHasClips(plan)) {
    throw new RenderConfigError('EMPTY_TIMELINE', 'nothing to render — the timeline has no clips');
  }
  const ext = CODEC_EXT[codec];
  const outputLocation = output.toLowerCase().endsWith(ext) ? output : output + ext;
  return {
    compositionId: opts.compositionId?.trim() || DEFAULT_COMPOSITION_ID,
    codec,
    outputLocation,
    inputProps: { plan },
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    durationInFrames: plan.durationInFrames,
  };
}
