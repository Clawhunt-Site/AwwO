---
name: procedural-3d-scene
title: Procedural 3D scenes in three.js on one HTML page
title_zh: 程序化三维场景：单页 HTML 的 three.js 场景
description: Use when a node builds a 3D scene, world, landscape, city, product stage or generative piece in three.js: the three.js r186 and addons AwwO supplies, a seeded generator pipeline (terrain, scatter, structures, sky, water, life), light and colour management, post-processing, a frame budget, controls, determinism for recording, and a checklist.
description_zh: 节点用 three.js 做三维场景、世界、地形、城市、产品展台或生成艺术时使用：AwwO 自带的 three.js r186 与扩展模块，基于种子的生成流程（地形、散布、建筑、天空、水面、生命感），光照与色彩管理，后期处理，帧预算，镜头控制，可录制的确定性，以及交付前检查。
category: design
applies: html,motion,design
version: 1
attribution:
---
# Procedural 3D scenes

## Load three.js the way AwwO supplies it

AwwO's previews supply three.js r186 (0.186.1) and its addons with no network, through exactly this import map, written in the head before one `<script type="module">`:

`<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"}}</script>`

Write `import * as THREE from 'three'` and literal addon paths such as `three/addons/controls/OrbitControls.js`. Supplied addons include postprocessing (EffectComposer, RenderPass, UnrealBloomPass, OutputPass, SMAAPass, BokehPass, FilmPass), objects (Sky, Water, Reflector), math (SimplexNoise, ImprovedNoise), utils/BufferGeometryUtils.js, environments/RoomEnvironment.js, geometries/RoundedBoxGeometry.js and misc/GPUComputationRenderer.js. Nothing else loads: no texture, model, HDR or font by URL; make textures in code (a CanvasTexture, a DataTexture or a shader). If the node's output policy names only three.js r128, use r128 by that tag instead.

## Determinism first

- One integer seed, shown in a corner and settable with `?seed=`, feeds a small generator (mulberry32 or sfc32). Every random choice comes from it, never from Math.random; `new SimplexNoise({ random: rng })` makes the noise seeded too (ImprovedNoise has a fixed table: offset its input by seeded amounts). The same seed rebuilds the same world.
- Everything that moves is a function of time in seconds: `update(t)` sets it from t alone. The loop passes `t = (timestamp - start) / 1000` (its timestamp is in milliseconds; THREE.Clock is deprecated in r186). Expose `window.renderAt = t => { update(t); draw(); }`, which AwwO calls with t in seconds when it records frames; start with `window.__ready = false` and set it to true in code as soon as the world is built, never from a timer or an animation frame.

## Generator pipeline

Build in passes, each a pure function of the seed that writes its geometry once:

1. Height field: fractal noise (4-6 octaves, lacunarity 2, gain 0.5) on a rotated PlaneGeometry; ridged noise (1 - |n|) for mountains; a domain warp (offset each sample by a second noise) so no grid shows. Keep the heights in an array that later passes sample.
2. Surface from data: vertex colours by height and slope (sand at the shore, grass on gentle ground, rock where the normal's y is under about 0.75, snow above a noisy line), set once per vertex.
3. Water: a plane at sea level, either the Water addon (it needs a normal map: a tileable DataTexture from noise with wrapS and wrapT set to RepeatWrapping; it also re-renders the scene for reflections) or a short shader with fresnel and two scrolling normals; foam where the water is shallow.
4. Scatter: Poisson-disc or jittered-grid points kept where a mask, the slope and the height allow; one InstancedMesh per kind (trees, rocks, houses, crystals) with scale, rotation and colour per instance from the seed. Cluster them with a second, low-frequency noise. Call computeBoundingSphere() after setting the matrices so culling sees every instance.
5. Structures: rules and recursion, such as towers of stacked, shrinking boxes, roads along a CatmullRomCurve3 pressed into the terrain, branches grown recursively; merge each kind's static parts with BufferGeometryUtils.mergeGeometries.
6. Sky and air: the Sky addon (its uniforms include clouds) or a gradient dome; FogExp2 in the horizon colour so distance reads; one sun direction shared by the sky, the light and the water.
7. Life: dust, fireflies, snow or embers as Points moved in the vertex shader from a time uniform; a few drifting soft sprites; a slow idle camera path.

## Light and colour

- `renderer.outputColorSpace = THREE.SRGBColorSpace`, `renderer.toneMapping = THREE.ACESFilmicToneMapping` (or AgX), exposure 0.9-1.2. Colours written as hex or CSS strings are treated as sRGB.
- Sun: one DirectionalLight casting shadows, a 2048 map, the shadow camera fitted tightly around what is on screen, bias about -0.0005 and normalBias 0.02. PCFSoftShadowMap is gone in r186: use PCFShadowMap with `shadow.radius`, or VSMShadowMap. A HemisphereLight adds sky and ground bounce; a PMREM of RoomEnvironment or of the Sky lights physical materials.
- Keep the sky coloured: if the top of the frame burns to white, lower the exposure first, then the Sky's rayleigh; turbidity changes haze and extinction together and can whiten it, so tune it on its own. Draw beams, shafts and glows with `transparent: true`, additive blending, `depthWrite: false` and alpha fading along them, never as an opaque mesh.
- Palette: in the scene, one dark body colour, one haze colour and up to three light colours (the sun, warm windows, one glow), taken from the brand or a direction (design-directions' cinematic dark suits most scenes); the interface over the scene keeps a single `--accent`. Saturate only what emits light or matters; push emissive colours above 1 only where bloom should catch.

## Post-processing

An EffectComposer with RenderPass, then UnrealBloomPass (strength 0.4-0.9, radius 0.4, threshold about 1.0: the composer works in linear HDR, so a lower threshold makes sunlit snow, sand and walls glow too), then SMAAPass if edges shimmer, then OutputPass last, which applies the tone mapping and colour space. Resize the composer with the renderer.

## Budget

- About 300 draw calls and 1.5 million triangles at most; instancing and merging get there.
- Pixel ratio at most 2. Average the frame time over a second; above 20 ms, step down the pixel ratio (`composer.setPixelRatio` as well as the renderer's), then bloom, then shadows, instead of dropping frames. Once `window.renderAt` has been called, AwwO is recording on its own clock, where every frame seems to take 1000/fps ms: stop your own loop (`renderer.setAnimationLoop(null)`), keep full quality and stop auto-orbiting.
- One loop (`renderer.setAnimationLoop`) with a clamped time step; it pauses while the tab is hidden; regenerating disposes the old geometry, materials and textures.

## Controls

OrbitControls with damping, a set target, minDistance and maxDistance, and maxPolarAngle just under PI/2 so the camera stays above the ground; a gentle auto-orbit after 8 s idle that stops on any input; a Regenerate button that picks a new seed; every control reachable by keyboard. Under reduced motion, no auto-orbit and no drifting particles.

## Composition

Frame it like a photograph: a focal point on a third, layers in front, middle and back, a field of view of 35-45 degrees, the horizon off-centre. Give a sense of scale (a figure, a lamp, a door). Keep the overlay text small, in a corner over a scrim; the scene is the hero.

## Robustness

Create the renderer inside try and catch: r186 needs WebGL 2 and throws without it, so show a readable message instead of a black page, and do the same on a lost context. Log shader compile errors. Resize the renderer, the composer and the camera's aspect together. Never depend on localStorage; wrap fullscreen and pointer-lock calls.

## Before you hand over

1. Only the import map above (or the r128 tag a policy names); no other URL anywhere in the page.
2. The same seed rebuilds the same world; the seed shows; `window.renderAt(t)` and `window.__ready` exist.
3. A focal point, depth from fog or layers, and light on what matters; bloom only on the bright parts.
4. Within the draw-call and triangle budget; pixel ratio capped; the loop pauses when hidden.
5. A message without WebGL 2; resizing handled; reduced motion honoured.
6. The hand-over says what was read from the source and what was not seen running.
