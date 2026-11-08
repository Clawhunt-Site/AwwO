---
name: cinematic-landing
title: Cinematic landing pages: one signature, media first, a spec of real values, then look and fix
title_zh: 电影感落地页：一个记忆点、素材先行、写满真实数值的规格，再看图修正
description: Use when a node builds a landing page, launch page, portfolio home or hero section that should look studio-made rather than templated: settle five decisions before code, let stored images or video carry the first screen (or design type-led when there are none), write a spec in which every element has values, compose and stage the first screen, and score the result on a rubric with a short fix loop.
description_zh: 节点制作落地页、发布页、作品集首页或首屏，需要像工作室出品而不是模板拼装时使用：写代码前先定下五件事；让上游存储的图片或视频撑起首屏（没有素材时以文字为主来设计）；写一份每个元素都有具体数值的规格；完成首屏构图与入场编排；最后按评分表打分并做几轮修正。
category: design
applies: html,design,motion
version: 1
attribution:
---
# Cinematic landing pages

Generic generated pages come from loose planning, no real footage or images, and no one ever looking at the render. Deal with all three, in this order.

## 1. Five decisions before any code

One line each, first in the hand-over or in an HTML comment:
- Product and the one visitor this page must persuade.
- Three words for the mood ("calm, nocturnal, exact").
- The signature: the single thing someone would screenshot (the footage, a 3D object, a type moment, one interaction). Everything else stays quiet.
- Scope: the hero alone unless the brief asks for a full page.
- Media: which stored file carries the first screen, or "none, type-led".

## 2. Media first

- Use only the files the inputs list from upstream image, video or 3D nodes, by exactly those relative paths. No invented file names, outside URLs or placeholder services.
- Note what each file shows and where its subject sits. Copy goes on the empty side; reframe the media (`object-position`, scale it to 110-120%) before shrinking any text.
- Set the page background to the colour at the media's edges so the frame melts into the page. Where copy has to cross the picture, use a directional scrim (the background colour at 60-80% fading out over 30-40% of the height) or a soft text shadow, not a uniform dark veil.
- Video: `muted`, `autoplay`, `loop` and `playsinline`, with its poster, faded in over about 500 ms once it can play, optionally easing from scale 1.06 to 1 over 1.8 s. When the first and last frames differ, dip to the background colour over the clip's last and first 0.4 s instead of cutting. A looping clip has a visible pause button, and with reduced motion it shows its poster and does not play.
- No media: build type-led (giant type, one colour field, one drawn shape), never empty picture frames, and say in the hand-over which image or video node would lift the page: its size, length, subject and where that subject should sit.

## 3. Spec, then build

Every visible element gets numbers: its size at each breakpoint as a `clamp()`, its weight, leading and letter-spacing, its colour and opacity, its widest measure. Every motion gets what starts it, its delay, duration and curve, and its values at start and end, with staggers written out (`delay = 0.2 + i * 0.12 s`). An adjective with no number under it ("premium", "smooth") is a hole in the spec. Then code the spec as written.

## The first screen

- One idea: a mark, a nav of three to five links set at 12-15 px, one headline, a subline 28-42rem wide, one or two actions, the media, and one quiet strip at most (a logo row faded to 40-50%, or two to four real figures). Feature grids and icon rows wait below the fold.
- Choose the anchor: a centred stack, the headline low on the left with a secondary element low on the right, a left column, or labels in the four corners around one big word. A centred stack is the cautious option.
- Headline: 3-9 words broken by hand over two or three lines; a hero may run past design-craft's display sizes to `clamp(40px, 6.5vw, 96px)` but keeps its display leading and tracking (Latin 1.0-1.15 and -0.02 to -0.03em; Chinese 1.3-1.4 and never negative). Stress one phrase with an italic serif or a muted tint, never bold.
- Fonts AwwO supplies, two families at most: Instrument Serif italic with Inter or Manrope, one grotesk alone at 400-500, or Bebas Neue for a mega word; every stack ends in the Chinese fallback.
- Palette: background, foreground, one or two greys, plus a single accent seen at most twice on the first screen. Over media, rank text by opacity (100, 80, 60, 40) rather than by new colours.
- One surface material defined once and reused, such as glass for the nav, chips and secondary buttons over footage. The primary action is a solid pill in the inverse colours, 14-16 px, weight 500-600.
- Depth from layers, not ornament: a vast pale word layered beneath the subject's cut-out, the subject overlapping the headline, a frame laid over the footage. A grain layer at 4-10% ties video and interface together: a CSS background whose data URI holds a noise SVG, since inline SVG filters are removed.
- Full page: keep the hero's tokens, give each section one idea, prefer fewer and stronger sections, and change the form of at least one.

## Motion

- Entrances follow the reading order, navigation first, then eyebrow, headline, subline, actions and strip, 0.1-0.2 s apart and all settled by 1.5 s. Each piece fades from 0 while rising 20-30 px, optionally unblurring from 10 px, over 0.6-1.1 s on motion-discipline's enter curve, `cubic-bezier(0.16, 1, 0.3, 1)`: a staged entrance, the one place its over-500 ms durations belong.
- One headline treatment per page: words unblurring in turn (80-100 ms apart), lines rising out of a mask, or letters sliding in (30 ms apart).
- Below the hero, reveal each block once as it enters view: 20-30 px over 300-500 ms, 0.1 s between siblings. Hover stays small (scale up to 1.05 over 150-200 ms); a press scales to 0.97.
- Still: backgrounds, decoration and the headline once it has landed. The footage supplies the ambient movement.
- Content is visible without script and script adds the entrance, so a stalled script never leaves text at opacity 0. Reduced motion jumps to the final state.

## Look and fix

In the sandbox computer run `awwo-check-page index.html --out desk --viewport 1440x900` and again with `--out phone --viewport 390x844`, read both reports and open each `screenshot.png` if your tools can show images. Anywhere else, review the source against this rubric and say the page was not seen.

Fails outright: page errors, a missing file, sideways scrolling on a phone, text crossing a busy area of the picture or under 4.5:1, a white flash before a dark page, accidental overlaps, filler copy.

Score each 1-10: first glance (one focal point within three seconds), signature, type, composition and space, colour and light, media integration, motion, phone layout, copy, finish. Pass at a mean of 8 or higher with no category below 7. Take the three lowest, name each fix as values ("headline to clamp(48px, 7vw, 96px), tracking -0.03em"), apply them and check again; stop after three rounds and say what would lift it further.
