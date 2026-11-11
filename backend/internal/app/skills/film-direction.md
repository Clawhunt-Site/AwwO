---
name: film-direction
title: Directing a film written as code: numbers for adjectives, the score as the clock, and what done means
title_zh: 导演代码影片：用数字代替形容词，以乐谱为时钟，说清楚“完成”的定义
description: Use with code-motion or the film kit when a film written as code must be good, not merely render: replace every adjective in the brief with a number (materials, light, lenses, timing, springs by name), let one score or timing file drive picture and sound, keep the hero large and wholly inside the frame in every shot, carry one shape through a state list in interface films, define what finished means, and use the repair lines that fix the common failures.
description_zh: 配合 code-motion 或影片套件使用，当代码影片不只要能渲染、还要好看时：把简报里每个形容词换成数字（材质、光、镜头、时间、按名字取用的弹簧），让一份乐谱或时间表同时驱动画面和声音，每个镜头里主角都够大且完整入画，界面影片用一个形状串起状态列表，说清楚“完成”的定义，并给出修好常见问题的修复句。
category: video
applies: video,motion,html
version: 1
attribution:
---
# Directing a film written as code

An exact model handed a loose brief makes exact defaults. Directing means writing the decisions down as quantities before a single frame is drawn.

## Quantities in place of adjectives

| Vague word | What to write |
| --- | --- |
| premium | a clearcoat of 0.35 over a surface roughness of 0.38 |
| warm against cool | key light at 3200 K, rim light at 7500 K |
| cinematic | lenses by job: wide shots 35 mm, action 50 mm, faces 85 mm; focus held on the hero's true distance in each frame |
| smooth | the enter curve, named |
| bouncy | the bounce spring, kept for a single moment |
| snappy cutting | cuts land on beats; a beat lasts fps times 60 divided by the tempo in frames (30 frames at 120 BPM and 60 fps) |
| readable | every line of text stays up 1 s plus 1 s for each 4 words, or each 5 Chinese characters |

Each row of a brief states: the shot's single idea; the duration in seconds, the fps and the frame count; colours as hex; typeface, weight and size; what moves and between which frames; motion by token; holds; a list of forbidden looks (glowing orbs, gradients in purple, every element fading in, zooms standing in for energy); the frames a reviewer must see; and how the loop closes.

## Timing comes from one score

- Write the event list first (notes, beats, hits). It is the film's clock: jumps, key presses, cuts and camera moves are all derived from it and none is placed by eye, so sound and picture stay locked together.
- Sound reads its times from the same file: a contact sound peaks on its contact frame, a whoosh leads the cut it carries by 2 to 3 frames (film-sound), and any other lead or lag is written beside its own event, never applied to every sound at once.
- Prevent overlaps by layout rather than by repair: route moving things on paths that cannot cross (falling notes travel behind the keyboard, never through the performer).

## Measure the hero

- Minimum hero width: 170 pixels in a 1080p frame for every main shot, or 95 when several heroes share a row. Measure it shot by shot from the hero's projected bounding box. Opening frames are usually framed too loose, so settle size on stills while renders are still cheap.
- Measure how much of the hero is inside the frame as well. In one test a low shot met the width rule while cropping off the hero's head; letting the camera follow the hero's height, averaged over half a second, fixed it without making the camera hop.
- Energy belongs to cuts placed on beats. A strong angle holds for at least one beat. A film never shakes its camera (MOTION.md): an impact gets a cut, a light accent kept under three flashes a second, or the subject's own recoil.
- One hero motion at a time: when the camera travels to a new beat, the thing it shows starts moving once the camera has arrived; a card or caption appears only when nothing under it moves.

## Interface films: one container through a state list

A single container changes its size, corner radius and colour through the states (mark, button, input, spinner, tick, dashboard, chart, tooltip, command palette, toast, mark again); a pointer clicks every change, and the loop closes on the opening state. For each state, write how it enters, how it leaves and why it exists; drop any state you cannot justify. Stack springs so that each frame is computable alone: the value at time t equals the starting value plus, for every later state, its step multiplied by that spring's progress since the state began (sheet for size, snappy for the radius). Colour and opacity settle exactly, with no overshoot.

## Finished means

On AwwO a film node delivers the page; AwwO's render worker records it (up to 20 s) and an edit node levels the sound. Finished there means: `renderAt(t)` pure; in a sandbox computer, `awwo-check-page --frames` run with its frames and figures (stills, motion between frames, draw calls); the checks it could not run, named. The sandbox has no video encoder and stops a command after 30 s (120 s with the web), so do not try a full render or install one: the full render, frozen stretches, the loop joint and the loudness of the encoded file belong to a place that has an encoder. A failed check, a timeout or a missing font gets two repairs; if it fails a third time, deliver what works and name the failure and what was tried. Halt only for material a person must supply, and name it precisely.

## Lines that repair common failures

- A tiny hero: "Hold the hero to a 170 pixel minimum width in each main shot of a 1080p frame; measure every shot and list the figures."
- Stills pass but the film looks frozen: "Report change per second and the largest change in any tile of the frame; a pointer crossing a static layout is a hold, while no change anywhere is a freeze."
- Sound out of step: "Take every sound's time from the timing file; a contact sound peaks on its contact frame, and any lead or lag is written beside its event."
- A jolt where the loop joins: "Draw frames 0 through N minus 1; the closing frame must lead into the opening one in pose, speed, camera position and lighting."
- Preview and render land differently: "Compute every spring in closed form from t; carry nothing over from the previous frame."
- Words clipped by the edge: "A word is either entirely inside the frame or entirely outside it."
- Unrequested captions: "Show only the words listed in this brief."

## Before you hand over

1. The brief written in quantities, with the timing file first.
2. Hero width and in-frame share for each shot, or a plain note that they were not measured.
3. For interface films, the state list with a reason for each state.
4. What finished meant this time, and which checks ran, with their figures.
