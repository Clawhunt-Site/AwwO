# Production case draft: Robot cell planner

A case for the homepage built on measured prop data rather than invented figures: a pick-and-pack cell
where every object stands at its real size and mass, every lane and lift is arithmetic from those
figures, and the page says plainly which figures the data does not contain. It is the case half of the
owner's 2026-10-23 request to put a public simulation-grade asset library to use in AwwO; the
capability half shipped as the built-in skill `backend/internal/app/skills/physical-props.md`.

**This is a draft, not a landed case.** A case is atomic with its run: `saas-production-workflows`
requires `PRODUCTION_WORKFLOWS` and `PRODUCTION_CASES` to hold exactly the same ids, `saas-production-cases`
requires the card's footage on disk, and `saas-production-copy` requires a published record for every
case. So the workflow, the card, the footage and the record land in one commit, after the run.
Everything needed for that run is below, paste-ready and already typechecked.

## Why this case

AwwO's 3D and twin cases are built from numbers a model chose: the EV plant's stations are 7 m apart
because the task says so. That is fine for a diorama and wrong for a plan. This case inverts it: the
figures come first, as measured data in the canvas, and the delivery is judged on whether its lanes,
pitches and lifts follow from them. It shows three things no other case shows.

1. **Measured reality.** A forklift 1.36 m wide and 3.73 m long at 1730 kg, a 1.21 m pallet, a 3.10 m
   rack bay: an aisle either clears them or it does not, and the page shows the arithmetic.
2. **A decision the figures change.** The grippers in the data are a 6 kg and a 14 kg class; a loaded
   pallet is 62 kg before any goods. The plan therefore cannot have the robot move pallets, and the
   page says why with the numbers, instead of drawing a robot lifting one.
3. **Honesty about what the data lacks.** The data has a rack's own mass (797 kg), not its load
   capacity, and an arm's height (2.16 m), not its reach envelope. Those checks come out amber -
   "not in the data, source it from the maker" - rather than a green tick over a guess. A planner that
   says what it does not know is worth more than one that guesses.

## The measured props the canvas carries

Pulled 2026-10-24 from the asset library's public search service, one query per prop, keeping each
hit's own figures. Footprint and height in metres, mass in kilograms, bodies = rigid-body count.
Holder is CC-BY 4.0, (c) NVIDIA unless named; the delivered page's bill of materials names them.

| id | name | footprint | height | mass | bodies | holder |
|---|---|---|---|---|---|---|
| `forklift` | Counterbalance forklift | 1.36 x 3.73 | 2.17 | 1730 | 32 | NVIDIA |
| `palletJack` | Pallet jack, low profile | 0.65 x 1.63 | 1.27 | 164 | 8 | NVIDIA |
| `handTruck` | Hand truck, convertible | 0.50 x 0.48 | 1.35 | 30 | 11 | NVIDIA |
| `cart` | Platform cart | 0.67 x 1.22 | 0.95 | 142 | 6 | NVIDIA |
| `pallet` | Wooden pallet | 1.21 x 1.00 | 0.21 | 62 | 1 | NVIDIA |
| `rackBay` | Pallet rack bay, shelved | 3.10 x 0.70 | 2.50 | 797 | 1 | NVIDIA |
| `conveyor` | Roller conveyor section | 2.10 x 2.07 | 1.17 | 128 | 29 | NVIDIA |
| `packTable` | Packing table, heavy duty | 1.87 x 1.22 | 0.99 | 226 | 1 | NVIDIA |
| `guardPanel` | Machine guard panel | 0.70 x 0.15 | 1.70 | 74 | 1 | NVIDIA |
| `ladder` | Step ladder, rolling | 0.76 x 0.66 | 1.52 | 79 | 9 | NVIDIA |
| `crate` | Stacking crate | 0.60 x 0.40 | 0.10 | 1.9 | 1 | NVIDIA |
| `carton` | Cardboard carton | 0.34 x 0.26 | 0.17 | 0.2 | 1 | NVIDIA |
| `container` | Lidded container | 0.62 x 0.40 | 0.45 | 1.0 | 2 | NVIDIA |
| `basket` | Plastic basket | 0.25 x 0.33 | 0.13 | 0.7 | 5 | NVIDIA |
| `drum` | Steel drum | 0.64 x 0.66 | 0.87 | 102 | 2 | NVIDIA |
| `wasteBin` | Waste container | 0.48 x 0.37 | 0.70 | 46 | 3 | NVIDIA |
| `floorSign` | Folding floor sign | 0.31 x 0.31 | 0.92 | 49 | 1 | NVIDIA |
| `desk` | Supervisor desk | 0.80 x 1.80 | 0.76 | 121 | 1 | NVIDIA |
| `chair` | Office chair | 0.62 x 0.71 | 1.09 | 8.2 | 13 | NVIDIA |
| `armRobot` | Floor-standing robot arm | 0.56 x 0.52 | 2.16 | 330 | 7 | CC-BY 4.0, LucaDiRuscio |
| `cobot` | Collaborative robot | 0.20 x 0.45 | 1.52 | 31 | 11 | CC-BY 4.0, Standard Bots |
| `gripper14` | Gripper, 14 kg class | 0.12 x 0.07 | 0.17 | 1.5 | 5 | BSD-3-Clause, OnRobot A/S |
| `gripper6` | Gripper, 6 kg class | 0.10 x 0.08 | 0.28 | 1.1 | 12 | BSD-3-Clause, OnRobot A/S |

Two figures are the asset's own and implausible for the real object: the folding floor sign at 49 kg
and the desk at 121 kg. They are kept as measured and the page marks them, which is the discipline the
`physical-props` skill asks for - never silently rewrite a figure.

## The card

In `apps/web/src/saas/productionCatalog.ts`, after the EV plant card in the draft that was tested.
Placement among the other cards is the owner's call; `saas-production-cases-placement` pins where each
card sits, so check it in the same commit.

```ts
  {
    id: 'robot-cell', kind: 'twin', recording: true, footage: 'cell-real',
    title: 'Robot cell planner',
    brief: 'Plan a warehouse pick-and-pack cell where every object stands at its measured size and mass, and every aisle, clearance and lift is checked against them.',
    stages: [['Props'], ['Layout', 'Checks'], [RENDERING, FRONT_END], [FRONT_END], [REVIEW]],
    deliverable: 'An interactive cell planner',
  },
```

The card and the brief name no asset library: holders and licences belong in the delivered page's bill
of materials, never in AwwO's interface (owner decision 2026-10-23).

## The canvas

In `apps/web/src/saas/productionWorkflows.ts`, before the registry, with `CELL` added to the registry
list. Five stages, so every handoff crosses into a later one as the DAG rule requires: the props, then
the layout and the checks from them, then the scene and the interface, then the page that pastes all
five, then the review. It uses the file's own helpers (`n`, `e`, `code`, `sizedCode`, `r186Scene`,
`assembleR186`, `review`) and needs no 3D model node, since every prop is proxy geometry at its
measured size. The layout's field names are shared as a const, the way Crystal Keep shares `KEEP_MAP`,
so the checks, the scene and the interface are written against the same shape without waiting for it.
No brand fonts, so it stays on the R1 rules: figures are set in a system monospace stack with
`font-variant-numeric: tabular-nums`.

```ts
// Robot cell planner: measured prop data, a layout and the checks, a scene and an interface written from
// them, and a page that pastes all five. Every figure in PROPS is measured; the checks are arithmetic
// over it, and the ones the data cannot settle come out amber rather than green.
const CELL_PROPS = 'id | name | footprint x by y (m) | height (m) | mass (kg) | rigid bodies | holder: '
  + 'forklift | Counterbalance forklift | 1.36 x 3.73 | 2.17 | 1730 | 32 | NVIDIA; '
  + 'palletJack | Pallet jack, low profile | 0.65 x 1.63 | 1.27 | 164 | 8 | NVIDIA; '
  + 'handTruck | Hand truck, convertible | 0.50 x 0.48 | 1.35 | 30 | 11 | NVIDIA; '
  + 'cart | Platform cart | 0.67 x 1.22 | 0.95 | 142 | 6 | NVIDIA; '
  + 'pallet | Wooden pallet | 1.21 x 1.00 | 0.21 | 62 | 1 | NVIDIA; '
  + 'rackBay | Pallet rack bay, shelved | 3.10 x 0.70 | 2.50 | 797 | 1 | NVIDIA; '
  + 'conveyor | Roller conveyor section | 2.10 x 2.07 | 1.17 | 128 | 29 | NVIDIA; '
  + 'packTable | Packing table, heavy duty | 1.87 x 1.22 | 0.99 | 226 | 1 | NVIDIA; '
  + 'guardPanel | Machine guard panel | 0.70 x 0.15 | 1.70 | 74 | 1 | NVIDIA; '
  + 'ladder | Step ladder, rolling | 0.76 x 0.66 | 1.52 | 79 | 9 | NVIDIA; '
  + 'crate | Stacking crate | 0.60 x 0.40 | 0.10 | 1.9 | 1 | NVIDIA; '
  + 'carton | Cardboard carton | 0.34 x 0.26 | 0.17 | 0.2 | 1 | NVIDIA; '
  + 'container | Lidded container | 0.62 x 0.40 | 0.45 | 1.0 | 2 | NVIDIA; '
  + 'basket | Plastic basket | 0.25 x 0.33 | 0.13 | 0.7 | 5 | NVIDIA; '
  + 'drum | Steel drum | 0.64 x 0.66 | 0.87 | 102 | 2 | NVIDIA; '
  + 'wasteBin | Waste container | 0.48 x 0.37 | 0.70 | 46 | 3 | NVIDIA; '
  + 'floorSign | Folding floor sign | 0.31 x 0.31 | 0.92 | 49 | 1 | NVIDIA; '
  + 'desk | Supervisor desk | 0.80 x 1.80 | 0.76 | 121 | 1 | NVIDIA; '
  + 'chair | Office chair | 0.62 x 0.71 | 1.09 | 8.2 | 13 | NVIDIA; '
  + 'armRobot | Floor-standing robot arm | 0.56 x 0.52 | 2.16 | 330 | 7 | LucaDiRuscio, CC-BY 4.0; '
  + 'cobot | Collaborative robot | 0.20 x 0.45 | 1.52 | 31 | 11 | Standard Bots, CC-BY 4.0; '
  + 'gripper14 | Gripper, 14 kg class | 0.12 x 0.07 | 0.17 | 1.5 | 5 | OnRobot A/S, BSD-3-Clause; '
  + 'gripper6 | Gripper, 6 kg class | 0.10 x 0.08 | 0.28 | 1.1 | 12 | OnRobot A/S, BSD-3-Clause. '
  + 'Every holder without a licence beside it is CC-BY 4.0. These figures are measured: never round, '
  + 'adjust or replace one, and never add a prop that is not in this list.';
// The layout every module is written against, so the checks, the scene and the interface agree on its field names
// without waiting for it.
const CELL_LAYOUT = 'LAYOUT, in metres with its origin at the hall’s centre, x to the right and z forward: '
  + '{ hall: { w: 24, d: 18, wallHeight, baseRadius }, defaults: { aisle, rackRows, vehicle, robot, gripper } (the plan the page opens on), '
  + 'rackRow(i, aisle) returning { bays: [{ x, z, rot }], z } for rack row i at that aisle width, levels (3) and levelPitch, '
  + 'line: { conveyors: [{ x, z, rot }], tables: [{ x, z, rot }] }, pick: { x, z, rot }, '
  + 'guard: { panels: [{ x, z, rot }], gate: { x, z, width } }, lanes: [{ id, label, from: [x, z], to: [x, z], width, vehicle }] '
  + '(mainAisle, crossAisle and jackLane), pallets: { perBay: 2, perLevel }, goods: [{ id, x, y, z, rot }], '
  + 'props: [{ id, x, z, rot }] (ladder, drum, wasteBin, floorSign, desk, chair, handTruck, cart), notes: [string]';
const CELL: OfficialWorkflow = {
  id: 'robot-cell',
  title: 'Robot cell planner',
  stack: 'r186',
  brief: 'Build an interactive planner for a warehouse pick-and-pack cell of the fictional operator Ridgeline Logistics, held to the look of a fine architectural model photographed in a soft studio: a 24 x 18 m hall on a pale rounded base, pallet racking down the long wall, a packing line of two roller conveyors and two packing tables, a guarded robot pick station, a forklift aisle and a narrower pallet-jack lane marked on the floor, and a supervisor desk in the corner. Every object stands at its measured size and mass, and the plan is judged against them: the aisle either clears the forklift or it does not, two pallets either fit a rack bay or they do not, a gripper either lifts what it is given or it does not - and the page shows the arithmetic for each. The reader can change the plan (aisle width 2.0-4.0 m, two to four rack rows, the aisle vehicle, the robot, the gripper class) and every check, dimension and figure follows at once. Checks the measured data cannot settle - a rack bay’s load capacity, a robot’s reach envelope - come out amber and say what to source, never green. Click any object for its measured figures, and the page carries a bill of materials with each object’s holder and licence. Render live with three.js r186 and deliver one HTML file.',
  nodes: [
    n('props', 'Measured props', 'data', 0, 0,
      code('Write the measured prop catalogue as one JavaScript module from this table, changing no figure. ' + CELL_PROPS
        + ' Deliver const PROPS = {…}, keyed by id, each { name, w, d, h, mass, bodies, holder, licence, kind }: w and d are the two footprint numbers in metres (w the first, d the second), h the height, mass in kilograms, bodies the rigid-body count, holder and licence the strings above, and kind one of vehicle, store, line, robot, tool, goods, furniture for how the scene draws and the interface groups it. Add const FIGURE_NOTES = {…}, keyed by the ids whose mass is the asset’s own figure and implausible for the real object (floorSign and desk), each a short English sentence a reader can see, such as "Asset figure; a folding sign weighs a few kilograms in reality." Add const PALETTE = {…}, one hex colour per kind, an industrial scheme on light grey (store a warm grey, line a steel blue, robot a safety orange, vehicle a deep yellow, goods a kraft brown, tool a slate, furniture a pale birch). Export nothing and import nothing: these are top-level consts the page pastes.'),
      'Measured prop data module', 'Every figure matches the table in the task exactly; no prop is added or dropped'),
    n('layout', 'Cell layout', 'data', 1, 0,
      code('From the measured props, lay the cell out in coordinates: 1 unit = 1 metre, a 24 x 18 m hall on a pale rounded base about 26 x 20. Deliver exactly this shape, as one const the page pastes: ' + CELL_LAYOUT
        + '. Rack rows run along the long wall, three 3.10 m bays to a row from x = -10.5, the first row at z = -7.6 and each further row one aisle width nearer the centre; the packing line sits on the opposite side, two conveyor sections end to end along x from 1.6 to 5.8 at z = 5.2 with two packing tables beside them at z = 7.0; the robot pick station stands between the racking and the line, ringed by 0.70 m machine guard panels with one 1.4 m gate facing the main aisle; the main aisle runs between the racking and the pick station at the plan’s aisle width, the cross aisle at the hall’s east end, and the pallet-jack lane along the line; two pallets to a bay on a floor level and two beam levels, their 1.00 m depth overhanging the 0.70 m frame; the cartons, crates, containers and baskets sit on the tables, the conveyors and the pallets. Lay every object out from its own measured footprint so none overlaps another and none stands in a lane, and make sure the rack rows plus one aisle still fit the hall’s depth at the widest aisle the reader can choose (4.0 m) and the most rows (4). The notes say at most 6 things the layout assumes. The fields are settled: do not deliberate at length before writing - start writing. Output only the LAYOUT object and its notes, written compactly with numbers to one decimal place and no comments, at most 3,400 characters.'),
      'Cell layout data', 'No two objects overlap and nothing stands in a lane, at any aisle width or row count the plan allows'),
    n('checks', 'Plan checks', 'data', 1, 1,
      sizedCode('Write the plan checks as one module of pure functions over the measured props (PROPS, keyed by id, each { name, w, d, h, mass, bodies, holder, licence, kind }) and the cell layout (' + CELL_LAYOUT + '), in plain JavaScript. function runChecks(plan, props, layout) returns an array of { id, title, verdict: \'pass\' | \'fail\' | \'unknown\', value, limit, workings, note } where workings is the arithmetic as an English string a reader can follow ("1.36 m forklift + 2 x 0.50 m clearance = 2.36 m needed; 3.20 m aisle") and note is set only for an unknown. The checks, each from measured figures and nothing else: aisleWidth - the plan’s aisle against the chosen vehicle’s width plus 0.50 m of clearance on each side; turnRoom - the cross aisle’s width against the chosen vehicle’s length, since a vehicle turning there cannot need less than its own length; jackLane - the pallet-jack lane against the jack’s 0.65 m width plus 0.30 m each side; bayFit - two 1.21 m pallets (2.42 m) against a bay’s 3.10 m span, reporting the room left, and the 1.00 m pallet’s 0.15 m overhang past each side of the 0.70 m frame, which is how racking works and which the aisle must be measured from; levelHeight - a floor level and two beam levels at the layout’s pitch in a bay 2.50 m high, reporting the load height above each 0.21 m pallet separately (the lower levels and the taller top level) with the bay height left over, and which goods in PROPS fit each; gateWidth - the guard ring’s gate against the widest object that must pass it; transferLift - the height a packer lifts between the 0.99 m table, the 1.17 m conveyor and a 0.21 m pallet on the floor; gripperPayload - the chosen gripper’s class (6 or 14 kg, from its name) against the heaviest thing the robot is asked to move, which is the 1.9 kg crate, and separately against a 62 kg pallet, which it cannot lift, so the plan moves pallets with the vehicle; robotHeight - the chosen robot’s height against the top deck height (level pitch x 2 + 0.21 m), where each bounding box ends and nothing about reach; cellMass - the total mass of everything placed, and the mass standing in one full bay (6 pallets plus their goods). Two checks are unknown by construction, and must say so rather than guess: bayCapacity - the data has a bay’s own 797 kg mass, not its load rating, so the verdict is unknown with the note that the rating comes from the rack’s maker; robotReach - the data has the robot’s height, not its reach envelope, and an arm reaches above its own height when extended, so the verdict is unknown for either robot with the note that the envelope comes from the robot’s maker. Also export function planSummary(plan, props, layout) returning { counts (how many of each prop the plan places), mass (total), bom (one row per prop placed: id, name, count, w, d, h, mass each, mass total, holder, licence) } for the bill of materials. Never invent a figure, a capacity or a tolerance that is not measured or stated in this task.', 3800),
      'Plan check module', 'Every check returns the arithmetic it used; the two unsourced checks are unknown, never pass'),
    n('cell', 'Cell scene code', 'frontend', 2, 0,
      r186Scene('From the measured props and the cell layout (' + CELL_LAYOUT + '), write the scene code for the cell, held to the look of a fine architectural model photographed in a soft studio: a thick pale rounded base in satin plastic, a light grey floor with yellow lane lines and black-and-yellow hatching at the guard gate, two low walls (west and north) and none on the open sides so the cell reads from above. function createCell(scene, props, layout): every object is proxy geometry at its own measured size - w by d on the floor and h high, a RoundedBoxGeometry for housings - in its kind’s palette colour, never a wireframe or a grey block: racking as uprights and beams built from the bay’s 3.10 x 0.70 x 2.50 box, pallets as slatted decks, the conveyor as a frame with rollers, the robot as a base, two arm links and a wrist with the gripper at its end, the vehicle with a mast and forks (forklift) or a low fork body (pallet jack), guard panels as a mesh in a frame. It returns { setPlan(plan), update(dt), pick(raycaster), highlight(id), dimension(from, to, label, offset), clearDimensions(), objects() }: setPlan rebuilds the placements for a new aisle width, row count, vehicle, robot or gripper, reusing cached geometries and materials and never creating them every frame; update turns the robot’s wrist slowly and rolls the conveyor; pick calls raycaster.ray.intersectBox on each placed object’s world box and returns the nearest as { id, instance } or null; highlight frames one object with a THREE.BoxHelper and hides it for null; dimension draws one dimension line in the scene between two floor points - a thin line, two end ticks and a Sprite with the label (text drawn on a canvas, about 2 m wide, always facing the camera) - and clearDimensions removes them all. function createCellCamera(width, height) returns an orthographic camera looking down at about 35 degrees, framing the base to fill about 85% of the view, with left-drag to orbit, right-drag or Shift-drag to pan and the wheel to zoom, as { camera, attach(dom), resize(w, h), setTop(bool) }, where setTop(true) glides to a straight-down plan view and back. A HemisphereLight (sky #eef4ff, ground #97a1ad, intensity 0.6) and a DirectionalLight (#fff4e6, intensity 2.4) whose soft shadows cover the model; scene.background is a studio grey-blue #c6ced8, darker than the base, and there is no fog, since the camera stands far off and fog would whiten the model; surfaces are light grey (#e7ebf0 to #f3f5f8, roughness about 0.75) so the model keeps its shading. mergeGeometries joins only geometries that are all non-indexed with the same attributes: pass it geometry.toNonIndexed() of every part.', 6200),
      'Cell scene code', 'Runs as pasted; every object is drawn at its measured size, and a click hits one object'),
    n('hud', 'Planner interface code', 'frontend', 2, 1,
      sizedCode('Write the planner’s interface module in plain DOM with its CSS as a string, no framework; every label is in English, and every figure is set in a system monospace stack (ui-monospace, SFMono-Regular, Menlo, Consolas, monospace) with font-variant-numeric: tabular-nums, under its own small uppercase label so no label runs into its value. function createPlanner(root, handlers) builds the whole interface in root: a title "Ridgeline Logistics - Pick-and-pack cell" with the line "All sizes and masses are measured asset figures" beside it; a controls panel (aisle width as a range 2.0-4.0 m in 0.1 steps showing its value, rack rows 2-4, aisle vehicle forklift or pallet jack, robot floor arm or collaborative, gripper 14 kg or 6 kg class), each calling handlers.onPlan(change); a checks panel listing every check from runChecks as a row of a status dot (green pass, red fail, amber unknown), its title, its value against its limit and its workings in small type, with an unknown check’s note shown in full; a bill of materials table (object, count, size, mass each, mass total, holder and licence) with the cell’s total mass in its foot, scrollable and never cut off; an inspector card, closed until something is clicked, showing a clicked object’s name, footprint, height, mass, rigid-body count, how many the plan places, its holder and licence, and its figure note where PROPS has one, with a close control; and buttons "Plan view" (handlers.onTopView()), "Dimensions" (handlers.onDimensions(), which toggles the lane and bay dimension lines) and "Reset plan" (handlers.onReset()). It returns { setPlan(plan), setChecks(list), setBom(summary), showObject(id, props, layout, count), hideInspector(), setTopView(bool), setDimensions(bool), notice(text) }: setChecks redraws the rows and a one-line summary ("8 pass, 1 fail, 2 to source"); notice shows a short message for 3 seconds. Every element takes pointer events only for itself and never covers the scene’s clicks; the panels fit windows 900-1920 pixels wide, and on a window under 1200 the bill of materials collapses behind a toggle. Name only system font stacks in font-family, and never link or @import a font.', 6000),
      'Planner interface code', 'Runs as pasted; controls, checks with their arithmetic, the bill of materials and the inspector are all there, with no overlapping text'),
    n('page', 'Cell planner', 'frontend', 3, 0,
      assembleR186('Assemble the five upstream modules into the complete planner page: in the one module script, after the import lines, paste PROPS / FIGURE_NOTES / PALETTE, LAYOUT, runChecks / planSummary, createCell / createCellCamera and createPlanner as delivered, and write only the few dozen lines that connect them: create the renderer (shadows on, devicePixelRatio capped at 2), the scene and the composer; plan = { ...LAYOUT.defaults }; cell = createCell(scene, PROPS, LAYOUT) and cell.setPlan(plan); cam = createCellCamera(width, height) attached to the canvas, the RenderPass using cam.camera; planner = createPlanner(an interface layer in document.body, handlers), then one apply() that calls cell.setPlan(plan), planner.setPlan(plan), planner.setChecks(runChecks(plan, PROPS, LAYOUT)) and planner.setBom(planSummary(plan, PROPS, LAYOUT)), redraws the dimension lines when they are on (the lane widths, a bay’s span and the gate) and refreshes an open inspector card; requestAnimationFrame calls cell.update by real elapsed time with dt clamped to 0-0.1 s and renders through the composer. A click on the scene (pressed and released within 5 pixels) calls cell.pick and, for a hit, planner.showObject with the count from planSummary and cell.highlight; a click on nothing closes the inspector and clears the highlight. handlers: onPlan(change) merges the change into plan and calls apply(); onTopView() toggles cam.setTop and planner.setTopView; onDimensions() toggles the dimension lines; onReset() puts plan back to LAYOUT.defaults and applies. Keys: T for the plan view, D for the dimensions. Resize the camera, renderer and composer with the window. The page opens with the default plan already drawn, checked and listed - never an empty frame or a loading state.'),
      'Cell planner HTML', 'Opens on a drawn, checked plan; every control re-lays the cell and recomputes the checks; clicking an object shows its measured figures', 'html'),
    n('review', REVIEW_TITLE, 'review', 4, 0,
      review('Check the HTML source against the measured prop table and the check module item by item: whether every figure in PROPS matches the table in the props task exactly (list any that do not, with the code), whether any size, mass or capacity appears in the page that is not in PROPS or computed from it, each check’s arithmetic against its stated rule, that bayCapacity and robotReach are unknown rather than pass, that the two implausible masses are kept and marked, whether every object is drawn at its own measured size, whether the controls re-lay the cell and recompute the checks, the inspector, the bill of materials with holder and licence for every placed object, the import map, the environment map and the bloom chain, and any external library or request other than the three.js r186 modules AwwO supplies. '),
      REVIEW_OUTPUT, KEPT_APART),
  ],
  edges: [e('props', 'layout', 'Measured footprints'), e('props', 'checks', 'Measured figures'),
    e('props', 'cell', 'Measured figures and palette'), e('layout', 'cell', 'Cell layout'),
    e('props', 'hud', 'Measured figures and figure notes'), e('checks', 'hud', 'The checks and their shape'),
    e('props', 'page', 'Measured prop data'), e('layout', 'page', 'Cell layout'), e('checks', 'page', 'Plan check module'),
    e('cell', 'page', 'Cell scene code'), e('hud', 'page', 'Planner interface code'),
    e('props', 'review', 'Measured prop table'), e('checks', 'review', 'Check rules'), e('page', 'review', 'Page source')],
};
```

## What is already verified

The card and the canvas above were applied to a working tree on 2026-10-24 and checked, then taken
back out so the tree stays green until the run:

- `npm run typecheck:saas --prefix apps/web`: 0 errors (`three`, `fflate` and `pdfjs-dist` had to be
  installed first - they are declared but were missing from this checkout's `node_modules`).
- `saas-production-workflows`: passes, including the DAG rule. The first draft failed it - it wired
  `props -> layout` and `layout -> checks` inside one stage, and every handoff must cross into a later
  stage - which is why the canvas now has five stages and shares the layout's shape as a const.
- `saas-production-cases-placement`: passes with the card where the draft puts it.
- Still failing, as they must until the case runs: `saas-production-cases` (no `cell-real.mp4` or
  `.jpg` under `apps/web/showcase/`) and `saas-production-copy` (one case without a published record).
- Re-checked against `4701d91d` after a rebase onto the current `main`, where `PRODUCTION_WORKFLOWS`
  now folds in the flagship and epic workflows: `CELL` goes into that same list
  (`[CAR, CELL, CIRCUIT, …, ...PUBLISHED_FLAGSHIPS.map(…), ...PUBLISHED_EPICS.map(…)]`).
- Still applies at `a1373063` (2026-10-24 afternoon): neither `productionWorkflows.ts` nor
  `productionCatalog.ts` has moved upstream since the patch was made, so it is still a clean apply.
- An adversarial review of the `physical-props` skill found three rules that were also wrong in these
  tasks, now corrected here: a bay's levels are a floor level and two beam levels (0.59 m of load on the
  lower two, 0.69 m on the top, 0.10 m spare), a 1.00 m pallet overhangs a 0.70 m frame by 0.15 m each
  side so the aisle is measured from the load, and `robotReach` is unknown for *either* robot, since an
  arm reaches above its own height - being taller or shorter than a deck settles nothing.

## Running it

1. **Apply** the card and the canvas above. A patch of exactly the text above, taken from the tree it
   was tested in, is kept outside the repository at
   `E:/KiroCrew/awwo-simready-20261024/out/robot-cell-case.patch` (`git apply` it; re-checked against
   `a1373063`). It can also be retyped from the two code blocks above, which are the source of truth.
   The two failures above are expected until step 5; nothing is committed yet.
2. **Run** the case on production in the operator's workspace, on the openai-agents runtime with
   Claude Opus 5.5 at the published limits (200,000-token context, 32,000 output tokens, thinking on,
   one model call per node), driven from a browser signed in as the owner, as the other 23 records
   were.
   - **The local private stack cannot do this run from this machine.** It was built and proved out on
     2026-10-24 up to the model call itself: private PostgreSQL, the Go API, the openai-agents worker
     on Node 24 offering `bedrock.claude-opus-5-5`, authenticated, with the canvas created and the
     graph started. Every node then failed, because Bedrock refuses **streaming** Anthropic calls from
     this egress: `ValidationException` - *"Access to Anthropic models is not allowed from unsupported
     countries, regions, or territories"* - for the `global.` and `us.` profiles alike, while a
     **non-streaming** `Converse` with the same credentials succeeds. AwwO streams every run. The
     production host (UCloud Tokyo) is unaffected. Details and the five other gates that had to be
     cleared first are in the `awwo-local-case-run-geoblock` memory; the working kit is in
     `E:/KiroCrew/awwo-simready-20261024/tools/`.
   - The documented local alternative,
     `AWWO_SHOWCASE_EMAIL=… AWWO_SHOWCASE_PASSWORD=… node scripts/showcase/run-production-cases.mjs --api <url> --out <dir> --cases robot-cell --runtime openai-agents --model bedrock.claude-opus-5-5`,
     is therefore only usable where Anthropic allows streaming (the email and password are values the
     caller chooses: it registers the account on the private stack).
3. **Check** the delivered page in a real browser the way AwwO's preview runs it, and write down only
   what was observed, defects included:
   - every check's arithmetic against the figures by hand - the aisle (vehicle width + 2 x the stated
     clearance), the bay fit (2 x 1.21 m in 3.10 m, and the 0.15 m overhang past the 0.70 m frame), the
     levels (0.59 / 0.59 / 0.69 m with 0.10 m spare) and the gripper payload (carton and crate yes,
     62 kg pallet no);
   - the aisle slider at 2.0 and at 4.0: the aisle check turns red and green with the right numbers;
   - the vehicle, robot and gripper switches, and the rack-row count: the cell re-lays and every check
     recomputes;
   - `bayCapacity` and `robotReach` stay **amber**, each naming what to source - a pass there is the
     defect this case exists to avoid;
   - clicking several objects shows their measured figures, including a figure note on the floor sign
     and the desk; the bill of materials lists holder and licence for every placed prop;
   - the plan view (T) and the dimensions (D).
4. **Publish** with `node scripts/showcase/publish-run.mjs <raw.json> <notes.json>`. Every field below
   is required except `model`, and all prose is English:
   ```json
   {
     "note": "what happened in the run, failures included, and how many runs of this canvas text there were",
     "verification": "what the browser check in step 3 actually observed",
     "edition": "production, the operator's workspace",
     "source": { "api": "<api commit that ran>", "worker": "<worker commit that ran>" },
     "thinking": true,
     "model": "Claude Opus 5.5",
     "limits": { "contextWindow": 200000, "maxOutputTokens": 32000, "modelCallsPerNode": 1, "concurrency": 4 }
   }
   ```
5. **Record** the cover: a screen recording of the delivered page played with scripted input - the
   aisle slider moving and a check flipping is the shot that says what this case is - as
   `apps/web/showcase/cell-real.mp4` with its `.jpg` poster.
6. **Commit** the canvas, the card, the footage and the record together, then run
   `npm run test:saas --prefix apps/web` (it covers every `saas-production-*` suite),
   `npm test --prefix apps/web` and the Go suite. The known environmental failure here is the Windows
   symlink `EPERM` test in `saas-team-market-agents`.

## What a first run will probably need

The canvas is a first draft; several landed cases needed two or three runs before their text was
right, and their records say so. The likely corrections, in order:

- **The layout node** has the hardest job: it must place about forty objects from their own footprints
  without overlaps, at any aisle width and row count the reader can choose. If its first run overlaps
  or crosses a lane, give it the row and lane coordinates outright instead of asking it to derive them.
- **`checks` wording.** A model asked for an `unknown` verdict tends to turn it into a pass with a
  caveat. The acceptance criteria already name it; if a run still passes those two, add the exact
  verdict strings to the task.
- **Module sizes.** `cell` at 6,200 and `hud` at 6,000 characters plus three data modules come to about
  23,000, inside `assembleR186`'s 36,000-character page. If the page is cut off, split `hud` into a
  controls-and-checks half and a materials-and-inspector half, as the larger cases do.
- **The r186 look.** The exposure, environment strength and bloom threshold are the EV plant's, found
  by trial on a white diorama (exposure 1.0, environment 0.25, bloom above 1.4, no fog). A pale cell
  should hold at those numbers; if it blows out, that case's record notes are the place to look.

## Where this sits

- The capability half, shipped: `backend/internal/app/skills/physical-props.md`, a built-in skill any
  member's node can attach, carrying the same measured figures and the same rules (metres, arithmetic
  from the props, mass as the asset's own figure, a bill of materials with holder and licence).
- Provenance and licences: the paragraph in `THIRD_PARTY_NOTICES.md` dated 2026-10-24.
- A case node cannot attach a skill (`OfficialWorkflowNode` has no skills field), which is why this
  canvas carries the figures in its own tasks. That is also better for a case: a member who copies it
  can read every figure the delivery was held to.
