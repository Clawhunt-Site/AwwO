---
name: motion-discipline
title: Motion discipline: when interface motion earns its place
title_zh: 动效纪律：界面动效什么时候该有、该多快
description: Use when a page, app prototype or game interface animates: when motion helps (moving through space, time or state) and when it is decoration, duration and easing numbers, curves versus springs, reduced-motion and flashing limits, and rules for looping motion.
description_zh: 页面、应用原型或游戏界面带动画时使用：动效何时有用（空间、时间、状态的转换）、何时只是装饰，时长与缓动数值，曲线与弹簧的选择，减少动态效果与闪烁上限，以及循环动画的规则。
category: design
applies: html,motion,design
version: 2
attribution: Adapted from open-design (Apache-2.0, Copyright 2026 Open Design contributors); modified for AwwO
---
# Motion discipline

This skill is about motion inside an interface. For an animation that becomes a video, use code-motion.

## When motion earns its place

Animate when the user moves through space, time or state: navigating, a container opening into its detail, progress, a gesture following through, a change being confirmed. A moving explanation teaches no better than an equally informative still one, so do not animate to teach, to decorate, to look premium or to fill silence.

Confirm a change after it has happened: update the state first, then let motion acknowledge it. The user never waits for an animation to get a result.

## Durations

AwwO's tokens; a page with its own tokens uses those.

| Token | ms | Use |
| --- | --- | --- |
| fast | 140 | press, toggle, hover, confirming a state |
| base | 200 | a menu, popover or toast entering |
| slow | 260 | a sheet, dialog or drawer; a container changing shape |
| scene | 400 | between screens or a staged reveal; the most a transition takes |

An exit takes about two thirds of its entrance. On phones, take 80 %.

## Curves and springs

- Opacity and colour between known values: a curve. enter `cubic-bezier(0.16, 1, 0.3, 1)` for arriving or settling (the default); move `cubic-bezier(0.65, 0, 0.35, 1)` between two places on screen; exit `cubic-bezier(0.3, 0, 0.8, 0.15)` for leaving; emphasis `cubic-bezier(0.34, 1.4, 0.64, 1)`, about 5 % overshoot, for one moment, on position and scale only.
- Position, scale, rotation and anything a finger moves: a spring. snappy (stiffness 520, damping 36) for small things, sheet (380, 32) for heavy panels; both land without wobbling; with no library, step it each frame.
- Animate `transform` and `opacity`; never `width`, `height`, `top` or `left`.

## Reduced motion and flashing

- Under `@media (prefers-reduced-motion: reduce)`, remove translation, scaling, rotation, parallax and camera drift; keep opacity and colour fades, at 140 ms at most, where a change must still show. A script that animates checks `matchMedia('(prefers-reduced-motion: reduce)')` too.
- Never more than three flashes in any one second: flashing can trigger seizures.
- Motion is never the only sign of a change: pair it with colour, position or a label.

## Looping motion

- Anything that moves for longer than 5 seconds has a pause control: carousels, ambient backgrounds, tickers.
- Carousels stop after 3-5 cycles; a skeleton shimmer stops when content arrives; confetti plays once.
- Ambient motion stops when the tab is hidden (`visibilitychange`) and when the view changes.
- One `requestAnimationFrame` loop drives everything, its time step clamped (say to 1/30 s) so a stalled tab does not jump.

## In tools people work in

Spend motion on feedback inside the tool (a row expanding, a value updating), not on choreography; nothing decorative moves in the area where people work.

## Checklist

1. Every animation answers "which change does this explain?".
2. Durations within the table; only transform, opacity and short colour fades animate.
3. Reduced motion honoured in CSS and in script; at most three flashes a second; loops can be paused.
