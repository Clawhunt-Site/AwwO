---
name: design-craft
title: Design craft: type, hierarchy, colour and states that read as designed
title_zh: 设计工艺：排版、层级、配色与交互状态的硬规则
description: Use for any node that delivers a page, prototype, deck, dashboard or poster as HTML: concrete rules for type scale, leading for Latin and Chinese text, letter-spacing, hierarchy, palette and accent limits, contrast, interaction-state colours and layout integrity, with a checklist to run before handing over.
description_zh: 交付网页、原型、演示、仪表盘或海报（HTML）的节点使用：字号阶梯、拉丁文与中文的行高、字距、层级、配色与强调色上限、对比度、交互状态配色和版面完整性的具体规则，交付前逐项自查。
category: design
applies: html,design,motion
version: 1
attribution: Typography and colour rules adapted from open-design (Apache-2.0, Copyright 2026 Open Design contributors); those rules adapt refero_skill (MIT, Copyright (c) 2026 Refero); modified for AwwO
---
# Design craft

The brand or the chosen direction picks the colours and fonts; these rules say how they behave. Hex values or font pairs in other skills are examples, not the palette.

## Type

| Role | Size | Leading, Latin | Leading, Chinese | Tracking |
| --- | --- | --- | --- | --- |
| Display | 48-72 px | 1.0-1.15 | 1.3-1.4 | -0.02 to -0.03em, Latin only |
| H1 | 32-48 px | 1.1-1.2 | 1.3-1.4 | -0.01 to -0.02em, Latin only |
| H2, H3 | 20-32 px | 1.2-1.3 | 1.35-1.45 | 0 |
| Body | 15-18 px | 1.5-1.6 | 1.7-1.8 | 0 |
| Small, captions | 11-14 px | 1.5 | 1.6-1.7 | +0.01 to +0.02em |
| Labels, buttons | 12-15 px | 1.2-1.4 | 1.4 | +0.02em |
| All capitals, any size | | | | +0.06 to +0.1em, required |

- A 1.2 or 1.25 ratio, at most 6-8 sizes in one artifact, no more than 3 visible above the fold.
- Chinese glyphs fill the em box, so Latin display leading makes two lines of a Chinese title touch. Check the cover or hero title first: the 1.3 floor holds at 72 and 96 px too. Never give Chinese text negative tracking.
- An English kicker over a Chinese headline: tight Latin values on the Latin element only, never on a shared parent.
- Two typefaces at most, display and text, plus a mono for code, numbers and metadata if needed; or one family at several weights for utility screens. Three weights: 400 to read, 500-550 for interface text, 600 for headings and buttons; 700 and up rarely. Weights jump between levels, they do not step through every value.
- Body lines of 50-75 Latin characters (`max-width: 65ch`), about 30-40 Chinese characters. Never `text-align: justify` on the web.
- Fonts AwwO supplies, by name with a fallback, never linked or imported: display Unbounded, Orbitron, Exo 2, Oxanium, Rajdhani, Bebas Neue; serif Playfair Display, Instrument Serif, Cinzel; sans Inter, Space Grotesk, Manrope, Outfit, Montserrat; mono JetBrains Mono; pixel Press Start 2P, Pixelify Sans. They carry Latin only: end each stack with `"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif` (serif text: `"Songti SC", "Noto Serif SC", serif`).
- Inter, Roboto, Arial or a bare system-ui on titles reads as a default: give titles a deliberate face, unless the chosen direction names one (operator utility uses Inter throughout).

## Hierarchy

1. One dominant entry point per screen region; if two compete, demote one.
2. Contrast between levels comes from size, weight, spacing, tracking and alignment: at least two act together on the primary element, and adjacent levels sit at least 1.25x apart in size or a clear weight or spacing jump.
3. Three levels: primary, secondary, tertiary (labels, captions, metadata); a fourth above the fold is a composition problem.
4. Vary section gaps on purpose, one at least 1.5x the others; uniform gaps flatten a page.
5. The two failures: flat (everything equal: raise the contrast) and noisy (everything bold or coloured: promote one, demote the rest).

## Colour

| Layer | Share of pixels | Tokens |
| --- | --- | --- |
| Neutrals | 70-90% | --bg, --surface, --fg, --muted, --border |
| One accent | 5-10% | --accent, never a second accent |
| Status | 0-5% | --success, --warn, --danger |
| Effects | under 1% | glows and gradients, rarely |

- Declare the tokens once in `:root` and use `var(--...)` everywhere; name them by purpose (`--accent`), never by hue (`--blue-500`).
- At most 2 visible uses of the accent per screen, for example one eyebrow and the primary button. Links and focus rings count.
- Derive shades in `oklch()`: hover moves lightness by 0.06-0.12. Text in the accent colour uses a darker variant that reaches 4.5:1; the bright variant is for fills.
- Contrast gates, inclusive and never rounded up: body text 4.5:1; large text (24 px regular, or 19 px bold) 3:1; controls, chart marks and focus indicators 3:1. `--border` is for dividers; a control's own outline uses `--muted` or a shade further from the background.
- Dark themes: background near #0f0f0f and text near #f0f0f0, never pure black or pure white; borders as 1 px `rgba(255,255,255,0.08)`.
- A gradient separates two levels; it never decorates empty space.

## States and actions

- Give each state its foreground and background as a pair. Hover, focus, active and selected never lower text contrast: change the background, border, shadow or position, never grey the text. Disabled is the only state that may fade.
- Every focusable element shows a `:focus-visible` ring at 3:1 against its surroundings.
- One action, one primary button: a repeat only far down a long page, never in the same viewport. Other entry points are secondary, ghost or text links with different words.
- Touch targets 44 px. Slides at 1920x1080: titles 36 px and up, body 24 px and up. Phones never scroll sideways; redesign for them rather than squeeze.

## Layout integrity

Requirements, not taste: nothing overlaps by accident; text fits its box, with no clipping and no overflow out of table cells; no one- or two-character orphan on a heading's last line (change the width or the wrapping, never hide the overflow); display type fits its column, never `white-space: nowrap` into a neighbour; a badge over an image sits in one corner with equal inset, off faces, on a solid or frosted backing; chart marks are filled, not empty outlines.

## What AwwO's previews keep

Pages that show stored files, the studio and recordings run as written; the default preview keeps only common elements and attributes and runs scripts with no network. Write for it:

- An element outside its list goes with all it holds: never rely on `link`, `iframe`, `dialog`, `template`, `output` or `picture`. Keep the charset and viewport `meta` for the downloaded file; a stored clip the inputs list goes in a `video` src.
- Inline SVG keeps shapes, paths, `text`, `g`, `defs`, `pattern` and `use` with geometry and paint attributes; gradients, filters, masks, clip paths, `symbol`, `marker` and `animate` go, as do `opacity`, `text-anchor`, `font-*`, `dx`, `dy`, `stroke-dashoffset` and `patternUnits`. Style SVG and animate it with CSS; draw gradients in a canvas.
- The form attributes `required`, `pattern` and `maxlength` go (validate in script), and so does every `href` but an in-page `#ascii-id`. Elements a script creates keep their attributes but load nothing from the network.

## Before you hand over

1. Chinese headings at line-height 1.3 or more, all capitals tracked 0.06em or more, one dominant element per region, at most 3 sizes above the fold.
2. Tokens in `:root`; the accent at most twice a screen; contrast met in every state; one primary button per action per viewport; a focus ring on every control.
3. Nothing overlaps, clips or orphans at 360, 768 and 1440 px wide; say whether that comes from reading the CSS or from a render the inputs show.
