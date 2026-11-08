# AwwO motion language

One vocabulary for everything in AwwO that moves: the interface, what AwwO's agents build, and the videos made
about AwwO. It is written once, here, and kept as data in `apps/motion-tokens.json`; the hosted app's tokens, the
built-in skills and `scripts/motion-lint.mjs` are checked against that file, so the numbers cannot drift apart again.

## How we work with motion

1. **Language first.** Every project (a canvas, a film, a page) starts from one motion language: named durations,
   named curves, named springs, what never moves and what reduced motion does. Without one of its own, it uses this
   one. Nothing is timed by hand outside it.
2. **Describe how it behaves, then pick the numbers.** Write the behaviour in physical words ("a heavy panel that
   drags against the hand and comes to rest a hair past its mark"), translate the words with the table below, and
   keep every number the feel depends on in one `TUNE` object a person can adjust while watching.
3. **A free check.** A plain script finds the obvious drift: raw curves and durations, `transition: all`, layout
   properties, a page with no reduced-motion path, a film reading the clock. It costs nothing and runs every time.
4. **A skeptical review.** A model reviews the code against this file and answers with findings
   (`[{line, severity, issue, fix}]`). It is a first pass that finds what a script cannot judge, never the verdict.
5. **A decision record.** Each component that moves gets a short record of what was chosen, why, what was rejected
   and what happens under reduced motion, so the next person does not reopen the same question.

What stays with a person: taste (does it feel right), restraint (what should not move at all), watching it on the
real screen at real speed, and whether it fits the brand.

## Tokens

| Curve | `cubic-bezier` | Use |
| --- | --- | --- |
| enter | (0.16, 1, 0.3, 1) | anything arriving or settling; the default for a state change |
| move | (0.65, 0, 0.35, 1) | between two places that are both on screen; camera moves |
| exit | (0.3, 0, 0.8, 0.15) | anything leaving |
| emphasis | (0.34, 1.4, 0.64, 1) | one hero moment at a time, about 5 % overshoot; position and scale only |
| linear | (0, 0, 1, 1) | only motion that never starts or stops on screen: a spinner, a ticker |

| Interface duration | ms | Use |
| --- | --- | --- |
| fast | 140 | press, toggle, hover, confirming a state |
| base | 200 | a menu, a popover or a toast entering |
| slow | 260 | a sheet, a dialog or a drawer; a container changing shape |
| scene | 400 | between screens or a staged reveal; the most an interface transition takes |

An exit takes about two thirds of its entrance; on a phone, take 80 % of each duration.

| Film duration | seconds | frames at 30 fps | Use |
| --- | --- | --- | --- |
| xs | 0.2 | 6 | a small element, a tick |
| s | 0.4 | 12 | a card or a panel |
| m | 0.6 | 18 | a move across the whole frame |
| l | 1.0 | 30 | a title reveal |

At other frame rates, frames = round(seconds x fps). Siblings in a cascade start 2 frames apart (at 30 fps) and the
whole cascade stays under 15. A line of text holds 1 second plus 1 second for every 4 words (or 5 Chinese
characters) before it changes.

| Spring | stiffness / damping (mass 1) | zeta / settle | Use |
| --- | --- | --- | --- |
| snappy | 520 / 36 | 0.79 / 0.24 s | toggles, chips, small things a finger moves |
| sheet | 380 / 32 | 0.82 / 0.28 s | sheets, drawers, panels that should feel heavy |
| land | 85 / 14.7 | 0.8 / 0.6 s | a title or a card landing in a film |
| glide | 95 / 19.5 | 1 / 0.6 s | cameras and large containers, no overshoot |
| bounce | 97 / 11.8 | 0.6 / 0.7 s | one playful moment, about 9.5 % overshoot |

Settle is the time after which the motion stays within 2 % of its target. Physics libraries take stiffness and
damping; code that evaluates a spring at any time t (films) takes zeta and settle.

### As code

```css
:root {
  --dur-fast: 140ms;
  --dur-base: 200ms;
  --dur-slow: 260ms;
  --dur-scene: 400ms;
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

Distances go through `--motion-distance`, for example `transform: translateY(calc(16px * var(--motion-distance)))`,
so reduced motion removes the movement and keeps a short fade.

```js
const MOTION = {
  dur: { fast: 0.14, base: 0.2, slow: 0.26, scene: 0.4 },
  film: { xs: 0.2, s: 0.4, m: 0.6, l: 1 },
  ease: { enter: [0.16, 1, 0.3, 1], move: [0.65, 0, 0.35, 1], exit: [0.3, 0, 0.8, 0.15], emphasis: [0.34, 1.4, 0.64, 1] },
  spring: {
    snappy: { stiffness: 520, damping: 36, zeta: 0.79, settle: 0.24 },
    sheet: { stiffness: 380, damping: 32, zeta: 0.82, settle: 0.28 },
    land: { stiffness: 85, damping: 14.7, zeta: 0.8, settle: 0.6 },
    glide: { stiffness: 95, damping: 19.5, zeta: 1, settle: 0.6 },
    bounce: { stiffness: 97, damping: 11.8, zeta: 0.6, settle: 0.7 },
  },
};
```

A project with its own character starts from one of the presets in `apps/motion-tokens.json` (trust, premium, bold,
playful, calm, friendly): each sets the entrance curve, the length of the main move and how much it may overshoot.

## From words to numbers

| The brief says | Use |
| --- | --- |
| heavy, weighty | spring sheet; overshoot at most 2 %; resists past its limit |
| light, quick, snappy | spring snappy |
| lands, settles (film) | spring land, or curve enter |
| glides, precise, no bounce | spring glide, or curve move |
| springy, playful | spring bounce, for one moment only |
| resists | past a limit, follow 0.08 to 0.2 of the finger's distance |
| dismisses on a flick | let go faster than 800 px/s, or after 30 % of its height |
| snaps into place | spring to the nearest of the listed stops |
| can be interrupted | every motion starts from where it is now, never from its beginning |
| floats, breathes | 2 to 6 px over 3 to 6 s, background only, pausable, off under reduced motion |

## What never moves

- Text while it is being read; numbers change in place (one count-up at most).
- The area where people work in a tool: nothing decorative moves on a canvas, a table or a form.
- Layout properties (width, height, top, right, bottom, left, margin, padding): move with transform and opacity.
- `transition: all`.
- The AwwO mark: it may fade or scale in once; it never bounces, spins, glows or wobbles.
- Two hero motions at the same time.
- The scroll position, unless the person scrolled.

## Reduced motion

- **Interface:** movement goes (translation, scale, rotation, parallax, drift, drag elasticity; springs jump to their
  end); fades and colour changes stay, at 140 ms; loops longer than 5 seconds stop. Scripts read
  `matchMedia('(prefers-reduced-motion: reduce)')` and follow its changes. The token block above does the duration
  part on its own. AwwO's apps load it (`apps/web/src/motion-tokens.css`); their older entrances
  (`saas/design/motion.css`) run only under `no-preference`, so reduced motion gets none of them rather than a short
  fade, and other components turn their own animations off.
- **Film:** a video's frames cannot change, so a film keeps to these always: at most 3 flashes in any second, no
  camera shake, text still while it is read, and frame 0 a finished picture. A page that plays a film shows frame 0
  and waits for a click.

## Tuning

Keep every number a behaviour depends on in one `TUNE` object at the top of the script, each with the token it
started from. A tuning panel (a slider per value and a button that copies the values) appears only when the brief
asks for one or the work is a prototype. It stays hidden until a person opens it with a key (T) or a small Tune
button, because a page shown inside AwwO has no address to put `?tune` on (that works only on a downloaded file), and
it never shows in a render. Tuned values that leave the tokens are written into the decision record.

## Decision record

```
## <Component>: <behaviour>
- Decision: <token names, or numbers and why they are not tokens>
- Why: <the feel it gives>
- Rejected: <what was tried, and why not>
- Reduced motion: <what happens instead>
```

## The free check

`node scripts/motion-lint.mjs <files or folders>` prints `file:line rule message` and exits 1 when it finds
something (2 on a usage error). The rules:

- `transition-all`: written, or implied by a transition that names no property.
- `layout-property`: a transition, keyframe or `.animate` call that changes a layout property.
- `raw-curve`: a curve written in place instead of a token: numbers, a CSS keyword (`ease`, `ease-in`, `ease-out`,
  `ease-in-out`), a script easing by name (`easing: 'ease-in'`, `'easeOut'`, `'power2.out'`) or a Remotion easing
  (`Easing.out(Easing.cubic)`). `linear` and `steps()` are not curves to it.
- `off-language-curve`: a curve that is none of the five curve tokens and no character preset.
- `raw-duration`: seconds or milliseconds written in place outside the token block.
- `raw-spring`: spring numbers by hand: stiffness and damping, one of them alone in a spring's config, tension and
  friction, or a zeta / settle pair.
- `reduced-motion-missing`: something moves (a transform, a layout property, moving keyframes; `all` only when
  something in the file is moved by a transform) and the file has no reduced-motion path.
- `render-clock`: a film reads `Date.now`, `performance.now`, `new Date()` or `Math.random` while it draws: inside
  `renderAt` (or the function it names) on a film page, anywhere in a Remotion file or under `--video`. A player loop
  around `renderAt` may read the clock; helpers it calls are yours to keep pure.
- `fps-literal`: a frame rate written into a spring instead of the composition's.

Object literals and values over several lines are read whole. It reads code without running it or parsing it as a
compiler would: strings and template text are text (an expression inside `${...}` is code), but a regular-expression
literal or JSX text holding a quote can still mislead it, and the functions renderAt calls are not followed. A line that has to break a rule says so on that line
or the one above: `motion-lint-allow raw-curve: <reason>`, and the reason goes into the decision record.
`--profile page` reads a delivered page the way AwwO's canvas does (the page's own tokens, notes only),
`--tokens <file>` checks against another language, and `--video` holds every file of a film project to the clock
rule. A baseline (`--baseline`) lists drift that predates the check by rule and text, not by file, so moved code keeps
its allowance and a new finding fails where it was added; `--prune-baseline` lowers it after a fix and never raises a
count.

## The review

The `motion-review` built-in skill (for AwwO's review nodes) and the review step of our video kits ask one question:
does this code follow this file? They check token use, layout properties, interruption, reduced motion in CSS and
in script, focus (a sheet or a dialog takes focus in and gives it back), restraint, holds and readability in films,
and determinism. The answer is a JSON list; each item names the line, a severity (`block`, `fix` or `note`), the
issue and the fix, as `{"line", "severity", "issue", "fix"}`. On a review node with named outputs, the list goes
into its findings or issues field as one JSON string and the report opens with the verdict.

## Where it is used

- AwwO's apps: `apps/web/src/motion-tokens.css` holds the CSS block above and both apps load it, so `--dur-*` and
  `--ease-*` work everywhere. The hosted pages' older names in `apps/web/src/saas/design/tokens.css` (`--saas-ease`,
  `--saas-ease-in-out`, `--saas-ease-exit`, `--saas-ease-spring`, `--saas-dur-1` to `--saas-dur-4`) hold the same
  values. `npm run check:motion` runs the free check over `apps/web/src`.
- AwwO's agents: the built-in skills `motion-language`, `motion-review`, `code-motion`, `motion-discipline`,
  `promo-film`, `code-video-brief` and `vertical-reel` print only these values (a Go test reads every built-in
  skill). `interaction-design` ships its upstream text unchanged, so `motion-language` tells a node that its tokens
  win over any other skill's numbers.
- Videos about AwwO (tutorials, films, reels), from 2026-11-08: each takes its numbers from these tokens, runs the
  free check with `--video` before every render, gets one review per round and keeps a `DECISIONS.md`. Kits made
  before then keep their own numbers until they are moved over.

To change the language, edit `apps/motion-tokens.json`, then this file, `tokens.css` and the skills; the tests say
what is still out of step.
