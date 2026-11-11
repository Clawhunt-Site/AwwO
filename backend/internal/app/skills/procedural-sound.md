---
name: procedural-sound
title: Sound made in code for games and interactive pages
title_zh: 代码合成的声音：用于游戏与交互页面
description: Use when a game, simulation or interactive scene needs sound and no audio file may be loaded: a Web Audio graph with buses and a limiter, started by the first gesture; a pool of short voices with click-free envelopes; recipes for impacts, plucks, whooshes, engines, wind, rain, sea, water, interface ticks and creature calls; placing sounds in space and one generated room; music that follows the play from a scheduler; tying sound to the simulation; levels; and tests on rendered samples. For a film's score and effects use film-sound.
description_zh: 游戏、模拟或交互场景需要声音且不能加载任何音频文件时使用：带分组总线和限幅的 Web Audio 图，由第一次手势启动；带无爆音包络的短音色池；撞击、拨弦、呼啸、引擎、风、雨、海、水滴、界面提示音和生物叫声的合成配方；空间定位与一个生成的混响空间；由调度器驱动、跟随玩法变化的音乐；让声音跟随模拟数据；电平；以及对离线渲染采样做的测试。影片的配乐与音效请用 film-sound。
category: engineering
applies: html,code,motion
version: 1
attribution:
---
# Sound made in code

Every sound here is built from oscillators, noise and filters at the moment it is needed, so it can follow the simulation: louder for a harder hit, lower for a larger body. You cannot hear the result: describe what the code makes, and ask the member to listen at the moments that matter.

## The graph

- One AudioContext, created or resumed inside the first pointer or key event; until then show a small "sound off" chip. Suspend it when the tab is hidden.
- Three buses as GainNodes (effects, ambience, music) into a master gain, then a DynamicsCompressorNode as a safety limiter (threshold about -14 dB, ratio 4), then the destination. A mute control and one volume act on the master.
- Timing comes from `context.currentTime`, never from timers: schedule a sound a few milliseconds ahead and its parts relative to that start.

## Voices

- A sound is a function `(time, options)` that builds a few short-lived nodes, connects them to a bus and stops them. Cap the voices alive at 24 to 32 and drop the quietest new one beyond that.
- Every gain is shaped: rise in at least 2 ms, fall in at least 20 ms (`setTargetAtTime` or an exponential ramp to 0.0001, never a jump to 0), or it clicks.
- Never the same sound twice: vary pitch by 3 to 6 % and level by 1 to 2 dB from a seeded generator, and refuse a repeat of one kind within 40 ms.
- Make one two-second buffer of white noise at start and reuse it everywhere; brown noise is its running sum, leaked a little.

## Recipes

| Sound | How |
|---|---|
| impact | a sine falling from 120 to 45 Hz in 80 ms, plus a 30 ms noise burst through a band-pass at 1 to 4 kHz; for a ringing body add two or three detuned sines decaying over 150 to 400 ms |
| pluck, chime | two to four sines at ratios such as 1, 2.76 and 5.4, each decaying exponentially over 0.3 to 1.2 s, the higher ones faster |
| whoosh | noise through a band-pass that sweeps from 300 to 2,400 Hz over 250 ms, swelling and fading |
| engine, hum | a sawtooth and a sine an octave below through a low-pass; pitch and cutoff follow speed, a slow random wobble keeps it alive |
| wind | noise through a band-pass near 400 Hz whose centre and gain drift on two slow oscillators (0.05 to 0.3 Hz); gusts follow the weather value |
| rain | high-passed noise for the wash, plus sparse 3 ms clicks at random times for near drops |
| sea | brown noise through a low-pass that opens and closes every 6 to 10 s, one cycle per wave |
| water drop, bubble | a sine falling from 900 to 400 Hz in 60 ms with one quiet echo; a bubble rises from 300 to 900 Hz instead |
| interface tick | a 3 ms click and a 2 kHz blip, 18 dB under the effects |
| creature call | a sawtooth with vibrato through two band-passes (formants) that glide; short for a chirp, long for a moan |
| thunder, rumble | brown noise through a low-pass at 120 Hz with a slow swell and a 2 to 4 s tail |

Layer two recipes for anything important: a body and a detail.

## Space

- Pan with a StereoPannerNode from the source's position on screen, or the angle to the camera; level falls as `1 / (1 + distance / reference)`; a distant sound also loses its top through a low-pass.
- One room for the whole page: a ConvolverNode whose impulse is generated (noise times an exponential decay of 0.8 to 2.5 s, the two channels different). Effects send 0.1 to 0.3 of their level to it, ambience none.

## Music that follows the play

- A scheduler wakes every 25 ms and schedules the notes that start within the next 0.25 s; tempo and bar position live in audio time.
- One scale for the whole page (a minor pentatonic is hard to make ugly). Layers (a pad, a bass, an arpeggio, light percussion) fade in and out over 1 to 2 s with the state: calm, busy, danger, success.
- Let play write the melody: each pickup plays the next degree of the scale, so a streak climbs; a miss drops back to the root.

## Tied to the simulation

- Level from the speed of the contact, clamped and compressed (the square root reads well); pitch from size; brightness from the material (wood dull, glass and metal bright).
- A continuous quantity (wobble energy, speed, wind) drives a bed's gain and filter through `setTargetAtTime` with a time constant of 0.05 to 0.2 s, updated at most 30 times a second.
- Throttle: a pile of contacts in one frame makes one sound at the level of the largest.

## Levels

Effects peak at -9 to -6 dBFS, ambience sits at -24 to -18, music at -18 to -14, and the master never passes -1. Leave the loudest moment for the event that matters most.

## Recording and tests

- For a recording, `window.renderAudio({ seconds, sampleRate })` builds the same graph in an OfflineAudioContext from the seeded list of events and returns its AudioBuffer (film-sound says how AwwO uses it). Write the recipes to take the context as an argument so both paths share them.
- Tests render offline and read samples: an impact has energy in its first 100 ms and less than a thousandth of its peak after 900 ms; a muted bus renders silence; the last sample of every envelope is near zero; 200 triggers in a second leave no more voices than the pool; the same seed renders the same checksum.
- Plants: an envelope cut to 0 without a ramp, a voice that is never stopped, `Math.random` in the pitch, a bus wired past the master.

## Before you hand over

1. No audio file and no URL; the context starts on a gesture; a mute control and a volume.
2. Buses into one limiter; levels as above.
3. Shaped envelopes everywhere; a voice cap; variation from a seeded generator.
4. Sounds follow the simulation's numbers.
5. The hand-over says that the sound was not heard, and lists the moments to listen at.
