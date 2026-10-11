# anatomy kit (vendored)

The drawing modules of [Anatomy](https://github.com/wheresryan22/anatomy), a Claude Code skill by Ryan that draws an
idea as a working isometric machine: solids with four-tone shading, painted back to front, in a framed card with a live
readout. MIT License; the copyright notice is in `LICENSE`.

- Source: `https://github.com/wheresryan22/anatomy`, commit `dbf697a527bbf7d358668e1557cb1e35ff725d46`
  (2026-10-10, "Link the website from the README").
- Vendored byte for byte, nothing changed: `kit/iso-kit.mjs` (camera, solids, parts, SVG strings, card, `ISO_CSS`),
  `kit/lathe.mjs` (round parts on any axis), `kit/tube.mjs` (pipes and cables), `kit/gl.mjs` (the WebGL layer).
  The skill's instructions, references, examples, audit, 3D runtime and headless-browser checks are not vendored.

AwwO uses these modules as its figure kit (原理图解组件). `apps/web/scripts/build-figure-kit.mjs` turns them into one
classic browser script, `apps/web/src/canvas/figureKit/anatomy-kit.js`, which defines `window.Anatomy` and adds a few
page helpers (`mount`, `run`, `loop`, `follow`, `spring`, `calm`). A figure node's page loads it with
`<script src="https://awwo.clawhunt.store/kits/anatomy/1/anatomy.js"></script>`: AwwO's running previews inline the
pinned copy (`apps/web/src/canvas/previewLibraries.ts`), and the hosted site serves the same bytes at that address for
downloaded pages. To update, copy the new upstream files here, record the commit above, run
`node apps/web/scripts/build-figure-kit.mjs`, and bump the version in the script URL when the kit's API changes.
