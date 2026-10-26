---
name: anti-ai-slop
title: Strip the AI look: template tells to remove before handing over
title_zh: 去掉 AI 味：交付前必须清掉的模板痕迹
description: Use on any page, landing page, deck, poster or prototype a model writes, and in its review: the concrete patterns that mark output as default model work (stock indigo, two-stop gradients, emoji used as icons, invented metrics, filler copy, the left-border card), what to do instead, and how to add one deliberate choice.
description_zh: 模型写的网页、落地页、演示、海报或原型，以及对它们的评审都适用：一眼就被认出是模型默认输出的具体模式（默认靛蓝、双色渐变、表情符号当图标、编造的数字、填充文案、左侧色条卡片），替代做法，以及如何加入一个有意为之的设计选择。
category: design
applies: html,design,review
version: 2
attribution: Adapted from open-design (Apache-2.0, Copyright 2026 Open Design contributors); its list adapts refero_skill (MIT, Copyright (c) 2026 Refero); modified for AwwO
---
# Strip the AI look

A page assembled from defaults is recognised in a second. Every item below can be checked in the source. P0 never ships, P1 should be fixed, P2 when there is time. A brand guide in the inputs overrides only the colour and gradient rows, for its own colours and gradients.

## P0: never ship

| Tell | How to spot it | Instead |
| --- | --- | --- |
| Stock indigo or violet as the accent | #6366f1, #4f46e5, #4338ca, #3730a3, #8b5cf6, #7c3aed or #a855f7 anywhere except a brand's own token | The brand's colour, or a chosen direction's accent, as `--accent` |
| Two-stop "trust" gradient | purple to blue, blue to cyan (for example #3b82f6 or #2563eb with #06b6d4), indigo to pink, on a hero or a full background | A flat surface and type-led hierarchy; a gradient only to separate two levels |
| Emoji used as icons | sparkles, rocket, target, lightning, fire, light bulb, chart, party popper, check mark or star emoji inside a heading, button, list item or icon slot | Inline SVG with a 1.5-1.8 px stroke in `currentColor`, or no icon |
| Rounded card with a coloured left border | `border-left: 3px solid ...` together with `border-radius` | A hairline border all round, or drop the radius |
| Invented metrics | "10x faster", "99.9% uptime", "3x more productive", user counts or ratings nobody supplied | The task's real figure, or a labelled placeholder such as [conversion rate] |
| Filler copy | lorem ipsum, "feature one / two / three", "placeholder text", "sample content" | Copy from the brief; an empty section is a composition problem, not a gap to fill with words |
| A default face on titles | Inter, Roboto, Arial or a bare system-ui on h1 and h2 with no deliberate choice (a direction that names one, such as operator utility, is a choice) | A display face from the brand or the chosen direction |

## P1: should fix

- The fixed skeleton of hero, three features, pricing, FAQ and call to action with no variation: change the form of at least one section (a full-bleed quote, pricing set against the status quo, a small working demo in the page).
- Images from placeholder services (unsplash, placehold.co, picsum): AwwO's default preview blocks them and they break offline. Use a stored file the inputs name, inline SVG, a shape drawn in CSS, or a labelled placeholder box.
- More than about 12 raw hex values outside `:root`; the accent in 6 or more places on one screen.
- Hover that greys or lightens the text; two or more solid primary buttons for one action in one viewport; an icon beside every heading.
- A warm beige or cream page by default (only when the brand asks for it); hand-drawn SVG people or scenes; a purple wash on every layer.
- Controls only the designer would use (a palette switcher, a grid toggle) unless the brief asks for them.
- `scrollIntoView()` can scroll the page that holds the preview: scroll the container itself (`box.scrollTo({ top, behavior: 'smooth' })`).

## P2: polish

- Decorative blobs and waves that mean nothing.
- Perfectly symmetric sections with no tension: alternate one dense section with one that breathes.

## Add one deliberate choice

About 80% proven patterns and 20% decision. Put the 20% into one bold move (a typeface, one colour, an unexpected proportion), words specific to this product ("Start tracking" beats "Get started"), one small interaction worth remembering (a press that moves 2 px, a number that counts up once) and one detail only a real user would add (a keyboard hint, a status phrased the product's way). If someone outside the project can tell from a screenshot which product it is, it has character. One flourish per artifact; three is noise.

## Before you hand over

1. Search the source for every P0 pattern above; none remains.
2. Every number and every line of copy comes from the brief or is a labelled placeholder.
3. Name the one deliberate choice in a sentence of the hand-over (or an HTML comment).
