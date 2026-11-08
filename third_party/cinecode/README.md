# cinecode engine (vendored)

The frame engine of [cinecode](https://github.com/sarpstar/cinecode), a Claude Code skill by sarpstar that makes films
with code: an AI coding agent writes the script, builds every frame in code, designs the sound and hands over an MP4.
MIT License; the copyright notice is in `LICENSE`.

- Source: `https://github.com/sarpstar/cinecode`, commit `67f9807112b97ae253d4a5f0eccaccc46c3b2633`
  (2026-11-03, "The film's folder is told in plain words on Linux too").
- Vendored byte for byte, nothing changed (git blob ids as upstream):
  - `templates/quick/film.html` (`4a2117e0c70f8cddd794b0a040339d563836b271`): Quick mode's one-file film, whose FILM
    section a film edits and whose engine draws it: looks, 2.5D camera, depth planes, transitions, kinetic type,
    stylised characters, and a whole soundtrack rendered offline with Web Audio (score, effects, ambience, one room).
  - `templates/quick/HELPERS.md` (`7de2d9502e7014e036c7b80c516fb6b16009a095`): the engine's helpers at a glance.
  - `LICENSE` (`a83c0fb81d768b6cc066891de01e5fc79159cd3d`).
- Not vendored: the skill's instructions, references, styles, Python and Node tools, the guard and its hooks, tests,
  media.

AwwO uses this engine as its film kit (影片组件). `apps/web/scripts/build-film-kit.mjs` turns the engine part of
`film.html` into one classic browser script, `apps/web/src/canvas/filmKit/film-kit.js`, with AwwO's changes applied as
named, checked edits: the frame comes from AwwO's renderer (`renderAt`, `__ready`, `renderAudio`), the picture takes
the page's size, and the parts that need the kit's own tools (local files, recorded instruments, narration takes,
typeset formulas, captions from speech) are left out. A film node's page loads it with
`<script src="https://awwo.clawhunt.store/kits/film/1/film.js"></script>` after its FILM script. AwwO's running
previews inline the pinned copy (`apps/web/src/canvas/previewLibraries.ts`), the render worker answers that address
with its own pinned copy, and the hosted site serves the same bytes there for downloaded pages. To update, copy the new
upstream files here, record the commit above, run `node apps/web/scripts/build-film-kit.mjs`, and bump the version in
the script URL when the kit's API changes.
