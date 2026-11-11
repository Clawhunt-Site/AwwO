---
name: painterly-render
title: Painted look: a 3D or 2D scene drawn every frame by GPU brush strokes
title_zh: 手绘画面：每一帧用 GPU 笔触把 3D 或 2D 场景画出来
description: Use when a game, scene or film should look hand-painted (gouache, oil, impressionist) instead of rendered: draw the scene into a target, then paint it with hundreds of thousands to a few million instanced strokes in one draw call, coloured from a simplified copy of the scene, turned along its edges, layered from coarse to fine, held steady between frames and re-seeded at a low rate; with the numbers that made it read as paint, the cost of a frame, quality tiers, and how to check it by frames.
description_zh: 游戏、场景或影片要像手绘（水粉、油画、印象派）而不是渲染出来的样子时使用：先把场景画进渲染目标，再用一次绘制调用画几十万到几百万个实例化笔触，颜色取自简化过的场景，方向顺着边缘，由粗到细分层，帧与帧之间保持稳定并以低频率重新落笔；给出让它读起来像颜料的数值、每帧开销、画质分档，以及按多时刻画面检查的方法。
category: design
applies: html,design,motion
version: 1
attribution:
---
# Painted look

A scene reads as painted when its colour is simplified, its strokes follow its forms, and detail sits only where the picture changes. Stroke count alone does not do it: a million and a half strokes sampled straight from a render read as a noisy photograph.

## Pipeline: one look, two passes

1. Draw the scene (three.js, a raymarch, a 2D canvas) into a target at half the canvas size and build its mip chain every frame (`generateMipmap`, or a few downsample passes).
2. Draw all strokes in ONE instanced call of a quad (four vertices, a triangle strip) with no per-instance attributes and no uploads: the vertex shader takes `gl_InstanceID`, finds its layer and its grid cell, and draws everything else from an integer hash of the id (one PCG step): jitter in the cell, length, width, value drift.
3. Clear to a paper colour first, so the gaps read as canvas, and blend strokes with premultiplied alpha in instance order: coarse layers first.

## Numbers that read as paint

| Knob | Value | Why |
| --- | --- | --- |
| layers: share of strokes, length x width at 1080p | 8 % at 96 x 30 px, 32 % at 42 x 12, 60 % at 17 x 5 | block-in, forms, detail |
| mip level each layer reads | about 4, 2.6 and 1 | coarse strokes see a simplified picture |
| detail strokes | only where the luminance gradient passes about 0.05; the rest are moved off screen | flat areas stay broad; detail everywhere becomes grain |
| palette | each colour pulled about 55 % toward 7 steps a channel | a limited palette, not a photo |
| drift per stroke | value 4 to 5 %, hue at most 1.5 % | 5 % hue drift reads as coloured noise |
| direction | across the gradient read one mip coarser, plus up to 0.35 rad of jitter; flat areas lie nearly level | strokes flow along forms |
| brush | a round tip, a tapering tail, bristle grooves along the length, an edge ridge 15 to 20 % darker | a stroke you can see at 1:1 |
| re-seed ("boil") | 8 times a second, each re-seed moving local brightness only a few per cent; one seed held under reduced motion | hand-made, not crawling |

## Steady strokes

Strokes anchored on a screen grid hold while the camera holds; a fast camera move makes them swim. For moving shots, seed each stroke from a world-space cell of the surface under it and re-seed only at the boil rate. Never re-seed every frame. `renderAt(t)` takes its boil step from the whole number of t times 8, so no frame depends on another.

## Cost and tiers

- The stroke pass is one draw call whatever the count; the scene pass costs what the scene costs. A simple scene plus 1.5 million strokes measured 3.8 ms a frame at 1920 x 1080 on a desktop GPU.
- Strokes are bound by fill. At the sizes above, 1.5 M strokes cover the frame about 300 times over (the block-in layer alone about 170, the detail layer far less, since most detail strokes are moved off screen): a desktop GPU paints that, integrated graphics will not. Cut the block-in count first, then shrink the strokes; the detail layer is what reads as paint.
- Tiers: 1.5 M, 600 k, 250 k strokes for live play, chosen from its frame times. A recording is a different case: AwwO's render worker draws on a software renderer (the sandbox computer uses the same one), films of up to 20 s in 360 s for the whole render, about half a second a frame at 30 fps with its screenshot. Time one frame in the sandbox, size the recording's tier so a frame takes well under that, write it down, and keep it fixed: under `renderAt(t)` the renderer's clock, not the GPU, sets the frame times. Shrink the scene target before cutting strokes.

## Composition still decides

The look does not rescue a weak picture. One focal subject, a value structure that reads in grey at thumbnail size, and the boldest strokes where the eye should go. A field of identical shapes stays dull at any stroke count.

## Check it by frames

In the sandbox computer, `awwo-check-page page.html --out check --frames 0,0.13,3 --max-draw-calls 50 --budget-ms 60000`, with the scene and the camera held still for the check: the first two frames then differ only by the boil (in a moving shot the difference is overall motion, not the boil), and the strokes add one draw call to the scene's own. The contact sheet `check/frames.jpg` is scaled down (at most 640 px a frame): judge composition and value there. To judge single strokes, run one frame at a viewport of 640 x 360 (`--viewport 640x360 --frames 3`), whose cell is then the frame at full size; the strokes scale with the canvas, so judge the brush on the block-in strokes there (the detail strokes shrink to a few pixels). Without a sandbox, say that the look was not seen.

## Before you hand over

1. A scene target with mips; one instanced stroke call; no per-stroke attributes or uploads.
2. Three layers with the numbers above; detail only at edges; a limited palette.
3. A low boil rate; world-anchored strokes on moving shots; `renderAt(t)` depending on t alone.
4. Two tiers, each measured and stated: the live one from live frame times, the recording's from one frame on the software renderer, kept fixed for the whole film.
5. What the frames showed, or a plain statement that they were not run.
