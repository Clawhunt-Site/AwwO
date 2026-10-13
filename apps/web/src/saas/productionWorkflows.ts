import type { AgentTemplateId } from '../canvas/agentTemplates';
import type { OfficialWorkflow, OfficialWorkflowNode } from './examples/officialWorkflows';
import type { OfficialMediaNode } from './examples/officialMedia';

/** The canvases behind the homepage production cases (productionCatalog.ts). Each one is a real
 * workflow: `createOfficialDocument` compiles it into the canvas a member can copy, and the run
 * records in production-runs/ are what AwwO delivered when it ran. Every case is English, in both
 * interface languages. The tasks are sized for Claude Opus 5.5 — one model call per node and at most
 * 32,000 output tokens — so each build is one complete, polished HTML file whose look is held to the case
 * cover: three.js r128 for 3D (the one library AwwO's previews supply), everything else drawn in code. The
 * knowledge-base case ran on 2026-09-04 with its own canvas, which recordedCanvases.ts keeps as it ran. */
const n = (id: string, title: string, role: AgentTemplateId, column: number, row: number,
  task: string, output: string, acceptance: string, outputType?: 'html'): OfficialWorkflowNode =>
  ({ id, title, role, column, row, task, output, acceptance: [acceptance], ...(outputType ? { outputType } : {}) });
const e = (from: string, to: string, label: string) => ({ from, to, label });

const THREE_R128 = '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>';
const BUILD_RULES = '\nDelivery: one HTML file of at most 16,000 characters. This is a hard limit: this node makes one call of at most about 32,000 output tokens, the model’s thinking before it writes counts against them too, and a page that runs past it is cut off and lost, so finishing comes first — write all the way to the final </html>, dropping decoration rather than leaving the page unfinished. The plan, data and code are settled upstream; this step only implements and assembles them into the page: do not redesign the plan or deliberate at length before writing — start writing. Keep the code compact: generate repeated geometry, particles and interface with functions and loops, with no comments or blank lines, and never copy upstream explanations into the page. Use three.js r128 for 3D, referenced only by this one line: ' + THREE_R128 + ' (AwwO replaces it with its own built-in copy of that release, so the page stays self-contained and needs no network — the platform’s delivery rule against external libraries or scripts does not apply to this one line; THREE.CapsuleGeometry is available when a capsule is needed). Never paste the source of three.js or any other library into the page, and never write a WebGL renderer from scratch. Apart from that, no external scripts, module imports, fonts, images or audio files, and no localStorage, cookies or network requests — generate textures on a canvas. The look must reach the commercial key-art standard of this case’s cover: complete lighting and depth (ambient and key light, soft shadows, fog or depth of field), detail and material quality, fluid motion and particles — never wireframes, grey models or diagrams. The page runs inside an iframe: it shows the full scene as soon as it opens; keys work once the page is clicked; it fits its window (filling it with no scrollbars, the render size following the window, mouse positions converted by the displayed size, devicePixelRatio capped at 2). Check silently before answering and do not write the checks out: every {, ( and [ is closed, fixing unbalanced upstream code first; upstream code is reused as delivered, never wrapped in another try/catch; code that runs before the first user action (such as a draw loop) never reads an object that does not exist yet, such as an AudioContext not created yet; animate with requestAnimationFrame by real elapsed time. Output only the HTML document itself, from <!DOCTYPE html> to </html>, with nothing before or after it.';
const build = (task: string) => task + BUILD_RULES;
// Three-dimensional cases split the work so no single call has to think through and write the whole piece: an upstream
// node delivers the three.js scene as code, and the build only pastes it and wires the page around it. One model call
// holds at most 32,000 output tokens and Opus 5.5's own thinking counts against them, so a build that also designs the
// scene runs out before </html>.
const ASSEMBLY_RULES = BUILD_RULES.replace('at most 16,000 characters', 'at most 24,000 characters')
    .replace('The plan, data and code are settled upstream; this step only implements and assembles them into the page: do not redesign the plan or deliberate at length before writing — start writing.',
      'This step only assembles: paste the 3D code delivered upstream exactly as delivered — never rewritten, trimmed or wrapped again — and write only the page structure, the interface, the interaction and the code that connects the modules. Do not redesign the look or deliberate at length before writing — start writing.');
const assemble = (task: string) => task + ASSEMBLY_RULES;
// For upstream nodes that deliver three.js code the build pastes: the code uses the global THREE and stays compact.
const SCENE = 'The code uses the global THREE (three.js r128, THREE.CapsuleGeometry available), references no external resource and generates textures on a canvas; keep it compact, with no comments. Output only the code, at most 10,000 characters.';
const scene = (task: string) => code(`${task} ${SCENE}`);
// Where one scene module was still too much for a single call (the port's diorama, the glider's world), the scene is
// split into two smaller modules, and the build that pastes both gets more room so it never trims them to fit.
const HALF_SCENE = SCENE.replace('at most 10,000 characters', 'at most 7,000 characters');
const halfScene = (task: string) => code(`${task} ${HALF_SCENE}`);
const WIDE_ASSEMBLY = ASSEMBLY_RULES.replace('at most 24,000 characters', 'at most 28,000 characters');
const assembleWide = (task: string) => task + WIDE_ASSEMBLY;
// For nodes whose code the build pastes as delivered: a defect here ships in the page.
const CODE = 'The code must run as pasted: every bracket closed and no ellipses; nothing runs by itself at the top level (no top-level setInterval, no reads of objects not created yet) — callers invoke it when needed.';
const code = (task: string) => `${task} ${CODE}`;
const STATIC = 'If you can only read the source, say “not actually run”; list confirmed items, defects found (with the relevant code) and unverified items, at most 350 words.';
const review = (task: string) => task + STATIC;
const KEPT_APART = 'Static review and actual execution are kept strictly apart';
const AUDIO_LATE = 'The AudioContext is created only after the first user action';
const REVIEW_TITLE = 'Review', REVIEW_OUTPUT = 'Review record';

const PIXEL: OfficialWorkflow = {
  id: 'pixel-platformer',
  title: 'Pixel platformer · Fox Courier',
  brief: 'Make a pixel-art platformer level, “Fox Courier”, held to the look of a high-end indie pixel game: a golden-hour sky market where wooden stalls on floating islands carry red-and-white and yellow-and-white striped awnings, paper lanterns and potted flowers, vines hang under the rock, and towered islands and banks of cumulus fill the distance. A fox with a blue mailbag runs and jumps across rooftops and floating stalls, collects 3 letters, then touches the mailbox at the end to win. ←/→ or A/D to move, Space/↑/W to jump, R to restart; spikes or falling off the screen return the fox to the last checkpoint; show letters collected and elapsed time. All pixel graphics are drawn in code; deliver one HTML file that plays directly in the browser.',
  nodes: [
    n('design', 'Gameplay and tuning', 'general', 0, 0,
      'Define the core loop, controls, win/lose and restart rules, and give numbers that go straight into code: 16-pixel tiles; a 480×270 internal canvas scaled up by an integer factor; a level 90 tiles wide and 17 tiles high with a camera that follows the fox horizontally, leading ahead and smoothing; gravity, run speed, acceleration and ground friction, jump velocity with variable jump height (releasing the key cuts the rise), max fall speed, coyote time and jump buffering (in pixels/frame at 60 fps); the rules for 2 checkpoints. Describe the HUD, the title screen and the delivery/win screen. Use lists and a table, at most 400 words.',
      'Gameplay spec and tuning table', 'Numbers can go straight into code; one jump clears a 3-tile step and a 4-tile gap'),
    n('art', 'Pixel art', 'materials', 1, 0,
      'Design a palette of at most 24 colours (hex, keyed 0–9 and a–n; warm golden-hour light, purple-leaning shadows) and give 12 sprites and tiles as 16×16 character art: fox standing, running (2 frames) and jumping (with a blue mailbag), letter, mailbox, spike, checkpoint flag, stone ground (top with moss), wooden plank platform, striped awning and paper lantern. Each sprite is 16 strings of length 16 using palette keys, with . for transparent; the code mirrors sprites for direction. Add at most 6 sentences on the three parallax background layers: a sky from gold to pale blue, distant towered islands in silhouette, mid-ground cumulus with dithered shading — and the lanterns’ warm glow. Output only an object that can be pasted into JavaScript, and those notes.',
      'Palette and sprite grids', 'Exactly 12 sprites, each 16×16, using only palette keys'),
    n('levels', 'Level map', 'data', 1, 1,
      'Using the tuning, design a 17-row × 90-column tile map as an array of strings: # stone ground, = plank platform, A awning roof (standable), ^ spike, L letter (exactly 3), M mailbox, S start, C checkpoint (exactly 2), T lantern (decoration, not standable), . air. Three stretches from left to right: rooftop street, floating stalls (with gaps and spikes in the middle), and a high post-office platform with the mailbox at the far right; make sure every letter and the mailbox can be reached from S with the given jump numbers. Add at most 5 lines of reachability notes. Output only the map array and the notes.',
      'Tile map and reachability notes', 'Every row is exactly 90 characters; exactly 3 L and 2 C; one S and one M'),
    n('sound', 'Sound effects', 'materials', 1, 2,
      code('Synthesize chiptune sound with the Web Audio API: jump, letter pickup, checkpoint, delivery/win and fail/restart effects, plus an 8-bar looping background tune (square-wave lead over a triangle bass, about 132 BPM). Give a JavaScript snippet with sfx(name) and music(on) that create the AudioContext only after the first user action and build every sound from oscillators and gain envelopes, loading no audio files. At most 45 lines.'),
      'Synthesized music and effects', AUDIO_LATE),
    n('build', 'Playable level', 'frontend', 2, 0,
      build('Assemble the tuning, sprites, level map and sound into a complete playable game: a 480×270 canvas scaled up by an integer factor with CSS (image-rendering: pixelated), sprites pre-rendered 1:1 to offscreen canvases at 16 pixels per tile; the camera smoothing as specified; the three parallax layers as the art notes describe; lanterns swaying with a warm glow, letters sparkling with pickup particles, dust on landing, and a running fox that flips with its direction; tile collision (horizontal then vertical), letter pickups, a delivery animation and win screen when the mailbox is touched with all letters, spikes or falling returning to the last checkpoint; a HUD in a pixel font drawn in code with letters and time; a title screen “press any key”, and R to restart. Listen for keys on window and handle movement and jumping from a key-state table. Pad map rows shorter than 90 columns with .. Reuse the upstream map, sprites and sound exactly as delivered.'),
      'Playable level HTML', 'Movement, jumping, collision, pickups, checkpoints, winning and restarting all work', 'html'),
    n('review', 'Playtest review', 'review', 3, 0,
      review('Check the HTML source against the gameplay spec and the level map item by item: keys, variable jump height, whether a 3-tile step and a 4-tile gap can be cleared, collision tunnelling, the camera, the letter count, checkpoints, the win condition, R to restart, whether the look follows the art plan, and any external request. '),
      REVIEW_OUTPUT, KEPT_APART),
  ],
  edges: [e('design', 'art', 'Screen size and sprites needed'), e('design', 'levels', 'Tuning and level rules'), e('design', 'sound', 'Sound list'),
    e('design', 'build', 'Gameplay and tuning'), e('art', 'build', 'Palette and sprites'), e('levels', 'build', 'Level map'), e('sound', 'build', 'Sound code'),
    e('design', 'review', 'Acceptance criteria'), e('build', 'review', 'Game source')],


};

const CONFIGURATOR: OfficialWorkflow = {
  id: '3d-configurator',
  title: '3D configurator · Orvia e-bike',
  brief: 'Build a web 3D configurator for a city e-bike from the fictional brand Orvia (step-through frame, battery inside the down tube, mid motor, rear rack, fenders, headlight), held to the look of a premium product site’s studio shot: a soft gradient from white on the left to warm on the right, a lacquered frame with clear-coat highlights, matte tyres, metal spokes and disc brakes, and a soft shadow under the bike. 4 frame colours (coral, mint, sky blue, graphite), 2 batteries (standard / long range), 2 saddles (sport / comfort) and an optional front basket; round swatches and options sit on the right like a product site; drag to rotate, scroll to zoom, double-click to reset; the look updates live, and price and range follow the options (sample prices, labelled “sample” on the page). Render live with three.js r128 and deliver one HTML file.',
  nodes: [
    n('product', 'Options and pricing', 'general', 0, 0,
      'List every option: 4 frame colours (coral, mint, sky blue, graphite; names and hex values), batteries (range in km and price delta), saddles, the front basket (price delta); give the base price, the pricing formula, the format of the summary on the page and the order of the option groups on the right. Prices are samples and must be labelled “sample prices” on the page. Use a table, at most 200 words.',
      'Option table and pricing rules', 'Every option has a price or range effect; the pricing formula is unambiguous'),
    n('modelling', '3D bike structure', 'data', 1, 0,
      'Describe the whole bike with parameters three.js can build directly: x forward, y up, z sideways, in centimetres, with the origin on the ground midway between the wheels. Give two wheels (centre, radius about 35, tyre width about 5.5, rim section, a crossed lacing of 32 spokes, disc radius), the path of every step-through frame tube (3–5 control points and a diameter each, for TubeGeometry: head tube, curved down tube, seat tube, chain stays, seat stays, fork), the battery inside the down tube (standard and long-range lengths), the mid-motor housing, cranks, chainring and chain, handlebar, stem and grips, headlight, rear rack, front and rear fenders (arc radius, start and end angles, width), two saddles and the front basket (size and mesh). Give every part an id, a geometry type and the option that controls it. Output only data that can be pasted into JavaScript, at most 45 lines.',
      '3D geometry data', 'Proportions look like a real city e-bike (a wheelbase of about 110 cm); every optional part maps to an option'),
    n('rendering', 'Bike and stage code', 'frontend', 2, 0,
      scene('From the geometry and the option table, write three.js r128 code. function createBike() returns { group, setFrameColor(hex), setBattery(kind), setSaddle(kind), setBasket(on), update(dt) }: every frame tube as TubeGeometry through the geometry’s control points, MeshPhysicalMaterial with clearcoat; wheels with matte tyres, metal rims, 32 spokes and disc brakes; battery, motor, cranks and chain, handlebar and grips, headlight, rear rack, fenders, both saddles and the front basket built from the data, optional parts switched with visible, and colour changes blended over 300 ms in update. function createStage(renderer, scene, camera) sets ACESFilmic tone mapping and sRGB output, a PMREMGenerator environment from a procedurally built soft-light room, a HemisphereLight plus one DirectionalLight with soft shadows, a ShadowMaterial floor that shows only the shadow and a soft gradient background from white on the left to warm on the right, with a default camera on the bike’s right about 15° above showing the whole bike, and returns { resize(w, h) }.'),
      'Bike and stage code', 'Runs as pasted: calling the two functions shows the whole bike with its materials and lighting'),
    n('frontend', 'Configurator page', 'frontend', 3, 0,
      assemble('Assemble the option table and the upstream bike and stage code into the complete page: paste createBike and createStage as delivered and call them for the bike and the lighting; write drag to rotate, wheel to zoom and double-click to reset, all smoothly interpolated; stack round colour swatches and the battery, saddle and basket options on the right like a product site, calling setFrameColor, setBattery, setSaddle and setBasket; show a brand wordmark, a model name and a line or two of selling copy, plus a live price, range and chosen options computed from the option table, labelled “sample prices”, in refined, airy typography.'),
      '3D configurator HTML', 'Every option really changes the view or the price; rotation and zoom work', 'html'),
    n('review', 'Delivery review', 'review', 4, 0,
      review('Check the HTML source against the option table and the geometry: whether each option changes the view and the price, pricing against the formula, range figures, rotation and zoom, double-click reset, whether shadows and materials follow the plan, the “sample prices” label, and any external library or request other than three.js r128. '),
      REVIEW_OUTPUT, KEPT_APART),
  ],
  edges: [e('product', 'modelling', 'Parts and options'), e('modelling', 'rendering', 'Geometry data'), e('product', 'rendering', 'Colours and appearance'),
    e('product', 'frontend', 'Options and prices'), e('modelling', 'frontend', 'Geometry data'), e('rendering', 'frontend', 'Bike and stage code'),
    e('product', 'review', 'Acceptance criteria'), e('frontend', 'review', 'Page source')],


};

const PAPER: OfficialWorkflow = {
  id: 'papercraft-puzzle',
  title: 'Papercraft puzzle · Paper Path',
  brief: 'Make a papercraft puzzle, “Paper Path”, held to the look of a fine paper-sculpture miniature: a paper board floating before a sky-blue backdrop, surrounded by paper windmills, a red-roofed cottage, pointed trees, gears and a waterwheel, clouds and rolling paper hills, under soft studio light that shows the thickness, creases and shadows of the paper; each press of Q/E (or ←/→, or on-screen buttons) turns the whole board 90°; gravity always points down, so the blue glass marble rolls until something stops it, and the level is won when it reaches its home hole; 3 levels from easy to hard, a move counter, reset for the current level, and the next level after a win. Render live with three.js r128 and deliver one HTML file.',
  nodes: [
    n('design', 'Puzzle rules', 'general', 0, 0,
      'Define the rules: a 9×9 grid; cell types (paper wall, empty, marble start, home); after each 90° turn the marble keeps moving in the direction of gravity until a wall stops it, and passing over or stopping on home wins; move counting, reset and the next level; difficulty targets for the 3 levels (solutions of about 2, 3 and 4 moves). At most 250 words.',
      'Rules and level goals', 'Rotation, rolling and winning are unambiguous'),
    n('art', 'Paper scene code', 'frontend', 1, 0,
      scene('From the rules, write three.js r128 paper-scene code in cream, kraft, sage, brick red and sky blue. function createPaperWorld(scene) builds the paper world before a sky-blue backdrop: a HemisphereLight plus one DirectionalLight with soft shadows and fog, rolling paper hills, pointed trees, a red-roofed cottage, turning windmills, meshing gears that turn together, a waterwheel and clouds, with a paper-grain texture generated on a canvas, and returns { update(t) } turning the windmills, gears and wheel and drifting the clouds. function createBoard(grid, cell) builds, from a 9×9 grid (# paper wall, H home, anything else a channel), a thick card base, pale paper channels, walls as rounded-bevel extrusions (ExtrudeGeometry, with thin light and dark creases on the edges) and a paper cottage at the home doorway, and returns { group, cellToLocal(r, c), setHomeLit(on) }. function createMarble(radius) returns a blue glass bead with a highlight and refraction (MeshPhysicalMaterial).'),
      'Paper scene code', 'Runs as pasted and needs no images'),
    n('levels', 'Three levels', 'data', 1, 1,
      'Design 3 levels of 9×9 by the rules, each as 9 strings of length 9: # paper wall, . empty, O marble start, H home; the outer ring is all wall. For each level give a working solution (such as E,E,Q) and its move count, and list where the marble stops after each move to prove it is solvable (at most 6 lines per level). Output only the level arrays and the solutions, with no design notes or deliberation; if a layout does not check out, switch to a simpler one instead of revising it again and again. At most 50 lines in all.',
      'Level data and solutions', 'Every level is exactly 9×9 with one O and one H; each solution can be replayed step by step'),
    n('sound', 'Paper sounds', 'materials', 1, 2,
      code('Synthesize three sounds with the Web Audio API: turning (filtered noise, like paper rubbing), the marble coming to rest (a soft knock) and winning (a bright chord). Give sfx(name) in JavaScript that creates the AudioContext only after the first user action and loads no audio files, at most 20 lines.'),
      'Synthesized sound function', AUDIO_LATE),
    n('physics', 'Rotate-and-roll algorithm', 'backend', 2, 0,
      code('From the rules and the level format, write pure functions: rotate(grid, dir) turns the grid 90° clockwise or counter-clockwise (the marble and home turn with it), and roll(grid, pos) moves the marble down until a wall stops it, returning a win if it passes home. Use them to replay every level’s solution and write the marble’s position after each step. At most 25 lines of code and 10 lines of checks.'),
      'Algorithm code and step-by-step checks', 'All three solutions win when replayed with these functions'),
    n('build', 'Playable puzzle', 'frontend', 3, 0,
      assemble('Assemble the levels, the rotate-and-roll algorithm, the paper scene code and the sounds into a complete game: paste the upstream createPaperWorld, createBoard and createMarble, the level data and the algorithm as delivered; Q/E, ←/→ and on-screen buttons turn the whole board 90° about the view axis (eased over about 350 ms), after which the marble rolls smoothly cell by cell to where the algorithm stops it; show the move count; on a win the marble rolls into the doorway, setHomeLit(true) is called and paper confetti falls, then the next level begins; R or a button resets the level; show an ending after all three levels. Make the text and buttons look like paper cut-outs matching the scene.'),
      'Playable puzzle HTML', 'Turning, rolling, winning, resetting and changing levels all work', 'html'),
    n('review', REVIEW_TITLE, 'review', 4, 0,
      review('Check the HTML source against the rules and the solutions: whether turn direction matches the keys, whether rolling tunnels through walls, whether passing home wins, the move count, reset, level changes, whether the three levels match upstream, whether the scene follows the paper plan, and any external request other than three.js r128. '),
      REVIEW_OUTPUT, KEPT_APART),
  ],
  edges: [e('design', 'art', 'Visual elements'), e('design', 'levels', 'Rules and difficulty goals'), e('design', 'sound', 'Sound list'),
    e('design', 'physics', 'Movement rules'), e('levels', 'physics', 'Levels and solutions'), e('design', 'build', 'Rules and flow'),
    e('levels', 'build', 'Level data'), e('physics', 'build', 'Rotate-and-roll code'), e('art', 'build', 'Paper scene code'), e('sound', 'build', 'Sound code'),
    e('levels', 'review', 'Solutions'), e('build', 'review', 'Game source')],


};

const AD: OfficialWorkflow = {
  id: 'summer-ad',
  title: 'Summer sparkling-drink ad · Blood orange',
  brief: 'Pre-produce a 30-second summer ad for a fictional brand’s blood-orange sparkling drink, with a 3D animatic held to the look of a premium drinks commercial: under a clear blue sky and bright sun, a dewy blood-orange can bursts out of a splash while blood-orange slices, mint leaves and ice cubes tumble through the air and bubbles and droplets sparkle; a blood-orange palette, high impact, fast cuts. Deliver the script, a 10-shot storyboard, an edit timing sheet to 0.1 s (exactly 30.0 s in total), a grade, and a 30-second 3D animatic that plays in the browser (three.js rendering the can, slices, mint, ice, splash particles and camera moves live for every shot). The brand and slogan are fictional; do not generate, or claim to have filmed or generated, real footage.',
  nodes: [
    n('script', 'Script', 'materials', 0, 0,
      'Write the concept, a fictional brand name and one slogan (marked “fictional”), the voice-over and on-screen supers, the music style and BPM, and split the 30 seconds into 4 parts: 0–3 s hook, 3–15 s product, 15–25 s peak, 25–30 s end card. At most 250 words.',
      'Script and beat structure', 'The four parts add up to exactly 30 s; brand and slogan are marked fictional'),
    n('boards', 'Storyboard', 'materials', 1, 0,
      'From the script, write a 10-shot storyboard table: shot number, duration (seconds, one decimal), framing, what is on screen, camera move and on-screen text. The 10 durations add up to exactly 30.0 s. Use a table, at most 300 words.',
      '10-shot storyboard', 'Exactly 10 shots totalling 30.0 s'),
    n('edit', 'Edit timing sheet', 'general', 2, 0,
      'From the storyboard and the script’s BPM, make the edit sheet: each shot’s in and out (running time, one decimal), the transition (cut, whip, flash…), the beat it lands on, and a sound cue. The last row gives the total, which must be 30.0 s. Use a table, at most 250 words.',
      'Edit timing sheet', 'In and out points are contiguous and total exactly 30.0 s'),
    n('grade', '3D props and lighting code', 'frontend', 2, 1,
      scene('From the script and the storyboard, write three.js r128 code in blood orange, deep red, ice white and sky blue. function createCan() returns a dewy blood-orange can (grooves, ring pull and metal lid, a label with the brand wordmark and slogan drawn on a canvas, crisp highlights on the metal body). function createSlice(), createMint() and createIce() return a blood-orange slice with a canvas flesh texture, a mint leaf and a translucent ice cube. function createSplash(scene) returns { burst(origin, power), update(dt) }, splashing water, droplets and rising bubble particles. function createStudio(renderer, scene) sets ACESFilmic tone mapping, a blue-sky gradient background, a sun key light with glow, ambient light and fog, and returns { setMood(name) }, switching light and colour across the script’s four parts (hook, product, peak, end card).'),
      '3D props and lighting code', 'Runs as pasted; the palette follows the parts'),
    n('animatic', 'Animatic', 'frontend', 3, 0,
      assemble('Assemble the storyboard, the edit sheet and the upstream 3D props and lighting code into a 30-second 3D animatic player: paste createCan, createSlice, createMint, createIce, createSplash and createStudio as delivered; play the 10 shots in order at exactly the edit sheet’s in and out points, each staging the props as storyboarded with its own camera position, framing and move (push, pull, orbit, slow motion, whip), with the edit sheet’s transitions and setMood for each part; make the supers and the end-card wordmark refined typographic animations; provide play/pause, a draggable timeline, the current shot number and timecode, replay at the end, and jump the picture to the dragged moment at once. Do not present it as the finished film.'),
      'Playable 3D animatic HTML', 'Total length 30.0 s; shot changes match the edit sheet', 'html'),
    n('review', REVIEW_TITLE, 'review', 4, 0,
      'Check the storyboard, the edit sheet and the animatic source: exactly 10 shots, storyboard and edit durations matching and totalling 30.0 s, the animatic’s shot changes matching the edit sheet, use of the grade palette, the brand and slogan marked fictional, and no illustration presented as real footage. If you can only read the source, say “not actually played”; list passed items, defects and unverified items, at most 300 words.',
      REVIEW_OUTPUT, 'Durations are checked line by line; static review and actual playback are kept apart'),
  ],
  edges: [e('script', 'boards', 'Script and beats'), e('script', 'edit', 'BPM and parts'), e('boards', 'edit', 'Shots and durations'),
    e('script', 'grade', 'Mood and colour'), e('boards', 'grade', 'Picture content'), e('boards', 'animatic', 'Shot content'),
    e('edit', 'animatic', 'Edit sheet'), e('grade', 'animatic', '3D props and lighting code'), e('boards', 'review', 'Storyboard'), e('edit', 'review', 'Edit sheet'),
    e('animatic', 'review', 'Animatic source')],


};

const PORT: OfficialWorkflow = {
  id: 'port-twin',
  title: '3D port cockpit',
  brief: 'Turn a fictional port into a 3D cockpit held to the look of a fine isometric miniature diorama: quays and roads on a white rounded base, rows of pastel containers in the yards, white gantry quay cranes and yard cranes, berthed container ships, trucks coming and going and rows of green trees, and a softly reflective sea; the scene has 3 berths, 4 quay cranes, 6 container-yard blocks and ships coming and going; every 2 seconds the simulation advances — ships arrive, berth and work, then leave, and crane moves and yard occupancy change with them; the scene and a metrics panel move together; click a ship or crane for details; pause and speed up; label the page “simulated data”. Render live with three.js r128 and deliver one HTML file.',
  nodes: [
    n('layout', 'Port layout', 'data', 0, 0,
      'Describe the port in grid coordinates: the quay line, 3 berths (numbered 0–2, position and length), 4 quay cranes (numbered 0–3, their berth and rail range), 6 yard blocks (numbered 0–5, position, size, capacity in TEU, rows, bays and tiers each), roads and truck routes, the channel and anchorage, ship size classes and green belts. Give the 3D scene’s scale (metres per grid cell) and the heights of cranes, ships and containers. Output only one const LAYOUT = {…} object that can be pasted into JavaScript, written compactly with no comments, at most 3,000 characters.',
      'Scene geometry data', 'No objects overlap; every crane sits on a berth'),
    n('sim', 'Simulation model', 'data', 0, 1,
      code('Write a reproducible simulation: a seeded random generator (such as mulberry32), a ship state machine (waiting at anchorage → berthing → working → departing), one tick every 2 seconds, crane rates (moves per hour), rules for yard occupancy, and metrics: berth occupancy, crane moves, yard occupancy, ships waiting, throughput so far today. Give pure JavaScript init(seed) and step(state): the state holds ships (id, phase, berth 0–2, load), cranes (0–3, their berth, whether working), yards (occupancy of blocks 0–5), metrics, and events, a list of what happened this tick as text. Write it compactly, at most 2,500 characters.'),
      'Simulation code and metric definitions', 'The same seed gives the same result; occupancy never exceeds 100%'),
    n('yard', 'Quay and yard code', 'frontend', 1, 0,
      halfScene('From the layout, write three.js r128 quay and yard code held to the look of a fine isometric miniature diorama. function createYard(scene, layout) builds a white rounded base (with thickness and soft edges), light-grey quays with road markings, a gently swelling, reflective blue-green sea and rows of round green trees, the six yard blocks’ pastel containers as InstancedMesh (doors and corrugation painted on a canvas texture), six trucks running back and forth along the roads, and a HemisphereLight plus a DirectionalLight whose soft shadows cover the whole diorama, with light fog; it returns { setOccupancy(block, ratio), update(dt) }, with new containers dropping into place as occupancy rises and lifting away as it falls. function createIsoCamera(width, height) returns an orthographic isometric camera with drag to pan and wheel to zoom as { camera, attach(dom), resize(w, h) }.'),
      'Quay and yard code', 'Runs as pasted; container counts follow occupancy'),
    n('fleet', 'Crane and ship code', 'frontend', 1, 1,
      halfScene('From the layout and the simulation code, write three.js r128 crane and ship code in the same fine miniature style as the diorama. function createFleet(scene, layout) builds four white gantry quay cranes (legs, girders, boom, trolley, spreader and cables) and container ships (dark hulls with red bottoms, white bridges and rows of coloured containers on deck); it returns { apply(state), update(dt), pick(raycaster), highlight(target) }: apply reads the state after a simulation step and sets each ship’s goal (sailing from the anchorage to its berth, working alongside, departing out of view) and whether each crane works; update interpolates smoothly between ticks — ships sail and turn along their routes, and working cranes run their trolleys and raise and lower their spreaders to move containers; working, waiting and alarm show as coloured halos under each object. pick never raycasts the model meshes (a gantry crane is an open frame, so a ray slips between its girders to the ship behind): it calls raycaster.ray.intersectBox on each crane’s and each ship’s overall bounding box (new THREE.Box3().setFromObject(object)) and returns the hit nearest the ray’s origin as { type: "ship" or "crane", id }, or null when nothing is hit; highlight(target) frames the target with one THREE.BoxHelper and hides it for null. The interface and the method are settled: do not deliberate at length before writing — start writing, and finish first.'),
      'Crane and ship code', 'Runs as pasted; clicks hit a specific ship or crane'),
    n('frontend', 'Cockpit page', 'frontend', 2, 0,
      assembleWide('Assemble the layout, the simulation code, the quay and yard code and the crane and ship code into the complete cockpit: paste the upstream LAYOUT, init/step, createYard, createIsoCamera and createFleet as delivered; call step with setInterval every 2 seconds (at the chosen speed), handing each block’s occupancy to setOccupancy and the state to apply, with requestAnimationFrame only calling the two modules’ update and drawing; a frosted-glass metrics panel (berth occupancy, crane moves, yard occupancy, ships waiting and throughput today, with small sparklines) and an event log showing state.events; clicking the scene uses pick to hit a ship or crane, opens a details card and highlights it; pause and 1×/4× speed; and a prominent “simulated data” label.'),
      '3D cockpit HTML', 'Scene, metrics and log change together with the simulation', 'html'),
    n('review', REVIEW_TITLE, 'review', 3, 0,
      review('Check the HTML source against the simulation code: whether the simulation advances every 2 seconds, metrics against their definitions, occupancy bounds, whether container counts follow occupancy, click details, pause and speed, the “simulated data” label, and any external library or request other than three.js r128. '),
      REVIEW_OUTPUT, KEPT_APART),
  ],
  edges: [e('layout', 'yard', 'Scene geometry'), e('layout', 'fleet', 'Berth and crane positions'), e('sim', 'fleet', 'Simulation state'),
    e('layout', 'frontend', 'Layout data'), e('sim', 'frontend', 'Simulation code'), e('yard', 'frontend', 'Quay and yard code'),
    e('fleet', 'frontend', 'Crane and ship code'), e('sim', 'review', 'Metric definitions'), e('frontend', 'review', 'Page source')],


};

const GLIDER: OfficialWorkflow = {
  id: 'glider-adventure',
  title: 'Cloud-sea glider adventure',
  brief: 'Make a playable glider adventure, “Cloud-Sea Glide”, held to the sky of a Japanese animated film: a golden sea of clouds laced with pink and pale blue at sunset, floating grassy islands in the distance with ruined stone arches, small windmills and waterfalls, and flocks of birds; the player flies a white paper glider (the pilot’s red scarf streaming in the wind) over the clouds in a third-person chase view; holding Space, the mouse or a touch pitches up to climb, releasing dives to gain speed, and ←/→ or A/D steer; flying through glowing updrafts restores height and light orbs between the islands score points; hitting an island or touching the clouds ends the run, showing distance, score and the best result since the page was opened, with an instant restart. Render live with three.js r128 and deliver one HTML file.',
  nodes: [
    n('design', 'Flight feel and generation', 'general', 0, 0,
      'Give a 3D flight model that goes straight into code (metres and seconds): forward speed, gravity, lift and pitch rate while holding, drag, dive acceleration and top speed, bank angle and turn rate when steering; how far ahead and how far apart islands, updrafts and orbs spawn and their random ranges, and how difficulty grows with distance; collision (islands as bounding spheres or cylinders), scoring, game over and restart rules. Make it float: with no input the glider needs at least 6 seconds to drift from take-off height to the clouds, and the first 10 seconds are survivable. Use lists and a table, at most 300 words.',
      'Flight and generation spec', 'Numbers can go straight into code; the first 10 seconds are survivable'),
    n('sky', 'Sky and cloud code', 'frontend', 1, 0,
      halfScene('From the flight spec, write three.js r128 sky and cloud code held to the sky of a Japanese animated film. function createSky(scene) builds a large sky sphere (a canvas gradient texture, clear cyan-blue overhead warming downward to a golden glow at the horizon on the sun’s side; its material uses fog: false and depthWrite: false), a low sun with a soft glow sprite, a warm DirectionalLight as the key light plus a HemisphereLight, and linear fog that only fades the distance (near no less than 120 m, far about 900 m, coloured like the horizon) so the foreground stays crisp and contrasty; the sea of clouds is mainly a large subdivided plane whose vertices undulate slowly by noise, with vertex colours shading it from gold and cream white on the sunlit side to pale blue-violet in shadow, drifting billboard cloud puffs on top (soft-edged cloud textures generated on a canvas, depthWrite: false), towering cumulus in the distance, every translucent sprite at least 30 m from the camera, and flocks of birds (small V-shaped meshes with flapping wings). It returns { update(t, camera) }: the sky, the cloud sea, the cumulus and the birds follow the camera horizontally and wrap around, so the clouds always reach the horizon on an endless flight.'),
      'Sky and cloud code', 'Runs as pasted; crisp up close, fading into the distance'),
    n('world', 'Island and glider code', 'frontend', 1, 1,
      halfScene('From the flight spec, write three.js r128 island, glider and prop code. Get the low-poly look from MeshStandardMaterial with flatShading: true (r128’s MeshLambertMaterial has no flatShading). function createGlider() returns { group, update(dt, speed, bank) }: a white paper glider (triangular wings and body with light crease lines), the pilot lying on it (brown hair, green top), and a red scarf as a ribbon of points streaming with speed. function createIsland(rand, size) generates a floating island from the random function rand and returns { group, radius, update(t) }: low-poly rock with jittered vertices (warm grey and ochre, tapering downward into an inverted cone), a bright green grassy top, a few round-crowned trees, a ruined stone arch or a turning windmill chosen by rand, and waterfall particles spilling over the edge. function createUpdraft() returns { group, radius, update(t) }: a ring of slowly rising glowing particles around a very faint column (opacity at most 0.07, normal blending), visible from afar and never washing out the frame when flown through. function createOrb() returns { group, update(t) }: a golden orb with a glow sprite.'),
      'Island and glider code', 'Runs as pasted; island radii match the collision spec'),
    n('sound', 'Sound', 'materials', 1, 2,
      code('Synthesize with the Web Audio API: a wind loop that follows speed (filtered noise), a whoosh on entering an updraft, a bright chime for orbs, a thud on crashing, and a soft ambient chord bed. Give JavaScript startWind(), setWind(speed) and sfx(name) that create the AudioContext only after the first user action and load no audio files, at most 35 lines.'),
      'Synthesized sound code', AUDIO_LATE),
    n('build', 'Playable build', 'frontend', 2, 0,
      assembleWide('From the flight spec, assemble the sky and cloud code, the island and glider code and the sound code into the complete game: paste the upstream createSky, createGlider, createIsland, createUpdraft, createOrb and the sound functions as delivered; use one state variable for three phases, ready → fly → over, updating and drawing the current phase every frame: on the ready screen the camera slowly circles the glider waiting above the clouds with “hold Space to take off”, and pressing Space, the mouse or a touch starts fly; in fly the glider moves by the spec’s 3D flight model (hold to climb, release to dive, ←/→ or A/D to steer and bank) with a smooth third-person chase camera about 6 m behind and 1.8 m above it, the glider filling about a quarter of the frame width; islands, updrafts and orbs spawn ahead by the spec and are recycled once behind, with no island ahead in the first 3 seconds; flying through an updraft restores height with its sound, and orbs score; hitting an island or touching the clouds goes to over, which shows distance, score and the best result for this page visit (kept in a variable only), and Space or a click takes off again at once; a corner shows score, distance, speed and height.'),
      'Playable glider game HTML', 'Climbing, diving, steering, updrafts, scoring, game over and restart all work', 'html'),
    n('review', REVIEW_TITLE, 'review', 3, 0,
      review('Check the HTML source against the flight spec: hold and release parameters, steering, whether updrafts restore height, orb scoring, island and cloud collisions, whether the start is survivable, whether the best result stays in memory only, whether restart clears state, whether the upstream 3D code is used as delivered, and any external request other than three.js r128. '),
      REVIEW_OUTPUT, KEPT_APART),
  ],
  edges: [e('design', 'sky', 'Scene elements'), e('design', 'world', 'Sizes and collision'), e('design', 'sound', 'Sound cues'),
    e('design', 'build', 'Flight and generation spec'), e('sky', 'build', 'Sky and cloud code'), e('world', 'build', 'Island and glider code'),
    e('sound', 'build', 'Sound code'), e('design', 'review', 'Acceptance criteria'), e('build', 'review', 'Game source')],


};

const PARTY: OfficialWorkflow = {
  id: 'party-game',
  title: 'Party game · Ice Fish Frenzy',
  brief: 'Make a four-player couch party game, “Ice Fish Frenzy”, held to the look of a 3D animated short: a round ice floe with sparkling edges floats on a clear turquoise sea, and four round penguins in knit hats of different colours (mint, coral, yellow and sky blue, each with a pom-pom) slide around grabbing fish, kicking up ice spray as they slide and splashing when they fall in; small icebergs, a flag, a buoy and seagulls sit in the distance. Rounds last 60 seconds; penguins have momentum and little friction, bounce apart when they collide, and respawn in the centre 2 seconds after falling off; fish keep leaping onto the ice at random, a normal fish scores 1 and a golden fish 3; key sets WASD / arrows / IJKL / numpad 8-4-5-6, and 2–4 players can be chosen at the start; when time runs out show the ranking and offer another round. Render live with three.js r128 and deliver one HTML file.',
  nodes: [
    n('design', 'Rules and keys', 'general', 0, 0,
      'Define the round flow (choose players, a 3-second countdown, a 60-second round, results), the four key sets, scoring (normal fish 1, golden fish 3), fish spawn rate and cap, falling and respawn rules, ties, and the layout (the floe in the middle under an angled overhead camera; four scoreboards in the corners, coloured by hat). At most 250 words.',
      'Rules and flow', 'Flow, scoring and keys do not conflict'),
    n('characters', 'Character and scene code', 'frontend', 1, 0,
      scene('From the rules, write three.js r128 character and scene code. function createPenguin(hatColor) builds a round penguin from CapsuleGeometry and spheres (black body, white belly and face, orange beak and feet, short flippers, and a knit hat with a pom-pom from a canvas rib texture) and returns { group, setMotion(speed, heading), hit(), update(dt) }, leaning forward while sliding, waddling while walking and squashing and rebounding when hit. function createIceWorld(scene, radius) builds a round floe with a jagged edge, a snow-white top and translucent ice-blue sides, a swelling, glinting turquoise sea, and small icebergs, a flag, a buoy and circling seagulls in the distance, with a HemisphereLight plus a soft-shadowed directional light and light fog, and returns { update(t) }. function createFish(golden) returns a silver or metallic-gold fish. function createEffects(scene) returns { spray(x, z), splash(x, z), update(dt) }, the ice-spray and splash particles. The four hats are mint, coral, yellow and sky blue.'),
      'Character and scene code', 'Runs as pasted; the four players are easy to tell apart'),
    n('physics', 'Ice physics', 'backend', 1, 1,
      code('Write a pure JavaScript physics update step(penguins, input, dt): input acceleration, low-friction decay (exponential in dt), top speed, elastic circle–circle collisions (with separation so they never stick), off-ice detection and respawn timers. Give the constants and the code, at most 30 lines.'),
      'Physics code and constants', 'Penguins never stick after collisions; the feel holds at varying frame rates'),
    n('sound', 'Sound', 'materials', 1, 2,
      code('Synthesize with the Web Audio API: catching a fish (a short rising blip), a golden fish (a brighter chord), a bump (a low thud), a splash (water noise), and the countdown and final whistle. Give sfx(name) in JavaScript that creates the AudioContext only after the first user action and loads no audio files, at most 20 lines.'),
      'Synthesized sound function', AUDIO_LATE),
    n('build', 'Four-player build', 'frontend', 2, 0,
      assemble('Assemble the rules, the ice physics, the character and scene code and the sound into a complete game with one state variable for four phases, menu → countdown → play → end, updating and drawing the current phase every frame: paste the upstream physics, createPenguin, createIceWorld, createFish, createEffects and the sound as delivered; an angled overhead camera, which slowly circles the floe on the menu, where keys 2, 3 and 4 choose the number of players (default 4) and Space starts; the countdown shows a big 3, 2, 1 and then play begins; play lasts 60 seconds with all four key sets active at once (a keydown/keyup state table), penguins sliding and colliding by the physics code (physics coordinates mapped onto the floe), fish leaping onto the ice in arcs, score pop-ups on pickups, ice spray while sliding and splashes on falling in, respawn in the centre 2 seconds after falling off, and corner scoreboards in each hat colour; on the end screen the winning penguin jumps to celebrate and the ranking shows, and Space clears the scores for another round.'),
      'Four-player game HTML', 'Several players can press keys at once without interfering; scores and ranking are right', 'html'),
    n('review', REVIEW_TITLE, 'review', 3, 0,
      review('Check the HTML source against the rules: whether all four key sets work at once (a keydown/keyup state table), player selection, bouncing without sticking, falling and respawn, normal and golden fish scores, the 60-second timer, ranking and ties, whether play-again clears state, whether the look follows the character plan, and any external request other than three.js r128. '),
      REVIEW_OUTPUT, KEPT_APART),
  ],
  edges: [e('design', 'characters', 'Characters and layout'), e('design', 'physics', 'Movement and falling rules'), e('design', 'sound', 'Sound cues'),
    e('design', 'build', 'Rules and flow'), e('characters', 'build', 'Character and scene code'), e('physics', 'build', 'Physics code'), e('sound', 'build', 'Sound code'),
    e('design', 'review', 'Acceptance criteria'), e('build', 'review', 'Game source')],


};

const RHYTHM: OfficialWorkflow = {
  id: 'rhythm-runner',
  title: 'Rhythm runner · Key Dash',
  brief: 'Make a rhythm-runner level, “Key Dash”, held to the look of a 3D animated runner: a girl in a yellow hoodie and headphones races down a giant piano-key road stretching to the horizon (third-person chase view), with bright futuristic city towers and clouds on both sides, confetti in the air and glowing note gems hovering over the keys; WebAudio synthesizes a 120 BPM drum kit and piano melody live, and the keys light up and dip on the beat; obstacles land on the beat — jump black-key gaps with Space/↑ and slide under low note bars with ↓; every action is judged Perfect / Good / Miss with combo and score, and after 45 seconds the results show, with a restart. Render live with three.js r128 and deliver one HTML file.',
  nodes: [
    n('design', 'Beats and judging', 'general', 0, 0,
      'Define: 120 BPM, 90 beats in 45 seconds; obstacle types (gaps to jump, bars to slide under) and which beats they fall on; judgment windows (Perfect ±60 ms, Good ±120 ms, otherwise Miss), combo and scoring formulas; the running speed on the 3D road (metres per second) and the conversion “an obstacle reaches the runner exactly on its beat” (an obstacle’s z = (beat time − songTime) × speed); jump and slide durations; start, results and restart. At most 250 words.',
      'Beat and judgment spec', 'Judgment windows and scoring can be implemented as written'),
    n('art', 'Piano-key visuals', 'materials', 1, 0,
      'Give a three.js r128 look: the piano-key road (white and black key sizes, rounded edges and materials, lighting up with emission and dipping on the beat), black-key gaps and glowing note bars, floating spinning note gems (emissive with a glow); the running girl from basic shapes (yellow hoodie and hood, black skirt, ponytail, headphones, trainers) with joint angles for run, jump and slide poses; futuristic city towers on both sides (colourful segmented cylinders, ring balconies, glowing windows), clouds and a fading distance; confetti particles; lighting (hemisphere light, key light and shadows), fog and grading; a background pulsing with the beat; on-screen animation for the judgment words (Perfect / Good / Miss) and the combo; a palette (hex). Write steps and parameters that can be followed directly, at most 300 words.',
      'Look and parameters', 'The parameters go straight into three.js r128'),
    n('music', 'Music and chart', 'materials', 1, 1,
      code('Write JavaScript: startMusic() creates the AudioContext on the first user action and runs a lookahead scheduler on its clock that synthesizes kick, snare and hi-hat (oscillators and noise) and a simple piano melody; songTime() returns 0 before the start and afterwards the seconds since the first beat (from AudioContext.currentTime, never below 0); export a chart array listing which of the 90 beats hold a gap and which hold a bar (leave the first 8 beats empty to warm up, and at least 2 beats between obstacles). Create the AudioContext only after the first user action and load no audio files, at most 35 lines.'),
      'Synthesized music and chart code', 'AudioContext.currentTime is the master clock; the chart follows the spacing rules'),
    n('build', 'Playable level', 'frontend', 2, 0,
      build('Assemble the complete game: on the start screen the camera swoops from high over the city down to the start of the road, and music starts on the start key; render the piano-key road, the city on both sides, confetti and note gems as the look describes, the girl running, jumping and sliding with smooth transitions, and a third-person chase camera that sways slightly with the beat; obstacle positions are computed from the chart and songTime() (not accumulated frames), and the keys light up on the beat; Space/↑ jumps and ↓ slides; Perfect / Good / Miss pop-ups by the judgment windows, with combo and score and sparkles on a Perfect; a results screen after 45 seconds and a restart. Reuse the upstream music and chart code exactly as delivered.'),
      'Rhythm runner HTML', 'Obstacles land on the beat; judging, combo and results work', 'html'),
    n('test', 'Rhythm testing', 'review', 3, 0,
      'Check rhythm sync specifically: whether the game uses AudioContext.currentTime as the master clock, whether obstacles reach the runner exactly on their beats, whether the windows are ±60/±120 ms, whether pausing or switching tabs desynchronizes it, and whether restart resets the clock and chart. Give evidence for each point (quote code); if you can only read the source, say “not actually run”; at most 250 words.',
      'Rhythm sync test record', 'Every finding cites code'),
    n('review', REVIEW_TITLE, 'review', 4, 0,
      'Make the final review from the beat spec, the rhythm test record and the HTML source: list confirmed features, open defects (including whether the test record’s issues hold), unverified items, and conclude whether it can ship as a playable level. If you can only read the source, say “not actually run”; at most 250 words.',
      'Review verdict', 'The verdict matches the evidence; static review is never called a playtest'),
  ],
  edges: [e('design', 'art', 'Visual elements'), e('design', 'music', 'Beat and chart rules'), e('design', 'build', 'Judging and flow'),
    e('art', 'build', 'Look'), e('music', 'build', 'Music and chart code'), e('design', 'test', 'Judging rules'), e('build', 'test', 'Game source'),
    e('design', 'review', 'Acceptance criteria'), e('build', 'review', 'Game source'), e('test', 'review', 'Test record')],


};

// Media cases: the canvas's image and video nodes generate the pictures and the clip in the same run, and the build
// lays them out. createOfficialDocument wires each media node into the build as a soft `media_<id>` input that lists
// the stored files as `<node id>/<file name>` paths; the case dialog shows the published page with those files inlined.
const MEDIA_RULES = '\nMedia: the pictures and the clip the canvas’s media nodes generated are listed in the inputs by their relative paths, `<node id>/<file name>`; they are this canvas’s own files, not external images or video. Use those paths exactly as given, and only in <img src>, <video src> or <source src>, a video’s poster or a CSS url() — AwwO’s preview replaces them with the real files; never build or rewrite them in JavaScript strings (they would not be replaced), and when script needs a picture, read it from the <img> element that shows it. Every video is muted autoplay loop playsinline and fills its frame with object-fit: cover. Never invent a file name the inputs do not list; where a file was not generated, a gradient with particles stands in for it and the page still works. The look is a film poster or a leading brand’s site: the media themselves fill the screen, under refined Chinese and English typography, gradient masks, glow, particles and transitions; the content moves in full-screen acts and starts animating as soon as the page opens. This page needs no 3D.';
const mediaBuild = (task: string) => build(task + MEDIA_RULES);
const CLIP: OfficialMediaNode['params'] = { aspectRatio: '16:9', duration: 5, resolution: '720p', generateAudio: false, thinking: false };
const WIDE: OfficialMediaNode['params'] = { aspectRatio: '16:9', resolution: '2K' };
const PORTRAIT: OfficialMediaNode['params'] = { aspectRatio: '3:4', resolution: '2K' };
const media = (id: string, kind: 'image' | 'video', title: string, row: number, prompt: string, params = kind === 'video' ? CLIP : WIDE): OfficialMediaNode =>
  ({ id, kind, title, prompt, model: kind === 'video' ? 'xt.xtasy-v3' : 'xt.seedream-5-pro', params, column: 0, row, feeds: ['page'] });
const NEON_LOOK = 'cyberpunk film look, magenta-violet and cyan neon interwoven, mirror reflections on wet streets after rain, volumetric light and thin mist, shallow depth of field, film grain, cinematic grade, ultra detailed, no text or watermark';
const neonShot = (shot: string) => `${shot}, ${NEON_LOOK}`;

const NEON: OfficialWorkflow = {
  id: 'neon-city',
  title: 'Neon City · A rainy future metropolis',
  brief: 'Make a cinematic full-screen interactive brand page, NEON CITY: a fictional future city whose lights never go out on a rainy night. It opens on a full-screen looping clip of the city under a huge neon title, “霓虹之城”, with a slight glitch flicker, rain particles falling in front and a glow following the mouse; then three full-screen chapters — Rooftop Garden, Underground Night Market and Dawn — each filled with its picture under a slow push-in and mouse parallax, with a chapter number, Chinese and English titles and two lines of poetic copy. ← →, the wheel, clicks on either side or the dots below switch acts, and after 8 idle seconds the next one comes; acts change under a sweeping band of light; a sound toggle at the top right synthesizes a low ambience with Web Audio after the first click. The city and the brand are fictional.',
  nodes: [
    n('page', 'Full-screen brand page', 'frontend', 1, 0,
      mediaBuild('Assemble the opening clip and the three chapter pictures into a complete full-screen interactive brand page: the clip fills the screen and loops under a large sans-serif title with a neon outline glow and a glitch flicker; a canvas in front draws slanting rain and splashes; the mouse position drives a soft glow; each of the three chapters fills the screen with its own picture under a slow 1.0→1.08 push-in and ±12 px mouse parallax, with the chapter number (01/02/03), Chinese and English titles and two lines of copy set at the bottom left; acts change as a diagonal band of light sweeps across and the picture switches behind it; ←/→, the wheel, clicks on either side or the dots below switch acts, after 8 idle seconds the next one comes, and the dots with a progress bar show the current act and the countdown; a sound toggle at the top right (the AudioContext is created only after the first click) synthesizes a low ambience.'),
      'Full-screen brand page HTML', 'All four media files are used by their given paths; switching, autoplay, parallax and the sound toggle really work', 'html'),
    n('review', REVIEW_TITLE, 'review', 2, 0,
      review('Check the page source point by point against the task: all four media files used by their given paths, the opening clip filling the screen and looping, the act switching (keys, wheel, side clicks, dots, the 8-second idle advance), push-in and parallax, the light-sweep transition, the rain particles and the sound toggle really working, and the page complete within 16,000 characters. Use a list of at most 200 words; say where any problem is.'),
      REVIEW_OUTPUT, KEPT_APART),
  ],
  edges: [e('page', 'review', 'Brand page source')],
  media: [
    media('clip', 'video', 'Opening shot', 0, neonShot('a slow cinematic dolly shot down a future city street on a rainy night: towers on both sides hung with magenta and cyan neon signs, the wet road mirroring the neon, a streamlined maglev train gliding along an elevated track, rain glinting in the light, a few people with clear umbrellas crossing in front of the camera, a distant tower blinking in the mist')),
    media('rooftop', 'image', 'Rooftop garden', 1, neonShot('a rooftop garden high above the future city at night, a glass greenhouse full of glowing plants under strings of coloured lights, a figure in a trench coat leaning on the railing looking out, dense neon towers and gliding aircraft behind')),
    media('market', 'image', 'Underground night market', 2, neonShot('an underground night market of the future city, narrow alleys packed with steaming food stalls, red lanterns layered over neon signs, holographic ads projected on damp walls, a bustling crowd, steam rising through the light')),
    media('dawn', 'image', 'Dawn', 3, neonShot('the whole future city seen from high above at dawn, a pink-orange glow on the horizon, the rain just stopped, the first sunlight breaking through the clouds, the neon fading out, glass towers reflecting the sunrise')),
  ],
};

const GUOFENG_LOOK = 'Eastern fantasy in a Chinese style, a painterly illustration blending fine-line gongbi and ink wash, blue-green landscape palette with touches of gold, swirling clouds and mist, soft light, an open composition, ultra detailed, no text or watermark';
const guofeng = (shot: string) => `${shot}, ${GUOFENG_LOOK}`;

const SHANHAI: OfficialWorkflow = {
  id: 'shanhai-vn',
  title: 'Tales of Mountains and Seas · Qingqiu',
  brief: 'Make a playable chapter of a Chinese-fantasy interactive visual novel, Tales of Mountains and Seas · Qingqiu: the young swordsman Yunchuan enters Qingqiu for a cure and meets Bailing, a nine-tailed fox girl, in the fox forest. The title screen plays a full-screen shot of immortal mountains above a sea of clouds with “Press any key to start”; the story uses the classic visual-novel layout: a full-screen background, portraits fading in from the sides, a translucent dialogue box at the bottom typing out each line (click or Space to finish or advance), and a name plate, with the scene name spreading like an ink stroke at each change. There are 3 scenes (a town in the clouds, the Qingqiu fox forest, the Kunlun temple), one two-way choice in the fox forest leading to two different endings, and an ending screen with its name and “Play again”. Auto-play and sound toggles sit at the top right; after the first click Web Audio synthesizes a pentatonic, guqin-like melody. The story and the characters are fictional.',
  nodes: [
    n('script', 'Script and branches', 'materials', 0, 0,
      'Write this chapter’s script data for the page to use as is: output one JSON code block shaped {scenes:{id:{bg,lines:[{who,text}],choice?:[{text,to}],next?}},endings:{id:{title,text}}}. bg is one of town, forest, temple; who is one of Yunchuan, Bailing or Narrator; 22–26 lines across the 3 scenes, each at most 25 words; the fox-forest scene ends in a two-way choice, each option leading to an ending; the style is classical yet easy to read, with suspense and feeling. Output only that JSON code block.',
      'Script JSON', 'The JSON parses as is; the three scenes, the one choice and both endings can all be reached'),
    n('page', 'Visual-novel chapter', 'frontend', 1, 0,
      mediaBuild('Assemble the opening clip, the three scene pictures, the two portraits and the upstream script JSON into a playable visual novel: the title screen plays the opening clip full screen under a large vertical title and “Press any key to start”; in the story the scene picture fills the background under a slow push-in, and portraits fade in from the left or right by speaker (a CSS mask-image radial gradient blends their light backgrounds into the scene, about 85% of the viewport tall) while the silent one dims; the dialogue box at the bottom is translucent frosted glass with a name plate and types each line out, a click or Space completing it first and then advancing; scene changes run an ink-wash mask spreading in a ring and show the scene name; a choice shows two centred buttons; the ending screen shows the ending’s name, its text and “Play again”. Auto and sound toggles at the top right (the AudioContext is created only after the first click; it synthesizes a pentatonic guqin-like melody). Embed the script JSON exactly as delivered.'),
      'Visual-novel chapter HTML', 'All six media files are used by their given paths; dialogue, the choice, both endings and Play again really work', 'html'),
    n('review', REVIEW_TITLE, 'review', 2, 0,
      review('Check the page source point by point against the task: all six media files used by their given paths, the script JSON embedded as delivered, typing out and completing lines, portraits fading in and dimming, the ink-wash transition, the choice, both endings and Play again, and the auto and sound toggles really playable, and the page complete within 16,000 characters. Use a list of at most 200 words; say where any problem is.'),
      REVIEW_OUTPUT, KEPT_APART),
  ],
  edges: [e('script', 'page', 'Script JSON'), e('page', 'review', 'Page source')],
  media: [
    media('opening', 'video', 'Opening shot', 1, guofeng('the camera drifts slowly through a churning sea of clouds to reveal blue-green immortal mountains and waterfalls floating above them, flocks of white cranes gliding past, the golden roof of an ancient hall on the peak catching the morning light, mist flowing in front of the lens')),
    media('town', 'image', 'Town in the clouds', 2, guofeng('an old town built on cliffs above the clouds, wooden pavilions stacked in tiers hung with red lanterns and wind chimes, winding stone steps, a distant waterfall falling out of the clouds, warm evening light')),
    media('forest', 'image', 'Qingqiu fox forest', 3, guofeng('the Qingqiu fox forest under the moon, ancient peach trees and glowing fireflies, a stream shimmering blue between the trees, fox-fire drifting in the distance, a mysterious and gentle mood')),
    media('temple', 'image', 'Kunlun temple', 4, guofeng('the Kunlun temple on a snowy summit, white jade steps and a huge bronze cauldron, golden light pouring through a gap in the clouds, a ring of glowing runes floating before the hall, solemn and vast')),
    media('hero', 'image', 'Yunchuan portrait', 5, guofeng('a half-length portrait of a young swordsman, seventeen, in white close-fitting robes with teal trim, long ink-black hair in a high ponytail, an ancient sword on his back, clear and steady eyes, one hand on the hilt, a plain light beige background, centred'), PORTRAIT),
    media('fox', 'image', 'Bailing portrait', 6, guofeng('a half-length portrait of a nine-tailed fox girl, long silver-white hair, fox ears, nine fluffy white tails faintly behind her, a classical ruqun dress in moon white and pale pink, a vermilion dot on her forehead, a lively, slightly sly expression, a plain light beige background, centred'), PORTRAIT),
  ],
};

// 极光 GT: one original car in three colours and a clip of that same car. The pearl-white picture comes first; the two
// colour versions and the clip are made from it (`references`), so the configurator switches, and the clip drives, one
// car. The picture prompts are those of the fourth GT run (2026-10-12): a closed, smooth nose and centreless wheels leave
// no place for an emblem. The clip is a tracking shot that keeps the car at the reference picture's angle: every driving
// clip that let the car turn towards the camera (the fourth run, then three runs of this canvas on 2026-10-13) grew an
// emblem on the bonnet, a ringed three-pointed star in the last three, where the video model fills a front it never saw.
const GT_LOOK = 'premium car advertising photography, cinematic lighting, crisp highlights and reflections on the paint, a low three-quarter front view, a blurred background, ultra detailed, photorealistic, no text or watermark anywhere; no brand mark, emblem, badge, letters or nameplate on the nose, bonnet, wheels, tail or body, the nose and tail clean; an original concept car that looks like no existing car brand';
const gtShot = (shot: string) => `${shot}, ${GT_LOOK}`;

const AURORA: OfficialWorkflow = {
  id: 'aurora-gt',
  title: 'Aurora GT · An electric supercar launch site',
  brief: 'Make a launch site for a new electric supercar, AURORA GT: it opens on a full-screen looping shot of the car racing under the aurora, with a big title, “极光 GT”, and the line “Born for the night”; act two is a configurator where three photo-real pictures of the car at the same angle (pearl white, ruby red, midnight blue) switch with colour swatches under a sweep of light across the body; three clickable detail hotspots on the car (headlight, wheel, rear wing) open spec cards; act three shows performance figures that count up on entry (0–100 km/h in 2.1 s, 720 km of range, 1,020 kW peak power, 400 km in 10 minutes of charging); act four is a test-drive form that checks the name and mobile number and then shows a booking animation (demo data, nothing is sent). ←/→, the wheel or the dots on the right switch acts. The car and the brand are fictional.',
  nodes: [
    n('page', 'Launch site', 'frontend', 1, 0,
      mediaBuild('Assemble the driving clip and the three colour pictures into a four-act full-screen launch site: in act one the clip fills the screen and loops under a vignette gradient carrying a huge thin title, “极光 GT”, the English AURORA GT, a one-line tagline and a button, “Explore the colours”; act two is the configurator: the car picture fills the screen above three colour swatches (pearl white / ruby red / midnight blue), and a new picture fades in under a diagonal sweep of light; three breathing hotspots on the car (headlight, wheel, rear wing) open glass-like spec cards; act three is performance: the current colour’s picture, blurred, behind a dark overlay, with four figures counting up from 0 when they come into view and fine-line graphics; act four is a test-drive form: name, mobile number (an 11-digit check), a city drop-down and a date, and on submit a tick animation and “Booked” (nothing is sent). Navigation dots on the right, ←/→ and the wheel switch acts with a slide and a fade.'),
      'Launch site HTML', 'All four media files are used by their given paths; the colour switch, the hotspots, the counting figures and the form checks really work', 'html'),
    n('review', REVIEW_TITLE, 'review', 2, 0,
      review('Check the page source point by point against the task: all four media files used by their given paths, the opening clip filling the screen and looping, the three-colour switch with its sweep of light, the three hotspots and their cards, the counting figures, the form checks and the success animation, and switching by the dots, keys and wheel really working, and the page complete within 16,000 characters. Use a list of at most 200 words; say where any problem is.'),
      REVIEW_OUTPUT, KEPT_APART),
  ],
  edges: [e('page', 'review', 'Site source')],
  media: [
    { ...media('drive', 'video', 'Driving shot', 0, 'The pearl-white original electric concept supercar from the reference picture races along a lakeside road at night under green and violet auroras. A tracking shot: the camera moves alongside at the car’s speed, so for the whole clip the car keeps the place, size and angle it has in the reference picture (a low three-quarter front view), its nose never turning towards the camera or coming closer, while only the road, the reflections on the lake, the snowy peaks in the distance and the aurora stream past, its lights drawing trails on the slightly wet, reflective road. The car’s shape, the slim light bar across its whole front, the turbine-blade wheels and the pearl-white paint match the reference picture exactly; the bonnet is one continuous mirror of paint, reflecting only the aurora. Premium car advertising photography, cinematic lighting, crisp highlights and reflections on the paint, a motion-blurred background, ultra detailed, photorealistic, no text or watermark in the frame'),
      references: ['white'] },
    media('white', 'image', 'Pearl white', 1, gtShot('An original pearl-white two-door electric concept supercar with a very low wedge body and a closed, smooth nose carrying a single slim light bar across its whole width and no air intake grille; a clean, flat bonnet with no trim; turbine-blade wheels without centre caps; parked by a lake at night under green and violet auroras mirrored in the water, the car clean and whole, centred')),
    { ...media('red', 'image', 'Ruby red', 2, gtShot('Repaint this car in a deep ruby-red metallic, keeping its shape, angle, composition, background, aurora and lighting exactly as they are, still with no emblem, badge, letters or nameplate on the nose or the body')), references: ['white'] },
    { ...media('blue', 'image', 'Midnight blue', 3, gtShot('Repaint this car in a midnight blue with a fine metallic flake, keeping its shape, angle, composition, background, aurora and lighting exactly as they are, still with no emblem, badge, letters or nameplate on the nose or the body')), references: ['white'] },
  ],
};

/** Keyed by production case id. The knowledge-base case is not here: it ran on 2026-09-04 with
 * its own canvas, kept as it ran in recordedCanvases.ts, and its record lives in production-runs/knowledge-base.ts. */
export const PRODUCTION_WORKFLOWS: Readonly<Record<string, OfficialWorkflow>> = Object.fromEntries(
  [NEON, SHANHAI, AURORA, PIXEL, CONFIGURATOR, PAPER, AD, PORT, GLIDER, PARTY, RHYTHM].map(item => [item.id, item]));
