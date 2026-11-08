---
name: film-sound
title: Film sound: score, effects and one room for a film made in code
title_zh: 影片声音：代码影片的配乐、音效与空间
description: Use when a film, animation, ad or music video made in code needs its own sound, made by the page itself (AwwO's film kit, or a page's renderAudio): a genre card with tempo, groove, bass, harmony and lead; effects locked to the picture within an accent budget; one shared room; levels for the mix AwwO's edit node makes.
description_zh: 用代码做的影片、动画、广告或音乐视频需要由页面自己发声时使用（AwwO 影片组件，或页面的 renderAudio）：选一张曲风卡（速度、律动、贝斯、和声、主奏），音效与画面同帧且控制数量，全片共用一个空间混响，以及为 AwwO 剪辑节点混音准备的电平。
category: video
applies: video,motion,html,plan
version: 1
attribution: Adapted from cinecode (MIT, Copyright (c) 2026 Sarp Yıldız); modified for AwwO
---
# Film sound

You write the sound in code and cannot hear it: describe what each moment sounds like from the code, never that you listened, and end by asking the member to listen on headphones and a phone speaker at the seconds that matter.

## 1. The sound line
Decide it on the plan with the picture: genre card, BPM, key or mode, progression, groove, bass, lead and the arc (where it lifts, where it drops out, the last chord on the last frame). One piece for the whole film, following its sections; it never restarts per scene. Beats on whole frames: 80, 90, 96, 120 or 144 BPM at 24 fps; 90, 100, 112.5 or 120 at 30 fps.

## 2. Genre cards (a start; the film bends them)
| Genre | BPM | Groove (16 steps) | Bass | Harmony | Lead | Fits |
|---|---|---|---|---|---|---|
| Ambient | 60-90 | none, or `x.......x.......` | one held note | one chord, i-VI | pads, sparse plucks | night, mystery |
| Anthem | 84-100 | `X...x.x.X...x...`, snare rolls into peaks | roots in eighths | I-V-vi-IV, i-VI-III-VII | bright lead, stabs, pad | sport, victory |
| Piano | 60-80 | none | the left hand | I-V-vi-IV open | plucked arpeggios | memory, quiet |
| Lo-fi | 70-92 | kick `X......x..X.....`, snare 4 and 12, swing 0.2 | soft sub | m7, m9 | plucks, dusty pad | everyday warmth |
| House | 118-126 | four on the floor, clap 4 and 12, open hat off-beats | octaves | m7 stabs | stabs, pads | launches, upbeat ads |
| Synthwave | 84-110 | snare 4 and 12, hats in eighths | saw bass in sixteenths | i-VI-III-VII | saw lead, wide pad | retro tech, night |
| Trap | 130-150, half-time | hats in sixteenths with rolls, clap on 8 | sub808 with glides | i-VI, Phrygian | bell-like plucks, dark pad | bold launches, games |
| Playful | 110-140 | claps, ticks | bouncy plucked bass | I-IV-V | high plucks | kids, toys, comedy |

Swing delays the off sixteenths; shuffle and jazz swing the eighths, written in 12 steps a bar. Two cards may be mixed when the plan says so.

## 3. Effects on the picture
- A sound peaks on its contact frame; a whoosh 2-3 frames before the cut it carries. Cut on the music's accents, or accent the cuts.
- Budget: 2 whooshes and 1 riser per 30 s, about 5 full impacts a film, designed sound on at most 70 % of cuts. Interface ticks sit 10-15 dB under the music's peaks.
- An impact is layered: a low body under 90 Hz, a crack, a short tail in the room, the music ducking for it. Foley for the contacts the picture shows, each on its frame.

## 4. Beds, room and levels
- One bed per place at a low level, carried across cuts over 0.8 s. Silence is never digital zero: a stop-down drops the music 0.3-1.5 s before the peak it sets up and keeps the room tone.
- One room for every sound (a 1.5-2.5 s decay): effects send 0.2-0.35, music less, a voice almost none.
- A voice-over sits 8-10 dB over everything while it speaks; hits 6-8 dB over the loudest bed; leads low-passed at 2-3 kHz with attacks of 20 ms or more, which a phone speaker forgives.
- AwwO's edit node normalises the film (default -16 LUFS, true peak -1 dB) and ducks music under dialogue; a sound page peaks at -1 dBFS or lower (the film kit keeps it there).

## 5. In AwwO
- A page's sound reaches a film as one audio item of AwwO's edit node, { page, seconds }, made once from 0 for the whole film; the picture is the same page in cards of at most 20 s.
- With the film kit: effects as `sfx` rows, beds as each scene's `amb`, music in `score(ctx, out)` over the `arrangement`, the room as `room`. Without it: `window.renderAudio({ seconds, sampleRate })` returns an AudioBuffer of exactly that length from an OfflineAudioContext, from oscillators and seeded noise, with no timers and no audio files.

