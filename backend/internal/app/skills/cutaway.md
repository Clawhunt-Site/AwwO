---
name: cutaway
title: Cutaway: one picture into a 3D object that takes itself apart
title_zh: 一图拆解：把一张图做成能自己拆开的三维物体
description: Use when someone gives a picture of a robotic animal, machine or device and wants it rebuilt in three.js on one page as an object that opens part by part (a cutaway or exploded view), with a button per part and a film script: measure the picture, write a checklist for it, build every part in code, grade a still against the picture before any film, and give every part its own camera.
description_zh: 用户给出一张机械动物、机器或设备的图片，想在一个页面里用 three.js 把它重建成能逐个部件拆开的三维物体（剖视、爆炸图），每个部件一个按钮，并带拍摄脚本时使用：先量图、为这张图写检查清单、全部部件用代码搭、先拿静帧对照原图打分再拍片、每个部件有自己的机位。
category: design
applies: html,motion,design
version: 1
attribution: Adapted from cutaway by Nyxera0x, built on claude-motion by whaleyxbt (MIT, Copyright (c) 2026 Nyxera0x, Copyright (c) 2026 whaleyxbt); modified for AwwO
---
# Cutaway

One picture in; one object out, built entirely in code, that opens part by part while a camera finds each part. The page is the deliverable: the object in the middle, an invented product name and title, one button per part, and small cards that follow the motion. The same code plays a film from one beat script.

## Where this runs

- On a node without tools you write the page, the checklist and the script. You cannot render or look at a still, so say that the still has not been graded, and ask the user to compare the page with the picture.
- In the sandbox computer, check the page with awwo-check-page, look at its screenshot when your workspace can show you images, and measure with Python and Pillow (installed).
- A dense object draws fast on a GPU and slowly without one. A 1920x1080 frame of a build with about 260 small parts, clearcoat, glass and bloom took about 0.1 s on a GPU and about 9 s on a software renderer. AwwO renders video without a GPU, so keep the film short and within the budget in step 3, or deliver the page and say the film needs a GPU render.

## 1. Read the picture before any code

The picture sets the look; never embed or trace it, rebuild it.

- Measure the main proportions as shares of the body length: height, head, jaw or limb length. Write the numbers down.
- Measure density: crop the picture to the object's bounding box and take the share of dark pixels (luma under 80).
- Subjects with many joints and a dense core work; a long smooth shell reads as a toy however many rounds it gets. One main set of limbs per creature: legs, or wings, or tentacles.

## 2. A checklist for this picture

Before the first line of code, write 10 to 12 numbered lines a reader could check: the silhouette and pose, the key features in order of size, the materials, where the accent colour sits. Put a number in every line that can take one ("bristles 0.15–0.25 of the leg's thickness", not "thin bristles"), and write "never" where the default would be wrong ("panes of clear glass, never a solid white shell").

## 3. Build it as parts

- Every part that comes apart is its own group with a named anchor point; one pose(state) function sets the whole object for one moment.
- Two levels of mechanism: big parts (gears, rings, actuators) and many small ones (pistons, hoses, screws), with windows cut into the shells so the dark core shows. Break white surfaces into separate curved plates in three sizes with gaps over the mechanism; scattered dots do not count as density.
- Every limb has its own pose and segment lengths, never a row of identical copies.
- The accent colour only as lines and glows on tips, rims, edges and joints, marking what moves now.
- Budget: share a few materials across all parts (each distinct material is one more shader to compile before the page is ready), merge static small parts into one geometry or an InstancedMesh, cap the pixel ratio at 1 for renders, use one shadow-casting light, and keep bloom optional.

## 4. The still loop, before any film

1. Render one still posed like the picture.
2. Put the picture and the still side by side, also at about 900 px wide, the size most people will see.
3. Grade every checklist line yes, partial or no against the picture, never against what you remember building, plus one line: at small size, does it look as dense?
4. Measure: your dark-pixel share reaches 0.8 of the picture's, and the proportions match within a few hundredths.
5. Fix the no's, then the partials. After round 2, stop and show the user the side-by-side and the grades. Nothing is filmed until they approve the still.

## 5. The film from one beat script

- Keep the whole film in one script the page reads, in seconds: {"duration": 10, "script": [{"t": 1.5, "act": "wing"}, {"t": 3.8, "act": "exploded"}, {"t": 6.6, "act": "assemble"}, {"t": 7.8, "act": "hero"}]}. Cutting a beat is deleting a line.
- Frame 0 is the thumbnail: the front three-quarter view, the object big and already moving.
- A part opens in about 1 s, holds while its parts keep turning, and closes in about 0.5 s; a new beat every 2 to 3 s; then a full explode on a slow turntable, a fast reassembly and an exit.
- Every beat gets its own camera: its own side, height and distance, aimed at that part and pushing in while it hangs open. The opened part stays in view; the rest may leave the frame. Camera paths are smooth and never copy a footstep or a wing beat; visible wing beats stay at 1.5–2.5 Hz.
- A short version has its own script (the opening, one part, the explode, the exit), never pieces of the long film. A scene up to about 1.15 times the target length may play faster, with its sound stretched by the same factor.
- When a similar body already has an approved film, reuse its beat times and moves and change the body only; a new body on a new choreography takes about twice the rounds.

## 6. Renderable code

- Load three.js the way AwwO supplies it, in the head before one module script: `<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"}}</script>`, with literal addon paths. No model, texture or font by URL: build everything in code.
- Define window.renderAt(t): it draws the whole frame for time t from scratch, from the script and from tables built at load. Anything integrated over time (a gait, a speed ramp, the gears' clock) is tabulated at load, never stepped frame to frame.
- No Math.random, Date or timers in renderAt; use a seeded generator at setup. Start with window.__ready = false and set it to true once the scene is built and its shaders compiled, from promises, never from a timer.
- In shaders, clamp every pow() base: one NaN pixel can black out a frame through bloom. Write 1.0 - smoothstep(b, a, x) instead of smoothstep(a, b, x) with a > b, which some graphics drivers return as 0.
- A score, if any, reads the same script: a quiet click per button press, a short accent on each part that moves, a bed under the whole; continuous motion stays silent. Master around -14 LUFS.

## Checklist

- The picture's measurements and its checklist came before the code.
- Every opening part is its own group with an anchor and returns exactly where it was; nothing passes through anything.
- The still was graded line by line against the picture, its density measured, and the user approved it before any film; otherwise you said plainly that it has not been graded.
- Every beat has its own camera; no two beats from the same spot.
- renderAt depends only on t, and __ready never waits on a timer.
