---
name: film-looks
title: Film looks: drawn looks for code films, with their numbers
title_zh: 影片画风：可用代码画出的画风及其参数
description: Use when choosing or keeping the look of a film, animation, ad or music video drawn in code (with AwwO's film kit or a page of its own): eighteen looks, each with the film kit family it starts from, its palette, line, drawing rate, motion, type and the one device that makes it, plus the rules for choosing one and the defaults to avoid.
description_zh: 为用代码画的影片、动画、广告或音乐视频选定或保持画风时使用（AwwO 影片组件或自写页面）：十八种画风，各含起始的影片组件风格族、配色、线条、作画节奏、动态、字体与标志手法，以及挑选规则和应避开的默认做法。
category: video
applies: video,motion,html,design
version: 1
attribution: Look recipes adapted from cinecode (MIT, Copyright (c) 2026 Sarp Yıldız); its library includes lemo-opuscar's recipes (MIT, Copyright (c) 2026 LemoLab); modified for AwwO
---
# Film looks

## Choosing
- Choose for the story's place, era, material and feeling, never by habit; name the look and why on the plan. One look a film, its mark returning at the end; a scene that must change changes its light first, then its palette.
- With the film kit: `look: { base: '<family>' }` from the brackets with the look's palette; draw the rest in the scenes. On twos: poses at floor(t * 12) / 12, the camera on ones.
- Take a look's grammar, never an artist's, studio's or work's, and put no such name on screen. A data or source look shows only the brief's facts.
- Avoid by default: purple-cyan gradients, particle soup, lens flares, RGB split, neon or bloom everywhere, elastic easing everywhere, a centred title on black, floating interface cards.

## Looks
Each: [kit family] what it fits. Palette; line; rate; motion; type. Mark: its device.
- **papercut-red** [papercut-collage] folk tales, festivals. Red #D2201F on rice paper #F2E6CC, gold #D4A535; no outline; figures on twos, folds land on hits; Playfair Display. Mark: all detail is holes cut in red.
- **paper-lantern** [papercut-collage] memories, places. Night #0A1330, sheets #6A86C2 / #3F5A92 / #0E1532, windows #FFB862; on ones, layers slide from an edge; Instrument Serif. Mark: backlit sheets, bright far, dark near.
- **spy-titles** [papercut-collage] openers, chases, launches. Ink #1B1714, cream #EFE4C9, red #D23A22, mustard #E2A52A; a 2.4 px cut gap; figures on twos, credits slide on a grid; Bebas Neue. Mark: the words are the set.
- **vox-explainer** [papercut-collage] sourced why-explainers. Desk #F1E6D0, card #FBF7EE, navy #14213D, marker #B8312A; marker 6-10 px; on twos, cards drop with a small back; Bebas Neue. Mark: a marker circles what matters.
- **woodcut** [handmade-ink] wordless dramas. Ink #15120F, paper #EFE6D1, one plate #C0622B; knife 1.2-2 px, gouges to 22 px; on twos, a 2-frame strike after anticipation; Cinzel. Mark: light only where the knife cut.
- **risograph** [handmade-ink] gentle comedy, wide worlds. Paper #F4EEE2, blue #0078BF, yellow #FFE800, pink #FF48B0; a 4 px paper halo; on twos, 1-3 px off register; Space Grotesk. Mark: spot inks overprinting.
- **ink-wash** [handmade-ink] legends, poetry, heritage. Rice paper #F2ECDE, ink in 4 tones, seal #B02E22; brush with flying white, no closed outline; figures on twos; Instrument Serif. Mark: one stroke is a mountain or a cut.
- **whiteboard** [handmade-ink] explainers, courses. White board, ink #23262C, signal #2A5CB3, accent #D97757; marker strokes that overshoot; one board the camera glides across; Space Grotesk. Mark: every word and drawing is written live.
- **dark-keynote** [glossy-commercial] software launches. Stage #0B0C10, surface #17191F, text #E6E8EE, accent #B7F34A; 1 px borders at 8 % white; spawns of 0.2-0.3 s on the beat; Inter. Mark: a light sweep reveals the interface.
- **shape-morph** [glossy-commercial] product stories, logo endings. Orange #FF9F1C, blue #2E86DE, brown #9A6234 on navy #1E2440; no outline; morphs of 8-12 frames on beats, 10-15 % squash; Outfit. Mark: one outline becomes the next.
- **swiss-motion** [glossy-commercial] systems, timetables, stats. Page #EAE9E5, ink #111111, signal #E30613; 1 px rules; on ones, snaps on the beat, clip reveals, no bounce; Inter. Mark: a grid broken only by the signal.
- **dataviz** [glossy-commercial] trends from the brief's data. Paper #F4EEDF, ink #2E2823, grid #CFC6B6, red #B2182B, blue #2166AC; hairlines; marks land on the beat; Instrument Serif. Mark: notes pinned to values.
- **watercolor** [pastel-storybook] nature, travel, field journals. Paper #F3E2C8, washes #9FB4C4 / #5F7486, accent #C8442A; no vector line, strokes darken where they cross; on ones; Instrument Serif. Mark: the page paints itself.
- **crayon-book** [pastel-storybook] picture books, bedtime stories. Paper #F4EFE3, a dozen crayons, outline indigo or brown, never black; all drawing on twos, boiling; Outfit, letters tilted. Mark: one wash reveals what crayon hid.
- **rubber-hose** [anime-cel] retro ads, food, kids. Six greys and ink, no hue; 6 px outline at any zoom; on twos, idle things squash on each beat of 8-20 frames; Playfair Display. Mark: all objects alive, swinging.
- **cel-anime-80s** [anime-cel] music videos, game trailers. Flat two-tone cels, coloured outlines, airbrushed skies, one hero accent; cels on twos, blinks on threes, camera on ones; Exo 2. Mark: light bands sweep a held cel.
- **hologram-hud** [retro-synthwave-vhs] specs, teardowns. Stage #04100E, lines #5CF2C0, value #FF8A2A; 1.3 px additive strokes; boxes snap in 0.2 s, flash on downbeats; Rajdhani. Mark: a wireframe with locking boxes.
- **silent-film** [cinematic-realistic] wordless comedy, origins. Silver greys, one tint a section, one kept colour at most; engraved ink line; motion at 16 fps, flicker every frame; Playfair Display. Mark: intertitle cards, no voices.

