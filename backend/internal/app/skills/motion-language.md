---
name: motion-language
title: Motion language: one vocabulary for everything that moves
title_zh: 动效语言：所有动效共用一套词汇
description: Use when a page, prototype, game interface or film animates: start from one motion language (named durations, curves and springs as tokens, the project's own or AwwO's), turn the brief's physical words into numbers kept in one tunable place, hold back what should not move, honour reduced motion, and end with a decision record for each moving component.
description_zh: 页面、原型、游戏界面或影片带动效时使用：从一套动效语言出发（时长、曲线、弹簧都是命名 token，用项目自己的或 AwwO 的），把需求里描述手感的词换成数字并集中放在可调的一处，克制不该动的东西，照顾减少动态效果，最后为每个会动的组件写一条决策记录。
category: design
applies: html,motion,video,design
version: 1
attribution:
---
# Motion language

Everything that moves in one piece of work speaks one vocabulary: named durations, curves and springs, written once at the top of the code and used by name. You cannot watch it, so never say you saw it move.

## 1. Start from a language

Use the motion language your inputs give (a MOTION.md or a token block) exactly. Without one, use AwwO's:

```css
:root {
  --dur-fast: 140ms; --dur-base: 200ms; --dur-slow: 260ms; --dur-scene: 400ms;
  --ease-enter: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-move: cubic-bezier(0.65, 0, 0.35, 1);
  --ease-exit: cubic-bezier(0.3, 0, 0.8, 0.15);
  --ease-emphasis: cubic-bezier(0.34, 1.4, 0.64, 1);
  --motion-distance: 1;
}
@media (prefers-reduced-motion: reduce) {
  :root { --dur-base: 140ms; --dur-slow: 140ms; --dur-scene: 140ms; --motion-distance: 0; }
}
```

In script, the same names: `MOTION.dur` { fast: 0.14, base: 0.2, slow: 0.26, scene: 0.4 } and `MOTION.film` { xs: 0.2, s: 0.4, m: 0.6, l: 1 } in seconds; `MOTION.ease` with the four curves as arrays; `MOTION.spring` snappy (stiffness 520, damping 36; zeta 0.79, settle 0.24 s), sheet (380, 32; 0.82, 0.28 s), land (85, 14.7; 0.8, 0.6 s), glide (95, 19.5; 1, 0.6 s), bounce (97, 11.8; 0.6, 0.7 s). Physics libraries take stiffness and damping; a film that evaluates a spring at time t takes zeta and settle.

- enter: arriving, settling, a state change. move: between two places on screen, cameras. exit: leaving. emphasis (about 5 % overshoot): one hero moment, position and scale only.
- Interface: fast for a press or hover, base for a menu or toast, slow for a sheet or dialog, scene between screens (the most a transition takes); an exit takes two thirds of its entrance.
- Film: xs a small element, s a card, m a move across the frame, l a title; frames = round(seconds x fps).
- A brief with a character sets its entrance and main move: trust (0, 0, 0.2, 1) 0.7 s; premium (0.4, 0, 0.6, 1) 1.6 s; bold (0.16, 1, 0.3, 1) 0.6 s; playful (0.34, 1.56, 0.64, 1) 0.9 s; calm (0.65, 0, 0.35, 1) 1.4 s; friendly (0.25, 0.46, 0.45, 0.94) 0.9 s.
- Every animated value goes through a token; a value that has to leave them is named in the decision record. When another skill on the node gives other durations, curves or springs, these tokens win.

## 2. Words first, then numbers

Write one sentence per moving thing in physical words before the code, then translate it:

| The brief says | Use |
| --- | --- |
| heavy | spring sheet, at most 2 % overshoot |
| light, snappy | spring snappy |
| lands (film) | spring land or curve enter |
| glides, precise | spring glide or curve move |
| playful | spring bounce, once |
| resists | past its limit, follow 0.08 to 0.2 of the drag |
| dismisses on a flick | let go faster than 800 px/s or past 30 % of its height |
| can be interrupted | start every motion from where it is now |

Keep every number a behaviour depends on in one `TUNE` object at the top, each beside the token it came from, so a person can adjust it while watching. Add a tuning panel only when the brief asks or the work is a prototype: one slider per value and a button that copies the values, hidden until a key (T) or a small Tune button opens it (a page shown in AwwO has no address for `?tune`), never shown in a render.

## 3. Restraint

- Never animate width, height, top, left, margin or padding, and never write `transition: all`; move with transform and opacity, distances times `--motion-distance`.
- Nothing decorative moves where people work; text holds still while it is read; one hero motion at a time; a brand mark fades or scales in once and never bounces or spins.
- Reduced motion, in CSS and through `matchMedia` in script: movement goes, fades stay at 140 ms, loops longer than 5 s stop. A film always keeps to at most 3 flashes a second, no camera shake, text still while read and a finished frame 0.

## 4. Hand-over

End with a decision record for each moving component, after the page, or as an HTML comment at the end of its body when your answer is only the page:

```
## <component>: <behaviour>
- Decision: <tokens, or numbers and why they are not tokens>
- Why: <the feel it gives>
- Rejected: <what else, and why not>
- Reduced motion: <what happens instead>
```

Then name what a person still has to judge on the real screen at real speed: the feel, what should not move at all, and the brand fit.
