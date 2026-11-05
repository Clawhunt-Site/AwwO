import { THREE_MODULES_IMPORT_MAP } from '../canvas/previewImportMap';
import type { OfficialWorkflow } from './examples/officialWorkflows';

/** Blender cases (2026-11-05): homepage cases whose 3D is made in the Blender workstation (the 'blender' runtime) from
 * the owner's Grasshopper studies, which awwo_param ports to Python (deploy/saas/blender/awwo_param). Their makers work
 * as the local trials of 2026-11-05 did (each look at a render changed something): they build with awwo_param, look at
 * their renders (workspace_view) and correct them, and hand on web GLBs and renders as files of their own, which the
 * case's page loads by `<node id>/<file name>` (OfficialWorkflowNode.files). Listed in PRODUCTION_WORKFLOWS once a run is
 * recorded, as the flagships and epics are. */

/** The house's look, which every photograph keeps. */
const LOOK = 'the house’s look: a deep charcoal velvet sweep, a large soft key light, a narrow rim light that draws the metal’s edges, a faint warm fill, a real 18k-gold Principled BSDF (metallic 1, roughness about 0.15, a warm yellow gold)';
/** How a maker checks and hands on its work. */
const LOOK_AND_FIX = 'Look at every render with workspace_view and correct what you see (exposure, highlights, framing, focus, the colour of the gold) before you publish; each piece sits whole in its frame.';
const SHEET = 'awwo_param’s sheet lattice, which makes a lattice as one closed, watertight solid with even walls: read help(awwo_param.minimal.sheet) first, make each lattice a Blender object with awwo_param.blender.mesh_object(..., smooth=True), and do not thicken, remesh or subdivide it, it is a cast-ready solid. Judge each lattice by eye and adjust its cells or walls if it reads too dense or too sparse; walls stay at 0.4 mm or more so they cast.';
const GLB = 'a web-ready GLB (real-world scale in metres, a PBR gold material, at most 1.5 MiB, with no Draco or meshopt compression, which the site’s viewer does not load): decimate a copy of the lattice for it (Decimate modifier, collapse), never the render mesh';

type CaseFile = { readonly id: string; readonly label: string };
/** Each file a node publishes, by the name the site finds it by: a file is stored under the name it is published with,
 *  and the previews of a member's copy look files up by name (pickCanvasFile), so two nodes' files never share one. */
const named = (files: ReadonlyArray<CaseFile>) => `Save each file under the name the site finds it by and publish it into its output: ${files.map(file => `${file.label} into ${file.id}`).join(', ')}`;
const RING_FILES: ReadonlyArray<CaseFile> = [{ id: 'model', label: 'ring.glb' }, { id: 'render', label: 'ring.jpg' }];
const PIECES_FILES: ReadonlyArray<CaseFile> = [{ id: 'pendant', label: 'pendant.glb' }, { id: 'earrings', label: 'earrings.glb' }, { id: 'pendant_render', label: 'pendant.jpg' }, { id: 'earrings_render', label: 'earrings.jpg' }];
const PHOTO_FILES: ReadonlyArray<CaseFile> = [{ id: 'hero', label: 'hero.jpg' }, { id: 'detail', label: 'detail.jpg' }, { id: 'pair', label: 'pair.jpg' }];

const GYROID: OfficialWorkflow = {
  id: 'gyroid-jewellery',
  title: 'GYROID: minimal-surface jewellery',
  stack: 'r186',
  fonts: true,
  brief: 'GYROID is the first collection of Atelier Minima, a fine-jewellery house: a ring, a pendant and a pair of earrings whose bodies are triply periodic minimal surfaces, the gyroid and the diamond surface, after the house founder’s Grasshopper studies of minimal-surface jewellery. Each piece is built at real size in the Blender workstation as a cast-ready lattice in 18k yellow gold, photographed in ' + LOOK + ', and shown on the collection’s site in the round. Write everything in English.',
  nodes: [
    { id: 'ring', title: 'Ring maker', role: 'general', column: 0, row: 0, blender: true, output: 'Ring notes',
      files: RING_FILES,
      task: `You are the house's ring maker. Build the RING in Blender with ${SHEET} Start from its size 7 ring example (17.3 mm inside, 7.5 mm wide, a 2.6 mm band, gyroid, 18 cells round, 2 across the band and 3 up it, 0.45 mm walls, resolution 160, wrapped round the band): a fine, even woven lattice, which one cell across the band would make a crumpled sheet. 18k yellow gold.

Photograph it like a luxury campaign in ${LOOK}, the ring standing at a three-quarter angle with the whole band sharp (if you use depth of field, keep the ring within it). Render one close-up with Cycles on the GPU with denoising, 1600x1600, saved as a JPEG at quality 90. ${LOOK_AND_FIX}

Export the ring as ${GLB}. Plan your steps and reserve the last few for the export and publishing. ${named(RING_FILES)}; in your result, give the awwo_param call and its parameters, the triangle counts (render mesh and GLB), the ring's measured size, the file sizes, the render settings and the checks you ran, including what each look at a render made you change.`,
      acceptance: ['model is a GLB of at most 1.5 MiB at real size in metres', 'render is a 1600x1600 JPEG of the whole ring, sharp', 'The result names the sheet() call, the triangle counts and what each look at a render changed'] },
    { id: 'pieces', title: 'Pendant and earrings maker', role: 'general', column: 0, row: 1, blender: true, output: 'Pendant and earrings notes',
      files: PIECES_FILES,
      task: `You are the house's pendant and earring maker. Build two pieces in Blender with ${SHEET}
- PENDANT: a 20 mm sphere of the diamond surface (schwarz_d), 6 cells across, 0.5 mm walls, resolution 110 (shape 'sphere'): a fine, even lattice, which a few large cells across a sphere would make a lumpy ball. Hang it from a plain polished bail: a small ring of round wire (about 1.2 mm wire, 5 mm across) fused into the top of the sphere, and a short fine cable chain rising out of frame so it reads as worn.
- EARRINGS: a pair of gyroid lattice discs 16 mm across and 3 mm thick (shape 'cylinder', about 4 cells across, 0.45 mm walls), each framed by a plain polished bezel (a thin round rim along its edge, which hides where the lattice is cut) and hanging from a plain polished French hook of 0.8 mm wire; the second earring a mirrored copy turned a little, so the pair is not identical in the shot.
18k yellow gold for both pieces.

Photograph each piece like a luxury campaign in ${LOOK}, the whole piece sharp (if you use depth of field, keep the piece within it). Render each with Cycles on the GPU with denoising, 1600x1600, saved as a JPEG at quality 90. ${LOOK_AND_FIX}

Export each piece as ${GLB}, the pair of earrings in one file. Plan your steps and reserve the last few for the exports and publishing. ${named(PIECES_FILES)}; in your result, give each awwo_param call and its parameters, the triangle counts (render meshes and GLBs), the pieces' measured sizes, the file sizes, the render settings and the checks you ran, including what each look at a render made you change.`,
      acceptance: ['pendant and earrings are GLBs of at most 1.5 MiB each at real size in metres', 'pendant_render and earrings_render are 1600x1600 JPEGs of the whole pieces, sharp', 'The result names each sheet() call, the triangle counts and what each look at a render changed'] },
    { id: 'photo', title: 'Campaign photographer', role: 'general', column: 1, row: 0, blender: true, output: 'Campaign notes',
      files: PHOTO_FILES,
      task: `You are the house's campaign photographer. The makers hand you the collection's pieces as web GLBs at real size in metres, in inputs/ (the ring, the pendant, the pair of earrings; list them with workspace_list). Import each into Blender (bpy.ops.import_scene.gltf inside a window override), give every piece one real 18k-gold Principled BSDF (metallic 1, roughness about 0.15, a warm yellow gold) and shade it smooth. Do not change their geometry.

Shoot the campaign in ${LOOK}. Every piece is sharp where the frame says it should be; never blur a piece the image is about.
- HERO (1920x1080): the three pieces together on the velvet sweep, large in the frame across its right two-thirds (the camera close and low): the ring standing, the pendant lying with its chain curving, the earrings crossed; a composed still life with room for a headline on the left third.
- DETAIL (1600x1600): a macro of the ring's lattice where it turns away from the light, the lattice's walls and their rounded edges reading clearly. A web GLB is decimated, and a macro shows its facets: for this shot, build the ring again at full resolution with the awwo_param.minimal.sheet() call the ring maker's notes give (the same arguments; about 25 s), give it the same gold, put it where the imported ring is, and hide the imported one.
- PAIR (1600x1600): the earrings hanging side by side from a slim matte-black stand on the same charcoal sweep (nothing pale in the frame), the gold warm yellow, never rose.
Set the studio up once (the pieces, their gold, the sweep and the lights in one Blender call) and reuse it for every shot. Render with Cycles on the GPU with denoising, saved as a JPEG at quality 90. Work shot by shot, in three renders each: a quick test (half size, few samples), a corrected one and the final, with a fourth only when the third is still wrong. Look at each with workspace_view and correct what you see (exposure, highlights, composition, focus, the gold's colour, nothing cut off that should be whole); for the macro, crop a detail of its test with Pillow and look at that closer. Publish each photograph once its final render is right, then go on to the next.

Reserve the last few steps for publishing. ${named(PHOTO_FILES)}; in your result, give each shot's camera, lens, aperture and lights, the render settings, and what each look at a render made you change.`,
      acceptance: ['hero is a 1920x1080 JPEG of the three pieces together; detail and pair are 1600x1600 JPEGs', 'Every piece an image is about is sharp and whole', 'The result names each shot’s camera, lens and lights and what each look changed'] },
    { id: 'site', title: 'Collection site', role: 'frontend', column: 2, row: 0, sandbox: true, output: 'GYROID collection site', outputType: 'html',
      task: `You are the house's web designer. Build the GYROID collection's site as one page in your sandbox computer, test it, and publish it into result.

The canvas's own files, which the page shows by exactly these relative paths (AwwO's previews and the site put the real files in their place; they are not in your workspace, so a check of the page names them missing, which is expected): the campaign photographs photo/hero.jpg (1920x1080), photo/detail.jpg and photo/pair.jpg (1600x1600); the makers' renders ring/ring.jpg, pieces/pendant.jpg and pieces/earrings.jpg (1600x1600); the web models ring/ring.glb, pieces/pendant.glb and pieces/earrings.glb (GLBs at real size in metres, a few centimetres across, each with its own gold material). Write each path as one whole string literal or attribute, never assembled from pieces, and invent no other file names.

The page, in the house's look (deep charcoal, warm gold, generous space, refined type in the brand fonts AwwO supplies):
- a full-screen hero on photo/hero.jpg with the collection's name and a one-line idea, the headline set in the left third the photograph leaves for it and kept inside it at every width (its size clamped to the width), never over a piece;
- a viewer for the three pieces in the round: three.js r186 through exactly this import map in the head: ${THREE_MODULES_IMPORT_MAP}, one <script type="module"> importing 'three', 'three/addons/loaders/GLTFLoader.js', 'three/addons/controls/OrbitControls.js' and 'three/addons/environments/RoomEnvironment.js'; GLTFLoader loads each GLB by its path; each model is centred from its bounding box and framed to fill the view (they are a few centimetres across), on a dark ground with soft shadow; scene.environment from RoomEnvironment through PMREMGenerator so the gold reflects, but dimmed (environmentIntensity about 0.4) on a charcoal background with a warm key light, since gold shows what it reflects and a bright white room turns it pale; Khronos PBR Neutral tone mapping (THREE.NeutralToneMapping), which keeps a material's own colour where ACES Filmic turns gold olive; the gold must read warm yellow as in the photographs; a slow turntable that OrbitControls can take over; buttons for the ring, the pendant and the earrings; while a model loads, its render (ring/ring.jpg and so on) stands in its place;
- a section on the idea: what a triply periodic minimal surface is, why the lattice is light and strong, and each piece's real parameters as the makers' notes give them (cells, walls, sizes), with photo/detail.jpg;
- the pieces: each with its render, its size and materials as the notes give them, and photo/pair.jpg with the earrings;
- a short footer for Atelier Minima.
It fills its window and stays legible on a phone; no external scripts, fonts or network requests beyond the import map and the canvas's files above.

Test it with awwo-check-page (pass --missing-ok for the canvas's files above), fix what it reports, and publish the page into result.`,
      acceptance: ['One self-contained HTML document on three.js r186 through the import map', 'It loads ring/ring.glb, pieces/pendant.glb and pieces/earrings.glb with GLTFLoader and shows the campaign photographs by their paths', 'Its facts come from the makers’ and photographer’s notes', 'awwo-check-page ran on it and what it reported is fixed'] },
  ],
  edges: [
    { from: 'ring', to: 'photo', label: 'The ring (GLB)', port: 'model' },
    { from: 'ring', to: 'photo', label: 'Ring notes' },
    { from: 'pieces', to: 'photo', label: 'The pendant (GLB)', port: 'pendant' },
    { from: 'pieces', to: 'photo', label: 'The earrings (GLB)', port: 'earrings' },
    { from: 'photo', to: 'site', label: 'Campaign notes' },
    { from: 'ring', to: 'site', label: 'Ring notes' },
    { from: 'pieces', to: 'site', label: 'Pendant and earrings notes' },
  ],
};

/** Keyed by case id. */
export const BLENDER_WORKFLOWS: Readonly<Record<string, OfficialWorkflow>> = Object.fromEntries([GYROID].map(item => [item.id, item]));
