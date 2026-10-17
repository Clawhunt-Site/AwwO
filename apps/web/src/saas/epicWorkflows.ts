import type { MediaParams } from '../canvas/canvasDoc';
import { THREE_MODULES_IMPORT_MAP } from '../canvas/previewImportMap';
import type { OfficialMediaNode } from './examples/officialMedia';
import type { OfficialWorkflow, OfficialWorkflowNode } from './examples/officialWorkflows';

/** Epic canvases (2026-10-17): a whole game in one canvas run, on the flagship pattern (flagshipWorkflows.ts) grown to
 * a game's size. PALLWARD is an original open-world action RPG slice: a design room writes the Game spec and the Tech
 * spec from fixed templates and an art node the look and sound; ten concept paintings and 33 3D model nodes make its
 * characters (rigged and animated), weapons and props; twenty module builders write the program in parallel in their
 * sandbox computers against one fixed kernel contract and API sheet; an assemble node pastes their files into one page
 * byte for byte; a node in the sandbox computer runs the page's sixty acceptance tests and sixteen planted failures in a
 * headless browser and fixes what fails; a review reads that report. 69 nodes and 118 wires.
 *
 * Where it departs from the design (.local/design/G-canvas.md, G-gdd.md, G-assets.json), for the facts of the API:
 * - The 3D model nodes take the API's rig and motion settings (tripo_motion.go, 2026-10-17), not per-clip lists: every
 *   humanoid takes the full set, the only one holding every clip the design uses (fall for deaths, dive for rolls, jump,
 *   climb, shoot), which brings idle, hurt and turn too; quadrupeds and hexapods move by their one walk clip. Their
 *   files are model-1.glb (the mesh with idle walk run slash hurt), model-2.glb (dive climb jump fall turn) and
 *   model-3.glb (shoot), the later two clips only. The extra clips put the core at an estimated 28 MiB against the 23.5
 *   MiB the preview packs, so the assets module skips an asset that no longer fits and tries the next (the design
 *   stopped at the first): by the design's size estimates the Hearth Knight and the Candlehart then run as stand-ins,
 *   until the design's own contingency (code materials for the foes) is applied.
 * - The assets builder is fed the Tech spec alone, not the Game spec or the art direction (the design wired all three):
 *   its task carries the asset table, and its prompt, with both specs at their full templates and the 33 model nodes'
 *   file lists, would come too close to the 128,000-byte limit.
 * - Builders work as the flagships' do, in their sandbox computers (parts, node --check, publish the file), instead of
 *   answering with one code block; each spec node may write its template's length plus 1,500 characters (roomFor), so
 *   no number has to be dropped, where the design capped both at 24,000.
 * - The art node is given the sound effect list and the asset table in its task, since it reads only the Game spec.
 * - The page registers its ready listener before it boots (boot emits ready synchronously).
 * Not yet in PRODUCTION_WORKFLOWS: a case is listed only with a published run. */

// The world: premise, lore, factions and every name the game uses (the bible), for the design room and the look.
const PALLWARD_WORLD = `World (original; every name, place, creature, item and interface word is this game's own; tagline "Every flame must end."):
- Premise: in the Wanelands every life is a candle: the flesh is tallow, the soul is the wick, and death is the flame reaching the end. Three centuries ago the Rootmother, the god whose roots hold the land together, lay down on the Great Pyre to end her age. The Gilt, the land's undying nobility, drew out her Heartwick before the flame reached it. Her body became the Everpyre, a tree the height of a mountain that burns at its crown and regrows at its roots, forever. A flame without its end consumes nothing, so no flame anywhere can finish: the slain rise again at dusk as the Unfinished, their wicks a little shorter each time. You are the last of the Pallward, the pallbearers who carried the dead to the pyres. You wake in your own coffin on a wrecked funeral cart on the Corpse Road; you are Unfinished too, but your wick is still long. Take back the Heartwick from Kilnhold, carry it to the Everpyre, and let the world finish dying.
- Lore pillars: death is unfinished (the player respawns, and foes rise again when you rest); wicks are life (currency and experience in one); the wake must be kept (wakestones are wax-crusted vigil altars: resting there raises the dead nearby again); the flame is a prison (the Kilnsworn feed the Everpyre so it never ends); the roots remember (beasts of bark, hounds of cinder, a stag crowned with candles).
- Factions: the Pallward (the player's outlawed order of funeral knights); the Kilnsworn (the Gilt's soldiers, rust-red surcoats over soot-black iron, keepers of the Heart Kiln); the Gilt (undying lords held together by gold leaf and wax; in the slice only Halvard); the Unfinished (the risen dead, grave-candle stubs fused into their skulls and shoulders); Root-kin (Cinder Hounds, Root Crawlers, the Candlehart).
- The player, the Bearer: lean and hooded, a grey-violet mourning shroud over dark iron scale, a bronze half-mask over the lower face, a coil of candle-wick around the left forearm; starts with the Pallward Longsword and the Coffin-Lid, the lid of the coffin they woke in, as a shield. No character creation.
- Names: region Candlemoor (800 × 800 m of heather moor south of the Everpyre); the Everpyre (2.6 km north, 900 m tall); the Corpse Road; the Funeral Cart; Tallowby and Tallowby Chapel; the Weeping Water and Weeping Ford; Gibbet Watch; the Pyrefield; Cinder Copse; Mournmere and the Drowned Spire; Rootfall Hollow; the Hanged Oak; the Pallward Cairn; Kilnhold (Gatehouse, the Breach, Lower Bailey, Ramparts and Winch, Great Hall, Coffin Lift, Chapel of Embers, Inner Ward, Kiln Bridge); the Ember Veil; the Heart Kiln; wakestones Corpse Road, Tallowby Chapel, Pyrefield Edge, Mournmere Shore, Kilnhold Gate, Inner Ward; field boss CANDLEHART, SIRE OF THE WAKE; dungeon boss HALVARD, THE GILT CASTELLAN, in phase 2 HALVARD, PYRE-WED; elite the Hearth Knight; foes Unfinished, Kilnsworn Warden, Kilnsworn Arbalist, Cinder Hound, Root Crawler; currency wicks, dropped in a Guttering Candle; Wakewine Flask and Wakecup Shard; Pyre Resin, Wick Bundle, the Heartwick; weapons Pallward Longsword, Gravedigger's Greataxe, Wardens' Pike, Reaping Sickles, Censer Flail, Hearth Halberd; Coffin-Lid; armour Pallward Shroud, Chandler's Brigandine, Kilnplate.
- Interface words: UNFINISHED ("Death will not have you. Rise at the last wakestone."); LAID TO REST; WAKESTONE LIT; WICKS RECLAIMED; level up "Your flame steadies."; slice end "The Heartwick is yours. Far to the north, the Everpyre flares."`;

// The look and the sound (the bible's direction), which the art node turns into recipes the builders use.
const PALLWARD_DIRECTION = `Direction (the source of the look and the sound):
- Mood: a permanent burning dusk. Warm, dying firelight from the north against cold violet air; candles are the only warm points in the dark. Everything is wax, soot, iron, stone and gold leaf.
- Palette: pyre #FF7A1A (Everpyre fire, emissive cores); flame #FFB547 (candle flames, highlights); ember #C8361B (embers, hurt); gilt #C9A349 (the Gilt, boss interface); wax #E9DFC6 (wax, bone, interface text); tallow #B9A35A (stamina bar, old wax); soot #120C0A (deepest shadow); blood #8E1E14 (health bar, death text); char #2A2320 (burnt wood, armour); ashgrey #8C8580 (stone, ash); heather #5E3B4E (moor heather); moss #4F5B3A (moss, grass); dusk #3B2A4A (dusk sky, shadow tint); night #141826 (night fog); verdigris #3C8C86 (focus bar, old copper); rust #7A2E1C (Kilnsworn surcoats).
- Materials (MeshStandardMaterial lit by a sky environment map; colour, roughness, metalness): weathered stone #8C8580, 0.92, 0 (triplanar noise, wax drips on ledges); charred wood #2A2320, 0.88, 0 (ember cracks #FF5A1A, emissive 2.0, through a noise mask); wax #E9DFC6, 0.55, 0; iron #4A4744, 0.5, 0.85; gilt #C9A349, 0.32, 1.0; bronze #A8743A, 0.38, 1.0; leather #3A2A1E, 0.8, 0; cloth roughness 0.95; wet mud #3A2E26, 0.5; bark #3B302A, 0.9 with amber sap seams #FF9A3A (emissive 1.5) on the Everpyre. Candle flames: small additive sprites (#FFB547 core, #FF7A1A edge) flickering at 6-10 Hz.
- Lighting: the sun or the moon is the only shadow-casting light. A warm pyre light from the north (azimuth 0°, elevation 8°, #FF8A3D) never sets: 0.15 by day, 0.75 by night. Hemisphere ambient, cool above and warm brown below. ACES tone mapping; bloom only on fire, candles and the Everpyre.
- Fog and sky: warm violet-grey exponential fog, about 700 m visibility on a clear day and under 400 m in ashfall; a physical sky at turbidity 8 under a smoke band rising from the Everpyre and leaning east; night deep blue-black with sparse stars and a pale moon, the candle-lit graves of the Corpse Road a river of warm points.
- Silhouettes: tall and narrow (candles, spires, veils, coffins on end) against wide and low (moor, fallen pyres, roots). Every foe reads at 30 m: Unfinished hunched with candle stubs; Warden tall, kettle helm, tower shield; Arbalist hooded, crossbow held level; Hound low and spined; Crawler flat and wide; Hearth Knight bulky and horned; Candlehart a crown of flames 6 m up; Halvard the tallest, veil and greatblade forming a cross.
- Interface: wax-paper panels (#E9DFC6 at 6 % over soot), thin gilt rules, no rounded app chrome; Cinzel for titles, boss names, banners and the wick counter; Manrope for labels and menus; Instrument Serif italic for lore, item text and toasts; each followed by a generic fallback.
- Sound: all synthesized in code, no audio files; reverb from generated noise impulses (open moor 1.6 s, castle 3.2 s). Score motifs: 1 The Wake, a wordless choir hymn (formant "ah") in D Dorian, 4 bars at 60 BPM, for the title, the wakestones and the slice end; 2 Moor drone, a hurdy-gurdy-like drone on D2 and A2 (sawtooth through a buzzing band-pass, with wheel noise) and choir fragments every 20-40 s, colder, lower and windier at night; 3 The Pyre, a sub-bass swell under fire crackle whenever the Everpyre fills the view; 4 Battle, a low string ostinato in D minor at 92 BPM, frame drum on beats 1 and 3, from a foe's engagement until 4 s after the last leaves; 5 Candlehart, horn calls a fifth apart, high choir "oo", the wax-clatter of the antler crown, 84 BPM; 6 Halvard, phase 1 low brass and male choir in D Phrygian at 76 BPM, phase 2 at 96 BPM with a roaring fire layer, doubled drums and a clustered, distorted choir; 7 Unfinished (death sting), the choir falling a minor sixth into a snuffing hiss; 8 Laid to Rest, a long D-major chord on choir and drone resolving into silence.
- Effects: footsteps per surface (band-passed noise bursts), cloth, roll thud, jump and land, light and heavy swings (noise sweeps), metal hit (two inharmonic FM partials), flesh hit (60 Hz thump plus noise), wood crack, shield block, deflect (a bright 2.4 kHz ring), guard break, critical (an impact with a long tail), flask gurgle, candle gutter, wax drip, wakestone light (whoosh and choir swell), level up (a three-note chime), pickup, wick-gain shimmer, Unfinished groan (formant "oh"), hound growl and snap, crawler clicks and burrow rumble, Candlehart bellow, Halvard roar, crossbow twang, fire crackle, Pyre Resin ignite, lift chains, portcullis rumble, Ember Veil pass, wind, rain, thunder, interface move, confirm and back.`;

// The Game spec's template (the design document's Part A): every number a default the spec node keeps unless it finds
// and states a contradiction. The spec node's task carries it whole, the way a builder's carries the kernel.
const PALLWARD_GAME_SPEC = `## Part A - Game spec
Units m, s, ms; degrees in tables, radians in code; x east, z south (north −z), y up; yaw 0 faces +z, forward = (sin yaw, 0, cos yaw). [m] = measured on the 2026-10-17 probe rig.

### A1 Scope
In v1: Candlemoor (800 × 800 m); field boss Candlehart; legacy dungeon Kilnhold with two-phase boss Halvard; 6 foe types (2 non-humanoid) + a test dummy; 6 weapons, 1 shield, 3 armour sets; 6 wakestones; day/night (24 min day), 3 weathers; title → journey → credits; keyboard+mouse, gamepad, touch. Out: character creation, NPCs/shops, spells, mounts, co-op, armour as separate models (extended tier), disk saves (in-memory snapshot + exportable JSON only), audio files.

### A2 Controls

| Action | Keyboard + mouse | Gamepad (standard) | Touch |
|---|---|---|---|
| Move | WASD (Alt: walk) | left stick (≤ 0.5 walks) | left-half stick 70 px |
| Camera | mouse (pointer lock on first click; else arrows 2.4 rad/s or middle-drag) | right stick | right-half drag |
| Light / heavy (hold to charge, +800 ms max) | left / right mouse | RB 5 / RT 7 | Strike 84 px / Heavy |
| Guard (hold), deflect (timed press) | Left Shift | LB 4 | Guard |
| Weapon art | C | LT 6 | Art |
| Roll (tap; no direction = backstep), sprint (hold > 300 ms) | Space | B 1 | Roll |
| Jump | F | Y 3 | - |
| Interact (rest, take, lever, mantle, veil) | E | A 0 | context |
| Quick item, next item, next weapon | R, 3, 1/2 | X 2, d-pad down, d-pad right | Flask |
| Lock-on; switch target | Q or middle click; wheel or a 120 px flick | R3 11; stick flick > 0.7 | Lock; swipe |
| Pause, map, inventory | Esc, M, I | Start 9, Back 8 | menu |

Buffer 300 ms for light, heavy, art, roll, jump, flask (newest press wins); dead zone 0.18 radial; look: mouse 0.0024 rad/px, pad 2.6 rad/s, × sensitivity; touch buttons ≥ 56 px, shown on a coarse pointer or after the first touch.

### A3 Movement and camera
Body: capsule r 0.38, h 1.80; walk 1.8, run 4.6, sprint 6.6 m/s (10 stamina/s), guarding 1.6, locked-on 3.4; full speed in 150 ms, stop in 100 ms; turn 720°/s, attacks track 360°/s for the first 40 % of startup, then 0; gravity 18 m/s²; jump 5.2 m/s (apex 0.75 m, 578 ms, 30 % air control, 10 stamina, 120 ms landing); step-up 0.45 m; slopes > 45° slide at 6 m/s²; falls > 6 m cost (h − 6) × 8 % max HP, ≥ 16 m kill; mantle ledges 1.6–2.4 m: 1,600 ms, ending 0.8 m forward.
Camera: pivot feet + 1.62 m, 0.35 m right; distance 4.2 (locked 4.8); FOV 58° (+4 sprinting); pitch −20..+60° (default +12); follow 12/s; a 0.25 m sphere cast pulls it in to the hit − 0.1 m, easing out at 3 m/s. Lock-on: candidates within 25 m, in sight, within 70° of the camera forward; score = angle (rad) + distance/25, lowest wins; breaks beyond 30 m or after 2 s unseen; switching picks the nearest on that side by screen angle; locked aim = player chest + 0.35 × (target chest − player chest). Shake: light 0.06 m/120 ms, heavy 0.12/200, slam 0.25/400; 'reduce shake' halves it.

### A4 Combat rules
Stamina: an action starts if > 0 (may overdraw to 0); regen 45/s after 600 ms unspent (1,200 ms after hitting 0), ×0.4 guarding, 0 sprinting. Focus: no regen; +2 light hit, +4 heavy, +12 deflect, +20 critical; arts spend, rest refills. Poise: player 20 + armour; ≤ 0 → humanoid stagger 700 ms and refill; refills after 3,000 ms without poise damage (bosses 6,000); H, HC and arts halve poise damage taken in startup and active.
Damage: raw = AR × MV (player) or move dmg (foes); dmg = max(1, round(raw × (1 − abs) × 100/(100 + def))), physical and fire apart, summed; counter hit ×1.15 (target in startup or active); player def = 40 + level. AR = base × (1 + sM·f(Might) + sF·f(Finesse)), ×0.6 if a requirement is unmet, unrounded until damage; letters S 1.40, A 1.10, B 0.80, C 0.55, D 0.35, E 0.18; f(x) = 0.25·min(x,20)/20 + 0.45·clamp(x−20,0,30)/30 + 0.30·clamp(x−50,0,49)/49 (f(10) 0.125, f(12) 0.15, f(20) 0.25, f(50) 0.70, f(99) 1.00); fire AR = fire base × (1 + 0.35·f(Resolve)).
Guard: the shield absorbs its phys/fire %; stamina lost = round(sd × (1 − boost/100)), sd default 0.4 × raw; short → guard break (1,000 ms stagger, the rest lands); no shield: phys 70, fire 30, boost 25. Deflect: guard press then a parryable hit within 160 ms → 0 damage, 0 stamina, +12 focus, attacker 'deflected' 1,500 ms (riposte window); unparryable → normal guard; a press within 400 ms of the last opens no window. Criticals: riposte = light within 2.2 m, ±60° in front of a deflected or posture-broken foe; backstab = light within 1.4 m behind (±60° of its back, facing it ±45°), never bosses, hounds, crawlers; MV 3.0 (posture-broken boss 2.5); attacker invulnerable 1,600 ms, damage at 900 ms, foe down 2,400 ms.
Rolls (load = equipped weight / load max):

| Roll | Load | Total ms | I-frames ms | Distance m | Stamina | Cancel from ms |
|---|---|---|---|---|---|---|
| light | ≤ 30 % | 600 | 50-400 | 4.2 | 18 | 450 |
| medium | ≤ 70 % | 700 | 60-390 | 3.8 | 18 | 550 |
| heavy | ≤ 100 % | 900 | 80-340 | 2.6 | 22 | 750 |
| overloaded | > 100 % | 1,100 | none | 1.2 | 22 | 1,000 |
| backstep | any | 450 | 40-240 | 2.0 back | 12 | 380 |

Hit-stop (scale 0.05, unscaled ms): light 60, heavy 90, critical 140, boss slam 120. Wakewine Flask: 1,100 ms; charge spent at 450 ms (a hit before refunds); heals 300 + 10 % max HP evenly over 450–850 ms (a stagger stops the rest); 1.2 m/s while drinking; 4 charges (6 with both shards). Burning: ≥ 40 fire or a hazard → 3 s at 12/s. Knockdown (kd): 2,400 ms down, invulnerable 300–2,000 ms. Combo: cancel point c = startup + active + 0.6 × recovery; a press ≤ 300 ms before c starts the next move at c, after c at once, older presses drop; L1 → L2 → L3 (→ L4) → L1; heavy after light = H; a roll cancels from recovery start + 150 ms.

### A5 Stats and progression
Five stats 1–99; start Vigor 10, Breath 10, Might 12, Finesse 12, Resolve 10 = level 10 (level = sum − 44).

| Derived | Formula (rounded) | Values |
|---|---|---|
| Max HP | 300 + 20 min(V,25) + 13 clamp(V-25,0,15) + 6 clamp(V-40,0,20) + 1.5 clamp(V-60,0,39) | V10 500, V11 520, V25 800, V26 813, V40 995 |
| Max stamina | 50 + 3 min(B,30) + 1.5 clamp(B-30,0,20) + 0.5 clamp(B-50,0,49) | B10 80, B30 140, B50 170 |
| Load max | 45 + 1.5 B | 60 |
| Max focus | 40 + 4 min(R,30) + 2 clamp(R-30,0,20) + 0.5 clamp(R-50,0,49) | R10 80 |

Might/Finesse scale AR through f; Resolve adds +0.3 % fire absorption per point above 10. Soft caps: Vigor 25/40/60, Breath 30/50, Might and Finesse 20/50, Resolve 30/50. Level L → L+1 costs round(120 + 36L + 1.8L²) wicks (L10 660, L11 734, L12 811, L15 1,065, L20 1,560), only at a wakestone, one point per purchase, priced at the current level.

### A6 Weapons, shield, armour

| id | Name | Class | Phys | Fire | M/F | Req M/F/R | Weight | Reach | Hit r | Stamina L/H | Asset |
|---|---|---|---|---|---|---|---|---|---|---|---|
| longsword | Pallward Longsword | straight sword | 110 | 0 | C/C | 8/8/- | 3.5 | 1.25 | 0.12 | 14/26 | w_longsword |
| greataxe | Gravedigger's Greataxe | greataxe | 185 | 0 | A/E | 20/8/- | 9.0 | 1.6 | 0.22 | 24/40 | w_greataxe |
| pike | Wardens' Pike | spear | 120 | 0 | D/B | 12/14/- | 4.5 | 2.6 | 0.10 | 15/28 | w_pike |
| sickles | Reaping Sickles (pair) | twin blades | 78 | 0 | E/A | 6/18/- | 3.0 | 0.9 | 0.14 | 9/20 | w_sickle x2 |
| flail | Censer Flail | flail | 95 | 40 | B/D, fire Resolve D | 14/8/10 | 6.0 | 1.5 | 0.25 | 18/32 | w_flail |
| halberd | Hearth Halberd | halberd | 150 | 0 | B/C | 16/12/- | 8.0 | 2.3 | 0.16 | 20/36 | w_halberd |

Cells: startup/active/recovery ms, MV, poise, anim (swing A/B/C + spine twist °, B5), lunge m; HC = H fully charged (+800 ms); R running, Ro rolling (≤ 300 ms after a roll), J jump attack.

| Weapon | L1 | L2 | L3 / L4 | H / HC | R | Ro | J |
|---|---|---|---|---|---|---|---|
| longsword | 330/120/420 1.00 12 A+20 | 300/120/400 1.05 12 B-25 | 360/140/520 1.25 16 C0 | 600/150/650 1.60 30 C0 / 2.20 45 | 380/140/520 1.15 16 A+10 1.5 | 300/120/450 1.00 12 B-15 1.0 | 280/150/500 1.40 25 C0 |
| greataxe | 520/150/650 1.00 30 C+10 | 480/150/620 1.05 30 C-10 | - | 900/180/800 1.70 60 C0 / 2.40 80 | 560/160/700 1.20 35 A0 2.0 | 480/150/640 1.05 30 B0 | 320/170/650 1.50 45 C0 |
| pike | 360/110/420 1.00 10 B0 0.6 | 340/110/400 1.00 10 B0 | 380/120/500 1.15 14 A0 | 650/140/700 1.55 24 C0 1.0 / 2.10 36 | 420/180/550 1.30 20 B0 2.5 | 340/110/420 1.00 10 B0 | 300/150/500 1.35 20 C0 |
| sickles, 2 hits | 220/90/300 2x0.55 6 A+25 | 200/90/280 2x0.55 6 B-25 | 240/100/320 2x0.60 7 A+15 / 260/110/420 2x0.65 8 C0 | 450/120/500 3x0.60 8 A0 spin / 3x0.80 10 | 300/160/400 2x0.65 8 A0 1.8 | 220/90/300 2x0.55 6 B0 | 260/120/420 2x0.70 10 C0 |
| flail | 420/140/520 1.00 18 A+15 | 400/140/500 1.05 18 B-20 | - | 720/160/720 1.65 40 C0 / 2.20 55 | 460/150/600 1.20 22 A0 | 400/140/520 1.00 18 B0 | 340/160/600 1.45 35 C0 |
| halberd | 450/140/560 1.00 22 A+20 | 420/140/540 1.05 22 B-20 | - | 800/170/760 1.70 48 C0 / 2.30 65 | 480/150/600 1.25 26 A0 1.8 | 420/140/540 1.05 22 B0 | 340/160/620 1.50 40 C0 |

Arts (focus + stamina; frames; effect): Last Rites (longsword) 18 + 20, 500/180/700, MV 2.40, poise 45, a 3 m flame line deals 60 % of the hit; Grave Heave (greataxe) 22 + 30, 900/200/900, shockwave r 3.5, MV 1.80, poise 70; Warden's Brace (pike) 14 + 0, a 2,000 ms stance from 300 ms: the first frontal hit is blocked free and answered by a 2.20 MV thrust (poise 40); Reaping Whirl (sickles) 16 + 22, 300 ms then 4 hits 160 ms apart (4 × 0.70), recovery 500; Censer Swing (flail) 20 + 24, 600/160/700, MV 1.30, incense r 2.5 for 6 s (15 fire/s); Hearthsweep (halberd) 20 + 28, 700/220/800, 270° sweep, MV 1.60, poise 60. Hitboxes: a grip → tip capsule (reach × hit r) swept each active step, one hit per target per move; H, HC and arts have hyper armour. Shield Coffin-Lid (s_coffinlid): phys 100 %, fire 60 %, boost 62, weight 6.0. Armour sets (v1 only re-tints the player model): Pallward Shroud 12/10 %, poise 8, 8.0 (start); Chandler's Brigandine 22/16 %, 22, 17.0 (Gibbet Watch chest; tint × #C9A27A); Kilnplate 34/28 %, 45, 28.0 (Hearth Knight; tint × #6E6A66, seams #FF5A1A 0.8). Start load 17.5 of 60 = 29.2 % (light roll).

### A7 Items, wicks and death
Wicks per kill: Unfinished 45, Warden 120, Arbalist 90, Hound 60, Crawler 75, Hearth Knight 900, Candlehart 4,000, Halvard 8,000 (a thread flies to the player in 600 ms). Guttering Candle: on death all wicks stay at the death spot (fall or hazard death: the last spot that was solid ground ≥ 1 s); one at most; dying before reclaiming replaces it and its wicks are lost; touching it (1.5 m) reclaims all → WICKS RECLAIMED; a 0.5 m candle cluster under a 12 m light pillar, guttering every 4 s, audible to 60 m. Wakecup Shard: +1 max and current charge ("Your flask holds one more draught."). Pyre Resin: +30 fire AR for 60 s, 900 ms. Wick Bundle: small 200, large 800, 700 ms. The Heartwick: Halvard's drop; taking it ends the slice. Death: fall animation, flow 'dead'; UNFINISHED fades in at 1,000 ms (600 ms) with "Death will not have you. Rise at the last wakestone."; black at 4,000 ms; at 4,600 ms the player stands at the last lit wakestone with the rest effects, fades in 800 ms, 'play'.

### A8 Foes

| Type | Asset | H m | HP | Poise | Abs phys/fire % | Def | Walk/run | Sight m/FOV | Hear | Leash | Respawns |
|---|---|---|---|---|---|---|---|---|---|---|---|
| unfinished | m_unfinished | 1.75 | 220 | 15 | 0/-50 | 10 | 1.2/3.8 | 16/90 | 8 | 35 | yes |
| warden | m_warden | 2.0 | 520 | 35 | 25/10 | 30 | 1.5/4.2 | 22/70 | 10 | 45 | yes |
| arbalist | m_arbalist | 1.8 | 300 | 20 | 10/0 | 20 | 1.5/4.4 | 30/60 | 12 | 50 | yes |
| hound | m_hound | 1.1 | 160 | 10 | 0/40 | 5 | 2.0/7.5 | 18/120 | 16 | 60 | yes |
| crawler | m_crawler | 1.2 | 400 | 40 | 30/-25 | 25 | 1.0/3.0 | 12/180 | 14 | 30 | yes |
| hearth | m_hearth | 2.3 | 1,400 | 90 | 30/50 | 45 | 1.4/4.0 | 24/80 | 12 | 30 | no |
| dummy (tests) | stand-in | 1.8 | 10,000 | 30 | 0/0 | 0 | - | - | - | - | - |

Moves (range m; windup/active/recovery ms; dmg; sd; poise; P parryable; kd; W weight; Cd s; anim):

| Type | Move | Range | Frames | Dmg | sd | Poise | P | kd | W | Cd | Anim |
|---|---|---|---|---|---|---|---|---|---|---|---|
| unfinished | Chop | 0-2.0 | 600/150/800 | 85 | 40 | 12 | y | - | 3 | 0 | A+15 |
| unfinished | Frenzy (HP < 40 %) | 0-2.2 | 450/120/350 + 2 more (windups 300) | 60 x3 | 30 | 8 | y | - | 2 | 4 | A/B |
| warden | Thrust | 1.5-3.0 | 500/120/600 | 120 | 48 | 18 | y | - | 4 | 0 | B0 |
| warden | Bash | 0-1.8 | 350/120/500 | 60 | 60 | 30 | n | - | 2 | 3 | shove |
| warden | Sweep | 0-2.8 | 650/180/750 | 140 | 56 | 24 | y | - | 2 | 2 | C+20 |
| warden | Lunge (player drinking ≤ 6 m) | 2-6 | 400/200/700 | 130 | 52 | 20 | y | - | - | 8 | roll + B |
| arbalist | Bolt | 6-35 | aim 900 (red glint), 40 m/s, reload 1,600 | 110 | 44 | 15 | n | - | 1 | 0 | shoot |
| arbalist | Kick | 0-1.6 | 400/120/500 | 60 | 30 | 25 | y | - | - | 2 | shove |
| hound | Lunge bite | 3-6 | crouch 380, leap 450 at 11 m/s, 600 | 70 | 28 | 14 | n | - | 3 | 1.5 | walk x3, pitch |
| hound | Snap | 0-1.6 | 250/100/350 | 45 | 18 | 8 | y | - | 2 | 0 | head pitch |
| crawler | Root lash (front 120°) | 0-3.0 | 600/200/700 | 110 | 44 | 30 | n | - | 3 | 0 | yaw sweep |
| crawler | Sap spit (slow 40 % 3 s) | 5-18 | 700, 18 m/s, 800 | 40 | 16 | 5 | n | - | 2 | 3 | pitch |
| crawler | Burrow | 6-14 | dive 900, 4 m/s up to 4 s, cracks 900, erupt 200, recover 1,200 | 120 | - | 40 | n | y | 2 | 7 | sink, rise |
| hearth | Sweep 270° | 0-3.5 | 700/200/800 | 200 | 80 | 40 | y | - | 3 | 0 | A+30, yaw |
| hearth | Overhead cleave | 0-3.2 | 850/180/1,000 | 260 | 100 | 55 | y | y | 2 | 0 | C0 |
| hearth | Twin thrust | 2-4.5 | 450/120/400, 2nd windup 250 | 150 x2 | 60 | 30 | y | - | 2 | 0 | B, B |
| hearth | Kiln burst (HP < 50 %, r 4) | 0-4 | 900/200/900 | 180 fire | - | 50 | n | y | - | 15 | crouch |

Behaviour: IDLE/PATROL → NOTICE (500 ms head turn + alert sound; sight in range and cone with line of sight; hearing while the player runs, sprints or attacks, walking within 40 % of the radius; or a hit) → ENGAGE (chase into move range; ≤ 2 humanoids hold attack tokens, the rest circle at 4–6 m, 1.6 m/s) → ATTACK (weighted pick of in-range moves off cooldown) → RECOVER → STRAFE/GUARD 0.6–1.6 s → ENGAGE; RETURN when the player is past the leash or unseen 12 s (walk home, ignore 3 s, keep HP); STAGGER, KNOCKDOWN, DEAD override. Unfinished: wander 3 m; pd spawns lie in the fall end pose and rise in 1,200 ms within 4 m; Frenzy below 40 % HP. Warden: patrols; shield blocks frontal 120° physical 100 % (guard stamina 120, regen 30/s; break → stagger 1,200 ms); Lunge punishes drinking. Arbalist: holds 12–22 m; < 6 m backsteps 2 m and shoots; < 1.6 m kicks. Hound: first to notice howls 900 ms (alerts hounds ≤ 30 m); pack slots 120° apart at 5 m; one bites at a time, 600 ms apart, then retreats 6 m for 1.2 s. Crawler: tremor sense (moving player ≤ 14 m); ×0.5 damage in front 90°, ×1.25 behind 90°; criticals only after a posture break flips it 2,000 ms (any side, MV 2.0). Hearth Knight: guards the Chapel of Embers (leash 30 m), never respawns, drops Kilnplate + Hearth Halberd.

### A9 Bosses
CANDLEHART, SIRE OF THE WAKE (field boss): HP 2,600; poise 220 (break → down 2,500 ms, head critical MV 2.5); abs 10/40 %; def 30; 6.0 m to the crown; home (190, 7, 120), roams 35 m, leash 90 m (returns, full heal); walk 2.2, trot 6, charge 13 m/s; drops 4,000 wicks + the Censer Flail; no fog gate (bar within 40 m once engaged).

| Ph | Move | Range | Telegraph | Windup | Active | Recovery | Dmg | Poise |
|---|---|---|---|---|---|---|---|---|
| 1 | Antler sweep, front 140° | 0-5.5 | head lowers, candles flare | 700 | 250, 70° yaw | 900 | 180 | 50 |
| 1 | Trampling charge (kd) | 10-40 | two hoof stamps | 900 | up to 2,400 at 13 m/s, 8 m past | 1,400 | 220 | 80 |
| 1 | Rear and stamp | 0-7 | rears 40° in 800 ms | 800 | ring 0 → 7 m in 400 ms, 0.6 m high | 1,200 | 160 | 60 |
| 1 | Hind kick, rear 90° | 0-4 | weight shift | 350 | 150 | 700 | 140 | 40 |
| 1 | Antler toss (player staggered ≤ 3 m) | 0-3 | - | 450 | 200, throws 3 m | 900 | 120 | 70 |
| 2 | Wax rain, 9 m 40° cone | 0-9 | crown blazes | 900 | 2,500: 30 fire / 250 ms | 1,000 | 30 x10 | 5 |
| 2 | Double charge, 600 ms turn | 10-40 | three stamps | 800 | 2 x up to 2,400 | 1,600 | 220 x2 | 80 |

Phase 2 at ≤ 50 % HP: an 1,800 ms invulnerable rear, the crown bursts into flame; windups ×0.85, +40 fire per hit.
HALVARD, THE GILT CASTELLAN → HALVARD, PYRE-WED (the Heart Kiln, behind the Ember Veil): HP 3,600; poise 140 (P2 180); abs 20/50 % (P2 fire 80 %); def 45; 2.9 m; walk 1.6 m/s; drops 8,000 wicks + the Heartwick; intro: kneels before the kiln, rises, turns (2,500 ms camera, name card, bar).

| Ph | Move | Range | Telegraph | Windup | Active | Recovery | Dmg | Poise | P |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Funeral arc, 140° | 0-3.8 | blade drawn back right | 850 | 220 | 950 | 240 | 45 | y |
| 1 | Dirge pair (2nd delayed) | 0-3.8 | as the arc; holds 300 ms at the top | 700 / 450 + 300 | 200 / 200 | 1,100 | 200 / 220 | 40 / 45 | y |
| 1 | Grave thrust | 4-10 | crouch, gold glint | 600 | 300 at 9 m/s, up to 7 m | 1,000 | 260 | 60 | n |
| 1 | Censer hammer (kd) | 0-4 | rises on toes 1,000 ms | 1,000 | 180, ring 2.5 m | 1,300 | 300 | 70 | n |
| 1 | Shoulder check | 0-1.8 | shoulder dips | 300 | 150 | 600 | 90 | 40 | y |
| 2 | Pyre leap (kd) | 4-14 | flames gather | 700 | 600 air + 200 slam, r 3.5 | 1,100 | 280 + 80 fire | 70 | n |
| 2 | Ember wave | 6-18 | blade dragged, sparks | 800 | 18 m at 12 m/s, 4 m wide, 1.2 m high | 900 | 160 fire | 30 | n |
| 2 | Vow trio (2nd delayed 250) | 0-4 | three swings | 600 / 350 + 250 / 400 | 200 each | 1,300 | 180 / 190 / 240 | 40 each | 1st, 3rd |
| 2 | Gilt whirl, 360 x2 | 0-4.5 | blade low behind | 900 | 2 x 250 | 1,200 | 170 x2 | 45 | n |

Phase 2 at HP ≤ 1,800: 2,800 ms invulnerable; he cuts the Great Censer's chains, it crashes in flame and fire rings the arena (r ≥ 16 m burns 20/s); P1 moves stay with +60 fire, windups ×0.87. Posture break: down 2,500 ms, frontal critical within 2.4 m (MV 2.5). Death: LAID TO REST, the Veil opens, the Heartwick appears on the kiln altar. Every boss move emits telegraph {boss, move, kind} at windup start, kind ∈ sweep, thrust, slam, charge, aoe, projectile; FX and audio give each kind its own cue.

### A10 Flow, critical path, play time
Flow: boot → title → New Journey → 6 s wake cutscene at the cart → play ↔ pause/menus; death → dead → respawn; the Heartwick → "The Heartwick is yours. Far to the north, the Everpyre flares." → credits → title. Critical path (competent first-timer, ~2 deaths): cart and tutorial prompts 2 min; Corpse Road to Tallowby, rest at the chapel 6; ford, road north, switchbacks to the Kilnhold Gate wakestone 6; Breach, Bailey, ramparts and winch (shortcut 1), Great Hall, Chapel of Embers, Inner Ward wakestone, Coffin Lift (shortcut 2) 12; bridge, Veil, Halvard 5 + 3 retries. Target 30 min (20–40). Optional: Candlehart 6, Gibbet Watch 4, Rootfall 4, Mournmere 3, Hanged Oak 2, Cairn 2 (≈ 50 min for all). A first clear yields ≈ 9,600 wicks (≈ level 19).`;


// The Tech spec's template (Part B), for the tech node; B5 names the files and clips the 3D model nodes really hand over.
const PALLWARD_TECH_SPEC = `## Part B - Tech spec
Units m, s, ms; degrees in tables, radians in code; x east, z south (north −z), y up; yaw 0 faces +z, forward = (sin yaw, 0, cos yaw). [m] = measured on the 2026-10-17 probe rig.

### B1 Map
Terrain (G.rng(20261017) seeds the noise): h = 6 + 9·fbm(x/240, z/240; 4 octaves, gain 0.5) + 2.5·fbm(x/60, z/60; 2 octaves), then in order: (1) edge + 45·smoothstep(340, 400, max(|x|,|z|)), + 0.8·(d − 400) beyond 400 m; (2) Mournmere (−250, −120): h = mix(h, −4.5, 1 − smoothstep(55, 95, d)), water −1.2; (3) Weeping Water via (−190,−80) (−150,−20) (−110,50) (−60,120) (−10,190) (50,280) (100,400), level −1.2 → −2.6 along it, within 6 m h = min(h, level − 1.4·(1 − (d/6)²)), banks blend 6–14 m, ford (−66,112)–(−54,128) bed at level − 0.45; (4) crag x 135..270, z −395..−168 at 30.0, falloff 25 m; (5) Gibbet hill + 12·max(0, 1 − d/45)² at (60, −60); (6) Rootfall ellipse (−80, −230), 45 × 15, rotated 30°: h = mix(h, −8, 1 − smoothstep(0.6, 1, e)); (7) flats (exact inside r, blended over f): start (−310, 330) r 18 f 12 h 5.0, Tallowby (−170, 175) 45/20/4.0, Pyrefield (190, 120) 85/30/7.0, shore (−196, −38) 10/10/1.5, Hanged Oak (−20, 260) 14/10/base, Cairn (300, 300) 12/10/base; (8) roads: half-width 3.5 m, blend to 7 m, height = base smoothed ±10 m along the road (R4 rises linearly to 30.0).

| Road | Points (x, z) |
|---|---|
| R1 Corpse Road | (-310,330) (-240,250) (-170,185) (-100,140) (-60,120) (0,75) (60,20) (115,-40) (150,-118) |
| R2 Gibbet | (60,20) (60,-30) (60,-52) |
| R3 Pyrefield | (0,75) (90,110) (120,150) (190,120) |
| R4 switchbacks | (150,-118) (205,-128) (160,-140) (205,-152) (175,-166) (186,-176) |
| R5 Mournmere | (-100,140) (-150,60) (-196,-38) |
| R6 Oak lane | (-170,185) (-90,240) (-20,260) |
| R7 Cairn | (190,120) (260,220) (300,300) |

Heightmap 513 × 513 (1.5625 m), cells split (i,j)–(i+1,j+1); height() interpolates that mesh exactly. Surfaces: road ≤ 3.5 m, water depth > 0, mud ≤ 12 m from water, stone (slope > 30° or crag), ash (Rootfall, Cinder Copse), heather fbm(x/40, z/40) > 0.2, else grass.

| Wakestone | Name | x, z | y |
|---|---|---|---|
| W1 | Corpse Road | -302, 322 | 5.0 |
| W2 | Tallowby Chapel | -150, 150 | 4.0 |
| W3 | Pyrefield Edge | 120, 150 | 7.0 |
| W4 | Kilnhold Gate | 186, -176 | 30.0 |
| W5 | Inner Ward | 236, -296 | 44.0 |
| W6 | Mournmere Shore | -196, -38 | 1.5 |

Places: Funeral Cart (−310, 5, 330) yaw 40°; Tallowby: 9 ruined cottages on a 28 m ring round (−170, 175) facing in, chapel 8 × 14 m at (−150, 140), 40 graves south of it; Gibbet Watch: 7 × 7 × 12 m tower at (60, −60), platform at ground + 10 by 3 ramps on its S, E, N faces (7 m, +3.33 m, 1.6 m wide); Pyrefield: 3 fallen pyres, 20 candle racks; Cinder Copse: 60 burnt trees within 60 m of (240, −40); Drowned Spire (−262, −128), 12 m above water; Rootfall: 6 arching roots; Hanged Oak: one dead tree ×2.4 (22 m), 5 gibbet cages; Cairn (300, 300); Everpyre (0, 0, −2600), 900 m, sky layer. Scatter: 260 dead trees, 180 rocks, 300 graves (40 in Tallowby, the rest clustered 6–14 m off R1), each grave with a candle cluster; never on roads (6 m), water, flats or within 8 m of a wakestone. Areas (banner on entry): Candlemoor by default; radii round their places: Tallowby 60, Weeping Ford 30, Gibbet Watch 45, Pyrefield 90, Cinder Copse 60, Mournmere 110, Rootfall 60, Hanged Oak 35, Cairn 25; Kilnhold = the crag rectangle; Heart Kiln r 20 at (223, −372), y > 40.

| Ids | Type | Positions |
|---|---|---|
| S01-S06 | unfinished | (-185,170) (-175,190) (-160,165)pd (-195,185) (-165,200)pd (-150,180) |
| S07 | warden | patrols (-170,160) ↔ (-140,190) |
| S08-S09 | unfinished | (-250,260) (-230,245) |
| S10-S11 | hound | (-40,100) (-48,92) |
| S12 | warden | (60,-40) |
| S13-S14 | arbalist | Gibbet top (58,-60) (62,-62) |
| S15-S17 | hound | (235,-35) (245,-45) (240,-50) |
| S18-S19 | unfinished | (230,-20) (250,-30) |
| S20-S22 | unfinished | (-210,-90) (-230,-60) (-280,-40) |
| S23-S24 | hound | (-300,-150) (-305,-140) |
| S25-S27 | crawler | (-90,-225) (-70,-240) (-60,-215) |
| S28-S30 | unfinished | (-25,255) (-15,265) (-30,268)pd |
| S31-S33 | warden | (190,30,-225) (215,30,-250) (175,30,-255) |
| S34-S35 | unfinished | (205,30,-215) (230,30,-240) |
| S36-S37 | arbalist | (230,38,-205) (150,38,-250) |
| S38-S39 | warden | (210,30,-300) (235,30,-292) |
| S40-S42 | unfinished | (220,30,-310)pd (205,30,-295) (240,30,-310)pd |
| S43 | hearth | (223,37,-312) |
| S44-S45 | arbalist, warden | (210,44,-300) (228,44,-290) |
| S46-S47 | hound | (223,44,-335) (223,44,-340) |
| BOSS1, BOSS2 | Candlehart, Halvard | (190,120); (223,44,-380) |

Pickups: K1 greataxe (−205, 205); K2 pike (62, −36); K3 Gibbet-top chest: Brigandine + Shard 1; K4 Sickles + Shard 2 (−82, −232); K5 Resin ×2 (−20, 258); K6 large Bundle (300, 300); K7–K10 small Bundles (−152, 146), (−240, −95), (240, 30, −265), (200, 30, −316); K11 Resin (165, 30, −212).

### B2 Kilnhold
Boxes are x0..x1, y0..y1, z0..z1 in m. Walls are 2.4 m thick, with 1 m merlons every 2 m. Everything is weathered stone (triplanar, 2 m). Floors are walkable tops registered with physics.

| Part | Geometry |
|---|---|
| Curtain walls, walk at y 38 | south z -206.2..-203.8, x 150..182 and 198..250; west x 148.8..151.2, z -280..-204, open at z -234..-228 (the Breach); east x 248.8..251.2, z -280..-204; north-west z -281.2..-278.8, x 150..196 |
| Towers | r 5 at (150,-205) (250,-205) (150,-280) (250,-280); y 30..46; floor 38 joins the walks |
| Gatehouse | x 182..198, y 30..44, z -208..-192; tunnel x 187.5..192.5, y 30..36; portcullis at z -193, closed until the winch lever at (190, 38, -199) |
| Breach | rubble x 145..158, z -234..-228; a 2.0 m mantle ledge on its outer face at x 145 (top y 32); ramp (152, 32) to (158, 30) |
| Lower Bailey | floor y 30, x 152..248, z -278..-207 |
| West wall stair | ramp x 152..154.6, (z -262, y 30) to (z -246, y 38) |
| Keep | outer x 196..250, y 30..56, z -320..-280; interior x 198..248, z -318..-282; door x 211..217, y 30..36, south face |
| Great Hall | floor 30; 10 pillars (p_pillar, 6 m) at x 208 and 238, z -314..-286 |
| Hall stair | ramp x 198..201, (z -284, y 30) to (z -304, y 37) |
| Chapel of Embers | slab x 198..248, y 36.4..37, z -318..-304; altar (223, 37, -316) |
| East stair | ramp x 245..248, (z -306, y 37) to (z -286, y 44) |
| Inner Ward roof | slab y 43.4..44 over the interior; holes for the east stair (x 245..248, z -306..-286) and the lift (x 221..225, z -292..-288); parapet 1.2 m |
| Coffin Lift | platform 4 x 4 at x 221..225, z -292..-288; y 30 ↔ 44 at 2 m/s (7.0 s); starts at 44; locked until its lever at (226, 44, -294) ("Release the coffin lift"), then callable from either level |
| Kiln Bridge | x 220.5..225.5, y 43.4..44, z -355..-320, parapets 1 m |
| Ember Veil | plane at z -352, x 220.5..225.5, y 44..50; blocks until interacted (a 1,200 ms pass to z -356); seals behind the player while Halvard lives and fights |
| Heart Kiln | base cylinder r 18 at (223, -372), y 30..44, floor 44; wall r 18.5, y 44..66, 8 arches (the south one open); kiln mouth in the north wall glowing #FF7A1A at emissive 3.0; Great Censer (p_censer, 3.5 m) hung at y 58 |

- Test 16 route: (158,30,-231) (190,30,-240) (214,30,-270) (214,30,-281) (214,30,-292).
- Shortcut 1: the winch joins W4 and the bailey.
- Shortcut 2: the lift joins the Great Hall and W5.

### B3 Time and weather
Day = 24 min (1 h = 60 s); a journey starts at 17:30, clear; keys interpolate linearly, wrapping.

| Hour | Sun elev/az | Key light | Hemi sky / ground, intensity | Fog (clear) | Exposure | Env | Pyre light |
|---|---|---|---|---|---|---|---|
| 0:00 | moon 40/200 | #9FB2FF 0.35 | #1E2438/#0E0B0E 0.35 | #141826 0.0018 | 1.35 | 0.25 | 0.75 |
| 5:00 | -4/80 (moon) | #9FB2FF 0.30 | #2A3150/#120E12 0.35 | #1A1E2C 0.0018 | 1.35 | 0.25 | 0.70 |
| 7:00 | 10/95 | #FFC08A 1.6 | #8C8FB0/#3A2A22 0.6 | #6E6470 0.0016 | 1.10 | 0.45 | 0.35 |
| 12:00 | 58/180 | #FFF1D6 3.0 | #A9AEC4/#4A3A2E 0.9 | #8D8E97 0.0012 | 0.90 | 0.70 | 0.15 |
| 17:30 | 9/265 | #FFB27A 2.2 | #7E6E8A/#3A2A22 0.7 | #5B4A55 0.0016 | 1.05 | 0.55 | 0.40 |
| 19:30 | -6/290 (moon) | #9FB2FF 0.25 | #2E2A44/#140F12 0.4 | #2A2232 0.0018 | 1.30 | 0.30 | 0.65 |

Ashfall: fog 0.0024 mixed 50 % with #6E6560, key light ×0.7, 1,500 flakes within 40 m falling 0.6 m/s. Storm: fog 0.0030 mixed with #3C4048, key ×0.35, 3,000 rain streaks within 30 m at 9 m/s, lightning every 8–20 s (hemisphere +2.5 for 120 ms; thunder 1.2–4 s later). Every 6–10 min (seeded) the weather re-rolls: clear 50 %, ashfall 35 %, storm 15 %, 20 s crossfade. The environment map is rebuilt from the sky every 30 s and on each change.

### B4 Interface and sound list
1280 × 720 reference; scale min(w/1280, h/720) clamped 0.75–1.5. HUD: HP bar (32, 28) 10 px, width 160 + 0.36 × max HP (≤ 520), #8E1E14 with a #E9DFC6 lag segment shrinking after 600 ms; focus y 44, 8 px, #3C8C86, 160 + 1.2 × max; stamina y 58, 8 px, #B9A35A, 160 + 1.4 × max; equipment cross (32, 584), 56 px cells; wick counter bottom-right, Cinzel 22 + flame glyph, counting up over 600 ms; lock mark a 14 px gilt diamond; boss bar bottom-centre y 650, 760 × 8, name Cinzel 18, mark at 50 %; prompt y 600 ("E  Rest at the Wakestone", glyph per device); toasts top-right, Instrument Serif italic 18, 2,400 ms with 200 ms fades, ≤ 3; area banner Cinzel 40 between rules, 600/2,000/900 ms. Banners: UNFINISHED Cinzel 96, spacing 0.35 em, #8E1E14 + ember glow, subline Instrument Serif italic 22; LAID TO REST #C9A349 80 + boss name; WAKESTONE LIT #E9DFC6 56; WICKS RECLAIMED #FFB547 48.
Screens: Title (PALLWARD in Cinzel 112, spacing 0.28 em, over the live scene from (−318, 9, 344) facing the Everpyre at 17:30; New Journey, Continue (with a snapshot), Settings, Credits; "Press any key", a load bar; 25 s idle → camera tour). Pause (stops the simulation): Equipment, Inventory, Status, Map, Settings, Quit to Title. Equipment: 6 slots (right 1–2, left, armour, quick 1–2) with stat changes. Inventory: Tools, Weapons, Armour, Key items. Status: stats, derived values, level, wicks, next cost. Wakestone: Level Up, Travel, Leave. Level up: + per stat, cost, before → after, confirm. Map: 256 × 256 relief from height() with roads, water, visited areas, wakestones, player arrow, candle, bosses; travel to lit wakestones when no foe is engaged within 40 m, outside Kilnhold. Settings: sensitivity 0.2–3.0 (1.0), invert Y, volume master/music/SFX 0.8/0.6/0.9, quality Low/Medium/High (Medium), FPS, reduce shake, run self-test. Credits: an original roll, e.g. "PALLWARD - a vertical slice. Designed, painted, modelled, built and tested by a canvas of AI agents."; roles by function, never products or companies.
Music states: title, explore, night, combat, stag, boss1, boss2, rest, death, victory, none. SFX: step.grass, step.heather, step.stone, step.mud, step.wood, step.water, cloth, roll, jump, land, swing.light, swing.heavy, hit.metal, hit.flesh, hit.wood, block, deflect, guardbreak, crit, flask, gutter, drip, wakestone, levelup, pickup, wicks, groan, growl, snap, clicks, burrow, bellow, roar, twang, crackle, ignite, chains, portcullis, veil, wind, rain, thunder, ui.move, ui.confirm, ui.back.

### B5 Animation map
Files: every humanoid model hands over model-1.glb (the mesh and skeleton with the clips idle, walk, run, slash, hurt), model-2.glb (clips dive, climb, jump, fall, turn) and model-3.glb (clip shoot), the last two clips only for the same skeleton; a quadruped or hexapod model hands over model-1.glb with one clip, walk; every other asset model-1.glb alone. Clip names are lower case, as above.
Clip facts [m] (probe biped; s; h = model height):

| Clip | Duration | Facts |
|---|---|---|
| idle | 15.37 | loop; hips 0.525 h |
| walk | 2.37 | loop; 0.68 h/s |
| run | 1.27 | loop; 2.44 h/s |
| slash | 6.60 | one unarmed swing: rise 0.9-1.9, strike (peak right-hand speed) 2.10, settled 5.0 |
| dive | 2.73 | forward dive-roll: launch 0.75, hips lowest (0.065 h) at 2.00, up by 2.55 |
| fall | 3.03 | sideways fall: hips lowest (0.10 h) at 1.77, settled 2.25, ends lying |
| jump | 2.23 | repeated hops: lows 0.50, 1.00, 1.50; highs 0.25, 0.75, 1.25 (+0.25 h) |
| climb | 3.47 | ledge mantle: hips rise 1.17 h and move 1.65 h forward over 0.5-3.3 |
| turn | 3.87 | turn on the spot |
| hurt | 13.87 | sits on the ground (hips at 0.05 h); not a hit reaction, so unused |
| shoot | - | not measured |

Measure at load on whichever clip is loaded (real or stand-in), never hard-code: strike = peak R_Hand world speed; roll = from the last frame before the hips drop below 0.9 × their start height to the first frame after the minimum back above it; fallEnd = hip minimum + 0.25; hop = first local minimum after 0.2 s, next maximum, next minimum; rise = end − start hip height; release (shoot) = peak R_Hand speed. Swings from slash (AnimationUtils.subclip around strike S): A [S − 0.85, S + 0.90], B [S − 0.45, S + 0.90], C [S − 1.20, S + 1.10]; a heavy charge holds C at S − 0.25; a two-rate warp lands the strike mid-active, (S − t0)/(startup + active/2) before S and (t1 − S)/(active/2 + recovery) after; a spine-twist layer adds the listed degrees. Actions: locomotion rate = speed/(natural × height), walk below 2.6 m/s; roll = dive's roll window warped to the roll total; backstep = hop window moving 2 m back; jump = hop window; mantle = all of climb in 1,600 ms, code moves the body; death = fall at 1.2, clamped; knockdown = fall to fallEnd at 1.6, 500 ms hold, back at −1.4; wake cutscene = fall end pose reversed over 2.2 s, playdead rise the same over 1.2 s; stagger, deflected, guard break, flask, guard, wakestone kneel, shove = procedural bone layers; arbalist aim holds shoot 0.3 s before release.
Root motion: keep only the vertical part of the Hip translation (up in Hip's parent space at bind); none in climb and jump. Non-humanoids play their walk clip at speed/clip speed (1.0 h/s if unknown); attacks, deaths and knockdowns are procedural on the root and head/neck bones. Attach: grip = midpoint of R_Index1 and R_Pinky1, 0.03 m toward the palm; blade axis = R_Index1 − R_Pinky1 (handle across the palm, blade out of the thumb side); shields on L_Forearm facing out; weapon and shield models stand upright with the grip at the fraction of their height G.assets.meta(id).grip gives. LOD: mixers every step within 30 m, every 2nd to 60 m, every 4th beyond; skinned meshes hidden beyond 140 m (bosses 300 m).

### B6 Performance budget (mid laptop, 1280 x 720, Medium)
| Item | Budget |
|---|---|
| Frame | 16.7 ms. If the 2 s mean is over 18 ms, the pixel ratio drops 0.1 at a time to 0.7; it rises again below 12 ms |
| All passes | ≤ 450 draw calls and ≤ 1.2 M triangles |
| Terrain | 64 chunks of 100 m. LOD0 (8,192 tris) within 150 m, LOD1 (512) to 400 m, LOD2 (128) beyond. 2 m skirts. LOD0 built on demand, at most 2 chunks a frame |
| Instancing | Grass: 12 k cards (High 24 k, Low 4 k) in a 60 m ring, 2 draw calls. Heather: 3 k. Dead trees: 260 (mesh within 120 m, impostor beyond). Rocks: 180. Graves: 300. Candle clusters: 300, shown within 60 m. Ruins: one InstancedMesh per kind |
| Shadows | 1 directional light; 1,024 map (High 2,048); PCF soft; 90 x 90 m ortho box ahead of the player, texel-snapped. Casters: characters, castle, and trees on High |
| Post | Sky RenderPass; main RenderPass (clear false); UnrealBloomPass (0.55 / 0.6 / threshold 0.92, half resolution); grade ShaderPass (vignette, split tone, grain 0.035); OutputPass (ACES); FXAA on Medium or SMAA on High. Low: no AA, quarter-resolution bloom |
| Pixel ratio | High min(device, 1.5); Medium 1.0; Low 0.85 |
| Foes | At most 14 thinking within 80 m; frozen beyond 80 m, hidden beyond 140 m |
| Boot | Title within 1.5 s; heightmap plus LOD1 and LOD2 at init; assets settled within 15 s |

### B7 Acceptance tests
Scratch arena (flat 64 × 64 m; player at the origin facing +z, start kit, level 10); time advances only by G.loop.step(n); nothing renders unless stated. A test's name starts with its number and owner; its detail says what was compared.
1. core: listeners fire in order; an unsubscribed one stops; a disabled command → run() false, no effect.
2. core: step(120) → G.time +2.000 s, each system ×120 in order; a 100 ms frame → 5 steps.
3. core: rng(7) repeats 1,000 values in [0,1); snapshot, change wicks, restore → same wicks; JSON.parse(export()) = snapshot.
4. assets: every core id in priority order; paths match /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\\/model-\\d+\\.glb$/; bytes ≤ 25,165,824; meta heights = table.
5. assets: no file → load('m_unfinished') ≤ 3,000 ms gives a stand-in 1.75 ± 0.05 m with Hip, Spine02, Head, R_Hand, L_Hand, R_Index1, R_Pinky1, L_Forearm and clips walk, run, slash, fall at B5 durations ± 0.05.
6. assets: two m_warden instances: a bone turned in one stays in the other; geometry shared.
7. render: passes in order RenderPass (sky), RenderPass (main, clear false), UnrealBloomPass, ShaderPass, OutputPass, FXAAPass; ACESFilmic; exposure 1.05 ± 0.01 at 17:30; shadow map 1,024.
8. render: setTime(12) → sun > 50°; setTime(0) → sun below 0°, moon on; ashfall fog 0.0024 at any hour; clear 12:00 → 0.0012.
9. render (one render): title view 320 × 200 Medium ≤ 450 calls, ≤ 1.2 M triangles.
10. terrain: heights ± 0.05: W1 5.0, W2 4.0, W3 7.0, W4 and (200, −240) 30.0, W6 1.5.
11. terrain: 12 R1 points 60 m apart: heights at −3/0/+3 m within 0.30; ford depth 0.3–0.6; Mournmere centre ≥ 3 m deep; W1 dry.
12. terrain: 20 seeded points: LOD0 mesh = height() ± 0.02; height(±420, 0) ≥ 40.
13. dressing: ≥ 240 trees in ≤ 2 InstancedMeshes per LOD; grass ≤ 2 calls; no tree < 6 m from a road or < 8 m from a wakestone.
14. dressing: Everpyre in the sky layer at (0, 0, −2600) ± 1, 900 ± 10 m, fog: false, crown emissive ≥ 2.0 at 22:00.
15. dressing: 6 wakestones at B1 (± 0.1; y = ground ± 0.05), each a 'rest' interaction r 2.5.
16. castle: ground() = 30 at (200,31,−240), 38 at (150,39,−250), 37 at (223,38,−312), 44 at (230,45,−296), (223,45,−340), (223,45,−372); a 0.38 m capsule clears the B2 route.
17. castle: lift at 44, callLift(30) false before the lever; after it 44 → 30 in 7.0 ± 0.2 s carrying a body.
18. castle: the Veil stops a body going north at (223,44,−350); interact → z −356 in 1,200 ms; blocks the way back mid-fight; open after Halvard dies.
19. physics: a 10 m drop lands at 1.05 ± 0.03 s, grounded.
20. physics: a 0.4 m step is climbed, 0.6 m blocks; a 50° slope slides.
21. physics: an 8 m fall costs 80 of 500 HP; 16 m kills; two overlapping 0.38 m bodies ≥ 0.75 m apart after 1 step.
22. input: KeyW → (0, 1), KeyA → (−1, 0); mouse 0/2 → light/heavy; pad 5/7/4/1 → light/heavy/guard/roll; a stick past 0.18 moves.
23. input: in L1 (cancel 702 ms) a press at 450 → L2 at 702 ± 17; a press at 350 is dropped, L1 ends at 870 with no L2.
24. input: autoplay forward 70 steps from rest → 5.02 ± 0.15 m.
25. camera: A 8 m 5° left, B 12 m ahead → A; 26 m unlockable; the lock breaks at 31 m.
26. camera: locked on A, switch right → B.
27. camera: wall 2 m behind → camera ≤ 1.9 m from the pivot, player's side.
28. anim: stand-in measure() → strike 2.10 ± 0.07, roll [0.75 ± 0.10, 2.55 ± 0.15], fallEnd 2.02 ± 0.07, hop (0.50, 0.75, 1.00) ± 0.07, rise 1.17 ± 0.05 h; any rig: strike in 0.2–0.8 of its clip, roll 0.8–2.4 s, windows inside clips.
29. anim: L1 330/120/420 → strike at 390 ± 17 ms, 'active' 330–450, end 870 ± 17.
30. anim: sword grip ≤ 0.06 m from the R_Index1/R_Pinky1 grip, axis ≤ 15° off; tip ≥ 0.45 m before the chest at the L1 strike; after 120 walk steps Hip ≤ 0.05 m from the root horizontally.
31. combat: dummy 1.0 m ahead, autoplay light → exactly one 128 hit within 30 steps.
32. combat: raw 300 on the player (level 10, Shroud) → 176; warden thrust (sd 48) on the Coffin-Lid → 0 damage, 18 stamina.
33. combat: 3 L1 hits (poise 12) stagger the dummy (poise 30) on the 3rd; poise 30 again after 180 quiet steps.
34. fighter: light roll 18 stamina (80 → 62), 4.2 ± 0.2 m; raw-150 hit at 200 ms → 0, at 450 → 88; stamina 62 at 0.6 s, 80 ± 1 at 1.0 s.
35. fighter: guard press + parryable raw-150 (sd 60) hit 100 ms later → 0 damage, 0 stamina, +12 focus, attacker 'deflected' 1,500 ms; at 250 ms → guard, 23 stamina.
36. fighter: 100/500 HP, 4 flasks: 4 at 449 ms, 3 at 451, HP 450 at 850; a stagger at 300 → refund, no heal.
37. player: run 4.6, half-stick walk 1.8, sprint 6.6 m/s (± 0.1); sprint 10 ± 1 stamina/s.
38. player: death with 1,234 wicks at (5,0,5) → one candle of 1,234 within 0.5 m, wicks 0; touch → 1,234; a second death first → replaced by the new amount.
39. player: 2.0 m from a wakestone → prompt "Rest at the Wakestone"; interact → rest event, its menu, HP/focus/flasks full; at 3.0 m nothing.
40. ai: an unfinished notices standing at 12 m ahead within 30 steps; not walking 12 m behind; yes running 7 m behind; goes home after the player is > 35 m from home for 1 s.
41. ai: warden at 2.5 m, 300 seeded picks: thrust ≈ 67 %, sweep ≈ 33 % (± 8), bash 0.
42. ai: 4 engaged wardens ≤ 2 tokens at every step of 600; 3 hounds ≥ 90° apart within 240 steps.
43. bosses: Halvard 3,600 → 1,800 emits phase 2, takes 0 for 2,800 ms, then picks only P2 and kept P1 moves.
44. bosses: every boss move: windup ≥ 300 ms, telegraph at its start; Censer hammer and Trampling charge recover ≥ 1,200 ms.
45. bosses: Candlehart engages → bar "CANDLEHART, SIRE OF THE WAKE" 2,600; player > 90 m from its home 1 s → returns, full HP, bar hidden.
46. world: kill 3 unfinished + the Hearth Knight, rest → the 3 back at spawn at full HP, knight dead, flasks 4/4, HP full.
47. world: level 10, 700 wicks: levelUp('vigor') → 40 wicks, level 11, vigor 11, max HP 520; level 11 with 700 → refused (734).
48. world: K1 → greataxe in the inventory, pickup event, toast "Gravedigger's Greataxe"; AR at Might 12 = 132 ± 1.
49. fx: 300 bursts → live particles ≤ 512, pool size constant after warm-up.
50. fx: a heavy hit → timeScale 0.05 for 6 steps, then 1.
51. fx: trail only in L1 active steps 20–27, hidden at 30.
52. audio: ctx null after boot without a gesture; unlock() creates it; music('explore') sets the state.
53. audio: engaged foe → 'combat' within 60 steps; boss → 'boss1'; phase 2 → 'boss2'; rest → 'rest'; nothing scheduled > 0.25 s ahead.
54. audio: every B4 SFX plays without throwing; 30 m to the right: pan > 0.6, gain < 0.5 × the gain at 1 m.
55. hud: 250/500 HP → fill 50 ± 1 %; bar 340 px at 500 max, 448 at 800; boss bar hidden until a fight, then name at 100 %.
56. hud: 3 pickups within 100 ms → 3 toasts in turn, 2,400 ms each, ≤ 3 at once.
57. hud: death → UNFINISHED + subline at 1,000 ± 50 ms; 'play' at 4,600 ± 100 ms at the last wakestone.
58. menus: title lists New Journey, Continue (disabled without a snapshot), Settings, Credits; New Journey → 'play' within 360 steps, within 4 m of (−310, 330).
59. menus: level 10, 700 wicks: + Vigor enabled at 660; after buying, disabled (734 > 40).
60. menus: W2 lit, no foe engaged: map travel → within 3 m of (−150, 4, 150) in 'play'; unlit wakestones not offered.

### B8 Planted failures
| Id | Owner | Wrong variant | Caught by |
|---|---|---|---|
| P01 | core | the fixed step uses dt = 1/30 | 2 |
| P02 | assets | instance() returns the template itself | 6 |
| P03 | anim | one uniform rate over the whole swing window | 29 |
| P04 | anim | the weapon attaches to L_Hand | 30 |
| P05 | render | fog density ignores the weather | 8 |
| P06 | terrain | roads are not flattened (half-width 0) | 11 |
| P07 | physics | gravity 9.8 | 19 |
| P08 | input | buffer window 600 ms | 23 |
| P09 | camera | lock-on scores by angle only | 25 |
| P10 | combat | letter C = 0.35 | 31 |
| P11 | combat | absorption applied twice | 32 |
| P12 | fighter | i-frames cover the whole roll | 34 |
| P13 | fighter | deflect window 300 ms | 35 |
| P14 | player | death keeps the wicks (no candle) | 38 |
| P15 | bosses | phase 2 at 40 % | 43 |
| P16 | world | the level cost uses level + 1 | 47 |

### B9 Unknowns and defaults
Shoot release: measured at load, else 1.30 s. Non-humanoid bones: only the root and head/neck bones; natural speed 1.0 h/s. Untextured and base-colour-only sizes: estimates; the manifest packs by the real byte counts. Pointer lock refused: arrows and middle-drag. Headless AudioContext: may exist muted; tests check state. Real GLBs: absent in the sandbox (stand-ins run the tests); real models are checked in the live preview.`;

// What the spec nodes may write: room for their template with its numbers kept, and a little more.
const roomFor = (template: string) => Math.ceil((template.length + 1500) / 1000) * 1000;
const GAME_SPEC_LIMIT = roomFor(PALLWARD_GAME_SPEC);
const TECH_SPEC_LIMIT = roomFor(PALLWARD_TECH_SPEC);
const ART_LIMIT = 10000;
const chars = (count: number) => count.toLocaleString('en-US');

// The fixed contract every module codes against; the core module defines it. Builders never see each other's code.
const PALLWARD_KERNEL = `Pallward kernel contract (fixed; every module uses exactly these names):
- One global, window.Pallward, which core creates as its script runs (the first script). Every other module is one IIFE, (() => { const G = window.Pallward; ... })();, that defines no other global, attaches only its own namespace (the API sheet) to G as its script runs and registers G.module(name, init). Nothing runs at load. three.js arrives as G.lib = { THREE, GLTFLoader, SkeletonUtils, mergeGeometries, EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, OutputPass, FXAAPass, SMAAPass, Sky, SimplexNoise } just before G.boot and is read only in init or later. Init order: core, render, assets, physics, terrain, dressing, castle, input, camera, anim, combat, fighter, player, ai, bosses, world, fx, audio, hud, menus.
- G.on(type, fn) returns an unsubscribe; G.emit(type, detail). Types: ready, flow, spawn, despawn, hit {src, dst, dmg, poise, result}, death {e, by}, rest {id}, pickup {id, n}, level {stat}, phase {boss, phase}, telegraph {boss, move, kind}, area {id}, toast {text}.
- G.system(name, order, fn(dt)) runs fn every fixed step (dt = 1/60 s x G.timeScale; at most 5 steps a frame, the rest dropped), lower order first; G.onRender(fn(alpha)) once a frame after the steps. G.time (simulated s), G.step (count), G.timeScale (1), G.loop.step(n) (n steps now, nothing rendered), G.loop.paused.
- G.rng(seed) -> { next() in [0,1), range(a, b), int(n), pick(a) } (mulberry32); G.SEED = 20261017.
- G.ent.create(def) -> e = { id, kind ('player'|'enemy'|'boss'|'prop'|'pickup'|'candle'), type, team (0 player, 1 foe, 2 none), pos (THREE.Vector3), yaw (forward = (sin yaw, 0, cos yaw)), vel (Vector3), r, h, onGround, obj, rig, f, ai, alive, home } with def's fields copied; G.ent.get(id), all(kind?), near(pos, radius, fn?), remove(id); create and remove emit spawn and despawn.
- G.interact.add({ pos, radius, label, kind, enabled(), run(e) }) -> handle; G.interact.near(pos) -> the closest enabled one within its radius, or null; G.interact.remove(handle).
- G.flow.state: 'boot'|'title'|'play'|'pause'|'menu'|'dead'|'cutscene'|'credits'; G.flow.set(state, data) emits flow. Systems run only in play, dead and cutscene.
- G.ui.root: a full-window DOM layer over the canvas; G.ui.layer(name) returns its positioned div ('hud', 'toast', 'banner', 'menu', 'touch', 'debug', in that z-order).
- G.commands.register({ id, label, keys, run(params), enabled() }); G.commands.run(id, params) returns false when disabled; G.commands.list(). Ids: game.*, menu.*, debug.*, test.*.
- G.save.provide(key, get, set); G.save.snapshot() -> { key: value }; G.save.restore(snap); G.save.export() -> JSON string. No storage, cookies or network.
- G.reset(fn) registers fn(scratch): clear this module's state, for the flat 64 x 64 m test arena when scratch is true, for the real world when false. G.newGame() calls every reset with false.
- G.tests.add(no, name, fn) (fn returns or resolves true, or throws why; 2,000 ms cap); G.tests.plant(name, swap, catches) (swap() installs the wrong variant and returns its restore; catches = test numbers); G.tests.expect(table) (the spec's numbers and owners); G.tests.scratch(); G.tests.run() -> { tests: [{ name, ok, detail }], planted: [{ name, rejected, detail }] }: it pauses the loop and rendering, scratches before every test, runs each plant only against its catches (rejected when one fails; always restored), reports an expected number nobody registered as a failed test 'not registered', then restores the game it found. window.awwoSelfTest = () => G.tests.run().
- G.module(name, init); G.boot(root) runs the inits in order (a throw is caught, logged and toasted; the rest still run), emits ready and sets flow 'title'.`;

// The names each module owns, the second fixed text every builder gets.
const PALLWARD_API = `Pallward API sheet (fixed; each module owns exactly its namespace and the names listed for it; every other module may call these names and nothing else):
- render: G.render = { renderer, scene, sky (the sky scene), cam (a PerspectiveCamera, driven by camera), composer, quality, setQuality(q), time, setTime(h), weather, setWeather(k), sun, moon, fog(), mat(name) (a shared MeshStandardMaterial), bands(geometry, bands) (geometry groups and materials by height), triplanar(mat, scale), frame(), info() -> { calls, triangles }, suspend(bool), passes() }.
- assets: G.assets = { list(), meta(id) -> { kind, height, rig, clips, paths, bytes, priority, grip, material, omitted }, load(id) -> a Promise of a template (the GLB scene or a stand-in, userData.standIn), instance(id) (SkeletonUtils.clone), clips(id) (every file's clips merged by name), ready (a Promise), report() -> { loaded, standIns, omitted, bytes } }.
- physics: G.physics = { body(e), addBox(box, tag), addRamp(ramp, tag), addCyl(cyl, tag), addPlatform(box) -> a handle with y, addTrigger(shape, enter, exit), remove(h), ground(x, y, z), ray(o, dir, max) -> { t, point, tag } or null, sweep(a, b, r, filter) -> [{ e, t, point }], arena(on), teleport(e, pos), lastSafe(e) }.
- terrain: G.terrain = { height(x, z), normal(x, z), surface(x, z), water(x, z) -> depth, road(x, z) -> the distance to the nearest road line, meshHeight(x, z) (from the built LOD0 vertices), mesh, flat }.
- dressing: G.dressing = { wakestones ([{ id, pos, obj }]), landmark(id), counts() -> { trees, treeMeshes, grassCalls, rocks, graves }, update(camPos) }.
- castle: G.castle = { root, lift ({ y, unlocked }), callLift(level) -> bool, gate ({ open }), veil ({ open, sealed }), seal(bool), arena ({ centre, r }), route, ledges, fireRing(on) }.
- input: G.input = { move, look, held(a), pressed(a), released(a), buffered(a), consume(a), device, virtual(a, v), autoplay: { run(steps) -> Promise, scripts }, sensitivity, invertY }; actions move, look, light, heavy, guard, art, roll, jump, interact, flask, item, weapon, lock, switchL, switchR, pause, map, inventory, up, down, left, right, confirm, back.
- camera: G.camera = { mode, target, lock(), unlock(), switch(dir), shake(amp, ms), cine(path, ms) -> Promise, reticle() -> { x, y, visible }, forward(), yaw, pitch }.
- anim: G.anim = { create(e, assetId) -> rig, play(rig, action, timing) -> { phase, t, done }, loco(rig, speed), layer(rig, name, w), attach(rig, slot, obj, grip), tip(rig), bone(rig, name), measure(clip) -> { dur, strike, roll, fallEnd, hop, rise, release }, windows(rig), setTint(rig, hex), pose(rig, name, w) (procedural root motion for non-humanoids) }.
- combat: G.combat = { weapon(id), armor(id), shield(id), derive(stats, equip), ar(weaponId, stats), f(x), LETTERS, damage(src, dst, move), hit(src, dst, move, opts) -> 'hit' | 'guard' | 'deflect' | 'iframe' | 'none', kill(e, by), fallDamage(e, h) }.
- fighter: G.fighter = { attach(e, kit), command(e, cmd, arg) -> bool, wish(e, vx, vz), state(e), current(e) -> { id, phase, t }, invuln(e), guarding(e), spend(e, n), focus(e, n), heal(e, n), stagger(e, ms, kind), knockdown(e), crit(src, dst, kind) }.
- player: G.player = { e, spawn(pos, yaw), respawn(), control, die(by), kit }.
- ai: G.ai = { def(type), spawn(type, pos, opts), dummy(pos, opts), respawnAll(), active(), tokens() }.
- bosses: G.bosses = { def(id), spawn(id), start(id), active(), phase(id), defeated(id), reset(id) }.
- world: G.world = { state ({ wicks, level, stats, inv, equip, flasks, flasksMax, lit, last, flags, candle, killed }), item(id), give(id, n), take(id, n), equip(slot, id), rest(id), travel(id), levelCost(level), levelUp(stat) -> bool, flag(name, v), wakestone(id), area(pos), spawns }.
- fx: G.fx = { burst(kind, pos, dir, n), trail(e, on), ring(pos, r0, r1, ms, color), flash(color, ms), telegraph(e, kind), candle(pos) -> handle, flame(pos, scale) -> handle, hitstop(ms), stats() -> { alive, capacity, objects }, trailVisible(e) }.
- audio: G.audio = { ctx, unlock(), music(state), state, sfx(name, pos, opts) -> a handle { pan, gain }, loop(name, pos) -> stop, volume(bus, v) }.
- hud: G.hud = { show(bool), toast(text, sub), banner(kind, text, sub), prompt(text), boss(e, name), fps(bool), el }.
- menus: G.menus = { open(id), close(), current(), settings }.
- System orders (G.system): input 10, player 20, ai 30, bosses 32, fighter 40, physics 50, combat 60, anim 70, world 80, castle 82, dressing 84, render (its clock) 85, camera 90, fx 92, audio 94; hud and menus draw in G.onRender.`;

// Every builder's rules: what makes twenty modules written apart fit into one page.
const pallwardRules = (name: string, limit: number) => `Rules for every module:
- Structure: write the ${name} module as the kernel contract says: ${name === 'core' ? 'it alone creates window.Pallward, with every kernel name, as its script runs (it is the first script of the page)' : `one IIFE that attaches its API-sheet names to G as its script runs, registers its init with G.module('${name}', init) and defines no global`}. Never read G.lib or three.js before init.
- Boundaries: use other modules only through the names the API sheet gives them; never redefine, patch or wrap them. Anything the contract does not provide stays private to your module.
- Registration: register every user action as a command (G.commands.register), your systems with G.system at the API sheet's order, your acceptance tests with G.tests.add by the Tech spec's numbers and your planted failures with G.tests.plant with the test numbers that catch them; a test checks real values with real code, never only that nothing threw.
- Data: use the numbers in the Game spec's and the Tech spec's tables exactly; never redesign them. Where a spec and this task disagree, this task and the kernel contract win.
- Sandbox: the page runs in a sandboxed frame with no network, storage, cookies, workers, external scripts, imports or downloads; three.js r186 arrives only as G.lib. Fonts only by name, Cinzel, Manrope or Instrument Serif, each followed by a generic fallback, never linked; canvas text is drawn after document.fonts.ready. Never write the characters </script anywhere. Only the assets module writes a <node id>/<file> path.
- Main thread: slice any work longer than 50 ms across frames with requestAnimationFrame or setTimeout, and catch every Promise rejection. Interface text is English.
- Compact code: no comments, no blank lines, short local names, tables and loops instead of repetition; at most ${chars(limit)} characters in all; finish before you polish, and when space runs short drop polish before a contract name or a test. Think only a few sentences before writing: the design is settled.
- You work in the sandbox computer, and your answer is a file, not a message: write the module as numbered parts p01.js, p02.js, … of at most 6,000 characters each with workspace_write (one part a step), join them with cat p*.js > ${name}.js, run node --check ${name}.js and fix what it reports, then publish ${name}.js into your result output: call workspace_publish with field "result" and path "${name}.js", and end with exactly this reply and nothing else: {"result": ""} (the host fills in the published file). Ignore any rule about answering with one code block: the assemble node pastes the published file into the page byte for byte.
- This run ends after 25 minutes and about 60 model calls: write the parts first, check once, publish; keep what each command prints short.`;

// The canvas's media: ten concept paintings and the 33 3D models of the core tier (G-assets.json), on the API's real
// settings. A model made from a painting takes it as its reference picture; every model feeds the assets builder.
type Rig = 'biped' | 'quadruped' | 'hexapod';
interface PallwardConcept { readonly id: string; readonly title: string; readonly prompt: string }
interface PallwardAsset {
  readonly id: string; readonly title: string; readonly column: number; readonly row: number;
  readonly priority: number; readonly height: number; readonly faceLimit: number;
  /** Its own textures with PBR maps, base colour only, or none (its look is code). */
  readonly texture: 'pbr' | 'base' | 'none';
  readonly look: string; readonly prompt: string;
  readonly rig?: Rig; readonly grip?: number; readonly image?: string;
}

const CHARACTER = 'full-body character concept for a 3D game model, orthographic front view, A-pose with the arms 35 degrees from the body and the legs slightly apart, centred, the whole figure visible from head to feet, plain neutral mid-grey background, soft even studio light, no cast shadow, empty open hands, no weapon, no shield, no text, no logo, dark fantasy, realistic proportions, readable silhouette, highly detailed materials';
const CREATURE = 'full-body creature concept for a 3D game model, three-quarter front view from the left, standing still on all its legs, centred, the whole body visible, plain neutral mid-grey background, soft even studio light, no cast shadow, no text, no logo, dark fantasy, readable silhouette, highly detailed';
const CONCEPTS: ReadonlyArray<PallwardConcept> = [
  { id: 'i_bearer', title: 'i_bearer · Bearer concept', prompt: `A lean funeral knight, the last pallbearer of a fallen order: a hooded grey-violet mourning shroud over dark iron scale armour, a bronze half-mask over mouth and jaw, a coil of candle-wick wound round the left forearm, leather straps and buckles, worn tall boots; muted ash grey and violet with bronze accents. ${CHARACTER}` },
  { id: 'i_halvard', title: 'i_halvard · Halvard concept', prompt: `A towering undying castellan 2.9 m tall: blackened plate armour leafed with ornate gold filigree, a crowned great helm with a long black funeral veil falling over the shoulders, a torn mourning cape, cracked wax showing at the armour seams, gauntleted hands; gold leaf and soot black. ${CHARACTER}` },
  { id: 'i_candlehart', title: 'i_candlehart · Candlehart concept', prompt: `A colossal ancient stag whose huge branching antlers form a crown of dozens of lit church candles, wax dripping down its long face, a shaggy charcoal coat with ember-orange glowing cracks along the neck and flanks, long strong legs, head held high. ${CREATURE}` },
  { id: 'i_unfinished', title: 'i_unfinished · Unfinished concept', prompt: `A gaunt risen corpse villager: tattered grey funeral linen, waxy pale skin, a burlap hood over a featureless face, three short candle stubs fused into the top of the skull, bare feet, thin arms, shoulders slightly hunched. ${CHARACTER}` },
  { id: 'i_warden', title: 'i_warden · Kilnsworn Warden concept', prompt: `A tall soldier of a fire-keeping order: a rust-red surcoat over soot-black iron plate, a kettle helm with a narrow eye slit, an iron gorget, a small flame-shaped brass badge of original design on the chest, a mail skirt, heavy boots. ${CHARACTER}` },
  { id: 'i_arbalist', title: 'i_arbalist · Kilnsworn Arbalist concept', prompt: `A hooded crossbowman of a fire-keeping order: a padded soot-grey gambeson, a rust-red hood and short cape, leather bracers, a bolt quiver on the right hip, a brass clasp at the throat, light boots. ${CHARACTER}` },
  { id: 'i_hearth', title: 'i_hearth · Hearth Knight concept', prompt: `A massive armoured knight: bulky blackened kiln-plate armour whose seams glow furnace orange, a horned great helm with a grille visor, a heavy dark fur mantle, iron chains across the chest, huge gauntlets. ${CHARACTER}` },
  { id: 'i_hound', title: 'i_hound · Cinder Hound concept', prompt: `A lean feral hound the size of a wolf: a charred black hide split by glowing ember-orange seams, a ridge of bony spines along the back, long narrow jaws with sooty teeth, thin powerful legs, ash flaking from the coat. ${CREATURE}` },
  { id: 'i_crawler', title: 'i_crawler · Root Crawler concept', prompt: `A low six-legged creature of twisted roots and bark, about 2.5 m long: a flat armoured carapace of charred bark, glowing amber sap veins, six jointed root-like legs, a split root maw at the front, moss and soil clinging to it. ${CREATURE}` },
  { id: 'i_everpyre', title: 'i_everpyre · Everpyre concept', prompt: 'A colossal ancient world tree on fire, seen whole: an immense gnarled trunk splitting into a vast crown of bare twisting branches, the entire crown wreathed in tall flames and rising smoke, molten amber sap running down the bark like candle wax, great roots gripping a rocky hill; centred, the full tree from roots to crown, plain neutral mid-grey background, even light, no text, no logo, dark fantasy.' },
];

const UPRIGHT = 'standing vertically, head or blade pointing straight up and the handle at the bottom:';
const OBJECT = 'Centred single object, game asset, clean readable silhouette, no base, no stand, no ground, no text, no letters, no logo.';
const TEXTURED = 'textured, no PBR';
const asset = (id: string, title: string, column: number, row: number, priority: number, height: number, faceLimit: number,
  texture: PallwardAsset['texture'], look: string, prompt: string, more: Pick<PallwardAsset, 'rig' | 'grip' | 'image'> = {}): PallwardAsset =>
  ({ id, title, column, row, priority, height, faceLimit, texture, look, prompt, ...more });
const ASSETS: ReadonlyArray<PallwardAsset> = [
  asset('m_bearer', 'm_bearer · The Bearer (player)', 2, 0, 1, 1.8, 6000, 'pbr', 'textured, PBR', 'A lean hooded funeral knight in a grey-violet shroud over dark iron scale, bronze half-mask, A-pose, empty hands.', { rig: 'biped', image: 'i_bearer' }),
  asset('m_halvard', 'm_halvard · Halvard, the Gilt Castellan (boss)', 2, 1, 28, 2.9, 9000, 'base', TEXTURED, 'A towering gilded black-plate castellan with a crowned veiled great helm, A-pose, empty hands.', { rig: 'biped', image: 'i_halvard' }),
  asset('m_candlehart', 'm_candlehart · Candlehart, Sire of the Wake (field boss)', 2, 2, 32, 6, 8000, 'base', TEXTURED, 'A colossal stag with an antler crown of lit candles, charcoal coat with ember cracks, standing.', { rig: 'quadruped', image: 'i_candlehart' }),
  asset('m_unfinished', 'm_unfinished · Unfinished (risen villager)', 2, 3, 26, 1.75, 4000, 'base', TEXTURED, 'A gaunt risen villager in tattered funeral linen with candle stubs in the skull, A-pose, empty hands.', { rig: 'biped', image: 'i_unfinished' }),
  asset('m_warden', 'm_warden · Kilnsworn Warden', 2, 4, 27, 2, 5000, 'base', TEXTURED, 'A tall rust-red and black iron soldier with a kettle helm, A-pose, empty hands.', { rig: 'biped', image: 'i_warden' }),
  asset('m_arbalist', 'm_arbalist · Kilnsworn Arbalist', 2, 5, 30, 1.8, 4500, 'base', TEXTURED, 'A hooded crossbowman in a soot-grey gambeson and rust-red hood, A-pose, empty hands.', { rig: 'biped', image: 'i_arbalist' }),
  asset('m_hearth', 'm_hearth · Hearth Knight (elite)', 2, 6, 31, 2.3, 6000, 'base', TEXTURED, 'A massive horned knight in blackened kiln-plate with glowing seams and a fur mantle, A-pose, empty hands.', { rig: 'biped', image: 'i_hearth' }),
  asset('m_hound', 'm_hound · Cinder Hound', 2, 7, 29, 1.1, 3000, 'none', 'recipe charred, emissive #FF5A1A 1.8 through noise cracks 18 %', 'A lean charred hound with glowing ember seams and a spined back, standing on four legs.', { rig: 'quadruped', image: 'i_hound' }),
  asset('m_crawler', 'm_crawler · Root Crawler', 2, 8, 33, 1.2, 3000, 'none', 'recipe rootbark, emissive #FF9A3A 1.2 through noise veins 12 %', 'A low six-legged root-and-bark creature with a flat carapace and glowing sap veins.', { rig: 'hexapod', image: 'i_crawler' }),
  asset('p_everpyre', 'p_everpyre · The Everpyre', 2, 9, 5, 900, 10000, 'none', 'look from the dressing module\'s code', 'A colossal burning world tree: gnarled trunk, vast crown of bare branches, roots over a rocky hill.', { image: 'i_everpyre' }),
  asset('w_longsword', 'w_longsword · Pallward Longsword', 3, 0, 2, 1.15, 1200, 'none', 'bands bronze 0.06, leather 0.2, iron 0.24, steel 1', `A dark-fantasy longsword ${UPRIGHT} a straight double-edged steel blade 95 cm long, a crossguard of blackened iron shaped like two small candle stubs, a grip wrapped in dark leather, a round bronze pommel. ${OBJECT}`, { grip: 0.12 }),
  asset('w_greataxe', 'w_greataxe · Gravedigger\'s Greataxe', 3, 1, 21, 1.6, 1500, 'none', 'bands wood 0.8, iron 1', `A gravedigger's two-handed greataxe ${UPRIGHT} a long ash-wood haft bound with iron rings, a heavy single-bitted iron head shaped like a spade blade with a hooked back spike, a chipped edge. ${OBJECT}`, { grip: 0.1 }),
  asset('w_pike', 'w_pike · Wardens\' Pike', 3, 2, 16, 2.6, 1200, 'none', 'bands iron 0.04, wood 0.86, steel 1', `A long infantry pike ${UPRIGHT} a dark wooden shaft with iron langets, a narrow leaf-shaped steel head with two small side flukes, a rust-red cloth tassel below the head, an iron butt cap. ${OBJECT}`, { grip: 0.3 }),
  asset('w_sickle', 'w_sickle · Reaping Sickle (one of the pair)', 3, 3, 22, 0.55, 1000, 'none', 'bands wood 0.35, steel 1', `A single reaping sickle ${UPRIGHT} a curved crescent steel blade about 40 cm across, a short turned wooden handle with an iron ferrule, a leather wrist loop. ${OBJECT}`, { grip: 0.12 }),
  asset('w_flail', 'w_flail · Censer Flail', 3, 4, 23, 1.3, 1800, 'none', 'bands wood 0.7, bronze 1', `A censer flail ${UPRIGHT} a long iron-shod wooden haft topped by an iron hook from which a pierced bronze incense censer hangs on a short rigid bracket, ember glow inside the openings. ${OBJECT}`, { grip: 0.1 }),
  asset('w_halberd', 'w_halberd · Hearth Halberd', 3, 5, 20, 2.3, 1500, 'none', 'bands wood 0.78, darksteel 1', `A heavy halberd ${UPRIGHT} a long iron-banded dark shaft, a broad crescent axe blade, a back hook and a long top spike, the steel blackened with soot and edged bright. ${OBJECT}`, { grip: 0.25 }),
  asset('w_crossbow', 'w_crossbow · Kilnsworn crossbow', 3, 6, 19, 0.9, 1500, 'none', 'bands wood 0.7, steel 1', `A heavy military crossbow standing upright on the end of its stock with the bow arms at the top: a dark wooden tiller, a steel bow with a taut string, an iron stirrup at the front, brass fittings, a loaded bolt. ${OBJECT}`, { grip: 0.35 }),
  asset('w_greatblade', 'w_greatblade · Halvard\'s funeral greatblade', 3, 7, 18, 2.2, 1500, 'none', 'bands gilt 0.04, leather 0.2, gilt 0.25, darksteel 1', `A colossal funeral greatblade ${UPRIGHT} a 2 m straight two-handed blade of blackened steel with gold inlay along its fuller, a wide crossguard shaped like a coffin lid, a long black leather grip, a heavy gilt pommel. ${OBJECT}`, { grip: 0.08 }),
  asset('w_cleaver', 'w_cleaver · Unfinished\'s cleaver', 3, 8, 15, 0.6, 900, 'none', 'bands wood 0.4, rust 1', `A crude butcher's cleaver ${UPRIGHT} a rusty broad rectangular iron blade about 30 cm long, a short wooden handle wrapped in rags. ${OBJECT}`, { grip: 0.12 }),
  asset('s_coffinlid', 's_coffinlid · Coffin-Lid shield', 3, 9, 3, 1.25, 1200, 'none', 'bands oak 1', `A shield made from the lid of a narrow wooden coffin, standing upright with its outer face toward the viewer: a long hexagonal dark oak lid, iron corner bands and nails, a carved candle motif in the middle, a leather arm strap at the back. ${OBJECT}`, { grip: 0.5 }),
  asset('s_tower', 's_tower · Warden tower shield', 3, 10, 17, 1.5, 1200, 'none', 'bands rustpaint 1', `A tall rectangular tower shield standing upright with its outer face toward the viewer: dark rust-red painted wood with a soot-black iron border, a flame-shaped brass boss of original design in the centre. ${OBJECT}`, { grip: 0.5 }),
  asset('p_wakestone', 'p_wakestone · Wakestone (checkpoint)', 4, 0, 4, 1.3, 2500, 'none', 'bands stone 0.72, wax 0.85, iron 1', `A waist-high stone altar for funeral vigils: a rough grey stone block crusted with thick layers of melted candle wax running down its sides, dozens of candle stubs on top, a wrought-iron candle crown rising from its centre. ${OBJECT}`),
  asset('p_cart', 'p_cart · Funeral Cart (start)', 4, 1, 6, 2.2, 3000, 'none', 'bands oak 1', `A wrecked wooden funeral cart tipped on one broken wheel, carrying an open plain coffin without its lid, black cloth draped over the side, ropes and iron fittings, dark weathered wood. ${OBJECT}`),
  asset('p_candles', 'p_candles · Candle cluster', 4, 2, 7, 0.5, 500, 'none', 'bands iron 0.12, wax 1', `A cluster of five thick church candles of different heights in a small iron dish, wax pooled and dripping over the edge. ${OBJECT}`),
  asset('p_grave', 'p_grave · Headstone', 4, 3, 8, 1.1, 600, 'none', 'bands stone 1', `A leaning old headstone of weathered grey stone with a rounded top and a worn carved candle symbol, a low mound of earth in front. ${OBJECT}`),
  asset('p_deadtree', 'p_deadtree · Dead tree', 4, 4, 9, 9, 2500, 'none', 'bands charred 1', `A gnarled dead tree about 9 m tall with a twisted trunk and bare reaching branches, bark charred black, no leaves. ${OBJECT}`),
  asset('p_rock', 'p_rock · Moor boulder', 4, 5, 10, 2.5, 1200, 'none', 'bands stone 1', `A large weathered moorland boulder with angular faces and patches of lichen. ${OBJECT}`),
  asset('p_wall', 'p_wall · Ruined wall section', 4, 6, 11, 3, 1500, 'none', 'bands stone 1', `A broken section of a rough stone cottage wall about 4 m long and 3 m high with a jagged collapsed top and one small window hole. ${OBJECT}`),
  asset('p_arch', 'p_arch · Ruined archway', 4, 7, 12, 5, 2000, 'none', 'bands stone 1', `A ruined gothic stone archway 5 m tall: two weathered pillars joined by a pointed arch with one stone missing, moss and wax drips on its ledges. ${OBJECT}`),
  asset('p_pillar', 'p_pillar · Stone pillar', 4, 8, 13, 6, 1000, 'none', 'bands stone 1', `A tall weathered stone column with a carved capital, a cracked shaft and a chipped base. ${OBJECT}`),
  asset('p_censer', 'p_censer · The Great Censer', 4, 9, 14, 3.5, 2500, 'none', 'bands bronze 1', `A colossal hanging bronze incense censer: a pierced spherical body with ornate flame-shaped openings, a domed lid with a ring on top, three chains gathered at a ring above it. ${OBJECT}`),
  asset('p_pyre', 'p_pyre · Fallen pyre', 4, 10, 24, 2, 3000, 'none', 'bands charred 1', `A collapsed funeral pyre: a low platform of charred crisscrossed timber beams, partly fallen, with ash and a few unburnt logs. ${OBJECT}`),
  asset('p_statue', 'p_statue · Mourner statue', 4, 11, 25, 3.2, 2500, 'none', 'bands stone 1', `A mourning statue: a weathered stone figure in a long hooded robe holding a candle in both hands at its chest, head bowed, on a low square plinth. ${OBJECT}`),
];

// A model's settings on the low-poly game-asset model: humanoids take the full animation set (the only one with every
// clip the game plays: fall, dive, jump, climb and shoot), beasts their one walk clip, in place; the rest no skeleton.
const modelParams = (item: PallwardAsset): MediaParams => ({
  texture: item.texture !== 'none', pbr: item.texture === 'pbr', textureQuality: 'standard', faceLimit: item.faceLimit,
  ...(item.rig ? { rig: item.rig, motion: item.rig === 'biped' ? 'full' : 'locomotion', inPlace: true } : {}),
});
const PALLWARD_MEDIA: ReadonlyArray<OfficialMediaNode> = [
  ...CONCEPTS.map((item, row): OfficialMediaNode => ({ id: item.id, kind: 'image', title: item.title, prompt: item.prompt,
    model: 'xt.seedream-5-pro', params: { aspectRatio: '1:1', resolution: '2K' }, column: 1, row })),
  ...ASSETS.map((item): OfficialMediaNode => ({ id: item.id, kind: 'model3d', title: item.title, prompt: item.prompt,
    model: 'tripo.p1', params: modelParams(item), column: item.column, row: item.row, feeds: ['assets'],
    ...(item.image ? { references: [item.image] } : {}) })),
];

// The asset table the assets builder writes its manifest from, and the art node its tints from.
const ASSET_TABLE = `Assets (priority. id: height; skeleton; grip as a fraction of the height; look):
${[...ASSETS].sort((a, b) => a.priority - b.priority).map(item => `${item.priority}. ${item.id}: ${item.height} m; ${item.rig ?? 'static'}${item.grip === undefined ? '' : `; grip ${item.grip}`}; ${item.look}`).join('\n')}`;

const SFX_NAMES = 'step.grass, step.heather, step.stone, step.mud, step.wood, step.water, cloth, roll, jump, land, swing.light, swing.heavy, hit.metal, hit.flesh, hit.wood, block, deflect, guardbreak, crit, flask, gutter, drip, wakestone, levelup, pickup, wicks, groan, growl, snap, clicks, burrow, bellow, roar, twang, crackle, ignite, chains, portcullis, veil, wind, rain, thunder, ui.move, ui.confirm, ui.back';

// The page: the twenty modules as classic scripts in init order, each in its own tag after its marker (a module that
// fails to parse cannot stop the others), then one module script that imports three.js r186, hands it over as G.lib
// and boots. The boot screen is markup, so a screenshot taken before the shaders compile is never blank.
const MODULES = ['core', 'render', 'assets', 'physics', 'terrain', 'dressing', 'castle', 'input', 'camera', 'anim', 'combat',
  'fighter', 'player', 'ai', 'bosses', 'world', 'fx', 'audio', 'hud', 'menus'] as const;
const LIB = 'THREE, GLTFLoader, SkeletonUtils, mergeGeometries, EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, OutputPass, FXAAPass, SMAAPass, Sky, SimplexNoise';
const PALLWARD_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>PALLWARD</title>
${THREE_MODULES_IMPORT_MAP}
<style>html,body{margin:0;height:100%;overflow:hidden;background:#07060a;color:#e9dfc6;font:14px Manrope,system-ui,sans-serif;touch-action:none;user-select:none}#pallward{position:fixed;inset:0}#pallward canvas{display:block;width:100%;height:100%}#boot{position:fixed;inset:0;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 30%,#3b2a4a 0%,#120c0a 70%);font:600 72px/1 Cinzel,serif;letter-spacing:.28em;color:#e9dfc6}</style>
</head>
<body>
<div id="pallward"></div><div id="boot">PALLWARD</div>
${MODULES.map(id => `<!-- module: ${id} -->\n<script>{{in:from_${id}}}</script>`).join('\n')}
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
const G = window.Pallward, boot = document.getElementById('boot');
if (!G) boot.textContent = 'PALLWARD did not load.';
else { G.lib = { ${LIB} }; G.on('ready', () => boot.remove()); G.boot(document.getElementById('pallward')); }
</script>
</body>
</html>`;

// The builders read the art and sound direction where their module draws or sounds. The assets builder reads the Tech
// spec alone: its task carries the asset table, and its prompt holds the 33 model nodes' file lists besides.
const ART_FED: ReadonlySet<string> = new Set(['render', 'terrain', 'dressing', 'castle', 'fx', 'audio', 'hud', 'menus']);
const GAME_SPEC_FED = (id: string) => id !== 'assets';
const builder = (id: (typeof MODULES)[number], title: string, duties: string, limit: number): OfficialWorkflowNode => ({
  id, title, role: 'frontend', column: 5, row: MODULES.indexOf(id), output: `${title} code`, sandbox: true,
  task: `Build the ${id} module of PALLWARD from ${GAME_SPEC_FED(id) ? 'the Game spec and the Tech spec' : 'the Tech spec'}${ART_FED.has(id) ? ' and the art and sound direction' : ''} in your inputs, the kernel contract and the API sheet below; the other nineteen modules are written at the same time by other builders who share only the specs and these two fixed texts. Where a spec and this task disagree, this task and the kernel contract win.\nYour duties (${id}):\n${duties}\n\n${PALLWARD_KERNEL}\n\n${PALLWARD_API}\n\n${pallwardRules(id, limit)}`,
  acceptance: [`Runs as pasted; defines exactly the API sheet's ${id} names and registers what its duties give it`, 'Registers its acceptance tests and planted failures by the Tech spec\'s numbers'],
});

const BUILDERS: ReadonlyArray<OfficialWorkflowNode> = [
  builder('core', 'Kernel', `- window.Pallward and every kernel name: the event bus; systems sorted by order and G.onRender; the loop: requestAnimationFrame with real elapsed time feeds an accumulator of 1/60 s steps (at most 5 a frame, the rest dropped), G.timeScale scales the simulated dt, G.loop.step(n) runs n steps synchronously and renders nothing, G.loop.paused stops the steps.
- The mulberry32 G.rng and G.SEED; entities; G.interact; G.flow; G.ui.root and its six layers; the command registry; save providers; reset hooks and G.newGame.
- The test runner: core's init calls G.tests.expect with the Tech spec's table of tests 1-60 and their owners; each test is named "T<n> <owner>: <name>" and capped at 2,000 ms; each plant runs only against its catches; a number nobody registered is reported as the failed test "T<n> <owner>: not registered (did the <owner> module load?)"; before the run snapshot the game, after it reset with false, restore the snapshot, then the flow. window.awwoSelfTest is set as core's script runs.
- G.boot wraps each init (a throw is caught, logged and toasted), emits ready and sets flow 'title'.
- Commands: game.pause (Escape), test.run (F10: opens menus 'selftest'), debug.fps (F3).
- Tests 1-3; plant P01 (the fixed step uses dt = 1/30, caught by 2).
- Must not touch rendering or three.js at load.`, 16000),
  builder('render', 'Renderer, sky and materials', `- Renderer: a WebGLRenderer in the boot root with sRGB output, ACESFilmic tone mapping, PCF soft shadows and the pixel ratio by quality (B6).
- Two scenes: main, with FogExp2 by B3; sky, with the Sky addon (turbidity 8, rayleigh 2.2, mie 0.008, mieG 0.86), stars, a moon sprite and a far mountain ring. G.render.cam: FOV 58, near 0.15, far 1,200; a sky camera copies it each frame with near 10, far 9,000.
- Composer (B6): RenderPass (sky), RenderPass (main, clear false, clearDepth true), UnrealBloomPass at half resolution, a grade ShaderPass (vignette, split tone, grain 0.035, contrast 1.06), OutputPass, then FXAAPass (Medium) or SMAAPass (High); resize with the window; quality presets; dynamic resolution.
- Time and weather (B3): interpolate the keys; drive the sun and moon DirectionalLight, whose 90 m texel-snapped shadow box follows G.player.e, the hemisphere light and the pyre light from the north; exposure by the keys; scene.environment rebuilt with PMREMGenerator.fromScene(sky) every 30 s and on weather changes; weather particles round the camera; lightning; system 'clock' (order 85) advances 1 game hour per 60 s in play.
- G.render.mat: the shared materials stone, charred, wax, iron, gilt, bronze, leather, cloth, mud, bark, rootbark, oak, steel, darksteel, rust, rustpaint and wood from the art direction's recipes, with triplanar noise through onBeforeCompile on canvas textures and ember-crack emissive masks; bands(geometry, bands) splits a geometry into groups by normalised height, each with its material (bands = [[up to fraction, material name], …]).
- suspend(bool); info() with autoReset off across one composer frame; passes() lists the pass class names (test 7).
- Tests 7-9; plant P05 (fog density ignores the weather, caught by 8).
- Must not touch entities or the interface.`, 22000),
  builder('assets', 'Asset manifest and stand-ins', `- Inputs: one input per 3D model node, its label starting with the asset id and " · " (map each input to its id by that prefix). It lists the node's files by path, <node id>/model-1.glb, model-2.glb and model-3.glb, each with its byte count and its clip names (a later file holds clips only, for model-1.glb's skeleton), or says no file was made.
- Manifest: the 33 assets in the priority order of the table below. Each path is one whole single-quoted string literal copied exactly from the inputs, never built from pieces. Keep a running total of the byte counts the inputs give and write an asset's paths only while all of its files fit within 24,641,536 bytes; an asset that does not fit, or has no file, gets paths [] and omitted true, and the next one is still tried. meta(id) carries the table's height, skeleton, grip and look, its clips by file, its paths, bytes and priority.
- load(id): 1. GLTFLoader.loadAsync of model-1.glb, then of each clips-only file, every clip merged by its name, lower-cased with any prefix up to a ':' or '|' dropped (idle, walk, run, slash, hurt, dive, climb, jump, fall, turn, shoot; a quadruped's or hexapod's walk). 2. Normalize: scale by the bounding-box Y extent to the height, rotate −π/2 about Y (the files face +X), feet at y 0, cast and receive shadows. 3. An untextured model gets G.render.bands with its bands or G.render.mat of its recipe; a textured one without PBR gets roughness 0.75 and metalness 0.15. 4. Cache it. 5. Any failure, or 12 s without a result, resolves to the stand-in; no rejection is ever left unhandled.
- Stand-ins, procedural, with the same contract: a humanoid is a SkinnedMesh of capsules rigidly weighted to a skeleton with the rig's bone names (BoneRoot, Hip, Pelvis, Waist, Spine01, Spine02, NeckTwist01, Head; L_ and R_ Clavicle, Upperarm, Forearm, Hand, Index1, Mid1, Pinky1, Thigh, Calf, Foot) and synthetic clips idle, walk, run, slash, hurt, dive, climb, jump, fall, turn and shoot that reproduce the B5 timings (slash 6.60 with its strike at 2.10; shoot 2.40 with its release at 1.30); a quadruped or hexapod is an Object3D with legs named leg_*, a head and a walk clip; a weapon or prop is boxes, cylinders and lathes at its height with its bands.
- instance(id) clones with SkeletonUtils.clone (geometry shared); clips(id); ready settles when every asset has settled or after 15 s; report().
- Tests 4-6; plant P02 (instance() returns the template itself, caught by 6).
- Must not touch the scene or animations.
${ASSET_TABLE}`, 22000),
  builder('physics', 'Collision and bodies', `- Capsule bodies on entities (r, h), stepped in system 50: gravity 18; velocity from e.vel; collisions against an 8 m spatial hash of yawed boxes, cylinders and ramps; step-up 0.45 m; slopes over 45° slide; ground snap through ground() = the highest walkable top (terrain, floors, ramps, platforms) at or below y + 0.45; platforms carry bodies; bodies push apart as circles, bosses immovable; fall height tracked and reported to G.combat.fallDamage; lastSafe = solid ground held for at least 1 s; movement clamped to |x|, |z| ≤ 395.
- Triggers; ray() (a terrain march plus the colliders); sweep() (a capsule against the bodies' capsules, the earliest t first); arena(on): flat ground at y 0 with walls at ±32 m and the real colliders parked.
- Tests 19-21; plant P07 (gravity 9.8, caught by 19).`, 18000),
  builder('terrain', 'Terrain and water', `- The B1 recipe exactly, in order, with SimplexNoise seeded from G.rng(G.SEED). The 513 × 513 Float32Array heightmap is computed in init, sliced when it takes over 50 ms; height() interpolates each cell's two triangles; beyond 400 m the edge rise is computed analytically. normal, surface, water depth and road distance.
- 64 chunks with LOD0, LOD1 and LOD2 and 2 m skirts; LOD0 built on demand, at most 2 chunks a frame; a far ring of mountains.
- Ground material: a vertex-colour splat by surface (grass, heather, mud, road, stone, ash, in the art colours) blended with the triplanar stone on slopes. Lake and river surfaces share one custom shader (depth tint, fresnel to the environment, noise normals), with no extra render pass.
- flat: height 0 everywhere, for tests.
- Tests 10-12; plant P06 (roads not flattened, half-width 0, caught by 11).`, 20000),
  builder('dressing', 'Landmarks and scatter', `- The Everpyre: p_everpyre in G.render.sky at (0, 0, −2600), 900 m tall, fog off; bark with amber sap seams below 55 % of its height and a crown-fire shader above (animated emissive noise), an ember column of Points, smoke sprites and a glow sprite.
- Six wakestones from p_wakestone, p_candles and flames, each a 'rest' interaction (radius 2.5) that calls G.world.rest; the Funeral Cart (p_cart) with the lid prop at the start.
- The B1 places: Tallowby (cottages of p_wall, a chapel with a p_arch door, graves), Gibbet Watch (a tower with 3 ramps, its colliders and the K3 point), the Pyrefield (p_pyre and candle racks), Cinder Copse, the Drowned Spire, Rootfall (procedural tube roots), the Hanged Oak and its cages, the Cairn.
- Scatter by InstancedMesh with masks and seeded placement: 260 trees of p_deadtree (impostors beyond 120 m), 180 rocks of p_rock, 300 graves of p_grave, each with candles and flames shown within 60 m; grass cards in a 60 m ring that re-centres every 10 m, and heather; colliders for trees, rocks and walls.
- update(camPos) runs as system 84.
- Tests 13-15.`, 20000),
  builder('castle', 'Kilnhold', `- The B2 table as meshes merged per material, with merlons, dark window insets and up to 4 brazier point lights; a collider for every wall, floor, ramp, tower and stair; the Breach's mantle ledge in G.castle.ledges.
- Gate: the portcullis stays shut until the flag 'winch'; the winch lever is an interaction. Coffin Lift: a physics platform moving at 2 m/s, locked until its lever is pulled, then call interactions at 30 and 44.
- The Keep: its door, the Great Hall pillars (p_pillar) and statues (p_statue), the chapel altar; the Kiln Bridge; the Ember Veil, a shader plane whose interaction passes the player through in 1,200 ms, seal(bool) closing and opening the way back; the Heart Kiln: arches, a glowing kiln mouth, p_censer hung at y 58 that can drop, fireRing(on).
- Area triggers for Kilnhold and the Heart Kiln; system 82 runs the lift and the shader time.
- Tests 16-18.`, 22000),
  builder('input', 'Controls and autoplay', `- Devices: the keyboard by event.code; the mouse, requesting pointer lock on a canvas click, with the A2 fallbacks; the standard gamepad polled each step (dead zone 0.18); touch, a stick and buttons in the 'touch' layer, shown on a coarse pointer or after a touch.
- The A2 action map; pressed, held and released tracked per step; the 300 ms buffer (buffered() reports a buffered action, consume() spends it); look input accumulated for the camera; virtual() injects actions for touch and autoplay.
- autoplay.run(steps) runs in simulated time, so it works inside G.loop.step; step forms { hold: { move: [x, y] }, ms }, { press: a }, { wait: ms }, { look: [dx, dy] }. scripts.smoke is the self-test's journey: walk, attack, roll, rest; scripts.tour is the cover recording, from the cart along R1 to Tallowby, a fight, then a rest, started from the title by the command debug.autoplay (F8).
- The first gesture calls G.audio.unlock(); commands dispatch by their keys field, never while an input field has focus.
- Tests 22-24; plant P08 (a 600 ms buffer window, caught by 23).`, 14000),
  builder('camera', 'Camera and lock-on', `- Drives G.render.cam as the A3 third-person orbit; collision by 5 physics.ray rays approximating the 0.25 m sphere.
- Lock-on: candidates from G.ent.near, line of sight by ray, the A3 score, switch(dir), breaking the lock; reticle() gives screen coordinates for the HUD; shake(); cine() for the wake cutscene, the boss intros and the title tour.
- System 90.
- Tests 25-27; plant P09 (lock-on scored by angle only, caught by 25).`, 12000),
  builder('anim', 'Rigs and animation', `- create(e, assetId): the instance from G.assets.instance with an AnimationMixer; bones found by the rig's names (Hip, Spine02, Head, R_Hand, L_Hand, R_Index1, R_Pinky1, L_Forearm and the rest) with case-insensitive regex fallbacks. The clips come from G.assets.clips(assetId) by their lower-case names: a humanoid's idle, walk, run, slash and hurt (from model-1.glb), dive, climb, jump, fall and turn (model-2.glb) and shoot (model-3.glb), the later files' clips bound to model-1.glb's skeleton by bone name; a quadruped's or hexapod's walk. A stand-in has the same names. hurt (a seated loop) and turn stay unused.
- Root motion stripped as B5 says; measure() runs for every clip, sampling at 30 fps through the rig; subclips cut with AnimationUtils.subclip: swings A, B and C from slash, the roll from dive, the hop from jump, the mantle from climb, death and knockdown from fall; the arbalist's aim and release from shoot.
- play(rig, action, { s, a, r }): the two-rate warp (the timeScale set before and after the strike so it lands at s + a/2), reporting phase 'startup', 'active' or 'recovery'. loco(): idle below 0.1 m/s, then walk and run blended by speed with 150 ms crossfades.
- Procedural layers after the mixer: spine twist, left-arm guard, flask arm, stagger recoil (120 ms in, 600 ms ease out), deflected lean, kneel, look-at, breathing. attach(): the finger-bone grip frame (B5); tip(): the weapon tip's world position; pose(): root and head and neck motion for non-humanoids; animation LOD as B5; setTint() for armour tints.
- System 70.
- Tests 28-30; plants P03 (one uniform rate over the whole swing window, caught by 29) and P04 (the weapon attached to L_Hand, caught by 30).`, 22000),
  builder('combat', 'Combat rules and data', `- The A4-A6 data and formulas: weapon(id) (every move's frames, MV, poise, anim, lunge and stamina), armor(), shield(), derive(), ar() with f and LETTERS, damage() (counters, criticals, fire, absorption, def, the crawler's front and rear).
- hit() resolves in this order: i-frames, deflect (the window from G.fighter), guard (stamina, guard break), damage and poise, stagger or knockdown, burning; then it calls G.fx.hitstop, G.fx.burst and G.audio.sfx and emits hit and death.
- kill() grants wicks through G.world.give('wicks', n) and spawns the wick thread fx; fallDamage().
- System 60: burning ticks, and the weapon sweep of every active attack (a capsule from the grip to G.anim.tip, once per target per move instance).
- Tests 31-33; plants P10 (letter C = 0.35, caught by 31) and P11 (absorption applied twice, caught by 32).`, 16000),
  builder('fighter', 'Fighter actions', `- One state machine for the player, humanoid foes and Halvard's reactions: idle, move, sprint; attacks L1-L4, H, HC (charge), R, Ro, J and the art; roll, backstep, jump; guard and the deflect window; stagger, guard break, deflected, knockdown; critical (riposte and backstab); flask, item, mantle, dead.
- Frames from G.combat.weapon; cancel points and the buffer (G.input.buffered) for the player, while foes command directly; stamina (A4) delays and regen, focus, poise refill; the roll chosen by the load ratio with i-frames by the roll table; the flask's timings (A4); lunges and roll distances applied through e.vel; riposte and backstab geometry. It calls G.anim.play and G.combat.hit.
- System 40.
- Tests 34-36; plants P12 (i-frames over the whole roll, caught by 34) and P13 (a 300 ms deflect window, caught by 35).`, 22000),
  builder('player', 'The Bearer', `- spawn(): the entity, m_bearer's rig and the fighter with the start kit (longsword, Coffin-Lid, Shroud, 4 flasks); camera-relative movement from G.input at the A3 speeds, with the turn rate and lock-on strafing; actions mapped to fighter commands.
- G.interact.near drives the prompt (G.hud.prompt) and runs on interact; mantle ledges.
- Death: flow 'dead'; the Guttering Candle entity takes all wicks at the death spot or at physics.lastSafe, replacing any old candle; at 4,600 ms the player respawns at the last lit wakestone with the rest effects. Reclaim within 1.5 m, with its banner. The 6 s wake cutscene at New Journey. reset(true) spawns the player at the arena origin.
- System 20.
- Tests 37-39; plant P14 (death keeps the wicks, no candle, caught by 38).`, 16000),
  builder('ai', 'Foes', `- def(type) from A8; spawn(): the entity, rig and fighter with weapons attached (unfinished w_cleaver; warden w_pike and s_tower; arbalist w_crossbow; hearth w_halberd).
- The A8 machine: perception (sight cone, line of sight, hearing), at most 2 attack tokens, circling, a weighted move choice with cooldowns, leash and return, playdead. Per type: warden guard stance and punishing flask use; arbalist kiting, bolts as projectiles with a telegraph; hound pack slots, howl, hit-and-run, a procedural lunge; crawler burrow, cracks, emerge, sap spit; hearth kiln burst.
- dummy(pos, opts): a test dummy; with opts.strike it delivers a given move to the player at a given step.
- Simulation LOD: think within 80 m, freeze beyond, hide beyond 140 m; respawnAll(): every foe except the non-respawning ones and the bosses.
- System 30.
- Tests 40-42.`, 22000),
  builder('bosses', 'Bosses', `- def(id) from the A9 tables; a move runner: windup → telegraph event → active hitboxes (sweep cones, rings, waves, charges, leaps) → recovery, chosen by distance and angle with weights and no immediate repeats.
- Candlehart: procedural motion (its walk clip at the walk rate, then root pitch, yaw and roll for rears, sweeps and kicks), a phase 2 crown fire through fx, a 90 m leash (it returns, heals and the bar hides).
- Halvard: start() on entering the Heart Kiln (seal the Veil, show the bar, play boss1), the intro as a camera cine; phase 2 at ≤ 50 % (an invulnerable transition, the censer drop, castle.fireRing(true)); posture breaks; w_greatblade in his hand.
- Death: LAID TO REST; the Veil opens; the Heartwick pickup leads to the slice end and then the credits.
- System 32.
- Tests 43-45; plant P15 (phase 2 at 40 %, caught by 43).`, 22000),
  builder('world', 'World state and progression', `- G.world.state with a save provider; item names and descriptions for A7 and the weapons and armour; give, take and equip (a toast warns when a requirement is not met).
- rest(id): lights the stone on first use (WAKESTONE LIT), heals, refills flasks and focus, calls G.ai.respawnAll, sets last, emits rest and opens menus 'wakestone'; travel(): fade, teleport, the rest effects; levelCost and levelUp (A5); flags winch, liftReleased and the bosses; spawns from the B1 table on reset(false); pickups from the B1 K list as 'take' interactions; area banners on entry; the slice end.
- System 80.
- Tests 46-48; plant P16 (the level cost uses level + 1, caught by 47).`, 18000),
  builder('fx', 'Effects and hit feel', `- Pooled particles, at most 512 alive: sparks, embers, ash puffs, pale wax spatter (never blood), dust, fire; a weapon trail ribbon in active frames only; hit flashes and hitstop(ms) (G.timeScale 0.05 for ceil(ms/16.7) unscaled steps); rings, fire waves and cones; telegraph cues per kind (glint, glow, ground cracks, gathering flames).
- Candle flames as shared sprites (6-10 Hz flicker); the Guttering Candle look (cluster, flame, light pillar); Veil particles, heal glow, wick threads, ember deaths for non-humanoids, screen flash; stats().
- System 92.
- Tests 49-51.`, 16000),
  builder('audio', 'Music and sound', `- The AudioContext created only in unlock(), on the first gesture; master, music and SFX buses at the settings' volumes; reverb from generated impulses (moor 1.6 s, castle 3.2 s), switched by area.
- The procedural score of the sound direction's motifs in the B4 states: a 25 ms scheduler tick, notes at most 0.25 s ahead, 1.5 s crossfades; combat while a foe is engaged, the boss states from bosses, night by the hour.
- Every B4 SFX name synthesized from the sound recipes; a StereoPanner set by the angle to the camera, and gain 1/(1 + d/8).
- System 94.
- Tests 52-54.`, 18000),
  builder('hud', 'HUD', `- The 'hud', 'toast' and 'banner' layers: the B4 bars with their widths and lag segments, the equipment cross, the wick counter, the lock mark from G.camera.reticle(), the boss bar, the prompt, the toast queue, area banners on 'area', the death sequence with its exact timing, the LAID TO REST, WAKESTONE LIT and WICKS RECLAIMED banners on their events, and the FPS counter.
- Shown only in play, dead and cutscene; drawn in G.onRender.
- Tests 55-57.`, 14000),
  builder('menus', 'Menus and screens', `- The 'menu' layer. The title: New Journey (G.newGame() and the wake cutscene), Continue from the in-memory snapshot, Settings, Credits; the idle tour by camera.cine; the load bar from G.assets.ready.
- Pause; equipment, inventory and status; wakestone; level-up (G.world.levelUp); the map (a canvas relief; travel); settings (applied to input, audio and render); credits; the self-test screen ('selftest': runs G.tests.run() and lists every test and plant, green or red, with the counts); the slice end.
- Navigation by keyboard and gamepad through the menu.* commands, and by touch; drawn in G.onRender.
- Tests 58-60.`, 22000),
];

const PALLWARD: OfficialWorkflow = {
  id: 'pallward',
  title: 'PALLWARD open-world action RPG',
  stack: 'r186',
  fonts: true,
  brief: 'Build PALLWARD, an original open-world action RPG slice in one web page: the Bearer, last of the Pallward, wakes in a coffin on the Corpse Road and crosses Candlemoor, an 800 × 800 m moor of candle-lit graves under the burning Everpyre, to take back the Heartwick from the castle Kilnhold. Third-person combat with stamina, poise, deflects, rolls with i-frames and six weapons with combos and arts; six foe types, a field boss (the Candlehart) and a two-phase castle boss (Halvard); wakestones, wicks dropped where you die, levelling; day and night and three weathers; keyboard and mouse, gamepad and touch; a title, menus, a map and credits. It renders live with three.js r186 on real rigged and animated 3D models the canvas makes from its own concept paintings, with procedural stand-ins for any model not made, and its music and sound are synthesized in code. Twenty builders write it against one fixed kernel contract, and it tests itself: sixty acceptance tests and sixteen planted failures run inside the page in a headless browser, and what fails is fixed. Every name, place and word is original.',
  nodes: [
    { id: 'spec', title: 'Game spec', role: 'general', column: 0, row: 0, output: 'Game spec', sandbox: true,
      task: `You are the design room of a clean-room original game, PALLWARD, an open-world action RPG slice; name no other game, studio or product anywhere. Write Part A of its design document, the Game spec that twenty module builders implement in parallel, from the world below and the template after it.\n\n${PALLWARD_WORLD}\n\nThe template:\n${PALLWARD_GAME_SPEC}\nEnd of the template.\n\nWrite Part A exactly in the template's order and terms: A1 scope, A2 controls, A3 movement and camera, A4 combat rules, A5 stats, A6 weapons, A7 items and death, A8 foes, A9 bosses, A10 flow. Keep every number of the template unless it contradicts another; if you change one, list it in a final line 'Changes:' (write 'Changes: none' when there is none). Compact tables and lists, at most ${chars(GAME_SPEC_LIMIT)} characters in all, with no paragraph the template does not have. Keep your private reasoning short: the design is settled, and the work is the writing. You work in the sandbox computer, but your answer is a message, not a file: write nothing to the workspace and reply with the whole Game spec as your final message.`,
      acceptance: ['Every section of Part A in the template\'s order, with its numbers', 'Every changed number is listed on the Changes line'] },
    { id: 'tech', title: 'Tech spec', role: 'general', column: 0, row: 1, output: 'Tech spec', sandbox: true,
      task: `Write Part B of PALLWARD's design document, the Tech spec, from the template below, reading the Game spec in your inputs: B1 map, B2 Kilnhold, B3 time and weather, B4 interface and sound list, B5 animation map, B6 performance budget, B7 acceptance tests 1-60 (each with its owner), B8 planted failures P01-P16 (each with its owner and the tests that catch it), B9 unknowns. Keep the template's order, owners and numbers. Every test has given / when / then numbers that follow from Part A's formulas: where the Game spec's Changes line changed a number, recompute every test it touches and list them in a final line 'Changes:' (write 'Changes: none' when there is none). Keep B5's file and clip names exactly: they are the files the 3D model nodes hand over. Name no other game, studio or product.\n\nThe template:\n${PALLWARD_TECH_SPEC}\nEnd of the template.\n\nCompact tables and lists, at most ${chars(TECH_SPEC_LIMIT)} characters in all. Keep your private reasoning short: the design is settled, and the work is the writing. You work in the sandbox computer, but your answer is a message, not a file: write nothing to the workspace and reply with the whole Tech spec as your final message.`,
      acceptance: ['Every section of Part B in the template\'s order; tests 1-60 and plants P01-P16 each with its owner', 'Every test\'s numbers follow from the Game spec'] },
    { id: 'art', title: 'Art and sound direction', role: 'general', column: 0, row: 2, output: 'Art and sound direction', sandbox: true,
      task: `Write PALLWARD's art and sound direction, which the visual and sound builders use as is, from the direction below and the places and cast in the Game spec in your inputs. Original wording only; name no other game, studio or product. Write these sections as compact tables and lists:\n1. Palette tokens (hex).\n2. A recipe for every G.render.mat name, stone, charred, wax, iron, gilt, bronze, leather, cloth, mud, bark, rootbark, oak, steel, darksteel, rust, rustpaint and wood: colour, roughness, metalness, emissive, triplanar scale, noise.\n3. The sky (the Sky addon's turbidity, rayleigh, mie and mieG), the fog and the grade.\n4. Per place, its materials and dressing colours.\n5. Per asset of the table below, its tints and bands.\n6. The Everpyre fire, the candle flame and the Ember Veil looks.\n7. Interface tokens: the fonts Cinzel, Manrope and Instrument Serif, the colours, the panel style.\n8. Sound: the score motifs with their keys, tempos and voices for each music state (title, explore, night, combat, stag, boss1, boss2, rest, death, victory), and a synthesis recipe for every SFX name: ${SFX_NAMES}.\nAt most ${chars(ART_LIMIT)} characters in all. You work in the sandbox computer, but your answer is a message, not a file: write nothing to the workspace and reply with the whole direction as your final message.\n\n${PALLWARD_DIRECTION}\n\n${ASSET_TABLE}`,
      acceptance: ['A recipe for every material name and every SFX name', 'Original wording, within the direction'] },
    ...BUILDERS,
    { id: 'page', title: 'Assembly', role: 'frontend', column: 6, row: 0, output: 'Assembled PALLWARD page',
      task: 'Puts the twenty modules into one page, byte for byte and in init order, with no model: core, render, assets, physics, terrain, dressing, castle, input, camera, anim, combat, fighter, player, ai, bosses, world, fx, audio, hud, menus, each in its own script tag after its marker (a module that fails cannot stop the others), then one module script that imports three.js r186, hands it to the kernel as G.lib and boots the game.',
      acceptance: ['A complete HTML document that boots PALLWARD'],
      assemble: { template: PALLWARD_PAGE, fileOnly: true, fileName: 'pallward.html' } },
    { id: 'test', title: 'Test and fix', role: 'frontend', column: 7, row: 0, sandbox: true, output: 'PALLWARD', outputType: 'html', report: 'Test report',
      task: 'You are PALLWARD\'s integration tester, working in the sandbox computer. Your inputs give you the assembled page as a file in /inputs (pallward.html, about 380 KB: twenty modules in their own script tags, each after a line <!-- module: name -->) and the two specs as text. The 3D models are not in this computer: every model loads its stand-in, which is expected and is not a failure.\n1. Copy the page into the workspace (cp /inputs/*pallward.html pallward.html) and run: awwo-check-page pallward.html --out check --timeout-ms 60000 --budget-ms 100000 (a headless browser with every request blocked; it takes a screenshot after 1.5 s, then runs window.awwoSelfTest() and writes check/report.json; a command may run 120 s).\n2. Read check/report.json with one short python3 script: page errors (message, line), the self-test\'s results (each name starts "T<n> <owner>:"), the planted failures caught, the blank-page flag and the timings. Never print the page; find code with grep -n (the module markers, the names) and read it with sed -n, at most 40 lines at a time.\n3. Publish the page as checked at once (workspace_publish with field "result" and path "pallward.html"), then write report.md and publish it (field "report", path "report.md").\n4. Fix in this order: page errors first (a syntax error silences a whole module), then tests reported "not registered", then failing tests by number, then plants not caught. Fix each at its cause, in its owner\'s module, with small exact-string edits (python3); a name that is missing or misnamed is fixed in the module the API sheet gives it to. Never weaken, delete or skip a test or a plant, never change an expected value, and never touch G.tests, window.awwoSelfTest, the page\'s script tags or a <node id>/model-N.glb path.\n5. Run the check again after each round of fixes, at most 4 rounds, keeping 6 steps for the end; after a better check publish the page and report.md again.\n6. The report: the first and the last check\'s numbers (tests passed of total, plants caught of total, page errors, blank or not, self-test ms), every fix on one line (module: what was wrong → what changed), and what still fails. State only what the checks showed.\n7. End with {"result": "", "report": ""} (the host fills in the published files). The last page and report you publish are what you deliver. This run ends after 25 minutes and about 60 model calls.',
      acceptance: ['The page delivered is the one the last check ran on', 'The report gives the first and last check\'s numbers exactly, every failing test and every fix made'] },
    { id: 'review', title: 'Review', role: 'review', column: 8, row: 0, output: 'Review record', sandbox: true,
      task: 'Read the test report against the Tech spec and the Game spec. Report which acceptance tests pass and fail, by number and owner; which planted failures were caught; what the fixes changed; which parts of the specs no test covers; and what the report shows about the assets (stand-ins in the sandbox, real models only in the live preview). This is a static review: say "not actually run" for anything the report does not show, and claim nothing beyond it; at most 350 words.',
      acceptance: ['Static review and actual execution are kept strictly apart'] },
  ],
  edges: [
    { from: 'spec', to: 'tech', label: 'Game spec' },
    { from: 'spec', to: 'art', label: 'Places and cast' },
    ...BUILDERS.filter(node => GAME_SPEC_FED(node.id)).map(node => ({ from: 'spec', to: node.id, label: 'Game spec' })),
    ...BUILDERS.map(node => ({ from: 'tech', to: node.id, label: 'Tech spec' })),
    ...BUILDERS.filter(node => ART_FED.has(node.id)).map(node => ({ from: 'art', to: node.id, label: 'Art and sound direction' })),
    ...BUILDERS.map(node => ({ from: node.id, to: 'page', label: node.output })),
    { from: 'page', to: 'test', label: 'Assembled page', port: 'file' as const },
    { from: 'spec', to: 'test', label: 'Game spec' },
    { from: 'tech', to: 'test', label: 'Tech spec' },
    { from: 'test', to: 'review', label: 'Test report', port: 'report' as const },
    { from: 'spec', to: 'review', label: 'Game spec' },
    { from: 'tech', to: 'review', label: 'Tech spec' },
  ],
  media: PALLWARD_MEDIA,
};

/** Keyed by case id, like PRODUCTION_WORKFLOWS and FLAGSHIP_WORKFLOWS. */
export const EPIC_WORKFLOWS: Readonly<Record<string, OfficialWorkflow>> = Object.fromEntries([PALLWARD].map(item => [item.id, item]));
