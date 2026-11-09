---
name: film-checks
title: Film checks: find the defects a film written as code hides
title_zh: 成片检查：找出代码视频里藏着的缺陷
description: Use when a film written as code (a page AwwO renders, or a Blender scene) must be checked before it is published, or when the node building one must plan its checks: which check catches which defect and what each misses (facts with sources, a reference as numbers, stills at the beats and cuts, a render-twice test, contact, visibility, colour and loop-seam measurements in awwoSelfTest, the reports, a person for taste), a review answer by frame, and how each fixed defect becomes a rule, a test or a brief line.
description_zh: 代码视频（AwwO 渲染的页面，或 Blender 场景）发布前需要检查，或负责制作的节点要先规划检查时使用：哪种检查能发现哪类缺陷、又会漏掉什么（带来源的事实清单、量化的参考、节拍与切点处的静帧、渲染两次比对、awwoSelfTest 里的穿模、可见性、颜色与循环接缝测量、渲染报告、只能靠人判断的品味），按帧给出的评审结论，以及把每个修好的缺陷变成规则、测试或简报里的一行。
category: video
applies: video,motion,review,html
version: 1
attribution:
---
# Film checks

A coded film can pass a quick look and still be wrong: a two-frame defect, a colour the lighting shifted, a frame that depends on earlier ones. Every check is blind to something: pair each risk with the check that sees it, and never report a check whose output is not in front of you.

## Which check sees what

| Check | Catches | Misses |
| --- | --- | --- |
| Facts list with sources | made-up prices, quotes, screens and names | a fact drawn badly |
| Reference as numbers | a generic set, light and camera | what the reference never showed |
| Stills at beats and cuts | a hidden subject, things the wrong way round, renderer artefacts | anything between stills; colour by eye |
| Render-twice test | frames that remember earlier calls | frames wrong every time |
| Per-frame measurement | interpenetration, colour drift, loop seams, sound off its frame | what nobody measured |
| The reports | a delivery that differs from the page | how it looks |
| A person | pace, tone, whether the film is worth watching | contact, colour drift, frame memory |

## 1. What the checks need from the plan

1. Facts: list every fact the film shows (each word on screen, name, mark, interface and brand colour) with its source: the task's text, or a file an upstream node stored, by its path. A fact with no source is a gap: say so before building, and if the film must still ship, mark the gap plainly; never fill it with something that passes for real. How the film is shot, cut and paced is the builder's call.
2. Turn a reference into measurements: lens and camera height, seconds per beat, its colours as hex, relative sizes, what in the music or story each part follows, and what it lends nothing (its people, marks and places). Set its stills beside yours at matching times, or list those times.
3. Beats: each row has a time, a shot and what the viewer has to see then, worded so one still settles it ("6.4 s, tight on the pack: the price is 8% of the frame height and nothing crosses it"). Frame 0 is a beat: often the cover, seen first and silent, so it must read at phone size.

## 2. Frames that do not remember

`renderAt(t)` must depend on t and nothing else (code-motion). It fails quietly when:

- a helper accumulates time or state (three.js's AnimationMixer, a tween advanced per call): set it from t on every call (`reset()` each played action, set its clip `time` and `weight`, `mixer.update(0)`) or write the effect yourself (motion-effects);
- a simulation moves bodies meant to rest before their start: pin them until their release time and bake the run at load;
- a spline that takes its slope from neighbouring keys bulges between two equal keys: make that segment flat;
- one layer leaves shared state behind (alpha, a blend or composite mode, a renderer setting): set what you draw with on every draw.

In `window.awwoSelfTest` (self-test-oracle), for three times T: draw T and hash its pixels, draw 0, a transition and the end, draw T again and compare, awaiting each call; then draw the time the page showed before. Read canvas pixels in the call that drew them, or create the WebGL renderer with preserveDrawingBuffer; on a DOM page compare element boxes and opacity. Plant a variant whose picture depends on a call counter; the test must reject it.

## 3. Stills where defects hide

AwwO's contact sheet shows 12 evenly spaced frames, blind to a two-frame glitch at a cut. Review a still of every beat and three consecutive frames around every cut and transition; with no stills in front of you, list those times for a reviewer. In a sandbox computer, run `awwo-check-page` with `--viewport` at the film's size (more `--wait-ms` when readiness takes over 1.5 s) on a copy of the page, saved beside it, that calls `renderAt(T)` once loaded and ready and stops the page's own loop; its screenshot.png is the still. That load runs in real time (CSS animations play on, Math.random is unseeded), loads no CDN fonts and shrinks a large PNG (`screenshotScale`): judge staging and direction there, type and fine detail on the render. Reuse one `--out`: the workspace snapshot holds 2 MiB.

Ask each still a yes-or-no question ("is the price whole and readable here?"), not "does it look good". Give each defect its frame, what shows it (a still, the code, or nothing yet), a probable cause, a minimal fix and the frames to see again; with critic attached, use its table, the frame as Where.

- Things the wrong way round come from numbers that look right in code: a flipped sign, a half-turn offset, rotations applied in the wrong order or inherited from a parent, a mirrored axis or UV. Judge direction on a still.
- At cuts and transitions look for a full-frame flash; detail under about 1.5 px at the output size, which anti-aliasing, a denoiser or compression erase; flicker or see-through patches where two surfaces share a plane (nudge one, or set their draw order); and a streak from an object parked off screen that jumps into place under motion blur (hide it instead).

## 4. Numbers a still cannot give

Keep a `pose(t)` apart from the drawing, so a check can pose every frame without drawing it. Write these checks into awwoSelfTest and run them with awwo-check-page in a sandbox computer (15 s at most, and the held-clock load shares its 25 s: aim for 5 s, geometry on every frame, pixels on a handful); in a Blender workstation, step `scene.frame_set(f)` in execute_blender_code, split across calls, and return counts, never meshes. Without either, write them and say they have not run.

- Contact: on every frame, test points on each held, worn or touching prop (vertices, or a few dozen surface samples) against simple volumes inside the parts it must not enter (never the hand that grips it), a box, capsule or sphere each. Pass is no point deeper than 2 mm at the scene's scale (1 px in 2D); report the count and the worst frame.
- Visibility: at every beat, project what must be seen; check it is inside the safe area, that rays from the camera to a few of its points meet it first (hidden objects excluded) and that text keeps 4.5:1 contrast with the pixels behind it.
- Colour: at each beat that shows the brand colour, take the median colour of a box on the lit brand surface and compare it with the brand hex in CIELAB: delta E 1976 under 4. Tone mapping, coloured light and post-processing move a colour, so the probe decides, not the hex in the code; fix the base colour per lighting setup.
- Loop seam: frame L must draw what frame 0 draws (compare pixels, which see shaders too, or world matrices, where a whole turn counts as none), and for each moving value (unwrapped where it wraps), the step into L and the step out of 0 (1 ms each) differ by at most twice the largest such difference between neighbouring 1 ms steps anywhere else.
- Sound: for a page's sound (renderAudio), in a render or an edit, find each hit's onset in the rendered buffer; it lands within one frame of the frame it marks.
- The file: read the render's report (frames, duration, distinct frames, warnings) and any edit's report; a warning is a defect until explained. Encoding blurs thin coloured lines and an edit's fit and transitions change the frame: compare an edit's stills with the page at the same times.

## 5. Turn each fix into a rule

Put each fixed defect's lesson in the layer that would have stopped it: a line in the brief, a test in awwoSelfTest, or a line in the shared rules every film starts from ("captions over footage sit on a plate"). A note in a prompt fixes nothing; a failing test does.

## Report and checklist

Report what outputs show, with numbers: "contact: 0 of 540 frames past 2 mm (awwoSelfTest, awwo-check-page verdict pass)". Say what no check covered and what is left to a person.

- Facts listed with sources, gaps marked, nothing passed off as real.
- Every beat states what the viewer has to see; frame 0 reads at phone size with the sound off.
- The render-twice test passes and catches its plant.
- Stills of every beat and around every cut reviewed, each finding with its evidence.
- Contact, colour, seam and sound measured where they apply, with numbers.
- What is unchecked, and what needs a person, is said.
