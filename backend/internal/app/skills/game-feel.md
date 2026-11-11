---
name: game-feel
title: Game feel: response, weight, feedback and a game that plays itself
title_zh: 游戏手感：响应、分量、反馈，以及会自己玩的游戏
description: Use when a node builds a browser game or a playable slice and it must feel good in the hand, not only work: the fixed step and the input map (keyboard, pointer, touch stick, gamepad), buffering and forgiveness windows, movement and camera numbers, feedback stacked in cheap layers for each event, an attract mode driven by an honest autopilot that also drives the self-test and the cover recording, pacing of the first minute, the HUD, and the tests and planted failures that hold the feel to numbers.
description_zh: 节点做浏览器游戏或可玩片段，并且要求手感好而不只是能运行时使用：固定步长与输入映射（键盘、指针、触屏摇杆、手柄），输入缓冲与宽容窗口，移动与镜头的数值，每个事件用几层低成本反馈叠加，由真实自动驾驶驱动的自动演示（同时驱动自测和封面录制），第一分钟的节奏，HUD，以及把手感落到数字上的测试与植入缺陷。
category: design
applies: html,code,motion,design
version: 1
attribution:
---
# Game feel

A game that works and a game that feels good differ in three things, none of which needs content: how fast it answers, how much weight things seem to have, and how many senses confirm each event. Decide the numbers below before the levels.

## Time and input

- Simulate in fixed steps of 1/60 s from an accumulator (at most 5 steps a frame, the frame's time clamped to 0.1 s). Sample input once per step. Draw every frame, between the last two states when motion is fast.
- Map devices to actions and let the game read only actions: the keyboard by `event.code`; the pointer; a standard gamepad polled each step with a dead zone of 0.18; touch. On a coarse pointer show a stick at the bottom left (about 120 px, its direction taken through the camera) and action buttons in an arc at the bottom right, inside the safe-area insets.
- Remember a press for 100 to 150 ms, so one made a moment early still counts (a jump before landing, the next attack before the last ends). Allow 80 to 120 ms of grace after leaving a ledge. Hold-to-act takes 0.4 to 2.5 s with a ring that fills, and releases cleanly.
- The first gesture unlocks the sound. Losing focus pauses. Pointer lock and fullscreen are asked for inside try and catch, and the game stays playable without them.

## Movement and camera

| Quantity | Range |
|---|---|
| reach top speed | 80 to 150 ms |
| stop | 60 to 100 ms |
| jump | height set by how long the button is held; gravity 1.6 to 2 times stronger on the way down |
| camera follow | damped at 6 to 10 per second: `x += (target - x) * (1 - exp(-rate * dt))` |
| look-ahead | 10 to 20 % of the view in the direction of travel |
| field of view | changes by at most 10 degrees (speed, aim) |
| grid movers | glide between cells over the step interval; never jump a cell in one frame |

Aim and steering get the same treatment: a small dead zone, a response curve that is gentle near the centre, and a sensitivity setting.

## Feedback in layers

Each event that matters is confirmed by three to five cheap layers at once; any one alone is weak.

| Event | Layers |
|---|---|
| a hit lands | 40 to 80 ms of hit-stop (time scale near 0.05), one frame of white on the target, 6 to 12 pooled particles along the normal, a shake of 4 to 8 px that dies in 150 to 250 ms, a sound pitched within 5 % at random, a number that pops |
| taking a hit | a red vignette pulse, a directional arc, a low thump, the camera pushed away from the source |
| a pickup | the item scales up and vanishes with the bounce spring, a ring expands, a tone one step up the scale from the last pickup, the counter ticks |
| failure | 600 ms at a fifth of the speed, colour drains, one low sound, then a restart within 1.5 s |
| a goal reached | a banner with the scene-length entrance, the music lifts a layer, the next goal appears at once |

- Shake is `trauma squared` times smooth noise, capped, with rotation under 2 degrees; reduced motion turns it off with flashes and hit-stop. Never more than three flashes a second.
- Pool everything that appears and disappears (particles, decals, popups): no allocation while playing. One InstancedMesh per kind of particle.
- Interface motion takes the motion language's durations, curves and springs by name.

## A game that plays itself

- Until someone touches it, the game plays: an autopilot presses the same actions a person would. Keep it honest and simple: a shortest path that also checks it is not walking into a dead end; a target chosen by distance and danger; a driver that looks one corner ahead. It should play well enough to show the game and badly enough to stay interesting.
- Any input takes over within one frame; after 8 to 10 s without input the autopilot returns and a small chip says how to play.
- Everything random comes from one seeded generator, so the same seed replays the same game: the autopilot is then also the self-test's driver and the cover recording's actor, and `window.renderAt(t)` can rebuild second t by replaying steps.

## The first minute

- A first success within 10 s, with no text to read first. One new idea at a time, each shown before it is tested.
- Raise the pressure every 20 to 30 s (speed, count, a new kind), and ease it after a failure.
- Show the score always and health only when hurt. Keep the best score in memory; storage may be refused in the frame.
- Finish the loop: title or attract, play, an end screen with the numbers that mattered, and one key to go again.

## HUD and settings

- Corners, over scrims; numbers in JetBrains Mono with tabular figures; goals as a short line and a marker in the world; hints as key caps that change with the device in use.
- Settings in one panel: sound, sensitivity, quality, reduced effects. Every action remappable is a luxury; every action reachable by keyboard, touch and gamepad is the minimum.

## Tests and planted failures

Drive the game through its actions in fixed steps, with no animation frames:

1. A press 100 ms before landing still jumps; one 300 ms before does not.
2. From rest, top speed is reached within 9 steps and lost within 6.
3. A hit holds the simulation for 3 to 5 steps and then lets it run.
4. The autopilot scores at least a set number within 60 s of simulated time and dies to no first obstacle.
5. The same seed and the same inputs give the same score and checksum; input during attract mode takes control in the next step.
6. No more than the pool's size of particles is alive after 200 hits.

Plants: a buffer window of 600 ms (1), acceleration ignored (2), hit-stop that never ends (3), an autopilot that ignores dead ends (4), `Math.random` in the spawner (5).

## Before you hand over

1. Fixed steps; input sampled per step; actions, not keys, in the game code.
2. Buffer and grace windows; damped camera; glide on grids.
3. Three or more layers on every important event; pools; shake capped and optional.
4. Attract mode on a seeded autopilot that yields to input.
5. Keyboard, touch and gamepad all play; pause on blur; sound after a gesture.
6. The tests' numbers in the hand-over, or a plain statement that nothing was run.
