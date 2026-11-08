---
name: video-remake
title: Same-structure remake: a reference's shape, your content
title_zh: 同款复刻：保留原片结构，换成你的内容
description: Use when someone wants a new video in the shape of a reference ("make one like this", "remake it with my product"): turn a shot-by-shot breakdown into one plan that keeps the cuts, timing, actions and pacing and swaps the subject, product and words; route each shot to a video, image, voice or music node, a code-rendered page or footage the user supplies; merge shots into as few paid generations as the models allow; and join everything in an edit node.
description_zh: 用户想按参考视频的样子做一条新片（"做同款""换成我的产品重做"）时使用：把逐镜拆解变成一份计划，保留切点、时长、动作和节奏，换掉主角、产品和台词；每个镜头分给视频、图片、配音或配乐节点、代码渲染页面或用户自备素材；在模型允许的范围内合并成尽量少的付费生成，最后用剪辑节点拼成片。
category: video
applies: video,plan
version: 1
attribution: Adapted from rea-video by JuneYaooo (Apache-2.0, Copyright 2026 JuneYaooo); modified for AwwO
---
# Same-structure remake

A remake keeps what made the reference work: its cuts and durations, the order and timing of actions, the camera moves, the pacing and where the words land. It replaces what belongs to someone else: the people, the product, the words, the music and the setting. It is never a frame-by-frame redraw of the original.

## Rights first

- Remake only a reference the user may study. Reuse its structure and technique, never its dialogue, slogans, music, characters, logos, or a real person's face or voice.
- Generated people are invented people. Mark generated media as AI-generated where the platform asks for it.

## 1. One plan before anything is generated

Start from a breakdown (the video-breakdown method, or an analysis report). Write one plan table that every later node follows:

| Shot | Start–end (s) | Made as | Route | Unit | Actions in order, with seconds | Camera | New on-screen text | New voice line | References |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

- Keep the reference's cut points and durations. Change one only to fit a model's limits or a line's length, and say so.
- Copy actions as timing, not content: "0.0–1.2 s lifts the bottle to the lens, 1.2–2.0 s turns it label-out" becomes the same beats with the user's product.
- Write one locked description per new character and per product, and paste it unchanged everywhere it appears.
- Show the plan to the user and take their changes before the first paid call.

## 2. Route each shot by how the reference made it

| In the reference | Route on AwwO |
| --- | --- |
| AI video, 3D, stylised footage | a video node, starting from the locked reference picture |
| live action meant to stay real | a shooting note for the user (shot size, camera position, light, action) and a slot for their clip; a video node only if they accept a generated look |
| digital human | a video node whose model takes a portrait and a voice, or the user's own take |
| code, template, UI, chart, title | a page AwwO renders to video (the code-motion method), not a generation |
| screen capture or screenshot | the user's own recording or screenshot, never generated |
| still with zoom or pan | an image node, then the move in a rendered page or as a picture held in the edit |

## 3. References first

- Make the locked pictures before any clip: one per character (clear front face and half body, in the target light) and one per product. The user's real product photo always beats a generated one.
- Wire the same reference picture into every video node that shows that subject; identity drifts when each shot invents its own.
- A frame reused as a reference carries no subtitles, stickers or watermarks: they are not part of the scene.

## 4. Fewer, longer generations

- Know each model's limits before splitting: shortest and longest clip, fixed lengths, how many reference pictures it takes, whether one generation may hold several shots, whether it makes sound.
- Shots of one scene that the reference separates with inserts can be generated as one multi-shot clip where the model allows it, then cut apart in the edit.
- Many models make nothing shorter than about 4–5 seconds: generate the minimum and trim to the planned length in the edit.
- Before running, state the count: units, seconds per unit, total paid seconds, and the units most likely to need a retry.

## 5. Cost discipline

- No paid generation before the user has seen the plan and the count.
- Run one short unit first to check the look and the real cost; continue only when it is right.
- After two failures of the same unit, stop and report what failed instead of retrying with new guesses.

## 6. Words and sound

- A new script in the reference's rhythm: the same number of lines, each about as long as the original's, the punchline in the same place, never the original wording.
- Voice from a speech node, one take per line, named by its shot. Music from a music node or a track the user has rights to, matching the tempo and where it drops. Effects on the same events as the reference (a text pop, a reveal).
- Subtitles, titles, labels and stickers never go into a generation prompt: they belong to the edit or to a rendered page.

## 7. Join it in the edit node

Write the edit node's timeline, an awwo.timeline/1 JSON document: tracks.video lists each clip as <node id>/<file name> with in and out, in plan order; the dialogue, music and sfx tracks place the sounds; subtitles carry the new lines. Place voice lines, effects and subtitles by anchor (the id of the video item they belong to) and offset rather than by absolute seconds, so a shot that changes length moves what is tied to it. The edit writes subtitles as a separate .srt file and does not draw styled captions or stickers over clips: put styled text in a rendered card or in the picture, and say which.

## 8. Variants

A variant changes one axis and keeps the rest: the subject, the product, the language, the claim or the ranking. Keep the plan and the timeline, regenerate only the units the change touches, and name each variant by what changed.

## Checklist

- The plan table exists, and the user saw it and the generation count before any paid call.
- Every recurring subject has one locked description and one reference picture, used everywhere.
- Every shot has a route; the footage, screenshots and recordings the user must supply are listed.
- Overlays stay out of prompts; the timeline anchors sounds and subtitles to their shots.
- Nothing of the original's words, music, characters or likeness is reused.
