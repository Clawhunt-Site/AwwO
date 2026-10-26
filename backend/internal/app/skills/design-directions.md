---
name: design-directions
title: Visual directions: choose one and bind its tokens
title_zh: 视觉方向库：先选定方向，再绑定设计变量
description: Use when a page, deck, poster, prototype or 3D scene has no brand guide: eight distinct visual directions, each with when it fits, font stacks from the fonts AwwO supplies, six oklch colour tokens checked for contrast, and layout posture, plus how to pick one from the brief instead of improvising colours.
description_zh: 网页、演示、海报、原型或三维场景没有品牌规范时使用：八种区分明确的视觉方向，每种写明适用场景、用 AwwO 自带字体组成的字体栈、六个已核对对比度的 oklch 颜色变量和版式要点，并说明如何根据需求选定一种，而不是临时拼凑配色。
category: design
applies: html,design,motion
version: 1
attribution: The direction library and its token method adapted from open-design (Apache-2.0, Copyright 2026 Open Design contributors); modified for AwwO
---
# Visual directions

## Choose

1. A brand source in the inputs (a guide, a screenshot, a page, its colours) beats every direction: take its values; never guess them.
2. Otherwise pick the one direction whose "fits" matches the brief's domain, audience and tone, and say which and why in one sentence of the hand-over. Never blend two.
3. Bind the six tokens and the fonts in `:root` before anything else, then use only `var(--...)`. Status colours: --success oklch(52% 0.13 150), --warn oklch(54% 0.13 70), --danger oklch(52% 0.19 27); on dark directions raise their lightness by about 0.2. A status pill puts text in its colour moved 0.06 further from the background on a 15% tint of it, or --fg text beside a dot.
4. The fonts carry Latin only: end every stack with `"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif` (serif text: `"Songti SC", "Noto Serif SC", serif`).

Tokens below are bg / surface / fg / muted / border / accent. Every text pair reaches 4.5:1: fg and muted on bg and surface, the accent as text, white on a light direction's accent fill and --bg on a dark one's. `--border` is for dividers; outline controls with `--muted`.

## The directions

**1. Editorial print.** Fits long reads, publishing, reports, essays, culture; not commerce or dashboards.
Fonts: display Instrument Serif or Playfair Display; text Manrope; JetBrains Mono for metadata.
Tokens: oklch(98% 0.004 95) / oklch(100% 0.002 95) / oklch(20% 0.018 70) / oklch(48% 0.012 70) / oklch(90% 0.006 95) / oklch(52% 0.10 28).
Posture: serif display over sans text; no shadows and no rounded cards, borders and whitespace do the work; one decisive image; a mono uppercase kicker.

**2. Quiet software.** Fits SaaS, developer tools, product launches, documentation.
Fonts: display Space Grotesk or Manrope 600; text Inter; mono JetBrains Mono.
Tokens: oklch(99% 0.002 240) / oklch(100% 0 0) / oklch(18% 0.012 250) / oklch(52% 0.012 250) / oklch(92% 0.005 250) / oklch(52% 0.17 255).
Posture: -0.02em on Latin display sizes; hairline borders, shadows only on menus and dialogs; tabular numerals; one product visual where it explains; a primary colour plus one signal colour, never plain greyscale.

**3. Friendly product.** Fits consumer apps, marketplaces, education, wellness, assistants.
Fonts: display Outfit 600-700; text Manrope.
Tokens: oklch(98% 0.004 240) / oklch(100% 0 0) / oklch(20% 0.02 240) / oklch(50% 0.018 240) / oklch(90% 0.006 240) / oklch(50% 0.11 170).
Posture: strong weight contrast; 12-18 px radii on a crisp grid; colour separates panels and states; elevation only on interactive cards; no pastel wash over the page.

**4. Operator utility.** Fits dashboards, consoles, monitoring, trading, internal tools.
Fonts: Inter throughout; JetBrains Mono for numbers, IDs and code.
Tokens, light: oklch(98% 0.005 250) / oklch(100% 0 0) / oklch(22% 0.02 240) / oklch(50% 0.018 240) / oklch(90% 0.008 240) / oklch(50% 0.14 145).
Tokens, dark: oklch(16% 0.01 250) / oklch(20% 0.012 250) / oklch(94% 0.006 250) / oklch(68% 0.012 250) / oklch(28% 0.012 250) / oklch(72% 0.17 150).
Posture: information per square inch; tabular numerals; dense tables with hairlines and no zebra stripes; status pills as in Choose; no hero and no marketing copy.

**5. Brutalist.** Fits art, agencies, manifestos, events, indie launches.
Fonts: display Instrument Serif at clamp(80px, 12vw, 200px); text JetBrains Mono.
Tokens: oklch(98% 0.004 240) / oklch(100% 0 0) / oklch(15% 0.02 100) / oklch(40% 0.02 100) / oklch(15% 0.02 100) / oklch(55% 0.21 25).
Posture: borders at full ink, 1.5-2 px; radius 0-2 px; no shadows and no gradients; asymmetric 70/30 columns; underlined links.

**6. Cinematic dark.** Fits 3D scenes, games, launches, film and music pages, anything lit.
Fonts: display Unbounded or Exo 2; text Manrope; JetBrains Mono for readouts.
Tokens: oklch(14% 0.015 260) / oklch(19% 0.02 260) / oklch(95% 0.01 260) / oklch(70% 0.02 260) / oklch(30% 0.02 260) / oklch(80% 0.16 75).
Posture: the picture is the hero and type sits small in a corner over a scrim; one warm accent against cool darks; glow only on what emits light; generous negative space; numbers in mono.

**7. Luxury quiet.** Fits fashion, hospitality, jewellery, architecture, premium services.
Fonts: display Cinzel or Playfair Display; text Manrope 400.
Tokens: oklch(97% 0.005 85) / oklch(99% 0.003 85) / oklch(22% 0.01 60) / oklch(50% 0.01 60) / oklch(88% 0.01 85) / oklch(45% 0.06 60).
Posture: very large margins; small uppercase labels at +0.12em; thin rules; one photograph or object shown large; two type sizes per screen at most; no badges.

**8. Arcade pixel.** Fits retro games, playful launches, pixel art.
Fonts: display Press Start 2P at multiples of 8 px; text Pixelify Sans or JetBrains Mono.
Tokens: oklch(16% 0.03 280) / oklch(22% 0.04 280) / oklch(95% 0.02 100) / oklch(72% 0.03 280) / oklch(35% 0.05 280) / oklch(82% 0.18 140).
Posture: whole-pixel borders, no blur, no radius; `image-rendering: pixelated`; a second accent only as a status colour; motion in steps.

## Check

One direction named in the hand-over; its tokens and fonts in `:root`, each stack ending in the Chinese fallback; no hex outside them except in image data; the accent at most twice a screen; derived shades keep 4.5:1 for text.
