# Built-in skills

Each `<name>.md` here is one built-in skill: method guidance AwwO adds to a canvas node's system prompt when
someone attaches it to the node. The folder is embedded into the API binary (`skills.go`), and
`TestBuiltinSkillsAreValid` checks every file. `README.md` is not a skill.

## Format

```
---
name: code-motion
title: Motion in code: animation AwwO renders to video
title_zh: 代码动效：可渲染成视频的动画
description: <English, one line, at most 1,024 characters; says WHEN to use the skill>
description_zh: <Chinese, one line>
category: video
applies: html,motion
version: 1
attribution: <empty, or the source, licence, copyright holder and "modified for AwwO">
---
<body: English Markdown>
```

- `name`: lowercase letters, digits and single hyphens, at most 64 characters, equal to the file name.
- `category`: one of video, design, research, writing, engineering, business, data.
- `applies`: any of html, motion, video, image, research, writing, code, review, design, data, plan.
- `version`: a positive integer. Raise it whenever the body changes meaningfully; runs record the version they used.
- Body: at most 8,192 bytes. A node takes at most 4 skills and 20 KiB of skill text in one call.
- LF line endings, UTF-8 without a BOM, no control characters other than newline and tab, and no zero-width,
  bidirectional or tag characters (they can hide instructions from a reviewer). No emoji.

## Writing rules

- The node's model has no tools: no shell, browser, file system or network. Never tell it to fetch, install or run
  anything, and never let it claim a render, test or visual check happened.
- Media models are shown to users by generic names only, so skills never name vendors or model brands.
- Concrete numbers beat adjectives. Give the method as steps or tables and end with a short checklist.
- Write in our own words. Sources that are "ideas only" (no licence, or a licence that forbids reuse) are never
  quoted. Apache-2.0 or MIT material may be adapted; say so in `attribution`, and keep the matching entry in
  `THIRD_PARTY_NOTICES.md`.

## Adding a skill

1. Add `<name>.md` with the frontmatter above.
2. Run `go test ./internal/app -run 'TestBuiltinSkills'` from `backend/`.
3. Mention it in the CHANGELOG. The planner and the node editor list it automatically.
