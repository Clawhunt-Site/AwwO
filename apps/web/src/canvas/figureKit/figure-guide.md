## 原理图解组件 · how to build the figure page

Deliver ONE complete HTML page with an interactive isometric drawing of a real, well-made machine whose working IS the idea. AwwO supplies the drawing kit. Load it with exactly this tag, then put all your code in ONE inline classic script after it, inside `Anatomy.run(() => { ... })`:

```html
<script src="https://awwo.clawhunt.store/kits/anatomy/1/anatomy.js"></script>
```

AwwO inlines its own copy of that script; nothing else can load. Use no other external script, module, import, CDN, font, image or network call. The drawing is SVG built by the kit at load time.

### 1. Decide the object first (most of the quality is decided here)
- **Truth first.** Collect the real numbers and behaviour (sizes, counts, rates, thresholds, timings) and write them as one small model object. The motion, the readout, the aria text and the caption all read from it, so none of them can disagree.
- **The object is the explanation.** Invent a recognisable machine, instrument, tool or piece of furniture whose mechanism maps one-to-one onto the idea, and say in one sentence what moves and what that motion means. Examples: a queue is a marble run (two hoppers, one lane, an escapement releasing marbles on a timer drum); an LRU cache is a bookcase with four slots, most recent at the left; a bloom filter is a fruit machine whose three reels are the three hashes over a row of 16 flags; a token-bucket rate limiter is a hopper that drips tokens into a tray at the refill rate while each request takes one; a mutex is a water tank whose two pumps share one interlock key; a hash map is a sorting desk of 8 pigeonholes; binary search is a lab balance; TCP's handshake is a mail ropeway carrying SYN / SYN-ACK / ACK canisters.
- **Never** boxes, arrows, flowcharts, floating labels, people or maps. Words stay out of the drawing, apart from at most one tiny engraved label.
- **Parts list before geometry.** Start your script with a comment: idea → object → what moves; then 40–80 parts grouped into base (plate, feet, groove, corner screws, ruler strip, label plate), structure (posts, rails, frame bars, end stops), mechanism (carriage, bushings, springs, plunger, needle, reels), controls (knurled knob, lever, crank) and the ONE lit subject. Every part sits on another part.

### 2. World and camera
World units are about 1 px of the real thing: x and y on the floor, z up. A plan is a rounded rectangle `{ x, y, w, d, r }`; a circle is `cx, cy, r`. Fit every extreme point: `const P = k.fitProjection([...k.boxCorners(BASE, -BASE_H, 0), [x, y, topZ]], W, H, { pad: 30, azimuth: 42 })` with `W, H` about 600 × 380 (wide) or 520 × 460 (tall). Azimuth 35–60 shows the long side; elevation stays 30.

### 3. Kit API (`const k = Anatomy;`)
Solids return paths; draw them with `k.solidSvg(paths, { tone, crease, lit, flat, inner })`:
- `k.slabOf(plan, z, h, P, steps = 8, bevel = 0)` rounded box (steps 2–4 small, 8 big; bevel 0.4–1.6) · `k.cylinder(cx, cy, r, z, h, P, steps = 32, bevel = 0)` vertical post, puck, foot, knob · `k.extrude(ring, z, h, P, { convex: true })` any floor outline `[[x, y], ...]` (`convex: false` if concave)
- helpers: `k.circleRing(cx, cy, r, steps)` · `k.ringOf(plan, steps)` · `k.insetPlan(plan, by)` · `k.corners(plan, inset)` (4 `[x, y]`) · `k.boxCorners(plan, z0, z1)` · soft shadow first: `` `<path class="iso-halo" d="${k.haloOf(plan, z, h, P)}"/>` ``
- round parts on any axis, `const F = k.G.frameAlong([x, y, z], [1, 0, 0])` (axis unit vector): `k.G.disc(s0, s1, r, F, P)` roller, flange, pin · `k.G.solidOf([[s, r], [s, r, 1], ...], F, P)` turned profile (third value 1 = smooth) · `k.G.ringBand(s0, s1, rIn, rOut, F, P)` collar · `k.G.sphereOf([x, y, z], r, P)` ball. Spinning lines on them: `k.G.spokesOf(F, s, r0, r1, count, P, { phase })`, `k.G.arcOf(F, s, r, P)` seam, `k.G.dotsOf(F, s, r, count, P, { phase })` bolt circle (screen points for `k.dotsSvg`).
- pipes and cables: `const route = k.G.fillet([[x, y, z], ...], bendRadius)`; each `piece` of `k.T.tubePieces(route, radius, P, { maxLength: 18 })` is drawn with `k.T.tubeSvg(piece, { tone })` at depth `k.G.dot3(piece.mid, k.G.viewOf(P))`. A pipe starts and ends on a part.

Lines return `d` strings; draw with `k.lineSvg(d, { tone, dotted, dashed, flow, free })` (`flow` animates dashes along it):
- `k.lineOnTop([x, y], [x, y], z, P)` · `k.onTop(points, z, P, closed)` · `k.planOutline(plan, z, P)` groove or inlay · `k.ring(cx, cy, r, z, P, steps)` · `k.segment([x, y, z], [x, y, z], P)` · `k.rise([x, y], z0, z1, P)`
- `k.knurl(cx, cy, r, z0, z1, count, P)` · `k.sideArc(cx, cy, r, z, P)` band on a cylinder · `k.sideSeam(plan, z, P, steps)` seam on a box (pass as the slab's `inner`)
- `k.coil(x0, x1, [y, z], r, turns, "x", P)` (or `(y0, y1, [x, z], …, "y", P)`) → `{ back, front }`: paint back, then the rod, then front
- `k.topTicks(from, to, step, every, edgeY, z, [minor, major], P)` → `{ minor, major }` ruler ticks · `k.sideTicks(from, to, step, every, faceY, topZ, [minor, major], P)` · `k.radialTicks(cx, cy, r, count, every, z, [minor, major], P)` dial ticks (angle 0 = −y, clockwise)

Screen points come from `k.iso([x, y, z], P)` (keep `const at = (p) => k.iso(p, P)`):
- `k.dotsSvg(points, { size: 0.45, tone })` screws, rivets, LEDs · `k.wireSvg(at(a), at(b), { via: [at(c)], tone, flow })` connector whose end dots land on parts · `k.faceTextSvg(k.topMatrix([x, y], z, P, "x"), "0.01", { size: 2.4, tone: "lo", anchor: "middle" })` the one engraved label
- depth: `k.depthOf([x, y, z], P)` (larger is nearer); sort repeated parts ascending before drawing.

Moving: build a part once at rest inside `` `<g data-part="carriage" transform="${k.translateAlong(P, [dx, dy, dz])}">…</g>` `` and move it by setting that transform. A turn about z (needle, pointer, reel marks) is a path you rebuild each frame (set its `d`). A part whose shape depends on the state (a flag that is up, the tokens in a tray, a filled slot) gets its own `<g data-part="tray">`; when the state changes, set `trayEl.innerHTML = trayParts(state)`. Never rebuild, replace or clear the whole `<svg>` (`ui.svg.innerHTML = …` erases the figure). Card: `k.figureSvg({ width: W, height: H, label, body: [strings in paint order] })` inside `k.plateHtml({ fig, title, hint, readout, keys: [{ mark, label }], caption, body })` (`mark` is one of: lit, raised, flat, dim, dotted, dashed, red, green, blue); show it with `const ui = k.mount({ theme: "light", width: 650, html })` → `ui.stage`, `ui.svg`, `ui.readout`. Motion: `const kick = k.loop(ui.stage, (dt, calm) => { …; draw(); return stillMoving; })` (pauses offscreen; call `kick()` after input) · `k.follow(current, target, dt, seconds, calm)` · `k.spring(state /* { at, rate } */, target, dt, 420, 26, calm)` → settled · `k.calm()` reduced motion.

### 4. Craft rules
- **Solids, not wireframes.** Every part is a filled solid painted back to front and bottom to top, so what is in front hides what is behind. Split a part that wraps another (springs round a rod, a frame round a carriage) into a back half and a front half. A moving part is drawn in the slot where it physically sits.
- **Tones.** Base and feet `lo`, structure `mid`, subject `hi`; exactly ONE part (or one small group) `lit: true`: the thing to watch. Grooves `faint`, minor ticks `lo`, major ticks `mid`. Colour (`red`, `green`, `blue`) only where colour is the subject, such as a flag that is up.
- **Small precise detail, never noise.** Bevels 0.4–1.6, grooves inset 3–5 from an edge, screws as 0.4–0.55 dots with a ring at plate corners, knurls on knobs, ruler ticks every 4–5 with a major every 5th, a label plate with three rule lines. At 1× it reads as one machine; zoomed in, every region still has something true to find. No bare face, no empty corner.
- **Lines resolve.** Every line ends on a face, another line or a terminal dot. No leader lines, dimension arrows or labels in the air.
- **Nothing floats.** A part's `z` is the top of the part it stands on (a slab on a plate of height 12 starts at z = 12); posts, rods and pipes run from one part to another; a part held up high hangs from an arm, a bracket or a bearing. Check every z and every end before you answer.
- **Every change is motion.** When the state changes, parts visibly move, turn, rise or fill (eased); the readout never changes on its own.
- **Volume and composition.** Real thickness; parts stand on parts; a halo under the base and anything lifted. Centre the machine at 55–65% of the card; it must still read at 390 px wide.
- **The card.** Fig number top left, a short title top right, the interaction hint bottom left, the live readout bottom right. The hint and the readout share the bottom edge: keep each to about 24 characters (12 Chinese characters); details go in the caption. Legend keys and one true caption sentence sit under the card. Write these words in the language of the request.
- **Calm, true motion.** Time-based easing and springs, an idle tour that plays when nobody touches it, pointer AND keyboard (arrow keys, Home / End, Space or Enter for the main action), still under reduced motion (pass `calm`), readout and `aria-valuetext` from the model.
- **Code that runs the first time.** You cannot test the page, and one stray bracket or one name declared twice stops the whole script before anything is drawn. Declare every name exactly once: part builders end in `Parts` (`trayParts`, `reelParts`) and never share a name with the state they draw (`tokens`, `slots`); constants first, then builders, then the state in one block just before `draw`. A call nested more than two deep becomes named `const`s, one per line. Then read every line once more for matching `(` `)`, `[` `]`, `{` `}` and backticks.

### 5. Shape of the page (a smaller dial-indicator figure)
```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Dial indicator</title></head><body>
<script src="https://awwo.clawhunt.store/kits/anatomy/1/anatomy.js"></script>
<script>
Anatomy.run(() => {
  // Idea: a height becomes a needle turn. Object: dial gauge whose plunger rests on gauge blocks on a sliding carriage.
  // Parts: base plate, 4 feet, groove, 4 screws, ruler strip + ticks, 2 rails, 2 end stops, post, arm, dial bezel, ...
  const k = Anatomy;
  const M = { blocks: [18, 14, 10], step: 16, blockW: 15.6, perTurn: 20, base: 8, dial: [58, 0], dialR: 20, dialTop: 92 };
  const PLATE = { x: -128, y: -64, w: 262, d: 128, r: 8 };
  const stops = M.blocks.map((_, i) => M.dial[0] - (-24 + M.blockW / 2) - M.step * i);
  const heightUnder = (cx) => M.blocks.reduce((top, h, i) => { const from = cx - 24 + M.step * i; return from + M.blockW > M.dial[0] - 2.6 && from < M.dial[0] + 2.6 ? Math.max(top, M.base + h) : top; }, M.base);
  const W = 600, H = 380;
  const P = k.fitProjection([...k.boxCorners(PLATE, -17, 0), [-98, 0, 124], [78, 0, 92]], W, H, { pad: 30, azimuth: 42 });
  const at = (p) => k.iso(p, P), S = k.solidSvg, L = k.lineSvg;
  const byDepth = (pts) => [...pts].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
  function plate() {
    const out = [`<path class="iso-halo" d="${k.haloOf(PLATE, -17, 12, P)}"/>`];
    for (const [x, y] of byDepth(k.corners(PLATE, 22))) out.push(S(k.cylinder(x, y, 6, -17, 5, P, 28), { tone: "lo" }));
    out.push(S(k.slabOf(PLATE, -12, 12, P, 8, 1.6), { tone: "mid" }), L(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: "lo" }));
    const screws = k.corners(PLATE, 10);
    out.push(L(screws.map(([x, y]) => k.ring(x, y, 2.2, 0, P, 16)).join(""), { tone: "lo" }), k.dotsSvg(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
    const strip = { x: -110, y: 49, w: 230, d: 7, r: 1 }, ticks = k.topTicks(-106, 116, 4, 5, 49.8, 0.6, [2, 3.6], P);
    out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }), L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
    for (const y of [-20, 15]) out.push(S(k.slabOf({ x: 2, y, w: 122, d: 5, r: 1 }, 0, 3, P, 3, 0.4), { tone: "mid" }));
    return out.join("");
  }
  function carriage() {
    const out = [S(k.slabOf({ x: -28, y: -24, w: 56, d: 48, r: 3 }, 3, 5, P, 5, 0.6), { tone: "mid" })];
    M.blocks.forEach((h, i) => { const plan = { x: -24 + M.step * i, y: -12, w: M.blockW, d: 24, r: 1 }; out.push(S(k.slabOf(plan, M.base, h, P, 3, 0.5), { tone: "hi", crease: "lo" })); });
    return out.join("");
  }
  function stand() {
    const base = { x: -112, y: -20, w: 44, d: 40, r: 3 }, post = [-98, 0];
    return S(k.slabOf(base, 0, 24, P, 6, 0.8), { tone: "mid" }) + S(k.cylinder(-80, 8, 6, 24, 4, P, 32), { tone: "mid" }) + L(k.knurl(-80, 8, 6, 24, 28, 36, P), { tone: "lo" })
      + S(k.cylinder(post[0], post[1], 3.2, 24, 98, P, 28), { tone: "mid", crease: "none" }) + S(k.slabOf({ x: -105, y: -7, w: 14, d: 14, r: 2.5 }, 96, 12, P, 4, 0.6), { tone: "mid" })
      + S(k.slabOf({ x: -91, y: -3, w: 131, d: 6, r: 2 }, 100, 4, P, 4, 0.5), { tone: "mid" });
  }
  function dial() {
    const [x, y] = M.dial, t = k.radialTicks(x, y, M.dialR - 3, 50, 5, M.dialTop, [1.3, 2.8], P);
    return S(k.cylinder(x, y, 2.9, 54, 28, P, 20), { tone: "mid" }) + S(k.slabOf({ x: 32, y: -4, w: 8, d: 8, r: 1.5 }, 84, 16, P, 3, 0.4), { tone: "mid" })
      + S(k.cylinder(x, y, M.dialR, 82, 10, P, 64, 0.8), { tone: "hi", crease: "lo" }) + L(k.knurl(x, y, M.dialR, 88.6, 92, 84, P), { tone: "lo" })
      + L(t.minor, { tone: "lo" }) + L(t.major, { tone: "mid" }) + k.faceTextSvg(k.topMatrix([x, y + 9], M.dialTop, P, "x"), "0.01", { size: 2.4, tone: "lo", anchor: "middle" });
  }
  const needleAt = (turn) => { const a = turn * Math.PI * 2, [x, y] = M.dial; return k.lineOnTop([x - Math.sin(a) * 3.4, y + Math.cos(a) * 3.4], [x + Math.sin(a) * 16, y - Math.cos(a) * 16], M.dialTop + 0.2, P); };
  const svg = k.figureSvg({ width: W, height: H, label: "A dial gauge whose plunger rests on gauge blocks; the needle turns by the height under it.", body: [
    plate(), stand(), `<g data-part="carriage" transform="${k.translateAlong(P, [stops[0], 0, 0])}">${carriage()}</g>`,
    `<g data-part="plunger" transform="${k.translateAlong(P, [0, 0, 26])}">${S(k.cylinder(58, 0, 1.4, 0, 52, P, 16), { tone: "hi", crease: "none", lit: true })}</g>`,
    dial(), `<path data-part="needle" class="iso-line" data-tone="lit" d="${needleAt(0.9)}" style="stroke-width:1.1"/>`,
  ] });
  const ui = k.mount({ theme: "light", width: 650, html: k.plateHtml({ fig: "Fig 1", title: "Dial indicator", hint: "Hover or ← → to slide", readout: "block 1 · 18.0",
    keys: [{ mark: "lit", label: "Plunger and needle: what moves" }, { mark: "raised", label: "Blocks 18, 14 and 10 tall" }],
    caption: "The plunger rides onto the block beneath it; one needle turn is 20 px of travel.",
    body: `<div class="iso-stage" tabindex="0" role="slider" aria-label="Dial indicator, arrow keys move the carriage">${svg}</div>` }) });
  const parts = Object.fromEntries([...ui.svg.querySelectorAll("[data-part]")].map((el) => [el.dataset.part, el]));
  let x = stops[0], target = x, touring = !k.calm(), clock = 0, idle = 0;
  const tip = { at: M.base + M.blocks[0], rate: 0 };
  const draw = () => {
    parts.carriage.setAttribute("transform", k.translateAlong(P, [x, 0, 0]));
    parts.plunger.setAttribute("transform", k.translateAlong(P, [0, 0, tip.at]));
    parts.needle.setAttribute("d", needleAt((tip.at - M.base) / M.perTurn));
    const text = "reads " + (tip.at - M.base).toFixed(1) + " px";
    if (ui.readout.textContent !== text) { ui.readout.textContent = text; ui.stage.setAttribute("aria-valuetext", text); }
  };
  const kick = k.loop(ui.stage, (dt, calm) => {
    if (touring) { clock += dt; target = stops[Math.floor(clock / 2.2) % stops.length]; }
    x = k.follow(x, target, dt, 0.28, calm);
    const settled = k.spring(tip, heightUnder(x), dt, 420, 26, calm);
    draw();
    return touring || x !== target || !settled;
  });
  const steer = (next) => { touring = false; target = Math.min(stops[0] + 6, Math.max(stops[2] - 6, next)); kick(); clearTimeout(idle); idle = setTimeout(() => { touring = !k.calm(); kick(); }, 3600); };
  ui.stage.addEventListener("pointermove", (e) => { const b = ui.svg.getBoundingClientRect(); steer(stops[2] - 6 + Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)) * (stops[0] - stops[2] + 12)); });
  ui.stage.addEventListener("keydown", (e) => { const i = stops.indexOf(target), to = { ArrowRight: i - 1, ArrowLeft: i + 1, Home: 0, End: stops.length - 1 }[e.key]; if (to === undefined) return; e.preventDefault(); steer(stops[Math.min(stops.length - 1, Math.max(0, to))]); });
  draw();
});
</script>
</body></html>
```

### 6. Check before you answer
Every kit call above has the arguments shown (count them); every name is declared once and every bracket and backtick is closed; every element you query exists in your own markup; `draw()` only sets attributes or the `innerHTML` of `data-part` groups; every part rests on another (check the z values); a state change moves parts, not just the readout; the hint and readout are short; the page is one complete document with html, head and body and only the kit's script tag as an external reference; nothing in the drawing is a box, arrow or floating label; numbers come from the model. Return the whole page as the figure output.
