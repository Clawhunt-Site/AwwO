// P3b — Remotion entry. Registers the "Timeline" composition whose metadata is derived
// from the CompositionPlan passed as inputProps (calculateMetadata). Bundled by the render
// script via @remotion/bundler; never imported by the apps/web app or tests.
import { Composition, registerRoot } from 'remotion';

import type { CompositionPlan } from '../engine/compositionPlan';
import { deriveCompositionMetadata } from './metadata';
import { TimelineComposition } from './TimelineComposition';

const FALLBACK_PLAN: CompositionPlan = {
  id: 'empty',
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 1,
  tracks: [],
};

export const RemotionRoot = () => (
  <Composition
    id="Timeline"
    component={TimelineComposition}
    durationInFrames={1}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ plan: FALLBACK_PLAN }}
    calculateMetadata={({ props }) => deriveCompositionMetadata(props.plan)}
  />
);

registerRoot(RemotionRoot);
