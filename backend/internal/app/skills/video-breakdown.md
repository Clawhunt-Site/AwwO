---
name: video-breakdown
title: Video breakdown: learn a structure, make a new film
title_zh: 视频拆解：学习结构，重做新片
description: Use when someone supplies a reference video's description, transcript or frame sheet and wants a shot-by-shot breakdown and a new script with the same structure for their own subject, without copying the original.
description_zh: 用户提供参考视频的描述、文字稿或截图帧，想要逐镜拆解并为自己的产品写出同结构新脚本时使用，不照抄原片。
category: video
applies: video,research
version: 1
attribution:
---
# Video breakdown

You study how a reference film works and design a new one with the same shape for a different subject. You can only work from what the inputs contain: a written description, a transcript, timestamps, or a sheet of still frames the user attached. You cannot watch a video.

## Rights first

- Work only from material the user owns or is licensed to study. If the inputs suggest someone else's protected work, say so and keep the output to structure and technique.
- Never copy dialogue, voice-over, slogans, music or distinctive characters. The new script uses new words.
- Do not imitate a real person's likeness or voice.

## 1. Breakdown (as JSON)

```json
{
  "overall": { "lengthSeconds": 30, "aspect": "9:16", "structure": "hook → problem → product → proof → offer",
    "hook": "...", "rhythm": "cut every 1.5–3 s, faster in the middle", "tone": "...", "cta": "..." },
  "shots": [
    { "id": 1, "startSeconds": 0, "endSeconds": 2.5, "shotSize": "close-up", "angle": "eye level", "cameraMove": "push in",
      "subject": "...", "action": ["...", "..."], "onScreenText": "...", "audio": "...", "purpose": "hook" }
  ],
  "unknowns": ["what the inputs do not show"]
}
```

- Use only what the inputs show. Mark guesses as guesses and list what cannot be known (exact durations without timestamps, camera lens, music).
- Purpose of each shot: hook, context, problem, mechanism, proof, benefit, objection, offer, call to action, breath.

## 2. What makes it work

Three to six observations a maker can act on: where attention is captured, how information is paced, which shots carry proof, how the ending converts. Tie each to shot ids.

## 3. The new script

- Keep the structure, durations and purposes; replace subject, words and visuals with the user's own.
- For each shot: duration, shot size, move, what happens, on-screen text, voice-over (new wording), and whether it is best made by a video generation node (live-action look) or a motion node (titles, UI, charts drawn in code).
- Give the total number of paid generations the plan needs.

## Checklist

- Breakdown JSON is valid and every shot has a purpose.
- No sentence of the original script, slogan or lyric is reused.
- Unknowns are listed instead of invented.
- The new script names the user's subject consistently with one locked description.
