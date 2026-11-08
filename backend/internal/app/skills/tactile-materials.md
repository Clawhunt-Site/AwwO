---
name: tactile-materials
title: Tactile materials: paper, marker, pencil, goo and solid glass from CSS and SVG
title_zh: 质感材质：用 CSS 和 SVG 做出纸张、马克笔、铅笔、黏液与实心玻璃
description: Use when a page, prototype, game interface or poster should look made by hand or made of something (paper and tape, marker and stickers, pencil and watercolour, dripping goo, solid glass) instead of flat default UI: one material per artifact, how to build each from what AwwO's previews keep (no SVG filters, no handwriting font), seeded wobble that repeats exactly from one render to the next, presses that squash, and the accessibility rules no material may break.
description_zh: 页面、原型、游戏界面或海报需要手作感或材质感（纸张与胶带、马克笔与贴纸、铅笔与水彩、会滴落的黏液、实心玻璃），而不是平淡的默认界面时使用：一件作品只用一种材质；每种材质如何只用 AwwO 预览保留的元素做出来（没有 SVG 滤镜，没有手写字体）；用种子生成、每次渲染都一样的抖动线条；按下会被压扁的按钮；以及任何材质都不能破坏的无障碍规则。
category: design
applies: html,design,motion
version: 1
attribution:
---
# Tactile materials

A memorable interface usually owes its character to one material carried through every part, not to extra rules. Use one when the brief asks for something hand-made, playful, crafted or physical, or when the brand already looks that way, and name it as the page's deliberate choice. One material per artifact; none of them is a default look.

## Rules every material keeps

- Real controls underneath: a button is a `button`, a switch is a labelled checkbox, tabs answer the arrow keys. Drawings ride on top as pseudo-elements or as SVG marked `aria-hidden="true"`, and they take no clicks (`pointer-events: none`).
- Each fill is written with its text colour as a pair that reaches 4.5:1 (3:1 for large text). The focus ring stays a plain 2 px outline at 3:1; only decoration wobbles.
- No handwriting face is supplied: set text in Outfit or Manrope, notes in Instrument Serif italic, labels in JetBrains Mono, each stack ending in the Chinese fallback. The hand shows in lines, edges and fills, never in tilted letters, and nothing draws people, faces or scenes.
- With `prefers-reduced-motion: reduce`, boils, drips, peels and springs all stop; a state still changes, at once.

## Seeded wobble

A hand-drawn line must come out identical on every load, render and video frame. Hash the element's id or label into a seed for a small generator (mulberry32), and never call `Math.random()` for a shape.

- Pen line: sample the shape every 6-8 px and push each point along its normal by a smooth offset, the sum of two or three sines with seeded phases, wavelengths 40-120 px, 0.8-1.6 px in all. Let the ends overrun by 2-4 px and leave a loop slightly open. Write one `path`, 1.8-2.6 px, round caps. Independent random jitter per point looks broken, not drawn.
- With no script: eight unequal radii (`border-radius: 14px 9px 12px 8px / 9px 13px 8px 12px`), a 2-2.5 px ink border, and a tilt of -1.5 to 2 degrees on loose pieces only.
- Boil, for the current step or a live state: three seeded versions of the path stacked, one visible at a time through a `steps(1)` keyframe on `opacity`, about 0.45 s for the three. Boil one element at a time and only while its state lasts; like any loop it stops after 5 s or offers a pause (motion-discipline). In a film page pick the version from `t` (`Math.floor(t * 7) % 3`), never from a timer.
- A tick or underline that draws itself sets `stroke-dasharray` and animates `stroke-dashoffset` in CSS (280 ms); the dashoffset attribute itself is removed.

## The materials

**Paper and tape**: notebooks, planners, learning, craft.
- Grounds: a rule every 32 px, `repeating-linear-gradient(var(--rule) 0 1px, transparent 1px 32px)`, with one margin line; dots `radial-gradient(circle, var(--rule) 1px, transparent 1.6px) 0 0 / 24px 24px`; kraft brown, cutting-mat green, poster white or a dark board. The colour comes from the paper chosen, never cream by habit.
- Grain: a 160 px fractal-noise SVG as a data-URI `background-image` (base frequency 0.7-0.9) in a `::before` layer at 4-8% opacity. A filter inside an image still works; inline SVG filters do not survive.
- Tape: a 70-110 x 22-28 px strip turned 3-8 degrees, a fill at about 55% alpha, `mix-blend-mode: multiply` on light paper, ends notched with `clip-path: polygon(...)`.
- Charts: bars hatched with `repeating-linear-gradient(135deg, var(--ink) 0 3px, transparent 3px 8px)` and closed by a heavier solid stroke at the leading edge; lines as seeded pen paths; every value also written as text.

**Marker and stickers**: playful launches, communities, creator and family products.
- One marker colour for every outline; fills from four to six flat spot colours, each with its passing text colour.
- Sticker: a 3-6 px white cut border around the fill (`border: 4px solid #fff`), an offset shadow `filter: drop-shadow(3px 5px 0 oklch(20% 0 0 / 0.2))`, a tilt of -2 to 3 degrees.
- Press: on `:active` drop 2-3 px, scale 0.95 and shrink the shadow to 1 px in about 80 ms. On release, one squash and settle, `scale(1.05, 0.95)` then `scale(1)` within 400 ms. A cancel shakes 4 px twice instead of celebrating.
- Tags as strips of tape, progress as hatching, a spinner drawn as an open marker ring.

**Pencil and wash**: calm tools, journals, maps, onboarding.
- Graphite: 1-1.4 px lines at `stroke-opacity` 0.75-0.9, drawn twice from the same seed with the second pass shifted under 1 px.
- Wash: two or three soft shapes behind the content, radial gradients from the colour at 35-50% alpha to transparent, unequal radii, `mix-blend-mode: multiply`, an inset shadow of the same hue 0.05-0.1 darker at the rim. Text never sits on that darker rim.

**Goo**: one playful toggle, loader or signature control, never a whole interface.
- No script: drops of unequal radii hanging from an edge, grown by `transform: scaleY()` from `transform-origin: top` over 500-900 ms, once per action.
- Script: in a canvas the script creates (at most about 400 x 400 px), draw each blob as a radial gradient of alpha with `globalCompositeOperation = 'lighter'`, then read the pixels back: full alpha where the sum passes about 0.45, ramping up over the next 0.05 so edges stay smooth, tinted one colour. Redraw only while something moves.
- Choose one strength for the page (subtle, playful or wild), subtle unless the brief says otherwise.

**Solid glass**: AI tools, consoles, dark product pages over imagery.
- A heavy neutral pane that looks opaque until you lean in: dark `oklch(100% 0 0 / 0.05)` over a near-black page, light `oklch(98% 0.004 265 / 0.6)`; `backdrop-filter: blur(20-28px)` with no saturation boost, so what lies behind softens without lending its colour.
- Glassiness lives in the edges: a 1 px light line along the top (`inset 0 1px oklch(100% 0 0 / 0.16)`), a hairline all round, one soft shadow beneath. No gradient shades the pane itself.
- Higher layers are thicker panes: panel, then card, then popover, each more opaque. Hover, selected and open share one small clear pane. Colour and motion are kept for feedback.
- Text on glass passes 4.5:1 against the busiest backdrop it can cover; when it does not, thicken the pane rather than adding a glow.

## Before you hand over

1. One material, named in the hand-over as the deliberate choice.
2. Every shape seeded and nothing calls `Math.random()`; a film's boil reads `t`.
3. No SVG `filter`, gradient, `mask` or `clipPath` element (CSS gradients and `clip-path: polygon()` are fine); no handwriting font; no drawn people.
4. Every fill passes contrast; focus rings are plain; reduced motion stops every loop.
