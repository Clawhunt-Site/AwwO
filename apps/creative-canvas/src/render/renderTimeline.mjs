// P3b — render entry (Node). Bundles the Remotion Root and renders a CompositionPlan to
// an mp4 via @remotion/renderer (Chromium). This is a governed, explicit, LOCAL action —
// never run in CI (heavy Chromium render). Usage:
//   node src/render/renderTimeline.mjs [planJson] [outputPath]
// With no args it renders a small built-in demo plan (the render smoke).
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entryPoint = path.join(here, 'Root.tsx');

const DEMO_PLAN = {
  id: 'smoke',
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: 180,
  tracks: [
    {
      id: 't1',
      kind: 'video',
      name: 'V1',
      muted: false,
      clips: [
        {
          id: 'c1',
          sourceRef: 'asset:a',
          fromFrame: 0,
          durationInFrames: 90,
          trimStartFrame: 0,
          label: 'Clip A',
          keyframes: [
            { property: 'opacity', frame: 0, value: 0 },
            { property: 'opacity', frame: 15, value: 1 },
          ],
        },
        {
          id: 'c2',
          sourceRef: 'asset:b',
          fromFrame: 90,
          durationInFrames: 90,
          trimStartFrame: 0,
          label: 'Clip B',
          keyframes: [],
        },
      ],
    },
  ],
};

const planArg = process.argv[2];
const outputLocation = process.argv[3] || path.join(here, '../../../../out/timeline-smoke.mp4');
const plan = planArg ? JSON.parse(readFileSync(planArg, 'utf8')) : DEMO_PLAN;

mkdirSync(path.dirname(outputLocation), { recursive: true });

console.log('[render] bundling…');
const serveUrl = await bundle({ entryPoint });
console.log('[render] selecting composition…');
const composition = await selectComposition({ serveUrl, id: 'Timeline', inputProps: { plan } });
console.log(`[render] ${composition.durationInFrames} frames @ ${composition.fps}fps ${composition.width}x${composition.height} -> ${outputLocation}`);
await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation, inputProps: { plan } });
console.log('[render] done:', outputLocation);
