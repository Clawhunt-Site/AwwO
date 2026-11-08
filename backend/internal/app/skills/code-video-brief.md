---
name: code-video-brief
title: Code video brief: decide the piece before the code
title_zh: 代码视频简报：先定方案，再写动画
description: Use when someone wants a video made as code (motion graphics, an explainer, a 3D scene, a product promo, or a game or app shown as a video): write a one-page brief first (format, facts, look, motion, a beat-by-beat timeline with every word on screen, a sound cue sheet, the frames to check), then build the page to it.
description_zh: 需要用代码做视频时使用（动态图形、讲解、3D 场景、产品宣传片，或把游戏和应用做成视频）：先写一页简报（画幅、事实、视觉、动效、逐拍时间轴和每一句屏幕文字、声音提示单、要抽查的帧），再按简报写页面。
category: video
applies: video,motion,html,plan
version: 2
attribution:
---
# Code video brief

Code videos fail the same ways: a slow start, too much text at once, numbers nobody supplied, a generic look. All four are settled before the code: write this brief, then build the page to it. Attached, code-motion covers rendering, promo-film pacing, vertical-reel feeds.

## 1. The brief, in this order

1. **Bar.** Who watches, where, and what it must stand beside.
2. **Format.** Width x height, fps, exact length, loop or not, safe area. A render is picture only, up to 20 s, at the size and length the member picks (name them); an edit node joins longer films and adds sound, as cards: pages of at most 256 KiB and 20 s each (120 s in all), footage wired in, never inlined. 3D renders in software: use 30 fps.
3. **Facts.** The only names, numbers and claims allowed, each from the task's inputs, then "Do not claim:" for what the inputs do not support (results, customers, speed, "made from one sentence").
4. **Look.** Background, ink and one accent as hex; one or two typefaces with weights; one texture or none; a banned list (section 4).
5. **Motion.** The motion language (durations, curves and named springs as tokens; AwwO's unless the inputs give one), one camera grammar (locked off, a slow push, or one continuous move), how scenes hand over, the longest hold.
6. **Timeline.** A tempo, then one row per beat or bar: time, picture, the exact words on screen, the sound cue. One idea per row. At 120 BPM a bar is 2 s of four 0.5 s beats, 60 frames at 30 fps.
7. **Carried element.** One card, line, cursor or shape that survives every cut.
8. **Sound cue sheet.** Sound comes only through an edit node: a wired sound file, or `window.renderAudio({seconds, sampleRate})` (an OfflineAudioContext on the frame clock) on a page of at most 256 KiB that never waits on a timer. List the hits, the visible events that make a sound and how it ends (a decay or a fade, never a dead stop). Never say a plain render has sound.
9. **Frames to check.** Five to eight moments for a reviewer: frame 0, the middle of each transition, the end.

## 2. Pick the format

| Format | For | Needs |
| --- | --- | --- |
| Motion graphics | an idea, a launch, a brand line | poster type on the beat, one shape language, a strong frame 0 |
| Explainer | a process or a system | one step per scene, a diagram built piece by piece, labels beside what they name |
| 3D scene | a place or an object | one hero object, light that sets the hour, one camera move per shot |
| Build shown as video | a real app, page or game | it plays itself from a fixed script, its interface large enough to read |

A render has no player and may draw frames in any order: rebuild the state for every t by replaying the script's inputs up to t with a fixed dt or compute it directly. Never wait on a real event or the previous frame. Move the camera onto a small build.

In a plain render, footage the page names is inlined into it; the page stays under 6 MiB (about 4.5 MiB of media after base64); ask for smaller clips when it does not fit. Start with `window.__ready = false`, load every clip with `preload = 'auto'`, and set `__ready = true` once each has `readyState >= 2` or has fired `loadeddata` or `error`. In `renderAt`, skip a clip that failed (draw a plain plate); otherwise pause it, attach its `seeked` and `error` handlers, then set `currentTime`, and resolve on either event.

## 3. Words on screen

- Words come in three roles: poster words (one to four, as large as the frame allows, one phrase at a time, changing on a beat), captions (at most seven words or about twelve Chinese characters, readable with the sound off), and labels (a name, a number, a chapter mark; never the story).
- Keep the picture quiet where the big type sits; the subject goes to the other side or below.
- In a feed or a short clip, open on the promise: words and movement in the first second, the real thing on screen by t = 2 s.
- Frame 0 is a complete composition, not a black or an empty frame: it is a likely cover.
- Hold text for at least 1 s plus 1 s per 4 words (or per 5 Chinese characters); between changes, the picture moves on the beats. Never swap two text layers at once.
- Contrast 4.5:1 or more; small type over a busy picture gets a plate.

## 4. A look you chose

- Name one look with three rules, such as "paper: an ivory ground, ink-black lettering and a single blue; grain only behind the type".
- Banned unless the brief asks: particle bursts, lens flares, glow on everything, camera shake, RGB split, endless zoom, spinning cards, springy overshoot on every move, crossfades or blur-ins as the only transition, the stock purple-to-blue gradient.
- Carry continuity in transitions: a match cut (a shape ends one shot where the next starts), a flood or iris eased by area (radius = R x sqrt(progress)), a split-flap or paper fold, an object that becomes the next scene.
- Interfaces, logos and footage come from the inputs. Never invent screenshots, statistics, quotes or customers.

## 5. Build it to be checked

- Keep the tempo, the timeline, all copy and the motion tokens in one data block at the top, read by the drawing code.
- Draw every frame from t alone (code-motion's contract).
- Measure text; shrink or wrap it to fit its box inside the safe area.
- Unless it loops, end on the name and one action, held at least 1.5 s.

## Checklist

- The brief comes first, in this order; the page follows it row by row.
- Each name, number and claim shown is backed by the task's inputs; the "Do not claim" line holds.
- Frame 0 is complete; in feeds the promise lands in the first second, the real thing by t = 2 s; text holds its reading time; nothing banned slipped in.
- The cue sheet, render size and length and frames to check are stated; the video exists only once AwwO renders the page.
