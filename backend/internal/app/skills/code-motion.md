---
name: code-motion
title: Motion in code: animation AwwO renders to video
title_zh: 代码动效：可渲染成视频的动画
description: Use when the deliverable is an animation, title card, logo reveal, product loop or other motion piece that should become a video: one HTML page that computes every frame from time, planned on an exposure sheet with numbers.
description_zh: 交付物是动画、标题卡、Logo 揭示、产品循环短片等需要变成视频的动效时使用：一个按时间算出每一帧的 HTML 页面，先用摄影表把数字排好。
category: video
applies: html,motion
version: 1
attribution:
---
# Motion in code

The page you write is the film. AwwO's renderer opens it in a headless browser, sets it to one moment, takes a picture, and repeats that for every frame; then it encodes the pictures into an MP4 (and a GIF or a contact sheet when asked). You cannot run or watch the page: describe what frames will show from the code, and never say you have seen one.

## How AwwO turns the page into frames

- Frame i is the moment t = i / fps for i = 0 to N - 1, with N = round(seconds x fps). The studio renders at 24, 30 or 60 fps, for up to 20 seconds, at 1920x1080, 1280x720, 1080x1080, 1080x1350 or 1080x1920. Lay the piece out from `innerWidth` and `innerHeight` so every size works.
- Preferred: define `window.renderAt = (t) => { ... }`. AwwO calls it once per frame with t in seconds and waits when it returns a promise. Each call draws the whole picture for its t from scratch, relying on nothing an earlier call left behind.
- CSS animations, transitions and the Web Animations API work too: before each frame AwwO pauses every animation and moves it to t, counted from the frame where it first appeared.
- Every page runs on a substitute clock: requestAnimationFrame, timers, Date and performance.now only move when AwwO advances to the next frame's t, and Math.random is seeded. A page without `renderAt` still renders this way, but only `renderAt` lets you reason about each frame exactly.
- Loading fonts, images or data first? Start with `window.__ready = false` and set it to `true` when they have loaded. AwwO then waits up to 10 more seconds after `load` and `document.fonts.ready`, and renders anyway with a warning if it never turns true. The clock stands still during that wait, so set `__ready` from load events and promises, never from a timer or an animation frame.
- Only the allowed CDNs load (AwwO's three.js import map points at one, and the font CDNs are on the list); every other request is blocked, and AwwO reports the blocked requests it caught. Put data in the page. The page must not navigate.
- AwwO warns when all frames are identical, when scripts throw (the render continues) and when requests were blocked. A GIF longer than 350 frames gets a lower frame rate, and GIF has 256 colours, so wide gradients band. The contact sheet shows 12 frames at even steps from frame 0, so it may stop short of the last frame.

## Plan on an exposure sheet

Write the sheet before any code, one row per change, in frames at the chosen fps:

| Frames | Element | Change | Curve |
| --- | --- | --- | --- |
| 0-17 | headline | rises 40 px, opacity 0 to 1 | arrive |
| 12-35 | product | scale 0.92 to 1 | spring, zeta 0.8 |

Above it, state the size, fps, length and whether it loops. Frame 0 is what a viewer sees first and the first tile of the contact sheet, so compose it as a finished picture. The code follows the sheet exactly, and your answer names frames ("the logo settles at frame 48").

## Craft

Classic animation principles, as numbers:

- Staging: one centre of attention at a time; while the main change plays, the rest holds still or nearly so.
- Slow in, slow out: things accelerate and brake. Keep constant speed for motion that never starts or stops on screen, such as a spin that runs the whole piece or a scrolling ticker.
- Anticipation: a large move reads better after a 2-4 frame counter-move of a few percent.
- Follow-through: the parts of a group come to rest 2-6 frames apart rather than together.
- Arcs: living things travel on curves; machines may go straight.
- Squash and stretch: scale one axis up and the other down so the area stays about the same.

Durations at 30 fps (frames / 30 = seconds): small elements 5-8 frames, cards and panels 9-14, moves across the whole frame 15-21, a title reveal up to 30. An exit is about a third shorter than its entrance. In a cascade, offset siblings by 1-3 frames and keep the whole cascade under 15.

Curves by role, as CSS `cubic-bezier`:

- arrive: (0.05, 0.7, 0.1, 1)
- travel across the frame: (0.2, 0, 0, 1)
- leave: (0.3, 0, 0.8, 0.15)
- arrive with overshoot: (0.34, 1.56, 0.64, 1)

Springs: pick the damping ratio zeta from the overshoot you want. 0.8 gives about 1.5 %, 0.7 about 5 %, 0.6 about 9.5 %, 0.5 about 16 %, 0.4 about 25 %; at 1 or more there is none. Only position, scale and rotation may overshoot; opacity and colour stop at their target. A spring you can evaluate at any time, sized by how long it takes to settle:

```js
// Step response of a damped spring from 0 to 1. zeta: damping ratio, used between 0.05 and 0.95; 1 or more
// is treated as critical damping. settle: seconds after which it stays within 2 % of 1.
function springAt(t, zeta = 0.8, settle = 0.6) {
  if (t <= 0) return 0;
  if (zeta >= 1) { const w = 5.84 / settle; return 1 - (1 + w * t) * Math.exp(-w * t); }
  const z = Math.min(Math.max(zeta, 0.05), 0.95), k = Math.sqrt(1 - z * z);
  const w = (Math.log(50) - Math.log(k)) / (z * settle); // the envelope exp(-z*w*t) / k reaches 2 % at settle
  return 1 - Math.exp(-z * w * t) * (Math.cos(w * k * t) + (z / k) * Math.sin(w * k * t));
}
```

In CSS, give the animation a duration of 1.5 x settle and sample the spring 30-60 times over it into `linear(...)`; the last sample is then within 0.3 % of 1, so end it at exactly 1.

Text: hold each text state for about 1 second plus 1 second per 4 words (or per 5 Chinese characters) before it changes. No more than three flashes in any one second. Keep titles inside the central 90 % of the frame.

## Determinism

- Seed all randomness (for example mulberry32 with a fixed seed) so every render draws the same values.
- Simulations and particles: step with a fixed dt from the same initial state up to t, so a given t always gives the same picture.
- Nothing you draw may depend on `Date.now()`, `performance.now()`, timers or an unseeded `Math.random()`.
- Seamless loops: the rendered length is L = N / fps (exactly the chosen length whenever length x fps is a whole number, as with the studio's settings). The picture at t = L must equal the picture at t = 0; AwwO stops one frame short of L, so never add a final frame that repeats frame 0. Give every repeating motion a period that divides L, for example `Math.sin(2 * Math.PI * k * t / L)` with a whole number k.

## Before you hand over

- The exposure sheet is in the answer and the code matches it frame for frame.
- `renderAt(t)` (or the CSS animations) depends only on t and fixed data; `__ready` starts false and becomes true if anything loads.
- No request goes beyond the allowed CDNs; fonts come from them or from the system.
- Frame 0 is a finished picture. Say plainly that the video exists once AwwO renders the page.
