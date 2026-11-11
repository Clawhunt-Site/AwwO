---
name: render-passes
title: Render passes: a look of its own for a three.js scene
title_zh: 渲染通道：让 three.js 场景拥有自己的画面风格
description: Use when a three.js r186 scene needs a signature look that the stock materials and one bloom pass cannot give: see-through solids with thickness and refraction (jelly, glass, wax, ice), 3D drawn as pixel art (low-resolution target, outline, bands, dither, a fixed palette), wet ground with reflections at night, light shafts you can see, soft contact shadows. Gives the plumbing (targets, order, shared uniforms), each look as steps with its numbers, the grade and output, the cost of a pass, and how to check the result by frames.
description_zh: three.js r186 场景需要标准材质加一道辉光给不出的招牌画面时使用：有厚度和折射的半透明实体（果冻、玻璃、蜡、冰）、三维画成像素画（低分辨率渲染目标、描边、色阶、抖动、固定调色板）、夜晚带倒影的湿地面、看得见的光柱、柔和的接触阴影。给出管线搭建（渲染目标、顺序、共享 uniform）、每种画面的步骤与数值、调色与输出、每道通道的开销，以及用多时刻画面检查结果的方法。
category: design
applies: html,design,motion
version: 1
attribution:
---
# Render passes

procedural-3d-scene gives a scene that is lit and toned correctly. A look people remember comes from owning a few passes between the scene and the screen. Choose one look and carry it through; two looks in one page cancel each other.

## Plumbing

- A target: `new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 })`, with `depthTexture: new THREE.DepthTexture(w, h)` when a later pass reads depth. Resize every target with the renderer and cap the pixels drawn (about 2.3 million).
- A frame, in order: depth and shadow passes; the scene into a half-float target, in linear light; the look's passes; then one output pass to the canvas (`renderer.setRenderTarget(null)`) that tone maps, converts to sRGB and adds noise of half a code value so gradients do not band.
- A full-screen pass is one triangle with a ShaderMaterial (`FullScreenQuad` from three/addons/postprocessing/Pass.js). Give every material of the pipeline the same uniforms object for the camera, time and the light, so they cannot disagree.
- For a depth or thickness pass draw the same meshes with another material: `scene.overrideMaterial`, or a second Scene holding the same geometries; `side: THREE.BackSide` draws back faces.
- At start, render 2 x 2 pixels through the whole pipeline inside try and catch. If a shader fails, fall back to the plain forward render and say so in the page; never leave a black canvas.

## See-through solids: jelly, glass, wax, ice

1. Behind: render everything except the solid, and whatever sits inside it (seeds, bubbles, a core), into a half-float target. Keep linear depth in its alpha.
2. Back faces: render the solid's back faces writing linear depth, keeping the farthest.
3. The solid, front faces, in one shader:
   - thickness = back depth minus front depth, cut short by the depth of what is behind;
   - refraction: sample the behind target at `uv + N.xy * k * thickness` for an index of 1.3 to 1.5, five to seven taps spread by roughness;
   - absorption (Beer-Lambert): transmit `T = exp(-sigma * thickness)` per channel, with `sigma = -log(colour) * density`, so thin parts stay clear and thick parts take the colour;
   - scatter: add `(1 - T) * colour * light`, wrapped (`(N.L + 0.4) / 1.4`) so the shadow side still glows;
   - surface: a Fresnel reflection of the environment (Schlick with F0 0.04) and one tight highlight.
4. Its shadow is coloured: let the shadow pass write how much light the solid lets through, or lighten the shadow by `T`.
5. A glow inside ("lights out"): add the emitter's colour times T over the path from the emitter to the surface, and let it light the floor.

## Pixel-art 3D

1. Render at `ceil(cssSize / pixelSize)`, pixelSize 2 to 4, into a target with NearestFilter and a depth texture; show the canvas with `image-rendering: pixelated`.
2. Outline: four depth taps one texel away; where the largest difference passes a threshold that grows with depth, multiply the colour by 0.4.
3. Bands: quantise the diffuse term to three or four steps; flat shading per face for boxes.
4. Dither: before the palette, add the 4 x 4 Bayer value minus 0.5, times 0.03, to the lightness.
5. Palette: map each pixel to the nearest of at most 64 fixed colours, compared in OKLab with lightness weighted 1.5. Bake the mapping into a 32 x 32 x 32 lookup texture once; a loop over the palette per pixel is the costliest way.
6. Snap the camera's target to the texel grid in view space, or the picture crawls as it moves. Use an orthographic camera, or a field of view under 30 degrees.

## Wet ground at night

- One mask from seeded noise: puddle height, dampness, wear. Roughness ramps without a step: dry 0.75, damp 0.4, soaked 0.2, standing water 0.06. Wet albedo is darker, times 0.6. In puddles the normal goes flat and takes two or three rings of rain ripples.
- Reflection: mirror the camera in the ground plane and render the scene into a half-size target every second frame, with a clipping plane at the ground; sample it pushed by the normal and blurred with roughness. The Reflector addon does the mirror for a simple scene.
- Lights sell it: a few warm lamps, their long streaks in the water, a dark sky.

## Light you can see

- At half resolution, march 16 to 24 steps from the camera to the scene's depth; at each step read the sun's shadow map and add in-scattered light: density (0.003 to 0.02 per unit) times the light colour times a Henyey-Greenstein phase with g about 0.7.
- Start each ray at a jittered offset (interleaved gradient noise) and upsample with a depth-aware filter, or the steps show as bands. One light only.

## Soft contact

- Shadows whose edge widens with distance: 8 taps on a spiral find the average blocker depth, the penumbra is `(receiver - blocker) / blocker` times the light's size, then 16 taps filter at that width, rotated per pixel. r186 has no PCFSoftShadowMap; `VSMShadowMap` or PCFShadowMap with `shadow.radius` are the stock choices.
- An object on a floor: render its height from below into a 1,024 px orthographic target once a frame; darken the floor where the height above it is small, with two or three rings of taps. This grounds a hero better than any other pass.

## Grade and output

Bloom only above 1.0 in linear light, strength at most 0.6. Tone map with AgX, ACES or a neutral curve; keep whites from clipping on the hero. Vignette up to 0.3, grain up to 0.02, colour fringing up to 0.0015 and none under reduced motion. Anti-alias with the target's samples, or FXAA or SMAA last.

## Cost

- A full-resolution pass costs about a millisecond at 1080p on an integrated GPU: at most six passes, with ambient occlusion, shafts and reflections at half size.
- Quality tiers choose the shadow map (1,024, 2,048 or 4,096), the samples (0, 2 or 4) and the march steps; pick a tier from the first second's frame times.
- Dynamic resolution: while a second's mean frame is over 21 ms, scale the targets down in steps to 0.6; scale back up under 17 ms.

## Check it by frames

In the sandbox computer, `awwo-check-page page.html --out check --frames 0,3,6 --max-draw-calls 300 --budget-ms 60000`, then look at `check/frames.jpg`. In `report.json`, a frame's `pixels.bright` over 0.05 is clipped white, a `lumaStdDev` under 12 is murk, and `gl.drawCalls` counts every pass's draws. Without a sandbox, say that the look was not seen.

## Before you hand over

1. One look, named; every pass has a reason.
2. Half-float targets in linear light; one output pass with tone mapping, sRGB and dither.
3. A start-up test render and a fallback to the plain render.
4. Targets resized with the window; pixel count capped; tiers and dynamic resolution.
5. The hero neither clipped nor lost in the dark; reduced motion drops fringing, shake and grain flicker.
