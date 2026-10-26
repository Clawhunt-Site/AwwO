---
name: motion-discipline
title: Motion discipline: when interface motion earns its place
title_zh: 动效纪律：界面动效什么时候该有、该多快
description: Use when a page, app prototype or game interface animates: when motion helps (moving through space, time or state) and when it is decoration, duration and easing numbers, curves versus springs, reduced-motion and flashing limits, and rules for looping motion.
description_zh: 页面、应用原型或游戏界面带动画时使用：动效何时有用（空间、时间、状态的转换）、何时只是装饰，时长与缓动数值，曲线与弹簧的选择，减少动态效果与闪烁上限，以及循环动画的规则。
category: design
applies: html,motion,design
version: 1
attribution: Adapted from open-design (Apache-2.0, Copyright 2026 Open Design contributors); modified for AwwO
---
# Motion discipline

This skill is about motion inside an interface. For an animation that becomes a video, use code-motion.

## When motion earns its place

Animate when the user moves through space, time or state: navigating, a container opening into its detail, progress, a gesture following through, a change being confirmed. When studies compare a moving explanation with an equally informative still one, the motion does not teach better. So do not animate to teach, to decorate, to look premium or to fill silence.

Confirm a change after it has happened: update the state first, then let motion acknowledge it. The user never waits for an animation to get a result.

## Durations

| Duration | Use |
| --- | --- |
| 50-100 ms | press, toggle, hover |
| 150 ms | the default for confirming a state |
| 200-300 ms | something entering: a menu, a sheet, a dialog |
| 300-500 ms | moving between screens; a container changing shape |
| over 500 ms | staged or cross-screen transitions only |

A hover effect seen dozens of times stays at 200 ms or less. On phones, run 20-30% shorter, since the distances are shorter.

## Curves and springs

- Opacity and colour, between two known values: a curve. Standard `cubic-bezier(0.2, 0, 0, 1)`, which starts fast and settles; entering `cubic-bezier(0, 0, 0, 1)`; leaving `cubic-bezier(0.3, 0, 1, 1)`. `cubic-bezier(0.4, 0, 0.2, 1)` is the older standard.
- Position, scale, rotation and anything that follows a finger: a spring, critically damped or slightly under (damping ratio 0.8-1.0) so it lands without wobbling. With no library, write the spring as a few lines of code stepped each frame.
- Animate `transform` and `opacity`; never animate `width`, `height`, `top` or `left` every frame.

## Reduced motion and flashing

- Under `@media (prefers-reduced-motion: reduce)`, remove translation, scaling, rotation, parallax and camera drift; keep short opacity and colour fades where a change must still show. A script that animates checks `matchMedia('(prefers-reduced-motion: reduce)')` too.
- Never more than three flashes in any one second: flashing can trigger seizures.
- Motion is never the only sign of a change: pair it with colour, position or a label.

## Looping motion

- Anything that moves for longer than 5 seconds has a pause control: carousels, ambient backgrounds, tickers.
- Carousels stop after 3-5 cycles; a skeleton shimmer stops when the content arrives; celebrations such as confetti play once.
- Ambient motion stops when the tab is hidden (`visibilitychange`) and when the view changes.
- One `requestAnimationFrame` loop drives everything, with its time step clamped (for example to 1/30 s) so a stalled tab does not jump ahead.

## In tools people work in

Spend motion on feedback inside the tool (a row expanding, a value updating), not on choreography; nothing decorative moves in the area where people work.

## Checklist

1. Every animation answers "which change does this explain?".
2. Durations within the table; only transform, opacity and short colour fades animate.
3. Reduced motion honoured in CSS and in script; at most three flashes a second; loops can be paused.
