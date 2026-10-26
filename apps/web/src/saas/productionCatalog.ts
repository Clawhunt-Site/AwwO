/** Cases for the homepage, each laid out the AwwO way: the brief, a team of agents in stages, and
 * the deliverable. Every case has a real canvas (productionWorkflows.ts) that ran in AwwO; its record is in
 * production-runs/ and the case dialog
 * shows what each agent delivered. A cover marked `recording` is a screen recording of what that run delivered, played
 * with scripted input; any other cover would be an illustration, and the cards say which it is. Every case is
 * English, in both interface languages (owner 2026-10-14). */
export type ProductionKind = 'product' | 'game' | 'interactive' | 'film' | 'twin';
/** The roles of one stage; they work in parallel. */
type Stage = ReadonlyArray<string>;

export interface ProductionCase {
  id: string;
  kind: ProductionKind;
  /** The cover footage records what the run delivered, not an illustration. */
  recording?: true;
  /** The cover footage is a few seconds of the film the run delivered (a film case), not a screen recording. */
  excerpt?: true;
  title: string;
  brief: string;
  /** Short role names of the canvas's agents, stage by stage; the roles in one stage work in parallel. */
  stages: ReadonlyArray<Stage>;
  /** What the canvas delivers; the card marks it delivered only when the published run did. */
  deliverable: string;
  /** File stem under /showcase/ (.mp4 loop and .jpg poster). */
  footage: string;
}

export const PRODUCTION_KIND_LABELS: Readonly<Record<ProductionKind, string>> = {
  product: 'SaaS product',
  game: 'Game',
  interactive: 'Interactive',
  film: 'Film',
  twin: 'Digital twin',
};

const DESIGN = 'Design', ART = 'Art', LEVELS = 'Levels', CODE = 'Code';
const SOUND = 'Sound', PHYSICS = 'Physics', MODELLING = 'Modelling';
const RENDERING = 'Rendering', FRONT_END = 'Front end', PRODUCT = 'Product';
const REVIEW = 'Review', BACKEND = 'Backend';
/** The media nodes of a stage, shown as one slot of the team: they generate pictures and clips and are not agents. */
export const MEDIA_ROLE = 'Media';
/** A flagship's assembly: a stage member that makes the page from the modules with no model, so not an agent. */
export const ASSEMBLY_ROLE = 'Assembly';
/** A flagship's recorder: a stage member that writes a tool file from its template with no model, so not an agent. */
export const RECORDER_ROLE = 'Recorder';
/** A film's edit nodes: they join clips and sounds into a film by a timeline with no model, so not agents. (Not "Edit":
 * that is an agent of the summer ad, its timing sheet.) */
export const EDIT_ROLE = 'Edit node';
const MEDIA = MEDIA_ROLE;
const NOT_AGENTS: ReadonlySet<string> = new Set([MEDIA_ROLE, ASSEMBLY_ROLE, RECORDER_ROLE, EDIT_ROLE]);
/** The agents of a case's team: its stage members but its media, assemblies, recorders and edits, which run no agent.
 * Each marker is a name no agent of a case takes (tests/saas-production-workflows.test.ts counts every case's agents
 * from its canvas). */
export const agentCount = (item: ProductionCase) => item.stages.reduce((sum, stage) => sum + stage.filter(role => !NOT_AGENTS.has(role)).length, 0);

export const PRODUCTION_CASES: ReadonlyArray<ProductionCase> = [
  // The epic case (epicWorkflows.ts): a game written by twenty agents in sandbox computers from three design specs and
  // the pictures and 3D models its canvas made, assembled with no model and tested and fixed in two passes.
  {
    id: 'pallward', kind: 'game', recording: true, footage: 'pallward-real',
    title: 'PALLWARD',
    brief: 'An original open-world action game in one web page: a moor of graves and candles below a castle, combat with stamina, poise and rests at wakestones, foes and two bosses, and 33 3D models the canvas made, its nine characters rigged and animated; written by twenty agents in sandbox computers and testing itself.',
    stages: [['Game spec', 'Tech spec', 'Art direction'], [MEDIA], [MEDIA], [MEDIA], [MEDIA],
      ['Kernel', 'Renderer', 'Assets', 'Bodies', 'Terrain', 'Landmarks', 'Castle', 'Controls', 'Camera', 'Rigs', 'Combat rules', 'Fighter', 'Bearer', 'Foes', 'Bosses', 'World state', 'Effects', 'Sound', 'HUD', 'Menus'],
      [ASSEMBLY_ROLE], ['Test'], [ASSEMBLY_ROLE], ['Second test'], [REVIEW]],
    deliverable: 'An open-world action game in the browser',
  },
  // The epic film (a recorded canvas, recordedCanvas.ts): its pictures, clips, voices and score made on one canvas, six
  // reels cut by editor agents, joined by edit nodes, which run no model, into three acts and the episode.
  {
    id: 'the-long-chord', kind: 'film', recording: true, excerpt: true, footage: 'long-chord-real',
    title: 'THE LONG CHORD · Episode I',
    brief: 'An original space-opera film in three acts: on Corrow, a world sealed for twenty years, a girl who can still hear the ringing of the universe is found out by the woman who came to silence it, taken up into the ring that seals her world, and rings it open. Every picture, clip, voice and score cue made on one canvas, six reels cut by six editor agents, and the acts and the episode joined with dialogue in sync, score, subtitles and end cards.',
    stages: [[MEDIA], [MEDIA], ['Reel 1 editor', 'Reel 2 editor', 'Reel 3 editor', 'Reel 4 editor', 'Reel 5 editor', 'Reel 6 editor'],
      [EDIT_ROLE, EDIT_ROLE, EDIT_ROLE, EDIT_ROLE, EDIT_ROLE, EDIT_ROLE], [EDIT_ROLE, EDIT_ROLE, EDIT_ROLE], [EDIT_ROLE]],
    deliverable: 'Episode I: a film in three acts with dialogue, score, subtitles and end cards',
  },
  // The films written as code (2026-10-26; recorded canvases too): each answers an Opus 5.5 video prompt from YouMind's
  // collection. A Director writes the brief and the timing sheet, builders in sandbox computers write the kernel, the
  // scenes and the sound, an assembly pastes them into one page with no model, a tester checks it, an editor cuts it
  // into pieces, and the edit node renders the page's picture and sound into the film, with no model.
  {
    id: 'launch-film', kind: 'film', recording: true, excerpt: true, footage: 'launch-film-real',
    title: 'AwwO · launch film',
    brief: 'A launch film for AwwO in the manner of a flagship product film, every frame three.js: a floating display shows the canvas at work as code-drawn interface, with only word-for-word facts on screen.',
    stages: [['Director'], ['Kernel', 'Display and studio', 'Screen interface', 'Camera and cuts', 'Lines and end card', SOUND], [ASSEMBLY_ROLE], ['Test and fix'], ['Editor'], [EDIT_ROLE]],
    deliverable: 'An 18-second launch film with its sound, every frame drawn in three.js',
  },
  {
    id: 'studio-reel', kind: 'film', recording: true, excerpt: true, footage: 'studio-reel-real',
    title: 'AwwO Studio · Showreel',
    brief: 'A 30-second motion-graphics showreel with every graphic made from scratch in code, as if AwwO were a branding studio for startup founders: identities for six invented startups cut to a 128 BPM beat, ending on AwwO’s own mark.',
    stages: [['Director'], ['Kernel', 'Startups 1-3', 'Startups 4-6', 'AwwO Studio frames', SOUND], [ASSEMBLY_ROLE], ['Test and fix'], ['Editor'], [EDIT_ROLE]],
    deliverable: 'A 30-second showreel with its sound, every graphic drawn in code',
  },
  {
    id: 'brass-wolf', kind: 'film', recording: true, excerpt: true, footage: 'brass-wolf-real',
    title: 'Brass Wolf',
    brief: 'A steampunk mechanical wolf, modelled piece by piece in code by one agent and walked by another, crossing the pipes of a boiler room in three.js and ending on a howl.',
    stages: [['Director'], ['Kernel', 'Wolf model', 'Gait and howl', 'Boiler room', 'Steam and light', 'Camera and words', SOUND], [ASSEMBLY_ROLE], ['Test and fix'], ['Editor'], [EDIT_ROLE]],
    deliverable: 'A 20-second three.js film with its sound, the wolf modelled and walked in code',
  },
  {
    id: 'night-island', kind: 'film', recording: true, excerpt: true, footage: 'night-island-real',
    title: 'Night island',
    brief: 'A floating island at night drawn on an HTML canvas from TypeScript: rain, a campfire, moonlight through drifting clouds, and a wolf cub that howls at the moon once in every loop.',
    stages: [['Director'], ['Kernel', 'Sky, moon and mist', 'The island', 'Wolf cub', 'Rain and fire', SOUND], [ASSEMBLY_ROLE], ['Test and fix'], ['Editor'], [EDIT_ROLE]],
    deliverable: 'A 15-second seamless loop with its sound, drawn on an HTML canvas',
  },
  {
    id: 'rings-of-awwo', kind: 'film', recording: true, excerpt: true, footage: 'rings-of-awwo-real',
    title: 'The rings of AwwO',
    brief: 'A data film of AwwO’s own growth: the public repository’s first 51 days and 789 commits drawn as a city of code, district by district and ring by ring.',
    stages: [['Director'], ['Kernel', 'Ground and districts', 'Buildings', 'Rings and timeline', 'Captions', 'Camera', SOUND], [ASSEMBLY_ROLE], ['Test and fix'], ['Editor'], [EDIT_ROLE]],
    deliverable: 'A 64-second data film with its sound, every number from the repository’s history',
  },
  {
    id: 'run-token', kind: 'film', recording: true, excerpt: true, footage: 'run-token-real',
    title: 'Run token',
    brief: 'A beat-synced three.js film: a glowing run token bounces from canvas node to canvas node, lighting each one on the beat, through a cave, along a track and onto a stage, one classical piece for each, with a few jokes on the way.',
    stages: [['Director'], ['Kernel', 'Scene 1: the cave', 'Scene 2: the track', 'Scene 3: the stage', 'Token and camera', 'Speech bubbles', SOUND], [ASSEMBLY_ROLE], ['Test and fix'], ['Editor'], [EDIT_ROLE]],
    deliverable: 'A 48-second beat-synced film with its score, written as code',
  },
  {
    id: 'video-program', kind: 'film', recording: true, excerpt: true, footage: 'video-program-real',
    title: 'A video is a program',
    brief: 'A 12-second seamless loop that explains how AwwO turns a page into a video: an X-ray wolf whose every pose is computed from the frame number, with a frame counter, a contact strip and AwwO’s own render rules on screen.',
    stages: [['Director'], ['Kernel', 'X-ray wolf', 'Counter, strip and tabs', 'Mode lines', SOUND], [ASSEMBLY_ROLE], ['Test and fix'], ['Editor'], [EDIT_ROLE]],
    deliverable: 'A 12-second seamless loop at 60 fps with its sound',
  },
  {
    id: 'canvas-live', kind: 'film', recording: true, excerpt: true, footage: 'canvas-live-real',
    title: 'One canvas, live',
    brief: 'A 20-second live dashboard of a real AwwO canvas run, drawn in code: the Umber photo editor’s 13 nodes, the first run that left three unfinished, the runs that finished them while keeping the rest, and the self-test’s 63 of 64.',
    stages: [['Director'], ['Kernel', 'Canvas graph', 'Prompt and log', 'Header and counters', SOUND], [ASSEMBLY_ROLE], ['Test and fix'], ['Editor'], [EDIT_ROLE]],
    deliverable: 'A 20-second dashboard film of a real canvas run, with its sound',
  },
  // The flagship cases (flagshipWorkflows.ts): large systems written in a clean room by agents that work in sandbox
  // computers, assembled with no model and tested in a real browser.
  {
    id: 'umber-photo', kind: 'product', recording: true, footage: 'umber-real',
    title: 'Umber',
    brief: 'An open-source photo editor in one web page: layers with masks and 27 blend modes, adjustment layers, selection, painting and type tools, live filters and a history, built in a clean room and testing itself.',
    stages: [['Spec'], ['Kernel', 'Interface', 'Compositing', 'Viewport', 'Selection', 'Painting', 'Filters', 'Panels', 'Files'], [ASSEMBLY_ROLE], ['Test'], [REVIEW]],
    deliverable: 'A layered photo editor in the browser',
  },
  {
    id: 'backprop-lab', kind: 'product', recording: true, footage: 'backprop-real',
    title: 'Backprop',
    brief: 'A self-training workbench in one web page: build small neural networks, train them in the browser and watch them learn, on nine datasets from point sets to digits and text, with seven optimizers, live loss and decision boundaries and a table of every run; its engine written in a clean room from evidence about an open-source library, and testing itself.',
    stages: [['Reader'], ['Spec'], ['Kernel', 'Interface', 'Tensors', 'Layers', 'Optimizers', 'Datasets', 'Training', 'Visuals', 'Lab screens'], [ASSEMBLY_ROLE], ['Test'], [REVIEW]],
    deliverable: 'A neural-network training workbench in the browser',
  },
  {
    id: 'errand-agent', kind: 'product', recording: true, footage: 'errand-real',
    title: 'Errand',
    brief: 'An open-source agent workspace in one web page: watch an AI agent work on its own computer, its plan, its messages and every command, file and screenshot, in three real sessions recorded in sandbox computers during the run and replayed on a timeline; take the computer over at any moment, or run the agent live on your own model; designed in a clean room from evidence about an open-source agent workspace, and testing itself.',
    stages: [['Reader', RECORDER_ROLE], ['Spec', 'Site session', 'Data session', 'Search session'], ['Kernel', 'Interface', 'Virtual computer', 'Thread', 'Computer', 'Replay', 'Live agent', 'Library'], [ASSEMBLY_ROLE], ['Test'], [REVIEW]],
    deliverable: 'An AI agent workspace in the browser',
  },
  {
    id: 'roost-team', kind: 'product', recording: true, footage: 'roost-real',
    title: 'Roost',
    brief: 'An open-source home for a team of AI bots in one web page: named bots with their own roles share one computer and a group chat with you, ask before they act, run on routines and learn skills you show them; one real team session recorded in sandbox computers during the run replays on a timeline with a lane for each bot, three bots in four turns gathering a community garden’s forecast from the US weather service, building its weekly bulletin, reviewing it and fixing it; take the shared computer over, or run the team live on your own model; designed in a clean room from evidence about an open-source multi-agent app, and testing itself.',
    stages: [['Reader', RECORDER_ROLE], ['Spec', 'Wren'], ['Kernel', 'Interface', 'Shared computer', 'Chat', 'Bots', 'Computer', 'Skills', 'Replay', 'Live team', 'Bram'], ['Ivy'], ['Bram'], [ASSEMBLY_ROLE], ['Test'], [REVIEW]],
    deliverable: 'An AI bot team in the browser',
  },
  {
    id: 'neon-city', kind: 'interactive', recording: true, footage: 'neon-real',
    title: 'Neon City',
    brief: 'A cinematic full-screen interactive brand page: a future city whose lights never go out on a rainy night.',
    stages: [[MEDIA], [FRONT_END], [REVIEW]],
    deliverable: 'A full-screen interactive brand page',
  },
  {
    id: 'shanhai-vn', kind: 'game', recording: true, footage: 'shanhai-real',
    title: 'Tales of Mountains and Seas',
    brief: 'A Chinese-fantasy visual-novel chapter: a young swordsman seeks a cure in Qingqiu and meets a nine-tailed fox girl.',
    stages: [['Script', MEDIA], [CODE], [REVIEW]],
    deliverable: 'A playable visual-novel chapter',
  },
  {
    id: 'aurora-gt', kind: 'interactive', recording: true, footage: 'gt-real',
    title: 'Aurora GT',
    brief: 'A launch site for an electric supercar: an opening race under the aurora, a three-colour configurator, performance figures and a test-drive booking.',
    stages: [[MEDIA], [FRONT_END], [REVIEW]],
    deliverable: 'An electric supercar launch site',
  },
  {
    id: 'car-plant', kind: 'twin', recording: true, footage: 'car-plant-real',
    title: 'EV plant digital twin',
    brief: 'Turn a whole EV plant into a live 3D digital twin: 14 stations, buffers, rework and faults, every car changing as it moves down the line.',
    stages: [['Layout', 'Simulation', MEDIA], ['Plant', 'Equipment', 'Vehicles', 'Interface'], [FRONT_END], [REVIEW]],
    deliverable: 'A live 3D digital twin of a car plant',
  },
  {
    id: 'neon-circuit', kind: 'game', recording: true, footage: 'neon-circuit-real',
    title: 'Neon Circuit racer',
    brief: 'A synthwave 3D racer: three laps against five AI rivals, drifting through banked corners to fill the boost meter.',
    stages: [[DESIGN, MEDIA], ['Track', 'City', 'Cars', PHYSICS, 'Interface', SOUND], ['Wiring'], ['Build'], [REVIEW]],
    deliverable: 'A three-lap 3D race against five rivals',
  },
  {
    id: 'crystal-keep', kind: 'game', recording: true, footage: 'crystal-keep-real',
    title: 'Crystal Keep tower defense',
    brief: 'A ten-wave 3D tower defense: build, upgrade and sell towers on a floating island to keep the crystal alive.',
    stages: [[DESIGN], ['Map', 'Island', 'Units', 'Combat', SOUND, 'Interface'], ['Wiring'], ['Build'], [REVIEW]],
    deliverable: 'A playable ten-wave tower defense',
  },
  {
    id: 'mars-mission', kind: 'interactive', recording: true, footage: 'mars-mission-real',
    title: 'Mars mission control',
    brief: 'Plan and fly a Mars mission: pick a launch window on a live porkchop plot, build the rocket, fly the transfer and land by hand.',
    stages: [['Mission design'], ['Orbits', 'Scene', 'Lander', 'Console'], ['Wiring'], ['Build'], [REVIEW]],
    deliverable: 'A Mars mission you plan and fly',
  },
  {
    id: 'beat-studio', kind: 'product', recording: true, footage: 'beat-studio-real',
    title: 'Beat Studio music workstation',
    brief: 'A music workstation in the browser: drum machine, bass and chords, four patterns, a song chain and a mixer, all synthesized live.',
    stages: [[PRODUCT], ['Drums', 'Synths', 'Sequencer', 'Songs', 'Editor', 'Mixer'], ['Wiring'], ['Build'], [REVIEW]],
    deliverable: 'A working browser music workstation',
  },
  {
    id: 'knowledge-base', kind: 'product', recording: true, footage: 'kb-app-real',
    title: 'Team knowledge-base SaaS',
    brief: 'Build a team knowledge-base SaaS: sign-in and roles, document governance, search, a dashboard and an audit log, on simulated data.',
    stages: [['Architecture'], ['Access', 'Data', 'Copy'],
      [BACKEND], ['Frontend'], [REVIEW]],
    deliverable: 'A working knowledge-base web workspace',
  },
  {
    id: 'pixel-platformer', kind: 'game', recording: true, footage: 'pixel-real',
    title: 'Pixel platformer',
    brief: 'A pixel-art platformer: a fox courier delivering letters across a sky market.',
    stages: [[DESIGN], [ART, LEVELS, SOUND], [CODE], [REVIEW]],
    deliverable: 'A playable web level',
  },
  {
    id: '3d-configurator', kind: 'interactive', recording: true, footage: 'config-real',
    title: '3D configurator',
    brief: 'A 3D configurator: change the e-bike’s colour and parts, see it live.',
    stages: [[PRODUCT], [MODELLING], [RENDERING], [FRONT_END], [REVIEW]],
    deliverable: 'A web 3D configurator',
  },
  {
    id: 'papercraft-puzzle', kind: 'game', recording: true, footage: 'paper-real',
    title: 'Papercraft puzzle',
    brief: 'A papercraft puzzle: turn the paper world, roll the marble home.',
    stages: [[DESIGN], [ART, LEVELS, SOUND], [PHYSICS], [CODE], [REVIEW]],
    deliverable: 'Playable puzzle levels',
  },
  {
    id: 'summer-ad', kind: 'film', recording: true, footage: 'film-ad-real',
    title: 'Summer sparkling-drink ad',
    brief: 'A 30-second summer ad for a sparkling drink: blood orange, all impact.',
    stages: [['Script'], ['Boards'], ['Edit', 'Grade'], ['Animatic'], [REVIEW]],
    deliverable: 'Script, storyboard, edit sheet and a 30-second animatic',
  },
  {
    id: 'port-twin', kind: 'twin', recording: true, footage: 'port-twin-real',
    title: '3D port cockpit',
    brief: 'Turn the port into a 3D cockpit: ships, cranes, containers, live status.',
    stages: [[MODELLING, 'Data'], [RENDERING, 'Animation'], [FRONT_END], [REVIEW]],
    deliverable: 'A real-time 3D cockpit',
  },
  {
    id: 'glider-adventure', kind: 'game', recording: true, footage: 'glider-real',
    title: 'Cloud-sea glider adventure',
    brief: 'A playable glider adventure: a sea of clouds, floating islands, glowing wind.',
    stages: [[DESIGN], [RENDERING, MODELLING, SOUND], [CODE], [REVIEW]],
    deliverable: 'A playable build',
  },
  {
    id: 'party-game', kind: 'game', recording: true, footage: 'party-real',
    title: 'Party game',
    brief: 'A four-player couch party game: penguins scrambling for fish on the ice.',
    stages: [[DESIGN], ['Characters', PHYSICS, SOUND], [CODE], [REVIEW]],
    deliverable: 'A four-player build',
  },
  {
    id: 'rhythm-runner', kind: 'game', recording: true, footage: 'rhythm-real',
    title: 'Rhythm runner',
    brief: 'A rhythm runner: race the beat across giant piano keys.',
    stages: [[DESIGN], [ART, 'Music'], [CODE], ['Testing'], [REVIEW]],
    deliverable: 'A playable rhythm level',
  },
];
