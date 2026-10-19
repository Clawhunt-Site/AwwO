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
const MEDIA = MEDIA_ROLE;

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
