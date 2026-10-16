---
name: code-video-brief
title: Code video brief: decide the piece before the code
title_zh: 代码视频简报：先定方案，再写动画
description: Use when someone wants a video made as code (motion graphics, an explainer, a 3D scene, a product promo, or a game or app shown as a video): write a one-page brief first (format, facts, look, motion, a beat-by-beat timeline with every word on screen, a sound cue sheet, the frames to check), then build the page to it.
description_zh: 需要用代码做视频时使用（动态图形、讲解、3D 场景、产品宣传片，或把游戏和应用做成视频）：先写一页简报（画幅、事实、视觉、动效、逐拍时间轴和每一句屏幕文字、声音提示单、要抽查的帧），再按简报写页面。
category: video
applies: video,motion,html,plan
version: 1
attribution:
---
# Code video brief

Code videos fail the same ways: a slow start, too much text at once, numbers nobody supplied, a generic look. All four are settled before the code: write this brief at the top of your answer and build the page to it. When attached, code-motion covers rendering, promo-film pacing and vertical-reel feeds.

## 1. The brief, in this order

1. **Bar.** Who watches it, where, and what it must stand beside.
2. **Format.** Width x height, fps, exact length, loop or not, safe area; AwwO renders picture only, up to 20 s, at the size and length the member picks, so name them. 3D renders in software: use 30 fps.
3. **Facts.** The only names, numbers and claims allowed, each from the task's inputs, then "Do not claim:" for what the inputs do not support (results, customers, speed, "made from one sentence").
4. **Look.** Background, ink and one accent as hex; one or two typefaces with weights; one texture or none; a banned list (section 4).
5. **Motion.** One curve family, one camera grammar (locked off, a slow push, or one continuous move), how scenes hand over, the longest hold.
6. **Timeline.** A tempo, then one row per beat or bar: time, picture, the exact words on screen, the sound cue. One idea per row. At 120 BPM a bar is 2 s of four 0.5 s beats, 60 frames at 30 fps.
7. **Carried element.** One card, line, cursor or shape that survives every cut.
8. **Sound cue sheet.** The render is silent; this is for whoever adds music in an editor: the hits, which visible events make a sound, how it ends (a decay or a fade, never a dead stop). Never put audio in the page or say the video has sound.
9. **Frames to check.** Five to eight moments for a reviewer: frame 0, the middle of each transition, the end.

## 2. Pick the format

| Format | For | Needs |
| --- | --- | --- |
| Motion graphics | an idea, a launch, a brand line | poster type on the beat, one shape language, a strong frame 0 |
| Explainer | a process or a system | one step per scene, a diagram built piece by piece, labels beside what they name |
| 3D scene | a place or an object | one hero object, light that sets the hour, one camera move per shot |
| Build shown as video | a real app, page or game | it plays itself from a fixed script, its interface large enough to read |

A render has no player and may draw frames in any order: rebuild the state for every t by replaying the script's inputs up to t with a fixed dt (checkpoints computed from the script alone are fine), or compute it directly. Never wait for a real event or rely on the previous frame. Move the camera onto a small build.

Footage the page names is inlined into it, and the page must stay under 6 MiB, which leaves about 4.5 MiB of media after base64: ask the member for shorter or smaller clips when that does not fit. Start with `window.__ready = false`, load every clip with `preload = 'auto'`, and set `__ready = true` once each has `readyState >= 2` or has fired `loadeddata` or `error`. In `renderAt`, skip a clip that failed (draw a plain plate); otherwise pause it, attach its `seeked` and `error` handlers, then set `currentTime`, and resolve on either event.

## 3. Words on screen

- Words come in three roles: poster words (one to four, as large as the frame allows, one phrase at a time, changing on a beat), captions (at most seven words or about twelve Chinese characters, readable with the sound off), and labels (a name, a number, a chapter mark; never the story).
- Keep the picture quiet where the big type sits; put the subject on the other side or below.
- In a feed or a short clip, open on the promise, not a quiet brand open (promo-film's calm open suits films people chose to watch): words and movement in the first second, the real thing on screen by t = 2 s.
- Frame 0 is a complete composition, not a black or an empty frame: it is a likely cover.
- Hold text for at least 1 s plus 1 s per 4 words (or per 5 Chinese characters); between changes, let the picture move on the beats. Never swap two text layers at once.
- Keep contrast at 4.5:1 or more; small type over a busy picture gets a plate.

## 4. A look you chose

- Name one look with three rules, for example "paper: an ivory ground, ink-black lettering and a single blue; grain only behind the type".
- Banned unless the brief asks for it: particle bursts, lens flares, glow on everything, camera shake, RGB split, endless zoom, spinning cards, springy overshoot on every move, crossfades or blur-ins as the only transition, the stock purple-to-blue gradient.
- Carry continuity in transitions: a match cut (a shape ends one shot where it starts the next), a flood or iris eased by area (radius = R x sqrt(progress)), a split-flap or paper fold, an object that becomes the next scene.
- Interfaces, logos and footage come from the inputs. Never invent screenshots, statistics, quotes or customers.

## 5. Build it to be checked

- Keep the tempo, the timeline and all copy in one data block at the top that the drawing code reads; new timing means editing one table.
- Draw every frame from t alone (code-motion's contract), seed all randomness, and step simulations with a fixed dt.
- Measure text, then shrink or wrap it until it fits its box inside the safe area.
- Unless it loops, end on the name and one action, held for at least 1.5 s.

## Checklist

- The brief comes first, in this order, and the page follows it row by row.
- Each name, number and claim shown is backed by the task's inputs; the "Do not claim" line holds.
- Frame 0 is complete; in feeds the first second carries the promise and the real thing shows by t = 2 s; text holds for its reading time; nothing banned slipped in.
- No audio in the page; the cue sheet, render size and length and frames to check are stated; the video exists only once AwwO renders the page.
