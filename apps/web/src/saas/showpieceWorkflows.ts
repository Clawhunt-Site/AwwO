import type { OfficialWorkflow } from './examples/officialWorkflows';
import { CORE_DUTIES, showpiece, type Showpiece } from './showpieceRules';

/** The showpiece canvases (showpieceRules.ts): each joins PRODUCTION_WORKFLOWS once a run of it is published (a case is
 * listed only with its record). */

// GATHER: hot glass on a blowpipe, a material study people work with their hands. Its glass is 48 rings along the pipe's
// axis: each has an inner and an outer radius, a temperature and a droop, and the glass between two rings never
// changes volume, so blowing thins the wall and the jacks' squeeze lengthens the piece. Cheap enough to replay twenty
// seconds for one frame, which renderAt does.
const GATHER_DESIGN = `## Part A - GATHER, the design
### A1 The piece
A glassblower's bench at night. A gather of molten glass sits on the end of a steel blowpipe that lies across two rails and turns. The visitor keeps it turning, blows it into a bubble, swings it long, necks it with the jacks, reheats it with the torch and knocks the finished vessel off; it goes on the shelf behind, up to six of them. Stop turning and it droops; blow a hot thin wall and it bursts. Left alone for 8 s the piece works a vessel by itself. Kicker "Material studies / No. 07", title "Gather", subtitle "hot glass, turned and blown". Caption: "A gather of molten glass on a blowpipe. Keep it turning, blow it into a bubble, neck it with the jacks and knock it off before it sets, or before it thins and bursts."
### A2 Space and units
1 unit = 10 cm. Y is up, the floor is y = 0. The pipe's axis is the line y = 1.15, z = 0 along X; the pipe (radius 0.045) runs from x = -6 to its hot end at x = 0 and rests on two rails across it at x = -1.2 and x = -3.4. The glass grows from x = 0 towards +X. The shelf is a board at y = 2.35, z = -2.4, from x = -1.6 to x = 4.4, with six slots 1 unit apart starting at x = -1. The torch stands at (2.6, 0.5, 1.2) and points at (1, 1.15, 0). The camera looks at (1.3, 1.15, 0) from yaw 14 degrees, pitch 11 degrees, distance 6.2, field of view 32 degrees; pitch stays within 2 to 60 degrees, distance within 3.5 to 10. Where the panel leaves the stage narrow (a phone), the camera backs off by m = max(1, 3 × stage height / (2 × tan 16° × 6.2 × free width)), drawing at distance × m, so the glass and the pipe's hot end fit what is free (m is 1 on a desktop, about 1.8 on a phone).
### A3 The glass (module glass)
N = 48 rings. Ring i holds: len[i] (the length of the segment from ring i to ring i + 1), area[i] (the glass cross-section of that segment), a[i] (inner radius), T[i] (degrees C), d[i] (droop below the axis). Derived every step: R[i] = sqrt(a[i]^2 + area[i] / PI) (outer radius), w[i] = R[i] - a[i] (wall), x[0] = 0 and x[i + 1] = x[i] + len[i]. A segment's glass, area[i] * len[i], never changes. There are 47 segments, 0 to 46: every sum over the glass runs over them, and ring 47 closes the tip.
A new gather, with u = i / 47: len[i] = 0.9 / 47; outer radius R0 = 0.05 + 0.24 * sin(PI * min(1, 0.04 + 0.98 * u))^0.6; a[i] = 0.02 * sin(PI * u); area[i] = PI * (R0^2 - a[i]^2); T[i] = 1150; d[i] = 0; pressure P = 0. The angle goes on turning.
Softness s(T) = 0 below 560, else min(2, exp((T - 1100) / 90)). smoothstep(e0, e1, v) = t * t * (3 - 2 * t) with t = clamp((v - e0) / (e1 - e0), 0, 1). Grip g(u) = smoothstep(0, 0.12, u): the glass on the pipe's end does not move. Window b(u) = g(u) * (1 - smoothstep(0.86, 1, u)): the tip stays closed.
Each step (dt = 1/60), in this order, with R, w and x as the step before left them:
1. Pressure: P += (target - P) * (1 - exp(-4 * dt)), target 1 while Blow is held, else 0.
2. Heat and cooling: while Heat is held, T[i] += 0.9 * (1250 - T[i]) * (0.35 + 0.65 * u) * dt; otherwise T[i] -= 0.035 * (T[i] - 25) * (0.6 + 0.4 * clamp(0.12 / w[i], 0, 3)) * dt. Then conduction, from a copy of T: T[i] += 0.6 * dt * (T[i - 1] + T[i + 1] - 2 * T[i]), an end ring using its one neighbour twice.
3. Blow (not while burst): da = 0.26 * P * s(T[i]) * b(u) * (a[i] + 0.12) * (1 + min(1, 0.05 / w[i])) * dt; e = 0.15 * da / (a[i] + 0.12); a[i] += da; len[i] *= 1 + e; area[i] /= 1 + e. A bubble grows faster the larger and thinner it is, and lengthens a little as it widens.
4. Swing (while Swing is held, not while burst), from segment 46 down to 0, with beyond the glass of segments i..46 (the sum of area * len): grow = min(0.02, 0.35 * s(T[i]) * g(u) * (beyond / area[i]) * dt); len[i] *= 1 + grow; area[i] /= 1 + grow; a[i] /= sqrt(1 + grow).
5. Jacks (not while burst): while the jacks press at axial position xp with press q (0 to 1): k = (x[i] - xp) / 0.16; f = max(0.96, 1 - 0.6 * q * s(T[i]) * g(u) * exp(-k * k) * dt); where R[i] * f >= 0.06: a[i] *= f; area[i] *= f * f; len[i] /= f * f.
6. Turn and droop: angle += turn * dt (turn is G.state.turn, 0 to 6 rad/s); spin = clamp(turn / 2, 0, 1); d[i] += (0.5 * s(T[i]) * (x[i] / 1.5)^2 * (1 - spin) - 1.5 * spin * d[i]) * dt, kept within 0 to 1.4.
7. Derive R, w and x. A value that is not finite calls G.fail('The glass went missing.').
8. State: 'working' while the mean temperature is 560 or more, then 'set'; 'slumped' once the largest d passes 0.9 (it stays so); 'burst' when the thinnest wall of a ring with a[i] > 0.05 is under 0.012 while P > 0.3: P becomes 0, burst is emitted once, and 1 s later a new gather comes.
Knock off (allowed 1 s after a gather came, not while burst): the piece goes on the shelf as { colour, grade, x, R, a, d } (copies; the oldest leaves when six are there), knock { grade } is emitted, and 1.2 s later a new gather comes in the same colour (gather is emitted). Grade, the first that holds: 'slumped'; 'thin' (thinnest wall under 0.015); 'solid' (air under 60 ml); 'even' ((thickest - thinnest) / mean wall under 0.8 over the rings with a[i] > 0.05); else 'plain'.
Worked numbers, for the tests: a new gather holds 156.6 ml of glass; A7's script leaves, at 20 s, a flask 14.3 cm long with a belly of radius 7.2 cm, a neck of radius 3 cm near the pipe, a thinnest wall of 1.6 mm and about 1,060 ml of air, still working at about 680 C.
Measures: temperature = the glass-weighted mean T; wall = the thinnest w over rings with a[i] > 0.05, in mm (w * 100), or none; air in ml = 1000 * sum(PI * a[i]^2 * len[i]); length in cm = 10 * x[47]; glass in ml = 1000 * sum(area[i] * len[i]) (constant).
### A4 Glass colours
| id | name | hex | absorption per unit (r, g, b) |
|---|---|---|---|
| clear | Clear | #e9f4f1 | 0.10, 0.05, 0.07 |
| cobalt | Cobalt | #2a4fd6 | 3.2, 1.6, 0.25 |
| amber | Amber | #d98a1c | 0.35, 1.1, 3.4 |
| green | Bottle green | #3f8f4a | 2.2, 0.5, 2.0 |
| rose | Rose | #d6587a | 0.4, 2.3, 1.5 |
| smoke | Smoke | #5b5f66 | 1.5, 1.4, 1.3 |
The first gather is amber.
### A5 Glow by temperature (linear RGB, piecewise linear between rows)
| T | r | g | b |
|---|---|---|---|
| 550 | 0 | 0 | 0 |
| 650 | 0.25 | 0.02 | 0 |
| 800 | 1.6 | 0.25 | 0.02 |
| 950 | 3.2 | 0.9 | 0.12 |
| 1100 | 4.5 | 2.2 | 0.6 |
| 1250 | 6 | 4.2 | 1.8 |
The glass's shader adds 0.36 of this glow, scaled by 0.3 + 0.7 * min(1, path / 0.3); more burns the hot gather out to a white shape with no form. The bloom's strength is 0.4 (0.6 with the lights out), and the glass's light on the room is 0.55 times the glow's largest channel. The dust is faint: points of 0.012 units at opacity 0.2.
### A6 Verbs, keys and the panel
| id | label | key | kind |
|---|---|---|---|
| glass.blow | Blow | KeyB | hold |
| glass.heat | Heat | KeyH | hold |
| glass.swing | Swing | KeyS | hold |
| glass.knock | Knock off | KeyK | press |
| glass.new | New gather | KeyN | press |
| piece.dark | Lights out | KeyL | press (toggles G.state.dark) |
| piece.mesh | Show rings | KeyM | press (toggles G.state.mesh) |
| piece.pause | Pause | Space | press |
| piece.quarter | Quarter speed | KeyQ | press |
| view.reset | Reset view | Digit0 | press |
Pointer: pressing on the glass works the jacks there (how deep the pointer is inside the glass is the press); dragging anywhere else orbits, 0.3 degree per CSS pixel; the wheel or a pinch zooms; a double click resets the view. Panel, top to bottom: Glass (six swatches), Turn (a slider 0 to 6 rad/s in steps of 0.1, shown in rpm, its ends named "resting" and "fast"; it starts at 3), the hold verbs as buttons that work while pressed, Knock off, New gather, then the toggles. Readouts: Temperature (C, 0 digits), Wall (mm, 1 digit, "solid" when none), Air (ml, 0 digits), Length (cm, 1 digit). Status chip: LIVE, PAUSED, SELF-PLAYING, SET, SLUMPED, BURST or the failure. Hint: "Keep it turning. Hold B to blow, S to swing, H to reheat; press on the glass to neck it; K knocks it off." Footnote: "1 unit is 10 cm. Temperature is the glass-weighted mean of 48 rings; wall is the thinnest ring; air is the bubble's volume."
### A7 The script (seconds, action, argument); it is the attract mode, the recording and a test
0 state { turn: 3 } | 0.4 glass.heat true | 2.4 glass.heat false | 2.8 glass.blow true | 4.6 glass.blow false | 5.4 glass.swing true | 6.6 glass.swing false | 7.2 jack { at: 0.22, press: 0.9 } | 8.6 jack null | 9.2 glass.heat true | 10.8 glass.heat false | 11.2 glass.blow true | 12.6 glass.blow false | 13.4 jack { at: 0.2, press: 0.8 } | 14.4 jack null | 15 glass.blow true | 15.9 glass.blow false | 16.5 state { turn: 1.5 } | 22 glass.knock true | 24 colour next | 24.5 state { turn: 3 }
jack's at is a fraction of the glass's length, taken anew each step while that jack is held; colour next takes the next colour of A4. While the script runs the view drifts: yaw = 14 + 10 * sin(G.time * 0.12) degrees.
### A8 Budget
At most 120 draw calls and 400,000 triangles a frame; the bench at most 40 meshes; the glass 48 rings by 40 around; one shadow map (2,048, or 1,024 on the low tier); pixel ratio at most 2 (1 on low, 1.5 on medium).
### A9 Acceptance tests (number, owner, name: what must hold)
1. core: events and verbs: listeners run in the order added and an unsubscribe stops one; a disabled command returns false; a hold verb gets run(true) then run(false).
2. core: the clock: G.loop.step(60) moves G.time by exactly 1 s and runs systems lower order first.
3. core: the replay: G.restart(), G.play() and 360 steps give the same G.checksum() twice, and G.touch() during attract mode emits mode { attract: false }.
4. render: one frame draws at most 120 calls and 400,000 triangles (G.render.info()).
5. render: the passes end in bloom and output, and uniforms.tBehind is a texture of the drawing size.
6. render: lights out: with G.state.dark set, 120 frames of G.loop.frame() bring G.render.uniforms.uDark.value over 0.9, and back under 0.1 after it is cleared.
7. glass: a new gather has 48 rings, length 0.9 within 0.001, a closed tip (R[47] at most 0.06) and 156.6 ml of glass within 0.5 %.
8. glass: blowing 90 steps at 1150 C raises the air from under 5 ml to over 20 ml while the glass changes by less than 0.1 %.
9. glass: cooling: 600 steps with nothing held bring the temperature under 1000 and leave it over 560.
10. glass: set glass does not blow: at 500 C everywhere, 120 steps of Blow change the air by less than 0.001 ml.
11. glass: swinging 120 steps at 1150 C lengthens it by at least 40 % with the glass within 0.1 %.
12. glass: droop: 180 steps with turn 0 leave d[47] over 0.25; 240 more with turn 3 bring it under 0.1.
13. glass: the jacks at mid length with press 1 for 60 steps narrow that ring's R by at least 30 % with the glass within 0.1 %.
14. glass: over-blowing bursts: Heat 240 steps, then Blow up to 900 steps: the state becomes 'burst' and burst is emitted exactly once.
15. look: G.look.emission(500) is black; emission(1150)'s red is over 4; red rises from 700 to 1200.
16. look: the mesh has 48 rings of 41 vertices, and 60 steps of Blow widen its bounding radius.
17. look: a knocked-off piece appears on the shelf: G.look.shelf gains one child.
18. bench: at most 40 meshes, and after 30 steps at turn 3 the pipe has turned by G.glass.angle.
19. bench: six distinct slots on the shelf; torch(true) shows the flame; the glow's intensity is over 0 at 1100 C and under 0.02 at 400 C.
20. hands: pick at the glass's centre on screen returns a press over 0.5 and an x within the glass; pick at a corner returns null.
21. hands: the script is in rising t and names only registered commands and acts; its first jack presses at 0.22 of the length (G.glass.jack.x within 0.001 of 0.22 * x[47]); 1,200 steps of it leave over 150 ml of air, a neck (the smallest R in the first third under 0.7 of the largest R) and no burst.
22. hands: KeyB down then up runs glass.blow true then false, but not while an input has focus.
23. sound: G.sound.render('ting', 2) peaks between -18 and -6 dBFS, has energy in its first 100 ms and ends under a thousandth of its peak; nothing sounds before unlock.
24. sound: 40 plays leave at most 24 voices; a muted render is silent.
25. panel: every panel command has a button; the six swatches set G.state.colour.
26. panel: after 90 steps of Blow, G.panel.refresh() shows the measured air (over 20) in the Air readout.
27. panel: pause shows PAUSED on the status chip; G.fail('x') shows the fallback with its reason.
### A10 Planted failures (id, owner, the wrong variant, the tests that catch it)
| P1 | core | the fixed step is 1/30 s | 2 |
| P2 | glass | blowing leaves area untouched but adds a to R (the glass grows) | 8 |
| P3 | glass | cooling warms (the sign is flipped) | 9 |
| P4 | glass | softness is never 0 | 10 |
| P5 | glass | droop ignores the turning | 12 |
| P6 | look | the glow ignores the temperature | 15 |
| P7 | hands | the jacks' at is used as a position in units, not a fraction | 21 |
| P8 | sound | the ting never releases (neither its decay nor its fade) | 23 |
| P9 | panel | a readout keeps its first value | 26 |`;

const GATHER_API = `Gather API sheet (fixed; each module owns exactly its namespace and the names listed for it; every other module may call these names and nothing else):
- core: the kernel's names, and the commands piece.pause, piece.quarter, piece.restart and test.run.
- render: G.render = { renderer, scene (the opaque world), hero (a Scene for the glass, drawn after the world and over it), cam (a PerspectiveCamera), uniforms ({ tBehind, uRes, uTime, uNear, uFar, uDark }, each { value }, one object shared with the look's materials: tBehind is the world as drawn without the hero, in linear light), key (the DirectionalLight that casts the shadow), view ({ yaw and pitch (degrees) and dist (units), the goals the camera eases to; orbit(dx, dy) adds degrees to them; zoom(k) multiplies dist; reset(); free ({ x, y, w, h } in CSS pixels: the part of the stage no panel covers, which the hero is centred in) }), frame(dt), resize(), info() -> { calls, triangles } of the last frame, passes() -> the pass names in order, setQuality(tier) }.
- glass: G.glass = { N (48), len, area, a, T, d, R, w, x (Float32Arrays of N), P, angle, state ('working' | 'set' | 'slumped' | 'burst' | 'none': none from a knock-off until the next gather, when nothing of it is drawn), colour (the id of the piece being worked), age (s since the gather came), held ({ blow, heat, swing }), jacks(x, press) (press at axial x until jacksEnd()), jacksEnd(), jack (null or { x, press }), knock() -> the grade or null, gather(colourId), shelf ([{ colour, grade, x, R, a, d }], at most 6), measure() -> { temperature, wall (mm or null), air, length, glass }, softness(T), step(dt) }. Commands glass.blow, glass.heat, glass.swing, glass.knock, glass.new. Events burst, knock { grade }, gather { colour }.
- look: G.look = { mesh (the glass, in G.render.hero), shelf (a Group in G.render.scene of the kept pieces), colours ([{ id, name, hex, sigma }]), colour(id), emission(T) -> [r, g, b], update(), wire(on) }.
- bench: G.bench = { root, pipe (an Object3D that turns about X with G.glass.angle), slot(i) -> { x, y, z }, torch(on) (shows the flame whatever is held; the bench itself shows it while G.glass.held.heat), glow (a PointLight at the glass, driven by its temperature), counts() -> { meshes } }.
- hands: G.hands = { device ('mouse' | 'touch' | 'keys'), pick(clientX, clientY) -> { x, press } or null, script }. Acts jack and colour. Commands view.reset.
- sound: G.sound = { ctx (null until unlocked), unlock() (safe to call again), muted, mute(on), play(name, options) -> a handle or null, bed(name, level), voices(), render(name, seconds) -> a Promise of a Float32Array (that sound alone, offline, at 48,000 Hz), names }.
- panel: G.panel = { el, status(text), refresh(), free() -> { x, y, w, h }, fallback(reason), selftest() }. Commands piece.dark, piece.mesh.
- System orders (G.system): hands 10, glass 50, look 70, bench 80, sound 94. G.onRender orders: look 10, bench 20, panel 30, render 100.`;

const GATHER_DIRECTION = `Direction (the source of the look and the sound):
- A dark workshop at night, warm and quiet: charcoal walls, a polished concrete floor that takes a soft reflection of the glow, blued steel, oiled beech handles. The only saturated thing in the room is the glass.
- Light: one large soft key from above and a little to the left, the colour of a tungsten lamp; a cool, dim rim from behind on the right; and the glass itself, which lights the pipe, the rails and the floor under it in its own colour while it is hot.
- The glass: hot, it glows from within, yellow-white at its hottest through orange to a dull red, and the glow blooms; as it cools the colour of the glass comes through, clear where the wall is thin and deep where it is thick; what is behind it shows through, bent. Three pale threads run through it lengthwise so the turning can be seen.
- Lights out: the room goes to a twentieth of its light and the glass and the torch are what is left.
- The interface: warm paper on charcoal, hairlines, one ember accent; a display serif for the title, a grotesque for labels, a mono face for numbers.
- Sound: a hushed room. The torch is a low roar with a breath of hiss; blowing is air through a tube; the pipe ticks softly on its rails as it turns; the jacks squeak; a knocked-off piece rings like a small bell and clinks on the shelf; a burst is a soft pop and a scatter of grit. Nothing is loud, and there is no music, but quiet means few sounds, not sounds too faint to hear: as peaks in dBFS, the knock-off's ting -12, the clink and the pop -16, a tick -26; the beds, the torch -16, the breath -18, the jacks -24, the rails -34; a master gain of +11 dB into a limiter (threshold -10 dB, ratio 4).`;
const GATHER_DIRECTION_SECTIONS = `1. Palette tokens (hex): room, floor, wall, steel, wood, paper, muted, hairline, accent.
2. Materials: the floor, wall, steel pipe (with its heat tint towards the hot end), rails, wood, shelf and tools: colour, roughness, metalness, and the noise each takes from a canvas texture.
3. Light: the key's direction, colour and intensity, the rim, the fill, the environment's strength, and the glass glow's range and intensity against temperature; the lights-out values.
4. The glass shader's numbers: index of refraction, how far the background shifts per unit of thickness, the density that scales A4's absorption, the Fresnel base, the highlight's sharpness, the threads' width and brightness, and how the glow of A5 is added.
5. Bloom and grade: threshold, strength, radius, exposure, vignette, grain.
6. Interface tokens: the type sizes, the panel's width, paddings, the swatch and button styles, the status chip's colours.
7. A synthesis recipe for every sound name: torch, breath, rails, jacks, ting, clink, pop, tick, each with its peak in dBFS as the direction gives it.`;

const GATHER: Showpiece = {
  id: 'gather-glass',
  title: 'GATHER hot glass study',
  name: 'GATHER',
  global: 'Gather',
  file: 'gather.html',
  brief: 'Build GATHER, an original material study in one web page: a gather of molten glass on a blowpipe at a glassblower\'s bench, which a visitor keeps turning, blows into a bubble, swings long, necks with the jacks, reheats with a torch and knocks off onto a shelf. Stop turning and it droops; blow a hot thin wall and it bursts. The glass is simulated live as 48 rings that keep their volume; it glows by its temperature and shows the room through itself, bent and tinted; the bench, the light and every sound are made in code, with no file loaded. Left alone it works a vessel by itself, and the same script replays for any second, so the page can be recorded and checked frame by frame. Eight builders write it against one fixed kernel contract, and it tests itself: twenty-seven acceptance tests and nine planted failures run inside the page in a headless browser, a first pass fixes what fails, and a second looks at the page\'s frames and fixes what they show. Every name and word is original.',
  lib: [
    ['THREE', "import * as THREE from 'three';"],
    ['EffectComposer', "import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';"],
    ['RenderPass', "import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';"],
    ['UnrealBloomPass', "import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';"],
    ['ShaderPass', "import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';"],
    ['OutputPass', "import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';"],
    ['Pass', "import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';"],
    ['FullScreenQuad', ''],
    ['RoomEnvironment', "import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';"],
    ['mergeGeometries', "import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';"],
  ],
  events: 'burst, knock { grade }, gather { colour }',
  state: 'colour (an id of A4), turn (rad/s), dark, mesh, quarter',
  api: GATHER_API,
  design: GATHER_DESIGN,
  direction: GATHER_DIRECTION,
  directionSections: GATHER_DIRECTION_SECTIONS,
  fonts: 'Playfair Display, Manrope or JetBrains Mono',
  style: 'html,body{margin:0;height:100%;overflow:hidden;background:#14110f;color:#efe6d6;font:13px Manrope,system-ui,sans-serif}#stage{position:fixed;inset:0}#stage canvas{display:block;width:100%;height:100%;touch-action:none}#boot{position:fixed;inset:0;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 60%,#3a1c0c 0%,#14110f 70%);font:italic 400 84px/1 "Playfair Display",Georgia,serif;color:#efe6d6}',
  // 960x600 keeps the page's first load in step with the check's software renderer (at 1120x700 its first screenshot
  // took 18 s of the 20 s it may) and is still wide enough for the page not to stack.
  check: { frames: [1, 5, 9, 14, 20], viewport: '960x600', drawCalls: 120, triangles: 400000 },
  look: `- the glass and the pipe's hot end sit whole inside the part of the stage the panel leaves free, with room around them, at every frame;
- at 1 s the gather glows yellow to orange and lights the pipe and the floor under it; by 20 s it is a hollow vessel with a neck, cooler than it was;
- where the wall is thin the room shows through the glass, bent; where it is thick the glass takes its colour;
- no frame is mostly black (pixels.dark under 0.6) or burnt out (pixels.bright under 0.05), and the room reads (lumaStdDev 12 or more);
- the pipe and the glass have turned between frames, and the three threads show it;
- the masthead, the panel and the readouts are readable and nothing overlaps.`,
  modules: [
    { id: 'core', title: 'Kernel', limit: 16000, duties: `${CORE_DUTIES}
- Tests 1-3; plant P1.` },
    { id: 'render', title: 'Renderer and light', limit: 18000, art: true, duties: `- A WebGLRenderer in the boot root (no WebGL 2: G.fail('This piece needs WebGL 2.') and nothing else), sRGB output, pixel ratio by the tier (A8). Create it inside try and catch.
- Two scenes: scene, the opaque world, and hero, the glass. Each frame: draw scene into a half-float target (its texture is uniforms.tBehind); then draw scene and hero together into the composer's buffer, so the hero is hidden by what is in front of it and can read the world behind it from tBehind; then UnrealBloomPass, then OutputPass (tone mapping and sRGB). Do this as one custom Pass at the head of an EffectComposer. passes() lists the pass names.
- Light by the direction: the key (a DirectionalLight casting one shadow map by the tier, PCFShadowMap with a radius; r186 has no PCFSoftShadowMap), a rim, a hemisphere fill, and scene.environment from a PMREM of RoomEnvironment at the direction's strength.
- The camera as A2 says, from view.yaw, view.pitch and view.dist (times A2's m for a narrow stage), each eased towards its goal by damping; orbit and zoom set the goals within A2's limits; reset returns to A2's values; cam.setViewOffset centres the look-at point in view.free.
- Lights out: uniforms.uDark eases to 1 while G.state.dark (rate 3 per second) and back; it scales the key, rim, fill and environment down to 5 % and the background towards black.
- uniforms.uTime follows G.time; uRes, uNear and uFar follow the camera and the size. resize() on window resize and on quality, with every target.
- frame(dt) is registered with G.onRender at order 100 and draws one frame; info() reads renderer.info with autoReset off across the composer's frame.
- Tests 4-6.
- Must not touch the glass's numbers or the interface.` },
    { id: 'glass', title: 'Glass simulation', limit: 18000, duties: `- A3 exactly, in its order, on Float32Arrays, as system 50 and as G.glass.step(dt); no allocation in a step.
- The commands glass.blow, glass.heat and glass.swing (hold: they set G.glass.held), glass.knock and glass.new; jacks and jacksEnd; the shelf; the grade; measure(); softness.
- A reset that brings the first gather back in amber with an empty shelf; G.state.colour is the colour of the next gather and of the one being worked (setting it recolours the piece at once).
- The readouts temperature, wall, air and length (G.readout.provide, as A6 words them); the facts rings (48) and glass (ml); G.checksum of len, area, a, T and d.
- Tests 7-14; plants P2, P3, P4 and P5.
- Must not touch three.js or the DOM.` },
    { id: 'look', title: 'Hot glass look', limit: 18000, art: true, duties: `- The glass mesh in G.render.hero: 48 rings of 41 vertices (the seam doubled), ring i a circle of radius R[i] about the point (x[i], 1.15 - d[i], 0) in the plane across X, turned by G.glass.angle; positions and normals rewritten each frame in update() (G.onRender order 10) with per-vertex attributes for temperature, wall and whether the ring is hollow; a cap closes the tip; while G.glass.state is 'none' the mesh is hidden.
- One ShaderMaterial for it, using G.render.uniforms: the path through the glass is twice the wall over the facing (hollow) or the chord through the solid; the room behind (tBehind) is read at a place shifted along the normal by the direction's amount times that path; it is tinted by exp(-sigma * path * density) with the colour's sigma (A4); a Fresnel reflection of a soft key and rim is added, one tight highlight, the three threads (bands in the angle around the axis, turning with it), and A5's glow for the vertex's temperature, above 1 so that the bloom takes it. Under uDark the reflection goes and the glow stays.
- emission(T) is A5, piecewise linear; colours is A4; colour(id) its entry.
- The shelf: a Group in G.render.scene; on knock, a mesh of the kept piece's rings at half size, upright on its slot (G.bench.slot), cold, in its colour, with a dim constant in place of tBehind (it is in the world tBehind is drawn from); on restart it empties.
- wire(on): the rings and eight meridians as lines over the glass, shown while G.state.mesh.
- The fact triangles (the glass's count).
- Tests 15-17; plant P6.
- Must not change G.glass or draw the bench.` },
    { id: 'bench', title: 'Bench and torch', limit: 16000, art: true, duties: `- The room of A2 from the direction's materials, each texture drawn in code on a canvas: the floor, the back wall, the shelf board, the two rails on their legs, a rack with tools, all static parts merged per material so that the bench is at most 40 meshes; everything casts and takes the key's shadow.
- The pipe: a steel cylinder with a wooden grip and a few turned rings near its end so that its turning shows, vertex colours tinting it straw to blue towards x = 0; pipe.rotation.x follows G.glass.angle each step (system 80).
- The jacks: two long blades shown closing on the glass at G.glass.jack.x while it is pressed, open and parked on the rack otherwise.
- The torch at A2's place: a nozzle, and a flame (an additive, transparent cone that never writes depth, its flicker from G.time) shown while G.glass.held.heat, read each step, or once torch(true) was called.
- glow: a PointLight that sits at the middle of the glass, its colour and intensity from G.look.emission of the mean temperature, by the direction's numbers.
- Sixty motes of dust drifting in the key's light from G.time; none under reduced motion.
- The fact meshes.
- Tests 18-19.
- Must not touch the glass's numbers.` },
    { id: 'hands', title: 'Hands and script', limit: 14000, duties: `- Every device: keys by event.code to the commands (a hold verb down on keydown, up on keyup, repeats ignored, nothing while an input, select or textarea has focus); the pointer on the canvas; the wheel; touch with one finger as the pointer and two as a pinch. Each of these calls G.touch(), and each trusted one (event.isTrusted) G.sound.unlock() until the sound runs.
- pick(clientX, clientY): the ray from the camera through that point against the glass's rings (the closest approach to the line through the ring centres): null when it passes outside R[i] * 1.1 of every ring, else { x, press } with press from how deep inside the glass it passes (0 at the surface, 1 at the axis, at least 0.3 once inside).
- Pressing on the glass works the jacks: each step while it is held (system 10), G.glass.jacks(x, press) for where the pointer is now; releasing ends it. Pressing elsewhere and dragging orbits (G.render.view.orbit with 0.3 degree per CSS pixel dragged); the wheel and a pinch zoom; a double click or view.reset resets the view. Cursors: grab over the glass, grabbing while pressing, move while orbiting.
- G.script is A7; the acts jack (null ends it; otherwise, each step until the next jack, the jacks at at * the glass's length as it then is, with its press) and colour ('next' sets G.state.colour to the next of A4). While G.playing, the view's yaw goal follows A7's drift.
- Tests 20-22; plant P7.
- Must not draw anything.` },
    { id: 'sound', title: 'Sound', limit: 14000, art: true, duties: `- No AudioContext before unlock(), which the first gesture calls; then a master gain into a limiter, with buses for beds and effects; mute(on) and G.sound.muted; suspended while the page is hidden.
- Every sound name of the direction synthesized from oscillators, one shared noise buffer (filled from G.rng) and filters, each recipe a function of (context, destination, time, options) so that play() and render() share it; envelopes always ramp; at most 24 voices, the beds counted among them, the oldest released first.
- Beds, their level eased: torch while heat is held, breath by G.glass.P, rails by G.state.turn. Effects: jacks while they press (a squeak now and then, by G.time), ting and then clink on knock, pop on burst, tick on a command event that a person caused (not while G.playing).
- render(name, seconds): that sound alone in an OfflineAudioContext at 48,000 Hz, as a Float32Array; a muted render is silence.
- Tests 23-24; plant P8.
- Must not touch the DOM beyond its listeners.` },
    { id: 'panel', title: 'Panel and readouts', limit: 18000, art: true, duties: `- Everything over the canvas, in G.ui.layer('panel'), from A1 and A6 and the direction's interface tokens: the masthead top left (kicker, title, subtitle, caption; it takes no pointer events), the specimen panel on the right (288 px), the readouts and the hint bottom left with the footnote, the notes drawer bottom right (a details element with four short paragraphs: the rings, heat and time, light through glass, sound; their counts from G.facts.get()), and the status chip.
- The panel is built from the registries: a button for every command with panel set (a hold verb works while pressed: pointerdown runs it true, pointerup, pointercancel and pointerleave run it false), swatches for A4 that set G.state.colour, the Turn slider, toggles that show their state. Every control has a visible focus ring and a title with its key.
- refresh() writes the readouts from G.readout.list() (called 8 times a second from G.onRender at order 30, and at once on a state event); status(text) sets the chip, which follows pause, mode, burst, knock and the glass's state.
- free() is the stage's rectangle less the panel's and the masthead's columns; on resize and at init it sets G.render.view.free and calls G.render.resize(). Under 860 px wide the page stacks: the stage keeps the top 55 % and the rest scrolls under it.
- fallback(reason): on fail, a centred panel with the reason in place of the stage. selftest() (F9): an overlay that runs G.tests.run() and lists every test and plant, green or red, with the counts.
- Commands piece.dark and piece.mesh (they toggle G.state); the stylesheet inserted once at init; transitions by the motion language (140 ms for a press, 200 ms for a panel), none under reduced motion.
- Tests 25-27; plant P9.
- Must not touch the canvas or the simulation.` },
  ],
};

// MOSSGREEN: three holes of miniature golf on a floating island, drawn as pixel art. The ball rolls on each hole's height
// by fixed substeps (a rolling ball's pull, the carpet's or the sand's drag, walls that give back 0.62 of the speed into
// them, a cup that takes only a slow ball), and the autopilot searches its shots with that same code, then errs like a
// hand. Tuned on a prototype: over 24 seeds the autopilot scores 5 to 12 on the par-8 course, 7.0 on average.
const MOSSGREEN_DESIGN = `## Part A - MOSSGREEN, the design
### A1 The piece
A floating island in a morning sky carries three holes of miniature golf, built like a model: a moss-green carpet in timber edges, a bunker, a pond, a little windmill. The visitor drags back from the ball and lets go to putt: walls bounce it, slopes bend it, sand stops it, the pond sends it back for a stroke, the windmill's sails close its tunnel, and the cup takes the ball only when it arrives slowly. Left alone for 8 s the piece plays the round itself. It is drawn as pixel art: the world is rendered at a third of the screen's resolution, outlined, dithered and held to the 48 colours of A8. Kicker "Pocket dioramas / No. 03", title "Mossgreen", subtitle "three holes on a floating green". Caption: "Three holes of miniature golf on an island in the sky. Drag back from the ball and let go to putt; the cup only takes a ball that arrives slowly."
### A2 Space, units and the camera
1 unit = 1 m. Y is up; a hole's carpet lies at y = h(x, z) (A3), the island's ground at y = 0. The island's top edge lies around (0, -0.6) at radius 7.9 + 0.3 * sin(3 a) + 0.15 * sin(7 a) for the angle a; its rock tapers to a point at y = -4.5; the clubhouse stands at (3.2, 3.4); trees and stones stand outside the lanes; clouds drift below. Each lane is edged by timber walls 0.08 high and 0.06 thick, centred on its outline.
The camera is orthographic. It looks at the centre of the hole in play (A3) from 30 units away, at yaw 45 + view.yaw degrees (view.yaw starts at 0; view.left and view.right turn it by 90; a drag turns it freely) and pitch 32 degrees (20 to 70). Its frustum's half-height is H = max(Hh, Wh * stage height / free width) / zoom, with the hole's Hh and Wh (A3), the free part of the stage (the panel's free()) and zoom (1, within 0.6 to 2.5); cam.setViewOffset centres the hole in the free part. The close view (G.state.close) has H = 1.4 / zoom and centres on the ball. Changes of hole, view and zoom ease at rate 4 a second; while recording they jump.
### A3 The course (module course)
| no | name | par | tee | cup | outline (closed, in order) | more walls | sand (centre, radius) | water (x0, z0, x1, z1) | h(x, z) | centre | Hh, Wh |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | The Ridge | 2 | -5.5, -3.6 | -1.1, -3.35 | (-6, -4.2) (0, -4.2) (0, -3) (-6, -3) | a block x -2.2 to -1.9, z -3.55 to -3.15 (its four sides) | none | none | 0.08 * exp(-k^2), k = ((x + 3.2) + 0.5 * (z + 3.6)) / 0.45 | -3, -3.6 | 1.9, 2.8 |
| 2 | Dogleg | 3 | -5.5, -1 | -2.2, 2.4 | (-6, -1.6) (-1.6, -1.6) (-1.6, 3) (-2.8, 3) (-2.8, -0.4) (-6, -0.4) | none | (-3.25, -0.75), 0.32 | -2.8, 0.7, -2.3, 1.5 | 0.04 * S(-2.8, -1.6, x) * S(-0.4, 0.2, z) | -3.6, 0.7 | 2.4, 3.3 |
| 3 | The Mill | 3 | 1.3, -0.4 | 5.9, -0.05 | (0.8, -1) (6.4, -1) (6.4, 0.2) (0.8, 0.2) | the mill's base across the lane, x 3.4 to 3.8, with a tunnel from z -0.58 to -0.22: x = 3.4 and x = 3.8 from z -1 to -0.58 and from -0.22 to 0.2; z = -0.58 and z = -0.22 from x 3.4 to 3.8 | none | none | 0.16 * S(4.2, 4.8, x) | 3.6, -0.4 | 1.8, 3 |
S(e0, e1, v) = t * t * (3 - 2 * t) with t = clamp((v - e0) / (e1 - e0), 0, 1); grad is h's exact derivative (S's is 6 * t * (1 - t) / (e1 - e0) where 0 < t < 1, else 0). A hole's walls are segments: its outline's edges in order, then its more walls.
The mill: four sails on a hub over the tunnel's mouth turn at 0.9 rad/s, millAngle(t) = 0.9 * t; a sail stands in the mouth, and the tunnel is blocked, while (0.9 * t) mod (PI / 2) is under 0.28 or over PI / 2 - 0.28 (36 % of the time).
Surface at a point: 'block' inside hole 1's block or the mill's base outside its tunnel, 'water' in a water rectangle, 'sand' in a sand circle, 'carpet' elsewhere inside the outline, else 'out'.
### A4 The ball (module ball)
Radius r = 0.0214, drawn at y = h + r. A putt at power p (0.05 to 1) starts it at 4.2 * p m/s at angle a (radians: 0 is +X, PI / 2 is +Z). Each step runs 4 substeps of dt = 1/240 s while it rolls, each in this order:
1. g = grad at the ball; v += -7 * g * dt (a rolling ball's pull, 5/7 of gravity).
2. c = 3.2 in sand, else 0.55 (m/s^2); s = |v|. If s <= c * dt: v = 0, and if 7 * |g| < c the ball comes to rest and the substep ends. Otherwise v *= (s - c * dt) / s.
3. p += v * dt.
4. Hole 3: if this substep took x across 3.35 - r towards +X between z -0.58 and -0.22 while blocked(t): x = 3.35 - r and vx = -0.62 * vx (blade).
5. Walls, each segment in order: q is its point closest to p; if |p - q| < r: p = q + n * r with n = (p - q) / |p - q|, and if v.n < 0, v = 0.92 * (v - (v.n) * n) - 0.62 * (v.n) * n (bounce, with the speed into the wall, at most once a substep).
6. t += dt (the ball's clock: G.time at its substep).
7. If |p - cup| < 0.054 and |v| < 1.3: holed, with drop = |v|. If p lies in water: water.
Worked numbers: on flat carpet a putt at power 0.3 (1.26 m/s) rolls 1.443 m and stops after 2.29 s; struck at 1 m/s in sand it stops within 0.156 m; square onto a wall its velocity into the wall comes back at 0.62 of itself; across the cup's centre at 1 m/s it drops and at 1.6 m/s it rolls on; at rest at x = 4.5 on hole 3's ramp (slope 0.4) it rolls back, the pull of 2.8 m/s^2 beating the carpet's 0.55.
### A5 Play and the autopilot (module play)
A hole begins with the ball at rest on its tee and no strokes. A putt is one stroke. Water: one stroke more and the ball back at rest at its lie (where it was struck from). Holed: the hole's score is its strokes, named by strokes - par: 1 stroke is 'Hole in one', -2 'Eagle', -1 'Birdie', 0 'Par', +1 'Bogey', +2 'Double bogey', more '+n'. A sixth stroke that comes to rest outside the cup ends the hole as 'Picked up' with 6. 2 s after a hole ends the next begins; after hole 3 the round's card shows for 4 s and a new round begins at hole 1 with every stroke cleared. Setting G.state.hole starts that hole at its tee with its strokes cleared.
The aim: on each new lie it points along the line to the cup at power 0.5; aim.left and aim.right turn it at 90 degrees a second while held, power.up and power.down change its power by 0.6 a second while held (0.05 to 1), golf.putt strikes it. A person can putt only while the ball is at rest and the autopilot is not running.
The autopilot runs while G.playing or G.state.auto. From the moment the ball is at rest (or a hole begins) it waits 0.5 s, searches for 0.5 s (30 steps, at most 15 candidates a step, then idle), aims for 0.6 s (the aim turns to its choice the short way and the power moves to it, eased) and strikes at 1.6 s; when it stops before that, nothing is struck. Every candidate is simulated (G.ball.simulate, at most 10 s of rolling) as struck at the strike's time, so the sails are where they will be. Candidates, in order: of the 48 angles k * 7.5 degrees, those within 100 degrees of the line to the cup, each at powers 0.18, 0.36, 0.54, 0.72 and 0.9; then, around the best of those (a, p), 12 angles a + (i - 5.5) / 5.5 * 3.75 degrees (i = 0 to 11) at 6 powers p + (j - 2.5) / 2.5 * 0.09 (j = 0 to 5, kept within 0.05 and 1). A result's score, lowest best, the first of equals kept: holed, |drop - 0.6| - 10 + 0.1 * bounces; water, 50; else its distance to the cup, + 0.3 in sand, + 5 if still rolling. At the strike its hand errs: the angle by (2 * r1 - 1) * 2 degrees and the power by a factor 1 + (2 * r2 - 1) * 0.05, r1 then r2 from its own generator G.rng(G.SEED * 7 + 3).
Worked numbers: with the default seed it plays the round in 7 strokes (2, 2 and 3) and holes out at about 32 s; over 24 seeds it scores 5 to 12, 7.0 on average (par 8), and hole 1 always ends within 16 s.
Measures: speed (m/s); to the cup (m, from the ball to its hole's cup); stroke (strokes on this hole); score (strokes - par over the finished holes of this round).
### A6 Verbs, keys and the panel
| id | label | key | kind |
|---|---|---|---|
| golf.putt | Putt | Enter | press |
| aim.left | Aim left | ArrowLeft | hold |
| aim.right | Aim right | ArrowRight | hold |
| power.up | More power | ArrowUp | hold |
| power.down | Less power | ArrowDown | hold |
| golf.auto | Auto play | KeyA | press (toggles G.state.auto) |
| golf.hole1 | Hole 1 | Digit1 | press (sets G.state.hole) |
| golf.hole2 | Hole 2 | Digit2 | press |
| golf.hole3 | Hole 3 | Digit3 | press |
| view.left | Turn left | KeyZ | press |
| view.right | Turn right | KeyX | press |
| view.close | Close view | KeyC | press (toggles G.state.close) |
| piece.dusk | Dusk | KeyL | press (toggles G.state.dusk) |
| piece.pause | Pause | Space | press |
| piece.quarter | Quarter speed | KeyQ | press |
| view.reset | Reset view | Digit0 | press |
Pointer: pressing within 0.3 m of the ball while a putt may be taken (the point under the pointer at the ball's level) begins a putt: the shot goes from the pointer towards the ball with power min(1, pull / 1.6 m), and releasing strikes it (under 0.05 of power it is cancelled); pressing anywhere else and dragging turns the view, 0.3 degree per CSS pixel (yaw, and pitch within its limits); the wheel or a pinch zooms (by 1.1 a notch); a double click resets the view. Panel, top to bottom: the hole card (name, par, stroke), the three hole buttons, the scorecard (each hole's par and strokes, the round against par), Power (a slider 0 to 100 % that sets the aim's power), Putt, the hold verbs as buttons that work while pressed, Auto play, the view buttons and the toggles. Readouts: Speed (m/s, 2 digits), To the cup (m, 2 digits), Stroke (0 digits), Score (0 digits, shown with its sign, E for 0). Status chip: LIVE, PAUSED, SELF-PLAYING, AIMING, ROLLING, HOLED, IN THE WATER or the failure. Hint: "Drag back from the ball and let go to putt. Arrow keys aim and set the power, Enter putts; Z and X turn the island." Footnote: "1 unit is 1 m. The ball is 4.3 cm across, the cup 10.8 cm; a ball faster than 1.3 m/s rolls over the cup."
### A7 The script (seconds, action, argument); with it running the autopilot plays (A5), so it is the attract mode, the recording and a test
0 view.reset true | 12 view.right true | 22 state { close: true } | 28 state { close: false } | 34 state { dusk: true } | 46 view.left true | 54 state { dusk: false }
While the script runs the view drifts: yaw = its goal + 6 * sin(G.time * 0.15) degrees.
### A8 The look (modules render and world)
Pixels: the world is drawn into a target of ceil(CSS width / 3) by ceil(CSS height / 3) with a depth texture, and drawn again with every material swapped for normals into a second target of that size; one full-screen pass then writes the canvas: an edge where the linear depth steps by more than 0.35 units or the normal turns (a dot under 0.8) against any of the four neighbours, drawn at 45 % of its lightness; a 4 by 4 Bayer dither of 0.035 either way in sRGB; then the nearest colour of the palette below in OKLab, through a 32 by 32 by 32 lookup table built at init; each world pixel a 3 by 3 block of CSS pixels (nearest sampling).
Light: a key light from yaw 135 and elevation 50 degrees, sun-white, casting one shadow map; a hemisphere fill, sky to moss; toon shading in three bands (0.42, 0.72, 1). Dusk (G.state.dusk) eases uDusk to 1 at 2 a second (jumping while recording): the key to 30 % and amber, the fill violet, the sky the dusk gradient, and four lanterns and the mill's window lit (warm point lights, range 3).
The world: the island and its rock; each hole's carpet a mesh of h on a 0.1 m grid inside its outline, in stripes of two greens 0.5 m wide; the walls; hole 1's block; the bunker; the pond; the mill (a tower, a red cap, four cream sails turned by millAngle); the clubhouse with a lantern; a flag with its number in each cup; pines, shrubs and stones; eight clouds below; the ball, its round shadow and the aim, a dotted line from the ball 0.4 + 2.6 * power long, shown while the ball waits for a putt.
The palette (sRGB), the only colours a frame may hold: inks 0f0e17 1d1a2b 2b2840 | dusk 3d3459 5a4a7a 7d6b9e a593c2 | sky 1e3a5f 2c5d8f 3f86b8 6bb3d9 9fd6ec cdeef7 | water 1f5c5b 2e8577 4fb39a | greens 1f3d2b 2d5a35 3f7a3a 5a9a3f 7fb84a a8d65e cdeb8b | moss 4a5a2a 6b7a35 8f9b48 | woods 2e1f1a 4a2f24 6b4532 8f5f3f b07d52 d1a271 | sand e3c48a f2dfb0 fbf3dd | stone 3b3d45 565a63 7a7f88 a2a7ae c9ccd0 | reds 6e1f2a a8323b d9534a f08a6c | lights f4b942 ffd76e fff3b0 | white e8f4f0
### A9 Budget
At most 150 draw calls and 300,000 triangles a frame; the world at most 60 meshes (repeated things instanced); one shadow map (2,048, or 1,024 on the low tier); the canvas's pixel ratio at most 2 (1 on low, 1.5 on medium).
### A10 Acceptance tests (number, owner, name: what must hold)
1. core: events and verbs: listeners run in the order added and an unsubscribe stops one; a disabled command returns false; a hold verb gets run(true) then run(false).
2. core: the clock: G.loop.step(60) moves G.time by exactly 1 s and runs systems lower order first.
3. core: the replay: G.restart(), G.play() and 360 steps give the same G.checksum() twice, and G.touch() during attract mode emits mode { attract: false }.
4. render: one frame draws at most 150 calls and 300,000 triangles (G.render.info()).
5. render: passes() is world, normals, pixel, and target() is a third of the CSS size, rounded up.
6. render: quantize gives back each of the 48 colours as itself (within 1/255) and, for mid-grey (0.5, 0.5, 0.5), one of them.
7. course: three holes; each tee and cup is 'carpet' and at least 0.06 from every wall, and each outline closes.
8. course: grad is h's derivative: at 20 points in each hole's outline (from G.rng(5)) it is within 0.002 of a central difference with a step of 0.001.
9. course: blocked(0) is true and blocked(0.87) false, and over 6,000 steps the tunnel is blocked 34 to 38 % of the time.
10. ball: on flat carpet (hole 3, from (1.3, -0.4) towards +X) a putt at power 0.3 stops after 1.443 m within 1 %.
11. ball: struck at 1 m/s from the centre of hole 2's sand, it stops within 0.156 m (within 5 %).
12. ball: square onto hole 1's end wall (from (-0.3, -3.6) towards +X at 2 m/s), its x velocity just after the bounce is -0.62 of what it was just before, within 1 %.
13. ball: struck from 0.2 m before hole 3's cup straight at it at 1.1 m/s it drops; at 1.7 m/s it is past the cup and still rolling 30 substeps later.
14. ball: at rest at (4.5, -0.4) on hole 3's ramp, after 120 steps it is below x = 4.3.
15. play: a putt counts one stroke; a ball putted into hole 2's pond (from (-2.55, 0.3) towards +Z at power 0.3) comes back to rest at its lie with 2 strokes.
16. play: a sixth stroke that comes to rest outside the cup ends the hole as 'Picked up' with 6.
17. play: holing ends the hole with its strokes and its name (1 stroke on hole 1 is 'Hole in one'), and within 125 steps hole 2 begins with the ball at rest on its tee.
18. play: with G.state.auto set, hole 1 ends (done emitted) within 1,200 steps of its start, in at most 4 strokes.
19. play: G.play.search() from hole 1's tee returns a shot within 100 degrees of the line to the cup whose result holes or comes to rest within 0.5 m of the cup.
20. world: at most 60 meshes; after a frame the sails' angle is G.course.millAngle(G.time) within 0.001, and each flag stands at its cup within 0.01.
21. world: after a frame the ball's mesh is at the ball (within 0.001, at y = G.ball.y()), and the aim shows only while the ball waits for a putt.
22. hands: ground() at the ball's screen point is within 0.05 m of the ball; shot() for a press at the ball and a release 120 px to its left gives power over 0.3 and the angle from the release's ground point towards the ball, within 3 degrees.
23. hands: the script is in rising t and names only registered commands; ArrowLeft down then up runs aim.left true then false, but not while an input has focus.
24. sound: G.sound.render('tock', 1) peaks between -18 and -6 dBFS, has energy in its first 30 ms and ends under a thousandth of its peak; nothing sounds before unlock.
25. sound: 40 plays leave at most 24 voices; a muted render is silent.
26. panel: every panel command has a button; the hole buttons set G.state.hole; after hole 1 is holed the scorecard shows its strokes.
27. panel: while the ball rolls, G.panel.refresh() shows its speed in the Speed readout (within 0.01); pause shows PAUSED on the status chip; G.fail('x') shows the fallback with its reason.
### A11 Planted failures (id, owner, the wrong variant, the tests that catch it)
| P1 | core | the fixed step is 1/30 s | 2 |
| P2 | render | the lookup table holds each cell's own colour, not the palette's | 6 |
| P3 | course | grad's x part has the wrong sign | 8 |
| P4 | ball | sand drags like carpet | 11 |
| P5 | ball | the cup takes a ball at any speed | 13 |
| P6 | play | the pond adds no stroke | 15 |
| P7 | play | the search returns its first candidate | 19 |
| P8 | hands | the shot goes towards the pointer, not away from it | 22 |
| P9 | sound | the tock never releases (neither its decay nor its fade) | 24 |
| P10 | panel | a readout keeps its first value | 27 |`;

const MOSSGREEN_API = `Mossgreen API sheet (fixed; each module owns exactly its namespace and the names listed for it; every other module may call these names and nothing else):
- core: the kernel's names, and the commands piece.pause, piece.quarter, piece.restart and test.run.
- render: G.render = { renderer, scene, cam (an OrthographicCamera), uniforms ({ uTime, uDusk, uRes }, each { value }, one object shared with the world's materials), key (the DirectionalLight that casts the shadow), toon (the three-band gradient texture of the world's MeshToonMaterials), view ({ yaw, pitch and zoom, the goals the camera eases to; orbit(dx, dy) adds degrees; zoomBy(k) multiplies zoom; turn(n) adds n * 90 degrees to yaw; reset(); free ({ x, y, w, h } in CSS pixels: the part of the stage no panel covers) }), frame(dt), resize(), info() -> { calls, triangles } of the last frame, passes() -> the pass names in order, target() -> { w, h } of the world target, palette ([[r, g, b], ...]: A8's 48 colours in order, sRGB 0 to 1), quantize([r, g, b]) -> [r, g, b] (the colour the lookup table holds for that sRGB colour), toScreen(x, y, z) -> { x, y } (CSS pixels), ray(clientX, clientY) -> { origin, dir } (Vector3s), setQuality(tier) }.
- course: G.course = { holes ([{ no, name, par, tee: [x, z], cup: [x, z], outline: [[x, z], ...], blocks: [[x0, z0, x1, z1], ...], sand: [{ c: [x, z], r }], water: [{ x0, z0, x1, z1 }], centre: [x, z], half: [Hh, Wh] }]: A3's rows), h(no, x, z), grad(no, x, z) -> [gx, gz], walls(no) -> [[x0, z0, x1, z1], ...] (A3's segments in order), surface(no, x, z) -> 'carpet' | 'sand' | 'water' | 'block' | 'out', millAngle(t), blocked(t) }.
- ball: G.ball = { R (0.0214), hole (the number of the hole it is on), x, z, vx, vz, state ('rest' | 'rolling' | 'holed' | 'water'), lie ([x, z]), drop, speed(), y() (h + R), place(no, x, z) (at rest there), strike(angle, power), substep(), simulate(no, x, z, t0, angle, power, maxT) -> { state, x, z, t, drop, bounces } (on a copy, emitting nothing) }. Events bounce { speed }, blade, holed, splash.
- play: G.play = { hole (1 to 3), stroke (strokes on this hole), card ([{ no, par, strokes, name }], one row a finished hole of this round), score() (strokes - par over them), phase ('ready' | 'rolling' | 'done' | 'card'), aim ({ angle, power }), auto() -> whether the autopilot runs, search() -> { angle, power, result } (A5's whole search at once, from where the ball is), putt(angle, power) -> false when no putt may be taken, start(no) (that hole at its tee), name(strokes, par) }. Commands golf.putt, aim.left, aim.right, power.up, power.down, golf.auto, golf.hole1, golf.hole2, golf.hole3. Events putt { power }, hole { no }, done { no, strokes, name }, round { total }.
- world: G.world = { root, ball (the ball's Mesh), sails (the Object3D of the mill's sails; its rotation.x is the sails' angle), flags (three Object3Ds, one a cup), aim (the Object3D of the dotted aim), counts() -> { meshes } }.
- hands: G.hands = { device ('mouse' | 'touch' | 'keys'), ground(clientX, clientY) -> { x, z } or null (where the pointer meets the ball's level), shot(x0, y0, x1, y1) -> { angle, power } or null (the putt a press at the first point and a release at the second would make), script }. Commands view.left, view.right, view.close, view.reset.
- sound: G.sound = { ctx (null until unlocked), unlock() (safe to call again), muted, mute(on), play(name, options) -> a handle or null, bed(name, level), voices(), render(name, seconds) -> a Promise of a Float32Array (that sound alone, offline, at 48,000 Hz), names }.
- panel: G.panel = { el, status(text), refresh(), free() -> { x, y, w, h }, fallback(reason), selftest() }. Commands piece.dusk.
- System orders (G.system): hands 10, ball 40, play 50, sound 94. G.onRender orders: world 20, panel 30, render 100.`;

const MOSSGREEN_DIRECTION = `Direction (the source of the look and the sound):
- A model maker's care given to a tiny golf course: a slab of island in a clear morning sky, its top a bright moss-green carpet in warm timber edges, its underside rough rock with roots and moss, small white clouds below. Everything is chunky and readable: low trees, round shrubs, white-washed stones, a red-capped windmill with cream sails, a pond of clear teal, a bunker of pale gold, a little clubhouse with a lantern.
- Pixel art: only the palette's colours, in hard 3 by 3 pixels; one-pixel ink outlines on every silhouette and crease; shading in three bands; gradients only by dither (the sky, the rock falling into shadow).
- Light: a high morning sun from behind the camera's left shoulder, warm white, with crisp shadows; a cool sky fill. Dusk: the sky violet to amber, the sun low and amber, the lanterns and the mill's window warm, the carpet blue-green.
- The interface: cream paper and ink, hairline rules, one moss-green accent and the flag's red; a pixel display face for the title and the numbers, a plain sans for the labels.
- Sound: a calm outdoor morning. The putter is a hollow wooden tock; the ball rolls on carpet as a soft hiss that follows its speed, in sand as a dry rasp; a wall is a woody thock; the cup a short plastic rattle and drop; the pond a small splash; the mill creaks slowly; a light wind; a bird now and then (not at dusk). Holing out rings a short chime, three rising notes for par or better, two falling for worse. As peaks in dBFS: the tock -12, the thock -16, the rattle -14, the chime -14, the splash -16, a tick -26; the beds, the roll -24, the sand -22, the wind -30, the creak -32, the birds -28; a master gain of +6 dB into a limiter (threshold -10 dB, ratio 4).`;
const MOSSGREEN_DIRECTION_SECTIONS = `1. Palette use: which of A8's 48 colours each material and the interface take (by hex), and the outline's ink.
2. Materials: the carpet (its two stripes), timber, block, sand, water (its two moving tones), rock, moss, wood, stone, the mill's cap and sails, the flag: colour, the band the toon shading puts it in, and the noise each takes from a canvas texture.
3. Light: the key's direction, colour and intensity, the fill, the shadow's darkness, the dusk values, and the lanterns' colour, range and intensity.
4. The pixel pass's numbers: the outline's depth and normal thresholds and how dark it draws, the dither's strength, the sky's gradient as palette colours.
5. Interface tokens: the type sizes, the panel's width, paddings, the button and slider styles, the scorecard, the cards, the status chip's colours.
6. A synthesis recipe for every sound name: tock, roll, thock, rattle, sand, splash, creak, wind, birds, chime, each with its peak in dBFS as the direction gives it.`;

const MOSSGREEN: Showpiece = {
  id: 'mossgreen-golf',
  title: 'MOSSGREEN pixel golf diorama',
  name: 'MOSSGREEN',
  global: 'Mossgreen',
  file: 'mossgreen.html',
  brief: 'Build MOSSGREEN, an original pixel-art diorama in one web page: three holes of miniature golf on a floating island, which a visitor plays by dragging back from the ball and letting go. Walls bounce the ball, slopes bend it, sand slows it, a pond sends it back for a stroke, a windmill\'s sails close its tunnel, and the cup takes the ball only when it arrives slowly. The course, the ball\'s rolling and every sound are made in code, with no file loaded, and the world is drawn at a third of the screen\'s resolution, outlined, dithered and held to a palette of 48 colours. Left alone it plays the round itself with an honest autopilot that searches its shots and errs like a hand, and the same seed replays any second, so the page can be recorded and checked frame by frame. Nine builders write it against one fixed kernel contract, and it tests itself: twenty-seven acceptance tests and ten planted failures run inside the page in a headless browser, a first pass fixes what fails, and a second looks at the page\'s frames and fixes what they show. Every name and word is original.',
  lib: [
    ['THREE', "import * as THREE from 'three';"],
    ['Pass', "import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';"],
    ['FullScreenQuad', ''],
    ['mergeGeometries', "import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';"],
  ],
  events: 'putt { power }, bounce { speed }, blade, holed, splash, hole { no }, done { no, strokes, name }, round { total }',
  state: 'hole (1 to 3), auto, close, dusk, quarter',
  api: MOSSGREEN_API,
  design: MOSSGREEN_DESIGN,
  direction: MOSSGREEN_DIRECTION,
  directionSections: MOSSGREEN_DIRECTION_SECTIONS,
  fonts: 'Pixelify Sans, Manrope or JetBrains Mono',
  style: 'html,body{margin:0;height:100%;overflow:hidden;background:#cdeef7;color:#1d1a2b;font:13px Manrope,system-ui,sans-serif}#stage{position:fixed;inset:0}#stage canvas{display:block;width:100%;height:100%;touch-action:none;image-rendering:pixelated}#boot{position:fixed;inset:0;display:grid;place-items:center;background:linear-gradient(#9fd6ec 0%,#cdeef7 58%,#7fb84a 58%,#3f7a3a 100%);font:400 72px/1 "Pixelify Sans",monospace;color:#1d1a2b}',
  check: { frames: [1, 6, 12, 20, 30], viewport: '960x600', drawCalls: 150, triangles: 300000 },
  look: `- the hole in play sits whole inside the part of the stage the panel leaves free, with room around it, at every frame;
- every frame is pixel art: hard 3 by 3 blocks, ink outlines on silhouettes and creases, three-band shading, gradients only by dither, and no colour outside the palette;
- at 1 s the ball waits on hole 1's tee with its dotted aim; later frames follow the autopilot through the holes, and by 30 s it has left hole 1;
- the mill's sails have turned between frames, the view has turned at 12 s, and the shadows fall the same way in every frame;
- no frame is mostly dark (pixels.dark under 0.6) or burnt out (pixels.bright under 0.05), and the course reads (lumaStdDev 14 or more);
- the masthead, the panel, the readouts and the cards are readable and nothing overlaps.`,
  modules: [
    { id: 'core', title: 'Kernel', limit: 16000, duties: `${CORE_DUTIES}
- Tests 1-3; plant P1.` },
    { id: 'render', title: 'Pixel renderer and light', limit: 18000, art: true, duties: `- A WebGLRenderer in the boot root (no WebGL 2: G.fail('This piece needs WebGL 2.') and nothing else), created inside try and catch; the canvas's pixel ratio by the tier (A9).
- A8's pixels: two WebGLRenderTargets of target() size with nearest filtering, the first with a DepthTexture; the scene drawn into it, then again with scene.overrideMaterial a MeshNormalMaterial into the second; then one FullScreenQuad pass of a ShaderMaterial to the canvas: the outline, the Bayer dither and the palette through a Data3DTexture lookup table of 32 by 32 by 32 RGBA8 cells, each holding the palette colour nearest in OKLab to its cell's centre, built at init; passes() lists world, normals, pixel. quantize() reads the same table: the cell of round(c * 31) on each channel.
- The sky as a gradient behind the world, in the world pass. Light by A8 and the direction: the key (a DirectionalLight with one shadow map by the tier, PCFShadowMap), a hemisphere fill; toon, a DataTexture of three bands with nearest filtering; uDusk eased to G.state.dusk at 2 a second (jumping while recording) dims and recolours the key, the fill and the sky.
- The camera of A2: an OrthographicCamera 30 units from its target at yaw 45 + view.yaw (plus A7's drift while G.playing) and pitch view.pitch, its frustum from the hole in play (G.course.holes[G.play.hole - 1]) and view.free, or the close view on the ball; eased, jumping while recording; cam.setViewOffset centres it in view.free.
- toScreen and ray for the hands; uniforms.uTime follows G.time; resize() on window resize and on quality, with both targets.
- frame(dt) at G.onRender order 100 draws one frame; info() reads renderer.info with autoReset off across its three passes.
- Tests 4-6; plant P2.
- Must not touch the course's numbers or the interface.` },
    { id: 'course', title: 'Course', limit: 12000, duties: `- A3 exactly: the three holes with their outlines, blocks, sand, water, h and its exact gradient, centres and half sizes; walls(no) as segments in order (the outline's edges, then hole 1's block's four sides or the mill's base); surface(no, x, z); millAngle(t) and blocked(t).
- The facts holes (3), par (8) and walls (the segments over the three holes).
- Tests 7-9; plant P3.
- Must not touch three.js or the DOM.` },
    { id: 'ball', title: 'Ball physics', limit: 14000, duties: `- A4 exactly, as system 40 (the live ball's four substeps a step while it rolls, each at its own time) and as substep(); simulate() runs the same code on a copy of the ball, never touching it or emitting; no allocation in a substep.
- place, strike, speed and y; the events bounce (at most once a substep, with the speed into the wall), blade, holed and splash.
- A reset that puts the ball at rest on hole 1's tee.
- The readouts speed and "to the cup" (G.readout.provide, as A6 words them); G.checksum of x, z, vx and vz.
- Tests 10-14; plants P4 and P5.
- Must not touch three.js or the DOM.` },
    { id: 'play', title: 'Rules and autopilot', limit: 16000, duties: `- A5 exactly, as system 50: the hole, its strokes and phases, the card, the water's stroke and the lie, 'Picked up', the names, the next hole 2 s after one ends and a new round 4 s after hole 3; G.state.hole both ways (setting it starts that hole, starting a hole sets it).
- The aim with its hold verbs aim.left, aim.right, power.up and power.down; golf.putt; golf.auto (toggles G.state.auto); golf.hole1 to golf.hole3; putt() refuses while the ball rolls or the autopilot runs.
- The autopilot of A5: it runs while G.playing or G.state.auto; its 0.5 s wait, its search sliced at 15 candidates a step, its 0.6 s aim, its strike with the hand's error from G.rng(G.SEED * 7 + 3); search() runs the whole search at once from where the ball is (for the tests).
- The readouts stroke and score; the fact strokes (this round's); G.checksum of the hole, the strokes and the aim.
- A reset that begins a round at hole 1 with the autopilot's generator at its start.
- Tests 15-19; plants P6 and P7.
- Must not touch three.js or the DOM.` },
    { id: 'world', title: 'Island and course models', limit: 18000, art: true, duties: `- A2's island and A8's world from the direction's materials, each texture drawn in code on a canvas: the island's top and rock; each hole's carpet a mesh of G.course.h on a 0.1 m grid inside its outline, in stripes 0.5 m wide; its timber walls (merged a hole); hole 1's block; the bunker; the pond (its two tones moving with uTime); the mill (a tower, a red cap, and a sails Object3D over the tunnel's mouth whose rotation.x is G.course.millAngle(G.time) each frame); the clubhouse and four lanterns (their lights by uDusk); a flag with its number on a pole in each cup; pines, shrubs and stones as InstancedMeshes placed from G.rng(G.SEED + 11) outside the lanes; eight clouds below drifting with G.time. Every material a MeshToonMaterial with G.render.toon; everything casts and takes the key's shadow; at most 60 meshes.
- The ball: a sphere of G.ball.R at the ball, y = G.ball.y(), with a round shadow under it, hidden while holed; the aim: a dotted line from the ball along G.play.aim.angle, 0.4 + 2.6 * its power long, shown while the ball waits for a putt.
- Updates at G.onRender order 20; the fact meshes.
- Tests 20-21.
- Must not change the course, the ball or the play.` },
    { id: 'hands', title: 'Hands and script', limit: 14000, duties: `- Every device: keys by event.code to the commands (a hold verb down on keydown, up on keyup, repeats ignored, nothing while an input, select or textarea has focus); the pointer on the canvas; the wheel; touch with one finger as the pointer and two as a pinch. Each of these calls G.touch(), and each trusted one (event.isTrusted) G.sound.unlock() until the sound runs.
- ground(clientX, clientY): G.render.ray against the level plane at G.ball.y(); shot(x0, y0, x1, y1): null unless the first point's ground lies within 0.3 m of the ball, else the angle from the second point's ground towards the ball and power min(1, their distance / 1.6).
- A6's pointer: a press within 0.3 m of the ball while a putt may be taken begins a putt, the aim following the pull each step (system 10); releasing calls G.play.putt with it (cancelled under 0.05 of power); a press elsewhere and a drag turns the view (G.render.view.orbit, 0.3 degree a CSS pixel); the wheel and a pinch zoom (G.render.view.zoomBy); a double click resets the view. Cursors: grab over the ball, grabbing while pulling, move while turning.
- The commands view.left and view.right (G.render.view.turn(-1) and turn(1)), view.close (toggles G.state.close) and view.reset.
- G.script is A7.
- Tests 22-23; plant P8.
- Must not draw anything.` },
    { id: 'sound', title: 'Sound', limit: 14000, art: true, duties: `- No AudioContext before unlock(), which the first gesture calls; then a master gain into a limiter, with buses for beds and effects; mute(on) and G.sound.muted; suspended while the page is hidden.
- Every sound name of the direction synthesized from oscillators, one shared noise buffer (filled from G.rng) and filters, each recipe a function of (context, destination, time, options) so that play() and render() share it; envelopes always ramp; at most 24 voices, the beds counted among them, the oldest released first.
- Beds, their levels eased: roll by G.ball.speed() while it rolls on carpet, sand while it rolls in sand, creak, wind, birds now and then from G.time (not at dusk). Effects: tock on putt (by its power), thock on bounce (by its speed) and on blade, rattle on holed and then the chime (three rising notes when the hole's score is par or better, two falling otherwise, on done), splash, and a tick on a command event a person caused (not while G.playing).
- render(name, seconds): that sound alone in an OfflineAudioContext at 48,000 Hz, as a Float32Array; a muted render is silence.
- Tests 24-25; plant P9.
- Must not touch the DOM beyond its listeners.` },
    { id: 'panel', title: 'Panel and readouts', limit: 18000, art: true, duties: `- Everything over the canvas, in G.ui.layer('panel'), from A1 and A6 and the direction's interface tokens: the masthead top left (kicker, title, subtitle, caption; it takes no pointer events), the specimen panel on the right (288 px), the readouts and the hint bottom left with the footnote, the notes drawer bottom right (a details element with four short paragraphs: the course, the rolling ball, the pixels, sound; their counts from G.facts.get()), the status chip, and a card over the stage when a hole ends (its name and the score's name, for 2 s) and when the round ends (the scorecard, for 4 s).
- The panel built from the registries: a button for every command with panel set (a hold verb works while pressed: pointerdown runs it true, pointerup, pointercancel and pointerleave run it false), the hole buttons, the scorecard, the Power slider (it sets G.play.aim.power), toggles that show their state. Every control has a visible focus ring and a title with its key.
- refresh() writes the readouts from G.readout.list() (called 8 times a second from G.onRender at order 30, and at once on a state event) and the hole card and scorecard from G.play; status(text) sets the chip, which follows pause, mode, the ball's state and the play's phase.
- free() is the stage's rectangle less the panel's and the masthead's columns; on resize and at init it sets G.render.view.free and calls G.render.resize(). Under 860 px wide the page stacks: the stage keeps the top 55 % and the rest scrolls under it.
- fallback(reason): on fail, a centred panel with the reason in place of the stage. selftest() (F9): an overlay that runs G.tests.run() and lists every test and plant, green or red, with the counts.
- Command piece.dusk (it toggles G.state.dusk); the stylesheet inserted once at init; transitions by the motion language (140 ms for a press, 200 ms for a panel), none under reduced motion.
- Tests 26-27; plant P10.
- Must not touch the canvas or the simulation.` },
  ],
};

/** Keyed by case id, like PRODUCTION_WORKFLOWS, FLAGSHIP_WORKFLOWS and EPIC_WORKFLOWS. */
export const SHOWPIECE_WORKFLOWS: Readonly<Record<string, OfficialWorkflow>> = Object.fromEntries([GATHER, MOSSGREEN].map(piece => [piece.id, showpiece(piece)]));
/** The pieces themselves, for the tests that read a piece's check and modules. */
export const SHOWPIECES: ReadonlyArray<Showpiece> = [GATHER, MOSSGREEN];
