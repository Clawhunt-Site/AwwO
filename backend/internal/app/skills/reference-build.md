---
name: reference-build
title: Reference builds: rebuild an object from one picture, graded and measured against it
title_zh: 参考图重建：照一张图用代码重建物体，并逐条对照打分、量化测量
description: Use when a node must build a 3D object, creature, machine or set in code (three.js, or a Blender script) to match one reference picture, especially when it should come apart part by part (a cutaway, an exploded view) or be filmed: measure the picture first, write a numbered checklist with numbers and "never" lines, build every part that opens as a named group, grade each still against the picture, measure darkness and proportions instead of trusting the eye, stop for approval before filming, give every beat its own camera, and turn each correction into one line of the brief.
description_zh: 节点要用代码（three.js 或 Blender 脚本）照一张参考图做出物体、生物、机械或场景时使用，尤其是要逐件拆开（剖视、爆炸图）或拍成影片时：先量参考图，写带数字和“绝不”的编号清单，每个会拆开的部件单独成组并命名，每张静帧对照参考图逐条打分，用暗部占比和比例的测量代替目测，拍片前停下等人批准，每个节拍有自己的机位，每次纠正变成简报里的一行。
category: design
applies: html,design,motion,review
version: 1
attribution:
---
# Reference builds

Without a target, a model fills every gap with its safest shape and the result looks like a toy. With one picture and a list of the traits that picture rests on, it copies the evidence instead. Treat the picture as a target for looks only: rebuild everything in code, and never place, trace or load the image itself.

## Step 1: take the picture's numbers

- Silhouette ratios against the longest dimension, to two decimals: how tall it stands, the head, the jaw (or the longest limb), the widest point. Write "the jaw spans 0.36 body lengths", not "a big jaw".
- Dark fraction: inside the subject mask (step 4), the share of pixels darker than 80 on a 0 to 255 scale. That share is how much machinery shows; a closed white body has very little.
- Hero framing: the angle, the camera height, and the subject's share of the frame. A film's first frame shows the subject at 60 to 70 % of the frame, three-quarter front, already in motion.

## Step 2: a checklist of ten to twelve lines, written before code

- Order the lines from silhouette and viewpoint, through the one feature people remember and a second feature, to materials, the accent colour, and finally density.
- Give every size a number. One build was told "fine spikes" and returned quills double the right length; a range between 0.15 and 0.25 times the limb's thickness fixed it.
- Name the default each line resists, with the word "never": "glass over the gear train; never an opaque white side panel".
- The closing line is the dark fraction: no less than 0.8 times the picture's.

## Step 3: build it to come apart

- Every removable piece gets a separate group carrying an anchor point with a name (lens, wing, battery). A single `pose(state)` places every group for one instant, and the rest pose is where every piece goes home.
- Break white bodies into curved panels of three sizes with visible seams over the machinery; one unbroken shell keeps reading as plastic no matter what sits inside.
- Machinery in two tiers: large pieces (gear wheels, bearing rings, rams) and many small ones (piston rods, hose runs, fasteners) drawn with instancing.
- One family of limbs for each creature; legs and wings competing for attention read as clutter.
- Accent colour as edges, rims and seams, not scattered spots.

## Step 4: grade stills against the picture

1. Pose the build to match the picture and capture a single still.
2. Lay the picture, the new still and the last approved still in a row, and look at that row again shrunk to 900 px wide, where density shows.
3. Mark each checklist line pass, half or fail by looking at the picture itself; what you recall building is not evidence.
4. Then measure, because single features can pass while the whole still looks schematic: dark fraction ratio (fail under 0.8; when the picture's own dark fraction is under 0.02, compare the two fractions directly, within 0.01, and report the ratio as not applicable), each silhouette ratio within 0.03 of the picture's, frame share. A closed white mock-up once matched a picture's outline at 0.85 similarity with a dark fraction ratio of 0.19, so outline similarity proves little.
5. Repair the fails, then the halves. After the second round, show a person and wait: filming starts only on their approval. Run two builds at a time at most, each in a fresh session; notes given early change results, notes given late mostly add cost.

Measure pixels the scene drew, not the surrounding page: titles, labels and a floor shadow are not subject. Measure through a subject mask that does not depend on colour: render the measuring still with the floor and its shadow off and a transparent background, and take the subject's alpha as the mask (or an object-id pass); the dark fraction is the dark pixels inside the mask over the mask's pixels. Give the picture a mask drawn by hand on the same terms. Subtracting the backdrop is not a mask: white panels on a white backdrop vanish and a dark shadow counts as machinery.

## Step 5: film from a timing that already worked

- Use the most similar body's approved film as the template: keep its beat times and actions, scale its distances, replace only the body. A new body with new timing roughly doubles the rounds, so say early when nothing similar exists.
- Keep beats in one script file, in seconds; picture, page buttons and sound all take their times from it, so a recut is a change to one file.
- One motion at a time: the camera arrives (film.m on the move curve, or the glide spring), then the piece opens (film.m to film.l on enter), its label holds 1 s plus 1 s per 4 words (or per 5 Chinese characters) while nothing under it moves, then it closes on move in two thirds of its opening (MOTION.md's exit ratio). That makes a beat about 3.5 s with a two-word label; write the tuned values in `TUNE` and the reasons in the decision record. The finale: the camera steps back, everything flies out, the build turns on a turntable, comes home once the turn ends, and leaves.
- Give each beat a camera that differs from the previous one in direction, elevation or range and points at where the piece will be when open, so neither the camera nor a label moves while it is read. Cameras within 25 degrees of angle, 15 degrees of elevation and 20 % of distance of each other make the film feel static. Only the open piece has to stay visible.
- The camera never jitters with wingbeats or steps. Visible wing flapping stays between 1.5 and 2.5 cycles a second.
- A teaser is written as its own short script (an opening, one piece, the explode, a distinct exit), not cut from the long film's highlights.

## Step 6: one line per correction

Keep the brief as a file beside the build. Each correction a person makes becomes a line there, number included, and every later build starts from the file.

## In the sandbox computer

Render stills at the picture's size and view them next to it; for motion, `awwo-check-page page.html --out check --frames 0,2,5 --expect-motion --budget-ms 60000`, then look at `check/frames.jpg`. Report what you measured. Without a sandbox, state that nothing was seen or measured.

## Before you hand over

1. The picture's numbers and the checklist open the answer.
2. Removable pieces are named groups; `pose` drives them; all return to rest.
3. Per still: line grades, dark fraction ratio and silhouette ratios, or a plain note that they were not measured.
4. Each beat has its own camera, with none repeating; beats live in one script file.
5. The brief file with every correction so far.
