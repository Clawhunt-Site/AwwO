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
const MEDIA = MEDIA_ROLE;

export const PRODUCTION_CASES: ReadonlyArray<ProductionCase> = [
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
