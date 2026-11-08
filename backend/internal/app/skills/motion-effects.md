---
name: motion-effects
title: Motion effects: library looks drawn by the page itself
title_zh: 动效配方：不靠动效库，用页面自己的代码做出专业效果
description: Use when a motion piece calls for an effect people usually get from a motion library (After Effects-style keyframes, a 3D data globe, 2D physics, math animation, a staggered grid, gooey blobs, line drawing, a flow field, a moving chart, a shader background, a burst or a shader transition): AwwO pages load no such library, so build the effect in the page as a function of time, by a closed form, a bake at load or a shader.
description_zh: 动效需要通常靠动效库实现的效果时使用（AE 式关键帧、三维数据地球、二维物理、数学动画、交错网格、粘滞融球、描线动画、流场、会动的图表、着色器背景、爆散或着色器转场）：AwwO 的页面不加载这类库，所以在页面里把效果写成时间的函数：直接计算、加载时预烘焙，或用着色器。
category: video
applies: html,motion
version: 1
attribution:
---
# Motion effects without libraries

Each recipe names the library known for its look. AwwO supplies none of them: a page may neither load nor paste them, three.js aside (procedural-3d-scene). Each look takes a few dozen lines of code, and what `renderAt(t)` draws depends on t alone (code-motion).

## Three ways to make an effect seekable

1. Closed form: compute the state from t directly (staggers, bursts, line drawing, morphs, shaders, transitions).
2. Bake at load: run the simulation once from the seed with a fixed step of 1/120 s through t = L, keep each step's state in typed arrays, and let renderAt read step round(t x 120), exact at 24, 30 and 60 fps; at other rates (an edit at 25 fps), mix the two steps either side. Set `__ready` when the bake ends, a few seconds at most; never spread it over timers or animation frames.
3. Checkpoints, for pictures that pile up (trails that never fade): during the bake save an offscreen canvas every few seconds, at most 8 (each 1920x1080 one holds 8 MB); a frame draws the nearest earlier checkpoint, then the rest.

## Recipes

- **Keyframes as data** (After Effects or lottie-web): each property is a track of { t, value, ease }; `at(track, t)` finds the segment and eases across it. A hold is the segment between two equal keys; a spline that takes its slope from neighbouring keys would bulge across it. A Lottie file a member supplies cannot play in a page: ask for its shapes, or a video for an edit.
- **Data globe** (three-globe): a three.js sphere; latitude phi and longitude lambda sit at (r cos phi sin lambda, r sin phi, r cos phi cos lambda). An arc is the slerp between two unit vectors (via a midpoint for opposite points) at radius r + h sin(pi u), h 0.1 to 0.4 of r by distance; draw it as a line or tube and set its draw range from t. Land as dots from a coarse mask in the page, an atmosphere as a larger back-face sphere with a fresnel glow.
- **2D physics** (Matter.js): bake it. For circles, add gravity to the velocity and the velocity to the position each step, push overlapping pairs apart along their centres and, while they approach, apply an impulse along that line by inverse mass with a restitution of 0.2 to 0.6, over 4 to 8 iterations. A falling wall can be faked: each brick gets a seeded push at the impact time, then a ballistic path with spin that stops on the floor. Bodies stay exactly still until their release time.
- **Math animation** (Manim): SVG. Draw a curve on as in line drawing; morph two shapes by resampling both to the same number of points by arc length (200 is plenty), with the same start and winding, and interpolating point by point; plot y = f(x) as a polyline sampled about once per pixel; move the camera by animating the viewBox. Set equations as text or paths: LaTeX needs a library.
- **Staggered grid** (anime.js): cell i at distance d_i from the origin cell (the centre, a corner, a path) starts at t0 + d_i x step, and its progress is ease(clamp((t - start) / duration, 0, 1)). Size the step so the wave crosses the grid in 0.6 to 1.2 s: code-motion's 15-frame cascade is for parts arriving, not a wave that is the shot.
- **Gooey blobs** (Paper.js): circles in one SVG group under a filter whose region is wider than the group, feGaussianBlur near the smallest radius / 3, then feColorMatrix with the alpha row 0 0 0 18 -7, which snaps the blur back into one surface. Move each circle on a Lissajous path whose periods divide the loop.
- **Line drawing** (Vivus): give each path `pathLength="1"`, `stroke-dasharray="1"` and stroke-dashoffset 1 - progress, each path starting a little after the last, then fade the fill in. Hide a path until it starts (a round cap still draws a dot); text takes no pathLength, so letter with paths. AwwO's default preview strips filters, pathLength and stroke-dashoffset from markup, not from script: set them in script.
- **Flow field** (p5.js): the angle at (x, y) is 2 pi k noise(x s, y s) from seeded noise (three.js's `new SimplexNoise({ random: rng })`). Bake each particle's path with a fixed step length; draw its last n points as a streak, or its whole path so far through checkpoints. 1,000 to 3,000 particles of up to 500 steps stay quick; stroke each colour as one path.
- **Moving chart** (D3): keep the data in the page as dated keyframes; between keyframes k and k + 1, interpolate each value and ease each bar from its rank at k to its rank at k + 1, and the axis maximum the same way. Never move a bar toward a target from the last frame. Round numbers the same way every frame; `font-variant-numeric: tabular-nums` keeps digits still.
- **Shader background** (React Bits): a full-screen quad (in three.js, a ShaderMaterial on a 2 x 2 plane under an orthographic camera) whose shader reads a time uniform set from t; stacked, domain-warped noise gives aurora, silk and smoke. For a loop, offset only the warp's noise by R (cos 2 pi t / L, sin 2 pi t / L); offsetting p itself slides the whole field round. Draw it at half size, scaled up, calm behind type.
- **Burst** (mo.js): 6 to 16 pieces at angles 2 pi i / N plus seeded jitter, at distance R x easeOut(p) and size x (1 - p), with a ring that grows while its stroke thins to 0, over 0.3 to 0.6 s from the frame of the event. Bursts need the brief to ask (code-video-brief): mark a real event such as a click or a landing, never decorate.
- **Shader transition** (gl-transitions): pose scenes A and B at the same t, draw each into a render target (HalfFloatType: linear, before tone mapping) and mix them in a ShaderPass ahead of OutputPass with p = ease(clamp((t - t0) / d, 0, 1)), d 0.4 to 0.8 s: a soft-edged wipe, an iris whose radius grows with sqrt(p), a dissolve that shows B where noise is below p, a displacement by A's brightness. In a 2D page, clip B over A with a path.

## Checks

- No script but three.js as AwwO supplies it; no library code pasted in.
- Each effect is closed form, baked or checkpointed, and seeded; renderAt reads nothing an earlier call left.
- The bake ends before `__ready` turns true; holds stay flat; loop periods divide the length.
