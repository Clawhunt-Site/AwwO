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

/** Keyed by case id, like PRODUCTION_WORKFLOWS, FLAGSHIP_WORKFLOWS and EPIC_WORKFLOWS. */
export const SHOWPIECE_WORKFLOWS: Readonly<Record<string, OfficialWorkflow>> = Object.fromEntries([GATHER].map(piece => [piece.id, showpiece(piece)]));
/** The pieces themselves, for the tests that read a piece's check and modules. */
export const SHOWPIECES: ReadonlyArray<Showpiece> = [GATHER];
