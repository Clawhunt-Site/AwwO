---
name: neon-pixel-scene
title: Neon pixel scenes in one HTML page
title_zh: 霓虹像素场景（单页 HTML）
description: Use when building a single-file HTML scene, game backdrop or animated poster in a neon, cyberpunk or pixel-art style, in 2D canvas or three.js, that must look rich, run fast and record cleanly.
description_zh: 用单个 HTML 做霓虹、赛博朋克或像素风的场景、游戏背景或动态海报时使用（2D 画布或 three.js），要好看、流畅、可录制。
category: design
applies: html,motion,design
version: 1
attribution:
---
# Neon pixel scenes

What makes these scenes read as "neon city" is a dark, low-saturation body, a few saturated accents, light that glows and reflects, depth from haze, motion at several speeds, and strict pixel discipline.

## 2D path (Canvas 2D)

1. Draw into a low-resolution buffer with image smoothing off, then scale it up by a whole number onto the visible canvas: at 1080p, 320x180 scales by 6 and 480x270 by 4.
2. Cheap bloom: downscale the buffer to a quarter, multiply it onto itself to keep only bright pixels, downscale again, then add both glow layers back with `globalCompositeOperation = 'lighter'` at about 0.4–0.5 alpha.
3. Depth: three or four skyline layers, each moving at roughly twice the speed of the one behind it (for example 1/16, 1/8, 1/4 and 1/2 of the street speed), each followed by a haze gradient in the scene's colour, stronger far away.
4. Buildings from a seed: hash the building's slot to seed a generator; draw the static facade once into a small cached canvas, and keep only animated details (signs, a few windows) for every frame.
5. Neon text: render small text, threshold its alpha so edges stay crisp, place it on a dark panel with a one-pixel neon frame, cache the result.
6. Life: lit windows mostly in the scene's accent colours and warm tungsten, with only a few cool white; a few signs flicker briefly in rare windows of time; rain as two layers of short strokes; the wet road mirrors the rows above it with a slight wobble.

## 3D path (three.js on AwwO's import map)

1. One InstancedMesh of boxes for the whole city; a fragment shader draws windows, signs and edges from a per-instance hash instead of textures.
2. Push neon colours several times above 1.0 so a bloom pass with a high threshold catches only them.
3. Exponential fog plus a height fog in the scene colour.
4. Render at a third of the size and scale up with CSS `image-rendering: pixelated`; finish with a light ordered (Bayer) dither and a vignette.
5. Animate traffic, rain and dust in the vertex shader from time, not on the CPU.

## Palette rules

One dark body colour, one haze colour, three accents. Keep large areas desaturated; let the accents be the only saturated pixels. Text contrast at least 4.5:1.

## QA checklist

1. No network beyond pinned libraries; fonts from AwwO's list or bitmap glyphs drawn on the canvas.
2. Whole-number upscaling, smoothing off, no blurry text.
3. Bloom comes from bright pixels only; at most two glow passes.
4. At least three depth layers or fog.
5. Deterministic: every frame depends only on the seed and `t`; no randomness inside the draw loop. Expose `window.renderAt(t)` so AwwO can record it.
6. One animation loop with a clamped time step; device pixel ratio at most 2; pause when the tab is hidden.
7. Do not rely on `localStorage`; wrap fullscreen and pointer-lock calls so a refusal is harmless.
8. Sound only after a click, with a mute control.
9. Respect `prefers-reduced-motion`: turn off flicker, shake and colour splitting.
10. Never more than three flashes per second.
