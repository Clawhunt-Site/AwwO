---
name: motion-lab
title: Motion Lab: animation drawn in code
title_zh: 代码动效实验室
description: Use when the deliverable is an animation, title sequence, logo sting, product loop or any motion piece that AwwO should turn into a video: one HTML file that follows the render contract, directed with numbers.
description_zh: 做动画、片头、Logo 动效、产品循环短片等需要导出成视频的动效时使用：按渲染约定写成单个 HTML，用数字而不是形容词来导演。
category: video
applies: html,motion
version: 1
attribution:
---
# Motion Lab

You write motion as a program: one self-contained HTML page whose every frame is computed from the time `t`. AwwO's renderer opens the page in a headless browser, freezes it at each frame, and encodes the frames into an MP4 (and a GIF or contact sheet when asked). Nothing you write is rendered until AwwO does it, so never claim you saw a frame.

## The render contract (always follow it)

1. One self-contained HTML document. Load only the libraries you name, pinned to a version, from the allowed CDNs or AwwO's three.js import map. No other network requests.
2. Every visible value is a pure function of `t` in seconds. If JavaScript draws or moves anything, define `window.renderAt = (t) => { ... }` that draws exactly the frame at `t`.
3. CSS keyframes, the Web Animations API, SVG, Canvas 2D and WebGL are all fine. AwwO pauses every animation and sets its time to `t` for each frame.
4. Never drive motion from `Date.now()`, `performance.now()`, `setTimeout`/`setInterval` or unseeded `Math.random()`. Use a seeded generator (for example mulberry32 with a fixed seed).
5. Loops: a loop of N frames renders frames 0 to N-1. Frame N-1 must flow into frame 0. Drive cyclic motion from `phase = t / duration` with whole cycles.
6. When fonts, textures or precomputed data are ready, set `window.__ready = true`; AwwO waits for it (up to 10 s).
7. Frame 0 is a finished composition: it is the poster and the first thing a viewer sees.
8. A page without `renderAt` still renders (AwwO runs it on a virtual clock), but `renderAt` is the reliable path.

## Direct the piece before writing code

Fill these lines first and keep them at the top of your answer:

- GOAL: what the viewer should feel or do, in one sentence.
- OUTPUT: engine (plain HTML/CSS, Canvas, SVG or three.js) and size, e.g. 1920x1080.
- TIME: seconds x fps = frames; loop yes or no.
- LOOK: palette in hex with one accent, typeface, weight, size, tracking.
- MOTION: easings as cubic-bezier, springs as damping ratio, durations in frames.
- SHOTS: frame ranges; one hero move per shot; how each shot hands off (a hard cut by default).
- BANNED: defaults you refuse (see below), extended for this piece.
- QA: the frames you expect to check (e.g. 0, 24, 48, 72) and what each should show.

## Numbers that work

| Use | Curve |
| --- | --- |
| Reveals of text and logos | cubic-bezier(0.16, 1, 0.3, 1) |
| Premium entrances | cubic-bezier(0.22, 1, 0.36, 1) |
| Moves and camera pushes | cubic-bezier(0.76, 0, 0.24, 1) |
| Fast exits | cubic-bezier(0.7, 0, 0.84, 0) |
| A playful pop | cubic-bezier(0.34, 1.56, 0.64, 1) |

- Enter with ease-out, leave with ease-in; exits are 40–50% shorter than entrances. Linear only for rotation, progress bars and loop phase.
- Springs by damping ratio ζ = d / (2·√(k·m)): 1 has no bounce, 0.7–0.85 feels premium, 0.4–0.6 playful, below 0.3 cartoonish. Position and scale may overshoot; opacity and colour never do.
- Durations: feedback 100–200 ms, UI moves 200–500 ms, hero reveals 600–900 ms. Stagger letters 1 frame apart, words 60–120 ms, list items 40–80 ms; start the next element when the previous is 30–50% done.
- Frames from time: frames = ms × fps / 1000 (24 fps: 400 ms ≈ 10 frames).
- Music: frames per beat = fps × 60 / BPM. Compute each beat from its index and round that one value; never add a rounded beat length repeatedly (it drifts). Cut on the beat; change layout on the bar.
- Hold any text for at least 0.3 s per word plus 0.5 s; keep it alive with a slow 2% push.
- Parallax speeds: foreground 1.0, middle 0.5, background 0.2.
- Text contrast at least 4.5:1 on every frame; never more than 3 flashes per second.

A spring you can evaluate at any `t` without simulation:

```js
function spring(t, zeta = 0.75, hz = 2) {
  if (t <= 0) return 0;
  const w = 2 * Math.PI * hz;
  if (zeta >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t));
}
```

## Hierarchy

One hero move per shot. Secondary moves travel 50–70% as far and start 100–200 ms later. Ambient motion stays under 5% of the hero's travel, on a slow sine, and never stops.

## Default ban list

Purple-to-blue gradients, glow and lens flares as decoration, floating particles for their own sake, everything fading in at once, fade-and-slide-up on every element, centred-everything layouts, text that moves while it is being read.

## Fixes

| Symptom | Change |
| --- | --- |
| Flicker or jitter | Make every value a function of t; seed the randomness; remove timers and CSS transitions |
| Wrong or fallback font | Load fonts with display=block and set `__ready` after `document.fonts.ready` |
| Hiccup at the loop seam | Render 0..N-1 and use whole cycles of phase |
| Drift off the beat | Compute each beat from its index |
| Jank | Animate transform and opacity only |
| Shimmering text | Snap resting text to whole pixels |
| Too busy | Keep one hero move; delay and shorten the rest |

## Before you hand over

- The GOAL to QA lines are present and the code matches them.
- `renderAt(t)` exists (for JS motion) and depends only on `t` and fixed data.
- No clocks, timers, network calls or unseeded randomness drive the picture.
- Describe timing with frame numbers ("the logo lands at frame 36"), and say plainly that the video is produced when AwwO renders the page.
