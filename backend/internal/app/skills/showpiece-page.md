---
name: showpiece-page
title: One-page showpieces: a study, a diorama or a playable slice with nothing loaded
title_zh: 单页展示作品：材质研究、微缩场景或可玩片段，全部由代码生成
description: Use when a node builds a single-page interactive showpiece whose shape, surface, light and sound are all computed (a material study people can squeeze, a diorama that plays itself, a slice of a game, a machine in weather): one subject and one verb, the page's anatomy (stage, masthead, specimen panel, live readouts, notes), a fixed-step clock with renderAt, an attract mode, handling by direct manipulation, what must survive, and how the piece proves itself with a self-test and frames.
description_zh: 节点要做单页交互展示作品，且形体、表面、光照和声音全部由代码计算时使用（可以捏的材质研究、会自己运行的微缩场景、游戏片段、天气中的机械）：一个主体配一个动作，页面结构（舞台、刊头、标本面板、实时读数、制作笔记），固定步长时钟与 renderAt，自动演示模式，直接操控的手感，必须扛住的异常，以及用自测和多时刻画面证明作品可用。
category: design
applies: html,design,motion
version: 1
attribution:
---
# One-page showpieces

A showpiece proves one idea by letting people handle it. Nothing is loaded: no model, texture, sound or font file; the page computes its shape, surface, light and sound, so it weighs kilobytes and never breaks on a missing asset. For the scene itself use procedural-3d-scene (the three.js AwwO supplies); this skill is the piece around it.

## One subject, one verb

- A subject with a silhouette that reads at a glance, and one behaviour worth touching: it wobbles, melts, inflates, sails, routes, scans. Say it in one caption line: what it is made of and what it does.
- One hero and at most three supporting systems (droplets, bubbles, a wake, a swarm), each with a visible cause: the verb makes them, the hero reacts to them.
- Name it like a plate in a series: a kicker ("Material studies / No. 12"), a title, a subtitle. The frame makes a small thing feel deliberate.

## Anatomy

| Region | Holds |
|---|---|
| Stage | a full-bleed canvas. Centre the hero in the rectangle the overlay leaves free by shifting the projection (`camera.setViewOffset`), not the object |
| Masthead, top left | kicker in small caps, the title in a display serif (Playfair Display or Instrument Serif), a two-line caption; it takes no pointer events |
| Specimen panel, right, about 288 px | three to five choices that change the real thing: variants as swatches, two sliders whose ends are named in words ("trembling" to "set"), three verbs as buttons with their keys, two toggles (quarter speed, show mesh), pause |
| Readouts, bottom left | three or four live numbers measured from the simulation (volume as % of rest, length, count, speed) in JetBrains Mono with units, one line on how to handle the piece, and a footnote saying how the numbers are measured |
| Notes, bottom right | a `details` drawer: how it is built, in four short paragraphs, with the real counts written in by the running page (particles, triangles, draw calls) |
| Status chip | LIVE, PAUSED or the reason it stopped |

Below 860 px the regions stack: the stage becomes a block about 55 % of the height and the rest flows under it. One accent colour; the piece supplies the rest. Panels are thin: 1 px rules, a backdrop blur, no cards inside cards.

## Everything is computed

- Shape from functions: a signed distance turned into a mesh, a profile turned on a lathe or swept along a curve, rules that place instanced parts. Keep one function as the truth (a hull's surface, a body's distance) and place everything else by asking it, so parts always fit.
- Surfaces from seeded noise in a canvas or a DataTexture, or straight in a shader; lettering drawn with the supplied fonts after `document.fonts.ready`.
- Sound synthesized (procedural-sound), started by the first gesture.
- One seed, shown small and settable with `?seed=`; the same seed is the same piece.

## Time

- Simulate in fixed steps of 1/60 s fed by an accumulator, at most 3 steps a frame, the frame's time clamped to 0.1 s; draw once per frame. Pause stops the steps, quarter speed scales the time fed in, and a step button advances one.
- `window.renderAt(t)` rebuilds the state for time t (reset to the seed, then step or evaluate) and draws it, the same picture every time; `window.__ready` turns true as soon as the piece is built. AwwO records and checks the page through them.
- Attract mode: after 8 s without input the piece handles itself (its verbs on a schedule, a slow orbit, an autopilot that presses the same actions a person would). Any input takes over within one frame. Under reduced motion it rests instead.

## Feel

- Every control answers in the frame it is touched. Values the eye follows ease there by damping, `x += (target - x) * (1 - Math.exp(-rate * dt))` with a rate of 4 to 12 per second; nothing snaps and nothing lerps by a constant per frame. Interface transitions take the motion language's durations and curves by name.
- Dragging is direct: cast a ray, hold the point that was hit, show `grab`, `grabbing` and `move` cursors. Dragging empty space orbits; the wheel zooms, or twists what is held; a double click resets the view; a second finger does what the wheel does.
- Light the hero like a product: one large soft key, a rim from behind, a floor that catches a contact shadow. If the material can glow, give a second look ("lights out") on one key.
- Verbs are impulses with a consequence the readouts show (the volume jumps, the count rises), never a canned animation.

## What must survive

- No WebGL 2: a readable panel instead of a black page. A lost context: pause, then rebuild on restore.
- A number that is not finite in the simulation: reset the piece and say so in the status chip.
- A hidden tab pauses; the pixel ratio is at most 2; when a second's mean frame passes 20 ms, lower the simulation's substeps first, then the resolution.
- Every verb has a key and a button; the canvas carries an `aria-label` that describes the scene; reduced motion stops the attract mode, shake and drift.
- No storage: preferences live in memory.

## Prove it

- A self-test (self-test-oracle) on invariants, not on pixels: volume within a few percent of rest after 300 steps, nothing below the floor, the same seed giving the same checksum of positions, `renderAt(2)` twice giving the same checksum, each verb changing its readout. Plant a sign error, a missing clamp and a constraint switched off.
- In the sandbox computer, look at it: `awwo-check-page page.html --out check --frames 0,2,5 --expect-motion --max-draw-calls 300 --budget-ms 60000`, then view `check/frames.jpg`. Read each frame's draw calls and triangles and the shares of clipped white and black, and fix what the pictures show. Without a sandbox, say that nothing was seen running.

## Before you hand over

1. One subject, one verb, a caption that says both.
2. Stage, masthead, panel, readouts and notes present; the layout stacks on a phone.
3. No URL in the page but the three.js import map; one seed; `renderAt` and `__ready` defined.
4. Fixed steps, a clamped frame time, pause and quarter speed; attract mode yields to input.
5. Readouts are measured, with units; the notes' counts come from the page.
6. Fallback panel, lost-context handling, reduced motion, keys for every verb.
7. The hand-over gives the self-test's numbers and what the frames showed, or says they were not run.
