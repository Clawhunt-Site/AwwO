---
name: shot-director
title: Shot director: storyboards and video prompts
title_zh: 分镜导演：分镜表与视频提示词
description: Use when a node plans a video made by AwwO's video generation nodes: break the idea into shots, give each a directed prompt within the model's length and duration limits, and keep subjects consistent across shots.
description_zh: 规划要交给视频生成节点的视频时使用：拆分镜头，为每个镜头写出符合时长与长度限制的导演式提示词，并保持角色与产品前后一致。
category: video
applies: video,plan
version: 1
attribution:
---
# Shot director

Your output feeds video generation nodes. Each generation makes one short clip from one prompt, costs real money, and cannot be edited afterwards, so the work is in the planning.

## 1. Brief the film in five lines

- Purpose and audience (who watches, where: a feed, a landing page, a pitch).
- Length and aspect ratio (16:9, 9:16, 1:1 or 4:5).
- The one idea a viewer must take away.
- Look: palette, light, era, texture.
- What must never appear (brands you do not own, real people, unsafe claims).

## 2. Shot list

Write a table before any prompt:

| # | Role | Seconds | Shot size | Angle | Camera move | Subject and action | End state |
| --- | --- | --- | --- | --- | --- | --- | --- |

- Role is one of: hook, context, mechanism, proof, benefit, call to action, breath (a calm beat).
- Shot size: extreme close-up, close-up, medium close-up, medium, wide, extreme wide.
- One camera move per shot (static, push in, pull out, pan, tilt, orbit, tracking, crane). Two moves in one clip usually fail.
- At most about seven named elements per shot.
- The end state says how the clip settles ("the cup comes to rest centre frame, steam rising"). Clips without one tend to stall or end abruptly.
- Typical generation lengths are 4–15 seconds; some models only allow fixed lengths such as 4, 6, 8, 10 or 12 seconds. Generate slightly longer than the edit needs and trim later.

## 3. Prompt structure: Subject, Action, Context, Shot, Colour

1. Subject: who or what, described by appearance (age range, clothing, material, colour), never by a real person's name.
2. Action: three to five visible steps with amplitude ("lifts the lid slowly, steam curls up, she smiles").
3. Context: foreground, midground, background; time of day; weather.
4. Shot: size, angle, lens feel (wide, normal, telephoto), depth of field, the single camera move and its speed.
5. Colour and light: key light direction, colour temperature in Kelvin, contrast, saturation.

End every prompt with a stability tail: "steady camera, consistent subject, natural motion, no text, no watermark", adjusted to the shot.

Length budget: about 60–120 English words, or 80–200 Chinese characters, per shot. Longer prompts dilute the important words.

## 4. Continuity across shots

- Write a locked description for every recurring subject and paste it unchanged into each shot that shows it.
- Keep left/right positions, clothing and props fixed, and say them explicitly.
- Keep light direction and colour temperature constant within a scene.
- When a model accepts a reference image (a first frame or subject reference), use the approved still from the previous shot.
- Some models accept several shots in one generation through timestamped sections ("0–3 s: ... 3–6 s: ..."); the sections must add up to the clip length. Prefer this for tightly connected beats.

## 5. Cost and honesty

- Every shot is a paid generation. State the number of generations the plan needs; above about six, propose a shorter version first.
- Never promise exact lip-sync, readable small text, logos or exact product geometry: generation models are unreliable at them. Put titles and logos in a separate motion node (an HTML page AwwO renders) instead.
- Say which shots are most likely to need a retry.

## Output checklist

- The brief, then the shot table, then one prompt per shot, then the generation count.
- Every prompt carries the locked subject description where needed and a stability tail.
- Durations fit the stated model limits.
