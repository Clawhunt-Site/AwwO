---
name: video-breakdown
title: Video breakdown: how a reference was made, and its structure
title_zh: 视频拆解：原片怎么做的、结构是什么
description: Use when someone supplies a reference video's analysis report, description, transcript or frame sheet and wants to know, shot by shot, how it was made (filmed, generated, rendered in 3D or code, screen-recorded), what was laid over it (subtitles, titles, stickers), how its sound was made and how it is structured, with every finding backed by evidence and the rest marked unconfirmed.
description_zh: 用户提供参考视频的分析报告、描述、文字稿或截图帧，想逐镜知道它是怎么做的（实拍、AI 生成、三维或代码渲染、录屏）、上面叠了什么（字幕、花字、贴纸）、声音怎么来的、结构如何时使用：每个结论附证据，其余标"待确认"。
category: video
applies: video,research
version: 2
attribution: Adapted from rea-video by JuneYaooo (Apache-2.0, Copyright 2026 JuneYaooo); modified for AwwO
---
# Video breakdown

You work out how a reference film was made and how it is built, so that a new film can learn from it. What you can know depends on the inputs:

- An analysis report (from AwwO's video analysis, or one the user attached) measured the file itself: cuts, frame rate, noise, metadata, subtitle timings, sound stems, tempo. Treat its measurements as evidence and its labels as a first opinion you check against the frames.
- A description, transcript, timestamps or a frame sheet show only what they show. You cannot watch the video: never claim to have watched it, and never state a measurement the inputs do not hold.

## Rights first

- Work only from material the user owns or may study. If the inputs suggest someone else's protected work, say so and keep the output to structure and technique.
- Never copy dialogue, voice-over, slogans, music or distinctive characters, and never imitate a real person's likeness or voice.

## 1. How each shot was made

Give every shot one base method, with a probability when it is not certain:

| Method | What points to it |
| --- | --- |
| live action | sensor noise, natural motion blur, rolling-shutter wobble on fast pans, light that obeys the room |
| film or TV clip | letterboxing, a broadcast grade; judged from the picture only |
| AI video | no sensor noise, waxy surfaces, hands, text or logos that morph, objects that merge or drift between frames, a generator's watermark, an AIGC label in the metadata |
| digital human | a near-still portrait whose mouth and head follow a voice; soft mouth edges, blurred teeth |
| 3D render | rigid, stable geometry and clean highlights, motion along smooth curves |
| 2D animation | flat fills, drawn lines, drawings held for two or three frames |
| stop motion | held poses with small jumps in light and position between frames |
| code or template | text, charts, UI and shapes with exact edges, eased tweens, a layout grid |
| screen capture | a real app, browser or phone screen, a cursor, real interface text |
| still with motion | one picture zoomed or panned as a single plane |
| still frame | nothing moves |

For live action, also note AI edits: face swap, lip-sync, stylisation, outfit or background replacement.

Rules of evidence:

- Hard evidence outranks appearance: an AIGC label, a provenance record, a generator's watermark, repeated frames and frame-rate patterns beat "looks like".
- Missing metadata proves nothing: platforms strip it when they re-encode. Re-encoding also wipes sensor noise, so on a downloaded video "no noise" is weak evidence, and a filmed phone screen often measures like 3D or AI: look before deciding.
- A cartoon-like 3D shot may be generated or rendered: deformation, flicker and unstable geometry point to generation; rigid geometry points to rendering.
- In a code or template shot the text is the picture itself, not an overlay.
- The user's real footage, screenshots and recordings are assets to supply, never something to call generatable.
- When you cannot tell, write it so: "AI video or live action, unconfirmed (leaning AI video, about 70%); a sharp frame of the hands would settle it."

## 2. What is laid over the picture

Keep the packaging apart from the picture under it:

- subtitles: each line's start and end, position, colour, stroke or box, highlighted keywords, how lines enter;
- titles, callouts, labels that follow an object, chapter cards;
- stickers, GIFs, emoji, picture-in-picture, and how long each stays;
- layers that survive cuts (a disclaimer, a title bar, a corner badge): laid once over their whole span, not per shot;
- sound effects that land on a text pop or a sticker.

Tie each overlay to the spoken line it appears on (which line, how far into it), not only to seconds: a new script then carries its overlays with its words.

## 3. Sound

- Voice: a person or synthetic speech; how many voices.
- Music: tempo and key when known, sections, where it drops; a library track or generated. A video that is one sung song is usually a generated song; ordinary background music is usually a library track. Say "unconfirmed" and how to check.
- Effects: when, what kind, on which picture event; whether cuts land on the beat.

## 4. How live action was shot

Only for live-action shots: shot size; camera position and support (handheld, gimbal, tripod, selfie, overhead rig); speed (normal, slow motion, time-lapse); the key light (direction, soft or hard, contrast ratio, colour temperature), fill and rim; the grade (natural, teal-orange, film, black and white, low-key); the cutting (cuts per minute, mean shot length, jump cuts, push-in cuts, inserts). For generated or 3D shots, describe the light only as material for a prompt and say it is not a shooting plan.

## 5. Breakdown (as JSON)

```json
{
  "overall": { "lengthSeconds": 30, "aspect": "9:16", "verdict": "AI video 41% + code 59% of the running time; library music, 122 BPM",
    "structure": "hook → problem → product → proof → offer", "rhythm": "a cut every 1.9 s", "cta": "..." },
  "shots": [
    { "id": 1, "startSeconds": 0, "endSeconds": 1.4, "method": "code", "confidence": 0.8, "runnerUp": "3d 0.15",
      "evidence": ["exact edges", "eased tweens"], "aiEdits": [], "shotSize": "close-up", "cameraMove": "push in",
      "subject": "...", "action": ["..."], "overlays": [{ "kind": "subtitle", "line": 2, "text": "..." }],
      "audio": "...", "assets": ["screen recording, 3.2 s"], "purpose": "hook" }
  ],
  "sound": { "voice": "...", "music": "...", "effects": ["..."] },
  "unknowns": ["what the inputs do not show"]
}
```

- Shares are of running time, not of shot count.
- Purpose of each shot: hook, context, problem, mechanism, proof, benefit, objection, offer, call to action, breath.

## 6. What makes it work

Three to six observations a maker can act on, each tied to shot ids: where attention is caught, how information is paced, which shots carry proof, how the ending converts.

## 7. When a new film is wanted

Hand the breakdown to the remake plan (the video-remake skill). Without it, add a same-structure script: keep durations and purposes, replace subject and words, and say per shot whether it is generated, rendered in code or must be filmed or supplied.

## Checklist

- Every shot has one method, a confidence and its evidence; uncertain ones say what would settle them.
- Picture, overlays and sound are kept apart.
- Footage, screenshots and recordings the user must supply are listed.
- Nothing of the original's words, music or characters is reused.
- Unknowns are listed instead of invented.
