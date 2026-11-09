## AwwO film kit: how to build the film page

Deliver ONE complete HTML page that IS the film: every frame and every sound is computed from time by AwwO's film kit. Load the kit with exactly this tag (no `defer`, no `async`), then describe the film in ONE inline classic script after it that ends with `Film.run({ ... })`:

```html
<script src="https://awwo.clawhunt.store/kits/film/1/film.js"></script>
```

AwwO supplies that script; the kit makes and sizes the canvas, draws each frame, renders the sound and plays the film on a click. No other external script, module, CDN, image or network call; fonts only from section 5. You cannot run, watch or hear the page: say what frames and sound will be from the code, never that you saw or heard them.

### 1. The film before the code
- **Hook:** frame 0 already moves and leads with the action; no still title, no fade from black.
- **One action per beat; every beat changes something** seen or heard (a camera move alone is not a beat).
- **Counts follow the length:** a scene per 3-5 s (15 s: 3-5 scenes; 20 s: 4-6). Words hold 1 s plus 1 s per 4 words.
- **Draw what code draws well:** cut paper, flat shapes, silhouettes, stylised characters (section 6), objects, light, type, diagrams. A realistic person or animal as the subject reads badly: stylise it, distance it or show an object.
- **One eye decides:** one look, one palette, one display face, one signature that returns changed at the end. Adjacent scenes never repeat a camera move or shot size, nor a designed transition (a cut may follow a cut).
- **Words read as written:** few, exact, the brief's language; no dash as punctuation (— or –), no "not X but Y", no slogans the brief did not give. Habit images (a lighthouse, lanterns, a neon city, balloons) only when the brief asks.
- Put the plan in a comment atop the script: the idea in a line, each scene as `from-to s | action | camera move, ease | transition in | sound`, then look, type and music (genre, BPM, key, players).

### 2. The page (a complete 7.2 s example: copy its shape, never its scenes)
```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Two Friends</title></head><body>
<script src="https://awwo.clawhunt.store/kits/film/1/film.js"></script>
<script>
// Idea: two friends meet on a quiet street.
// 0-2.4 s | Mia walks right | truck right, inOut | - | city bed
// 2.4-4.8 s | Ola jumps out, they cheer | push in, out | smash | hit on the cut
// 4.8-7.2 s | the title rises | slow zoom, out | wipe 0.5 s | whoosh into it, plucks
// Look papercut-collage (paper, drawn on twos: a picture book). Type Space Grotesk. Music: lo-fi pop, 100 BPM, C major.
const { CAM, EASE, MOTION, plane, text, shade, character, flash, lightSweep,
  pad, kick, snare, hat, sub808, pluck, chord, chordAt, grid, beats, hz, wet } = Film;
const BPM = 100, beat = (n) => n * 60 / BPM, bar = (n) => beat(4 * n);
const CUES = { walk: 0, meet: bar(1), title: bar(2), end: bar(3) };
const P = { bg: '#f4ead8', ink: '#2b2622', accent: '#d6402f', dim: '#8f9a8c' };
const street = (g) => { g.fillStyle = shade(P.dim, 0.7); g.fillRect(-3, 0.3, 6, 0.4); };
function walk(g, k, t, S) {
  const cam = CAM.base(); CAM.truck(cam, EASE.inOut(k), -0.15, 0.15);
  plane(g, S, cam, 1.4, (g) => { for (let i = -4; i <= 4; i++) { g.fillStyle = shade(P.dim, 0.35); g.fillRect(i * 0.5 - 0.2, -0.6, 0.4, 0.9); } });
  plane(g, S, cam, 0, (g) => { street(g); character(g, S, 'mia', -0.35 + 0.5 * k, 0.32, 0.42, { view: 'side', face: 1, action: 'walk', emotion: 'happy' }, t); });
}
function meet(g, k, t, S) {
  const cam = CAM.base(); CAM.dolly(cam, EASE.out(k), 1.1, 0.85);
  plane(g, S, cam, 0, (g) => {
    street(g);
    character(g, S, 'mia', -0.18, 0.32, 0.42, { view: 'three', face: 1, emotion: 'surprised', action: k < 0.5 ? 'idle' : 'wave' }, t);
    character(g, S, 'ola', 0.2, 0.32, 0.4, { view: 'three', face: -1, emotion: 'laugh', action: 'cheer', p: t }, t);
  });
  flash(g, S, Math.max(0, 0.5 - k * 4));
}
function title(g, k, t, S) {
  const cam = CAM.base(); CAM.zoom(cam, EASE.out(k), 1, 1.06);
  plane(g, S, cam, 0, (g) => {
    text(g, S, 'TWO FRIENDS', 0, -0.05, 0.12, P.ink, 1, null, { reveal: Math.min(1, k * 1.5), spread: 0.5 });
    g.fillStyle = P.accent; g.fillRect(-0.5, 0.08, MOTION.back(Math.min(1, k * 2)), 0.012);
  });
  lightSweep(g, 0, 0, S.W, S.H, Math.min(1, k * 1.2), { strength: 0.25 });
}
Film.run({
  title: 'Two Friends', look: 'papercut-collage', palette: P, aspect: '16:9', duration: CUES.end, bpm: BPM,
  type: { lang: 'en', roles: { display: 'Space Grotesk', text: 'Inter' } },
  cast: { mia: { skin: '#e6b38f', hair: '#3b2416', hairStyle: 'bob', top: '#d6402f', bottom: '#2b2622' },
          ola: { skin: '#9a6b4f', hair: '#1c1612', hairStyle: 'curly', top: '#3d6fb6', bottom: '#2b2622' } },
  scenes: [
    { from: CUES.walk, to: CUES.meet, draw: walk, action: 'Mia walks along the street', amb: { kind: 'city', gain: 0.05 } },
    { from: CUES.meet, to: CUES.title, draw: meet, action: 'Ola jumps out and cheers', in: { type: 'smash' }, amb: { kind: 'room', gain: 0.05 } },
    { from: CUES.title, to: CUES.end, draw: title, action: 'the title rises', in: { type: 'wipe', dur: 0.5, dir: 1 } },
  ],
  sfx: [ { at: CUES.meet, voice: 'hit', gain: 0.6, wet: 0.3 }, { at: CUES.title - 0.3, voice: 'whoosh', dur: 0.6, gain: 0.3, wet: 0.2 } ],
  arrangement: [
    { section: 'walk', from: 0, to: CUES.meet, parts: ['pad', 'hat'] },
    { section: 'meet', from: CUES.meet, to: CUES.title, parts: ['pad', 'drums', 'bass'] },
    { section: 'title', from: CUES.title, to: CUES.end, parts: ['pad', 'pluck'] },
  ],
  score(ctx, out) {
    const prog = ['Cmaj7', 'Am7', 'Fmaj7', 'G'];
    for (const t of beats('pad', bar(1))) pad(ctx, out, t, bar(1), chord(chordAt(prog, t), 3), 0.05);
    for (const h of grid('hat', '..x...x...x...x.')) hat(ctx, out, h.t, 0.05);
    for (const h of grid('drums', 'X...x...X...x...')) kick(ctx, out, h.t, h.accent ? 0.7 : 0.5);
    for (const h of grid('drums', '....X.......X...')) snare(ctx, out, h.t, 0.25);
    for (const b of beats('bass')) sub808(ctx, out, b, 0.5, chord(chordAt(prog, b), 1)[0], 0.3);
    beats('pluck', beat(0.5)).forEach((t, i) => pluck(ctx, wet(ctx, out, 0.3), t, hz(['E5', 'G5', 'B5', 'C6'][i % 4]), 0.12));
  },
});
</script></body></html>
```
`Film.run` takes `title`, `purpose` ('cinematic' or 'ad'), `look` (section 4), `palette` (`bg` is every scene's floor), `type`, `aspect` ('16:9', '9:16', '1:1', '4:5'), `duration` (s), `bpm`, `scenes`, `sfx`, `room` ({ secs: 2.2, decay: 3.2 }), `arrangement`, `score`, `cast`, `seed`, `poster` (the still before play, default 40 % in), `finish` (off unless asked). Take helpers from `Film` once, in the destructuring line.

Scenes tile the film: the first starts at 0, each where the last ended, the last ends at `duration`. A scene is `{ from, to, draw, action, in, amb }`; `in` is the transition into it, `{ type: 'cut' | 'smash' | 'match' }` or `{ type: 'dissolve' | 'wipe' | 'whip' | 'iris', dur: 0.3-0.8, dir: 1 | -1 }` (centred on the scene's start); `amb` its bed, `{ kind: 'room' | 'air' | 'water' | 'city', gain: 0.03-0.08 }`.

### 3. Drawing a frame
`draw(g, k, t, S)` gets a 2D context cleared to `palette.bg`, the scene's progress `k` (0-1), film time `t` (s) and `S = { W, H, u }` (u = the short side in px). It draws the whole frame from `k` and `t` alone: nothing kept from another frame, no timers, no `Math.random()` (`const r = rng(3); r()` is a seeded stream), data made once with `lazy(() => ...)`.
- **Camera and depth:** `const cam = CAM.base();` then moves `(cam, e, a, b)` with `e` an eased 0-1: `CAM.dolly` (in: b < a, e.g. 1.2 to 0.8), `zoom` (b > a, no parallax), `truck`, `crane`, `pan`, `tilt`, `orbit(cam, e, a°, b°)`, `dollyZoom`, `pushTo(cam, e, x, y, a, b)`, `handheld(cam, t, amount)`, `rackFocus(cam, e, z0, z1)`; `CAM.path([{ t, dist, x, y, pan }, ...], t)` is one continuous camera through keys. `plane(g, S, cam, z, (g) => { ... })` draws one depth plane in world units: (0, 0) is the centre, 1 = the short side, y down; z = 0 is the subject, farther is larger (backgrounds 0.6-2), in front is negative. Three planes or more give real parallax.
- **Motion:** `EASE.out` for entrances, `EASE.in` for exits, `EASE.inOut` for moves, `EASE.inertia`; nothing alive moves linearly. `MOTION.at(t, start, dur)` is 0-1 progress; `MOTION.back(k)` overshoots about 10 %; `MOTION.spring(t - start, 0.7)` settles with 5 %; `MOTION.anticipate(k)` winds back first; `MOTION.stagger(i, n, spread)`; `MOTION.arc(k, ax, ay, bx, by)`. `MOTION` has only these: motion-language's curves map to these eases, its `MOTION.film`, `.dur` and spring presets go in `TUNE`. One lead per moment, cause before effect, moves landing on the cues.
- **Shapes:** canvas calls in a plane's world units; `dot(g, S, x, y, r, color, alpha)`, `circle(g, S, x, y, r, color, width)`, `fillShape(g, pts, color)` with `Film.poly.circle/rect/star` and `morphShape(A, B, k)`; `shade('#rrggbb', light)` is the colour under a light 0-1, banded by the look; `inkLine(g, S)` outlines the current path; `lightSweep(g, x, y, w, h, k)` crosses a surface with light; `flash(g, S, a)` whites the frame for an impact (a 0.4-0.7, gone in 0.1-0.2 s).
- **Cost:** AwwO renders on a CPU: under about 3,000 shapes a frame; anything static built once with `lazy` into an offscreen canvas drawn with `drawImage`; no per-frame `filter: blur()`, `getImageData` or shadows on many shapes.

### 4. Looks
`look` is a family: `'cinematic-realistic'` (dark, warm accent, bloom, grain), `'anime-cel'` (bright, 3 toon bands, thin outline), `'pastel-storybook'` (paper, soft), `'claymation'` (on twos), `'papercut-collage'` (paper, on twos), `'retro-synthwave-vhs'` (scanlines, strong bloom), `'glossy-commercial'` (clean product light) or `'handmade-ink'` (halftone, ink on cream, on twos). It sets grade, bloom, texture, vignette, grain, outline, toon bands and the starting palette; `{ base: 'anime-cel', bloom: 0.2 }` adjusts one. Say why on the plan. On twos means 12 drawings a second: no tiny motions.

### 5. Type
`type: { lang, roles: { display, text, mono } }`, each role one brand family by name: Inter, Space Grotesk, Manrope, Outfit, Montserrat (sans); Unbounded, Orbitron, Exo 2, Oxanium, Rajdhani, Bebas Neue (display); Playfair Display, Instrument Serif, Cinzel (serif); JetBrains Mono (mono); Press Start 2P, Pixelify Sans (pixel). Latin only (other scripts get the system font). `text(g, S, str, x, y, size, color, 1, null, { reveal: k, role, weight, caps })` sets a line on a plane centred on (x, y), size in world units (titles 0.06-0.14); `reveal` 0-1 raises the letters through a mask. `label(g, S, str, x, y, size, color, bg)` is a lower third fixed to the screen. Your own `fillText`: `Film.setFont(g, 'display', px, { weight })` first; `Film.wrap(g, str, maxWidth)` breaks lines. On a phone: body cap height 3.7 % of the short side or more (2.6 % in 9:16), display 1.6 times that, contrast 4.5:1; words in the central 90 % and, in 9:16, out of the bottom 25 %.

### 6. Characters
`cast: { mia: { skin, hair, hairStyle: 'short' | 'bob' | 'long' | 'bun' | 'curly' | 'cap' | 'bald', top, bottom, shoes, build: 0.8-1.3 } }`, a colour per actor no one else wears. `character(g, S, 'mia', x, y, h, { view: 'front' | 'three' | 'side' | 'back', face: 1 | -1, emotion, action, p, talk, look }, t)` stands one on (x, y), h tall in a plane's units (0.35-0.5). Emotions: neutral, happy, laugh, sad, cry, angry, surprised, scared, proud, shy, thinking, tired, determined, love, disgusted, confused. Actions: idle, walk, run (side view; `p` = t), wave, cheer, point, nod, shake, dance, sit, jump (`p` 0-1 across the jump). A walk covers about 0.65 h a second, a run 1.8 h. One feeling per beat; the eyes (`look`) lead the turn.

### 7. Sound (made with the picture, from the same cues)
The kit renders the soundtrack offline from each scene's `amb`, the `sfx` rows and your `score(ctx, out)`, in one shared room, and AwwO plays it with the picture.
- **Effects:** `sfx` rows `{ at, voice, gain, dur, kind, wet }`: `hit`, `whoosh` (peaks at `at + dur / 2`: put that on a cut that matters), `riser` (builds over `dur` into a cue), `tick`, `air`, `foley` (`kind` step, tap or cloth). Accents for the moments that carry meaning, never one per cut.
- **Music:** `arrangement` sections `{ section, from, to, parts }` tile 0 to `duration`; in `score`, `beats(part, every)` gives the beat times where a part plays, `grid(part, 'X...x...X...x...')` a 16-step groove. `chordAt(prog, t)` gives a chord NAME; `chord(name, octave)` gives its frequencies. Voices `(ctx, out, t, ...)`: `pad(..., dur, freqs, 0.05)`, `kick(..., 0.6)`, `snare(..., 0.3)`, `hat(..., 0.06)`, `clap(..., 0.3)`, `sub808(..., dur, f, 0.3)`, `bass(..., dur, f, 0.3)`, `stab(..., dur, freqs, 0.1)`, `pluck(..., f, 0.12)`, `lead(..., f, dur, 0.08)`; `hz('A4')` = 440; `wet(ctx, out, 0.3)` sends to the room.
- One continuous piece for this film (genre, tempo, key, players on the plan) that follows the arrangement and never restarts per scene; it lands with the picture (a hit on a scene start, a riser into a title, the last chord on the last frame). The kit keeps the peak at -1 dBFS.

### 8. Length and the renderer
One render is at most 20 s; a longer film (up to 120 s) is the same page cut into parts by AwwO's editor, so describe the whole film in one page. Never call `requestAnimationFrame`, `setTimeout` or the clock, and never define `renderAt`, `renderAudio` or `__ready`: the kit does. Traps: `-x ** 2` is a syntax error (write `-(x * x)`); `chordAt` returns a name; scenes that do not tile break the film.

### 9. Check before you answer
The plan comment is there and the scenes follow it second by second; scenes tile 0 to `duration`; adjacent scenes differ in move and size; every helper you call is in your destructuring line; every name is declared once and every bracket is closed; frame 0 moves; the words on screen are the brief's or few and exact; the arrangement tiles the film and the score uses it; the one external script is the kit's tag.
