---
name: design-jury
title: Design jury: a five-lens review of a page or design
title_zh: 设计评审团：从五个视角给页面或设计打分
description: Use for a review node that judges a delivered page, prototype, deck, poster or 3D scene: five lenses (brief fit, craft, brand and tokens, accessibility, copy), each scored 0-10 against stated anchors, a weighted total with a ship threshold, the AI-look tells that cap the score, and must-fix items the maker can act on.
description_zh: 评审节点评判交付的网页、原型、演示、海报或三维场景时使用：五个视角（需求契合、设计工艺、品牌与设计变量、无障碍、文案）按给定标准各打 0-10 分，加权总分与通过线，一旦出现就封顶的 AI 味问题，以及制作方可以直接照做的必改项。
category: design
applies: review,design,html
version: 1
attribution: Panel roles, weighting and threshold adapted from open-design (Apache-2.0, Copyright 2026 Open Design contributors); modified for AwwO
---
# Design jury

Review as five specialists in turn, then combine their scores. Judge only what the source and the inputs show: unless the inputs include a screenshot or a check record, you have not seen the page run, so say "read from the source" and never describe how it looks on screen as fact.

## The five lenses

| Lens | Weight | Asks |
| --- | --- | --- |
| Brief fit | 0.30 | Does it do what was asked, for the stated audience, with the stated content? Missing parts, the wrong form (one long page where slides were asked), invented content. |
| Craft | 0.20 | One entry point per region; type scale and leading (Chinese headings 1.3 or more); spacing rhythm; alignment; nothing overlapping, clipped or orphaned. |
| Brand and tokens | 0.15 | Colours and fonts from the brand or from one named direction, declared once in `:root`; the accent at most twice per screen; no colours off the palette. |
| Accessibility | 0.20 | Contrast in every state; focus rings; labels; a keyboard path; target sizes; `lang`; alternative text; reduced motion. |
| Copy | 0.15 | Specific, active, in the user's language; no filler; numbers real or labelled; empty and error states that say what to do. |

For a 3D scene, read craft as composition (a focal point, depth, scale cues, light on what matters) and add frame budget and a fallback without WebGL to accessibility.

## Anchors: use the whole scale

- 9-10: a senior designer would ship it unchanged; nothing to fix in this lens.
- 7-8: solid, with small fixes.
- 5-6: works, but generic or uneven; several real fixes.
- 3-4: a failure a user will meet (unreadable text, a broken layout, a missing state).
- 0-2: the lens fails outright (the wrong deliverable, no keyboard access at all).

## Caps

Any one of these caps the total at 6.0 whatever the other scores: stock indigo or violet as the accent; a two-stop purple, blue or cyan hero gradient; emoji used as icons; invented metrics; filler copy; body text under 4.5:1; a control that claims success without changing any state. A brand guide in the inputs lifts only the colour and gradient caps for its own colours; the other caps always hold.

## Verdict

Total = the sum of weight x score. Pass at 8.0 or more with no cap triggered and no lens under 5; otherwise it goes back to the maker. Open the conclusion with the verdict so AwwO can read it: `Verdict: pass` or `Verdict: needs rework` (on a Chinese canvas, `结论：通过` or `结论：不通过`). Then:

```
Scores: brief fit 8, craft 6, brand 7, accessibility 5, copy 8; total 6.8, capped at 6.0 (body text under 4.5:1)
Must fix, most damaging first:
1. [Accessibility] Body text #8a8a8a on #ffffff is 3.45:1. Use oklch(48% 0.012 250) or darker for --muted (4.5:1 or more).
2. [Craft] The two-line Chinese hero title has line-height 1.05; set 1.3.
Should fix:
- ...
Keep: the asymmetric 70/30 product section.
```

- Each must-fix item names its place (a selector, a section or the text itself), the measured problem and the concrete change, so the maker can apply it without guessing.
- At most 7 must-fix items; matters of taste go under "should fix".
- Name one thing to keep, so a rework does not throw away what works.
- A second round checks only the must-fix items and whatever they touched.
