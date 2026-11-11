import type { OfficialWorkflow, OfficialWorkflowEdge, OfficialWorkflowNode } from './examples/officialWorkflows';
import { THREE_MODULES_IMPORT_MAP } from '../canvas/previewImportMap';

/** Showpiece canvases (owner request 2026-11-11): one page whose shape, surface, light and sound are all computed, that
 * people can handle and that plays itself: a material study, a diorama, a playable slice. They run on the flagship
 * pattern (flagshipWorkflows.ts, epicWorkflows.ts): a design room writes the spec from a template, module builders in
 * sandbox computers write the page apart against one fixed kernel contract, an assemble node joins their code byte for
 * byte with no model, and a tester runs the page in a real browser. What is new here is what a piece that moves needs:
 * - the kernel's clock is a fixed step that `window.renderAt(t)` can replay from the seed, so the page is the same
 *   picture at second t every time (AwwO's renderer and the page check both drive it so);
 * - the piece plays itself from one script of timed actions, which is its attract mode, its self-test's driver and its
 *   cover recording;
 * - the testers see the page: the check takes frames at several seconds (awwo-check-page --frames), counts each
 *   frame's draw calls and triangles against the piece's budget, and writes them side by side on one sheet, and a
 *   second pass looks at that sheet and fixes what the pictures show. */
export interface ShowpieceModule {
  readonly id: string;
  readonly title: string;
  /** What this builder writes, as a list of lines. */
  readonly duties: string;
  /** The most its file may hold, in characters. */
  readonly limit: number;
  /** Reads the look and sound direction beside the design. */
  readonly art?: true;
}
export interface Showpiece {
  readonly id: string;
  readonly title: string;
  /** The piece's name, the global its kernel creates (window.<global>) and its page's file. */
  readonly name: string;
  readonly global: string;
  readonly file: string;
  readonly brief: string;
  /** The names three.js arrives under, as G.lib, and the import lines that bring them. */
  readonly lib: ReadonlyArray<readonly [name: string, line: string]>;
  /** The kernel's events beyond its own, and the state the panel shows, as the contract writes them. */
  readonly events: string;
  readonly state: string;
  /** The second fixed text: each module's namespace and names, and the system orders. */
  readonly api: string;
  /** The design's template (Part A), which the design room completes, and the direction the look and sound node writes from. */
  readonly design: string;
  readonly direction: string;
  readonly directionSections: string;
  readonly modules: ReadonlyArray<ShowpieceModule>;
  /** The page's markup around the modules: its style and its boot screen. */
  readonly style: string;
  readonly fonts: string;
  /** The check's frames (seconds), viewport and budgets. */
  readonly check: { readonly frames: ReadonlyArray<number>; readonly viewport: string; readonly drawCalls: number; readonly triangles: number };
  /** What the second pass looks for in the frames, as lines. */
  readonly look: string;
}

const chars = (count: number) => count.toLocaleString('en-US');
/** What a design node may write: room for its template with its numbers kept, and a little more. */
export const roomFor = (template: string) => Math.ceil((template.length + 1500) / 1000) * 1000;
export const DIRECTION_LIMIT = 8000;

/** The fixed contract every module codes against; the core module defines it. Builders never see each other's code. */
export const showpieceKernel = (piece: Showpiece) => `${piece.name} kernel contract (fixed; every module uses exactly these names):
- One global, window.${piece.global}, which core creates as its script runs (the first script). Every other module is one IIFE, (() => { const G = window.${piece.global}; ... })();, that defines no other global, attaches only its own namespace (the API sheet) to G as its script runs and registers G.module(name, init). Nothing runs at load. three.js arrives as G.lib = { ${piece.lib.map(([name]) => name).join(', ')} } just before G.boot and is read only in init or later. Init order: ${piece.modules.map(module => module.id).join(', ')}.
- G.on(type, fn) returns an unsubscribe; G.emit(type, detail). Types: ready, state { keys }, command { id, down } (each time a verb runs), restart, mode { attract }, pause { on }, quality { tier }, toast { text }, fail { reason }, ${piece.events}.
- The clock: G.system(name, order, fn(dt)) runs fn every fixed step, lower order first, with dt = 1/60 s; a frame feeds an accumulator with its real time (clamped to 0.1 s) times G.timeScale (1, or 0.25 at quarter speed) and runs at most 3 steps, the rest dropped. G.onRender(fn(dt), order) runs once a frame after the steps, lower order first (0 when left out; the render module draws at 100), with the frame's real seconds. G.time (simulated s, G.step / 60), G.step (count), G.loop.paused, G.loop.step(n) (n steps now, nothing drawn), G.loop.frame(dt) (the onRender list once, now, with dt, 1/60 when left out).
- G.SEED (an integer: ?seed= in the address, else 20261111) and G.rng(seed) -> { next() in [0,1), range(a, b), int(n), pick(list) } (mulberry32). Nothing calls Math.random or reads the wall clock for anything a person sees or hears.
- G.state = { ${piece.state} }; G.setState(patch) changes it and emits state with the keys that changed. It holds only what the panel shows and a person sets.
- G.commands.register({ id, label, keys, hold, panel, run(down), enabled() }): a verb. run(true) on a press; for a hold verb, run(false) on its release. G.commands.run(id, down) returns false when disabled, and run(id, false) does nothing for a verb that is not held; G.commands.list() -> the registered objects. keys is an array of event.code names; the hands module alone listens to devices and dispatches them, never while an input, select or textarea has focus.
- G.reset(fn) registers fn(): put this module's state back to the seed's start. G.restart() calls every reset in init order, sets G.time and G.step to 0 and emits restart.
- The script: G.script = [[t, action, argument], ...] in rising t (seconds since the script began), which the hands module sets in its init. An action is a command id with true or false, or 'state' with a patch, or a name the hands module registers with G.act(name, fn(argument)). G.play() starts the script: from then on core applies, before each step's systems, the entries whose t has come, and begins it again 2 s after its last entry (the piece is not restarted). G.stop() ends it and releases every verb it holds. G.playing says whether it runs.
- window.renderAt(t): the first call sets G.recording (the frame loop then neither steps nor draws, and attract mode ends); the first call, and any call whose t is before G.time, calls G.restart() and G.play(); it then steps until G.time >= t and calls G.loop.frame(). The same t gives the same picture every time: while G.recording nothing eases or waits on elapsed time (a camera, a light or a readout drawn 8 times a second jumps to its value on every G.loop.frame()). window.__ready is false until G.boot has run every init, then true, set in that same call, never from a timer or a frame.
- Attract mode: G.touch() is called by the hands module on every input a person makes. After 8 s without one (not counted while paused or while the script plays), and never under reduced motion or while recording, core calls G.restart() and G.play() and emits mode { attract: true }; a G.touch() while it runs calls G.stop() within that frame and emits mode { attract: false }, leaving the piece as it is.
- G.quality = { tier: 'low' | 'medium' | 'high', auto }; G.setQuality(tier) emits quality and ends auto. While auto, core averages the frame time over each second and steps one tier down when it passes 22 ms; it never steps up on its own.
- G.ui.root: a full-window DOM layer over the canvas; G.ui.layer(name) returns its positioned div ('panel', 'toast', 'touch', 'debug', in that z-order); the root and its layers take no pointer events, so the canvas under them stays live, and what a module puts into a layer turns them on for itself; G.ui.toast(text) emits toast.
- G.readout.provide(id, label, unit, digits, fn) registers a live number fn() measures; G.readout.list() -> [{ id, label, unit, digits, value }]. G.facts.provide(key, fn) and G.facts.get() -> { key: value } give the notes their real counts. G.checksum(fn) registers fn() -> a number or an array of numbers of a module's state; G.checksum() -> one hex string over every provider's numbers rounded to four decimals, the same for the same state.
- G.fail(reason): pauses, sets G.failed and emits fail; the panel shows the reason. A module that meets a number that is not finite calls it.
- G.tests.add(no, name, fn) (fn returns or resolves true or { ok: true, detail } with what it measured, or throws why; any other result fails; 2,000 ms cap); G.tests.plant(name, swap, catches) (swap() installs the wrong variant and returns its restore; catches = test numbers); G.tests.expect([[number, owner], ...]) (the design's table); G.tests.scratch() (G.restart() with G.state at its start values, the loop paused and attract mode off); G.tests.run() -> { tests: [{ name, ok, detail }], planted: [{ name, rejected, detail }] }: it pauses the loop and drawing, scratches before every test, runs each plant only against its catches (rejected when one fails; always restored), reports an expected number nobody registered as a failed test 'not registered', then restarts the piece and resumes. Core names each test "T<n> <owner>: <name>" itself: a module passes the bare name, and a plant's name begins with its id ("P4 softness is never 0"). window.awwoSelfTest = () => G.tests.run().
- G.module(name, init); G.boot(root) keeps root as G.root (the element the render module puts its canvas in) and runs the inits in order, each with no argument (a throw is caught, reported with console.error and toasted; the rest still run), emits ready, sets window.__ready and starts the frame loop, which pauses while the page is hidden.`;

/** Every builder's rules: what makes modules written apart fit into one page. */
export const showpieceRules = (piece: Showpiece, name: string, limit: number) => `Rules for every module:
- Step size (read this first): each reply you send is one step, and a step that runs past the model's output limit is cut off and ends the whole run with nothing delivered. So before a tool call write at most two sentences, never code, a plan or a draft; write the module only through workspace_write, as parts of at most 6,000 characters, one part a step; and keep each command's output short.
- Structure: write the ${name} module as the kernel contract says: ${name === 'core' ? `it alone creates window.${piece.global}, with every kernel name, as its script runs (it is the first script of the page)` : `one IIFE that attaches its API-sheet names to G as its script runs, registers its init with G.module('${name}', init) and defines no global`}. Never read G.lib or three.js before init.
- Boundaries: use other modules only through the names the API sheet gives them; never redefine, patch or wrap them. Anything the contract does not provide stays private to your module. Calls go one way: a function of yours that another module calls never calls back into that module, where the API sheet does not say it does (two modules that call each other recurse until the page's stack runs out).
- Registration: register every action a person can take as a command (G.commands.register), your systems with G.system at the API sheet's order, your resets with G.reset, your acceptance tests with G.tests.add by the design's numbers and your planted failures with G.tests.plant with the test numbers that catch them; a test checks real values with real code, never only that nothing threw, steps the piece with G.loop.step and never waits on frames or timers, and returns true or { ok: true, detail } (never a bare string, which fails).
- Data: use the numbers in the design's tables exactly; never redesign them. Where the design and this task disagree, this task and the kernel contract win.
- Determinism: everything a person sees or hears follows from G.SEED, G.time and what was done: no Math.random, no Date, no performance.now in the simulation or the drawing. Anything that moves on its own reads G.time.
- Sandbox: the page runs in a sandboxed frame with no network, storage, cookies, workers, external scripts, imports or downloads; three.js r186 arrives only as G.lib, and every texture is made in code. Fonts only by name, ${piece.fonts}, each followed by a generic fallback, never linked; canvas text is drawn after document.fonts.ready. Never write the characters </script anywhere.
- Main thread: slice any work longer than 50 ms across frames, and catch every Promise rejection. Interface text is English. Under prefers-reduced-motion nothing drifts, shakes or flashes.
- Compact code: no comments, no blank lines, short local names, tables and loops instead of repetition; at most ${chars(limit)} characters in all; finish before you polish, and when space runs short drop polish before a contract name or a test. Think only a few sentences before writing: the design is settled.
- You work in the sandbox computer, and your answer is a file, not a message: write the module as numbered parts p01.js, p02.js, … of at most 6,000 characters each with workspace_write (one part a step), join them with cat p*.js > ${name}.js, run node --check ${name}.js and fix what it reports, then publish ${name}.js into your result output: call workspace_publish with field "result" and path "${name}.js", and end with exactly this reply and nothing else: {"result": ""} (the host fills in the published file). Ignore any rule about answering with one code block: the assemble node pastes the published file into the page byte for byte.
- This run ends after 25 minutes and about 60 model calls: write the parts first, check once, publish; keep what each command prints short.`;

/** What the core builder writes, the same for every showpiece: the kernel itself. */
export const CORE_DUTIES = `- The global and every kernel name: the event bus; systems sorted by order and the onRender list; the frame loop (requestAnimationFrame; real elapsed time clamped to 0.1 s and scaled by G.timeScale feeds an accumulator of 1/60 s steps, at most 3 a frame, the rest dropped; then the onRender list; nothing while the page is hidden, G.loop.paused stops the steps but not the drawing, G.recording stops both), G.loop.step and G.loop.frame.
- G.SEED from the address and the mulberry32 G.rng; G.state and G.setState; the command registry; G.reset and G.restart; G.script, G.act, G.play and G.stop; G.checksum; window.renderAt and window.__ready as the contract words them; attract mode and G.touch; G.quality and its one-way step down; G.ui.root with its four layers and G.ui.toast; G.readout and G.facts; G.fail.
- The test runner: core's init calls G.tests.expect with the design's table of tests and their owners; a number nobody registered is reported as the failed test "T<n> <owner>: not registered (did the <owner> module load?)"; each plant runs only against its catches; before the run it pauses and remembers G.state, after it G.restart() and the state put back. window.awwoSelfTest is set as core's script runs.
- G.boot wraps each init (a throw is caught, reported with console.error and toasted).
- Commands: piece.pause (Space; toggles G.loop.paused and emits pause), piece.quarter (Q; G.timeScale 0.25 or 1, G.state.quarter), piece.restart (R), test.run (F10: emits toast with the counts when the run ends).
- Must not touch drawing, three.js or the DOM beyond G.ui.root.`;

/** The page: the modules as classic scripts in init order, each in its own tag after its marker (a module that fails to
 * parse cannot stop the others), then one module script that imports three.js r186, hands it over as G.lib and boots.
 * The boot screen is markup, so a screenshot taken before the shaders compile is never blank. */
export const showpiecePage = (piece: Showpiece) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${piece.name}</title>
${THREE_MODULES_IMPORT_MAP}
<style>${piece.style}</style>
</head>
<body>
<div id="stage"></div><div id="boot">${piece.name}</div>
${piece.modules.map(module => `<!-- module: ${module.id} -->\n<script>{{in:from_${module.id}}}</script>`).join('\n')}
<script type="module">
${piece.lib.map(([, line]) => line).filter(Boolean).join('\n')}
const G = window.${piece.global}, boot = document.getElementById('boot');
if (!G) boot.textContent = '${piece.name} did not load.';
else { G.lib = { ${piece.lib.map(([name]) => name).join(', ')} }; G.on('ready', () => boot.remove()); G.boot(document.getElementById('stage')); }
</script>
</body>
</html>`;

const builder = (piece: Showpiece, kernel: string, module: ShowpieceModule, row: number): OfficialWorkflowNode => ({
  id: module.id, title: module.title, role: 'frontend', column: 2, row, output: `${module.title} code`, sandbox: true,
  task: `Build the ${module.id} module of ${piece.name} from the design${module.art ? ' and the look and sound direction' : ''} in your inputs, the kernel contract and the API sheet below; the other ${piece.modules.length - 1} modules are written at the same time by other builders who share only the design and these two fixed texts. Where the design and this task disagree, this task and the kernel contract win.\nYour duties (${module.id}):\n${module.duties}\n\n${kernel}\n\n${piece.api}\n\n${showpieceRules(piece, module.id, module.limit)}`,
  acceptance: [`Runs as pasted; defines exactly the API sheet's ${module.id} names and registers what its duties give it`, 'Registers its acceptance tests and planted failures by the design\'s numbers'],
});

/** The page check as both passes run it: a headless browser with every request blocked but three.js r186, the self-test,
 * and the page's frames at the piece's seconds with its draw budget. */
export const showpieceCheck = (piece: Showpiece) => `awwo-check-page ${piece.file} --out check --viewport ${piece.check.viewport} --wait-ms 3000 --timeout-ms 40000 --budget-ms 115000 --frames ${piece.check.frames.join(',')} --expect-motion --max-draw-calls ${piece.check.drawCalls} --max-triangles ${piece.check.triangles}`;
const CHECK_SAYS = (piece: Showpiece) => `(a headless browser with every request blocked but three.js 0.186.1, which it answers from its own copy; it takes a screenshot after 3 s, runs window.awwoSelfTest(), then brings the page to ${piece.check.frames.join(', ')} s by window.renderAt(t), counts each frame's draw calls and triangles and writes the frames side by side to check/frames.jpg; it writes check/report.json; a check takes a minute or two, and a command may run 120 s)`;

// The two passes share their steps. The budget rules are the flagships': a pass that fixed without publishing ran out
// of model calls with nothing better delivered (2026-10-18).
const passSteps = (piece: Showpiece, start: string, order: string, report: string) => `${start}
2. Read check/report.json with one short python3 script: page errors (message, line), the self-test's results (each name starts "T<n> <owner>:"), the planted failures caught, the blank-page flag, and frames: its mode, still, each frame's gl.drawCalls and gl.triangles, pixels (lumaMean, lumaStdDev, dark, bright), blank and motion.changed, and failure or unfinished. Never print the page; find code with grep -n (the module markers, the names) and read it with sed -n, at most 40 lines at a time.
3. Publish the page as checked at once (workspace_publish with field "result" and path "${piece.file}"), then write report.md and publish it (field "report", path "report.md").
4. ${order} Fix each fault at its cause, in its owner's module, with small exact-string edits (python3); a name that is missing or misnamed is fixed in the module the API sheet gives it to. Never weaken, delete or skip a test or a plant, never change an expected value, and never touch G.tests, window.awwoSelfTest, window.renderAt or the page's script tags.
5. Run the check again after each fix or two; after every check better than the one before, publish the page and report.md again at once. Spend at most 15 commands on one fault: if it is still there then, write in report.md what you found and go on to the next. Keep 8 model calls for the end, and mind the clock as well: a check takes up to two minutes, and a run cut off at 25 minutes delivers nothing, not even what it published. Before each check read the minutes gone (echo $(( ($(date +%s) - $(cat /tmp/start)) / 60 ))); from minute 17 on run no more checks: publish the best page and report.md you have, then end.
6. The report: the first and the last check's numbers (tests passed of total, plants caught of total, page errors, blank or not, frames taken, the most draw calls and triangles in a frame, still or moving), ${report} every fix on one line (module: what was wrong → what changed), and what is still wrong, with what you found. State only what the checks and the pictures showed.
7. End with {"result": "", "report": ""} (the host fills in the published files). The last page and report you publish are what you deliver. This run ends after 25 minutes and about 60 model calls.`;

/** The canvas of a showpiece: the design room, the builders, the assembly, two passes over the page and a review. */
export function showpiece(piece: Showpiece): OfficialWorkflow {
  // The canvas's own nodes keep their ids: a module may not take one.
  const taken = piece.modules.find(module => ['design', 'direction', 'page', 'test', 'checked', 'test2', 'review'].includes(module.id));
  if (taken) throw new Error(`Invalid showpiece module id: ${taken.id}`);
  const kernel = showpieceKernel(piece);
  const check = `${showpieceCheck(piece)} ${CHECK_SAYS(piece)}`;
  const builders = piece.modules.map((module, row) => builder(piece, kernel, module, row));
  const designLimit = roomFor(piece.design);
  const moduleList = piece.modules.map(module => module.id).join(', ');
  const nodes: OfficialWorkflowNode[] = [
    { id: 'design', title: 'Design', role: 'general', column: 0, row: 0, output: 'Design', sandbox: true,
      task: `You are the design room of ${piece.name}, an original piece; name no product, company, studio or other work anywhere. Write its design, which ${piece.modules.length} module builders implement in parallel, from the template below.\n\nThe template:\n${piece.design}\nEnd of the template.\n\nWrite the design exactly in the template's order and terms. Keep every number of the template unless it contradicts another; if you change one, list it in a final line 'Changes:' (write 'Changes: none' when there is none). Where the template says "complete", write the rows it asks for in the same form as the rows it gives. Compact tables and lists, at most ${chars(designLimit)} characters in all, with no paragraph the template does not have. Keep your private reasoning short: the design is settled, and the work is the writing. You work in the sandbox computer, but your answer is a message, not a file: write nothing to the workspace and reply with the whole design as your final message.`,
      acceptance: ['Every section of the template in its order, with its numbers', 'Every changed number is listed on the Changes line'] },
    { id: 'direction', title: 'Look and sound direction', role: 'general', column: 1, row: 0, output: 'Look and sound direction', sandbox: true,
      task: `Write ${piece.name}'s look and sound direction, which the builders that draw and sound use as it is, from the direction below and the design in your inputs. Original wording only; name no product, company, studio or other work. Write these sections as compact tables and lists:\n${piece.directionSections}\nAt most ${chars(DIRECTION_LIMIT)} characters in all. You work in the sandbox computer, but your answer is a message, not a file: write nothing to the workspace and reply with the whole direction as your final message.\n\n${piece.direction}`,
      acceptance: ['Every section, with values a builder can type in', 'Original wording, within the direction'] },
    ...builders,
    { id: 'page', title: 'Assembly', role: 'frontend', column: 3, row: 0, output: `Assembled ${piece.name} page`,
      task: `Puts the ${piece.modules.length} modules into one page, byte for byte and in init order, with no model: ${moduleList}, each in its own script tag after its marker (a module that fails cannot stop the others), then one module script that imports three.js r186, hands it to the kernel as G.lib and boots the piece.`,
      acceptance: [`A complete HTML document that boots ${piece.name}`],
      assemble: { template: showpiecePage(piece), fileOnly: true, fileName: piece.file } },
    { id: 'test', title: 'Test and fix', role: 'frontend', column: 4, row: 0, sandbox: true, output: piece.name, outputType: 'html', report: 'Test report',
      task: passSteps(piece, `You are ${piece.name}'s integration tester, working in the sandbox computer, the first of two passes over the page. Your inputs give you the assembled page as a file in /inputs (${piece.file}: ${piece.modules.length} modules in their own script tags, each after a line <!-- module: name -->) and the design as text.\n1. Note the time (date +%s > /tmp/start), copy the page into the workspace (cp /inputs/*${piece.file} ${piece.file}) and run: ${check}.`,
        'Fix in this order: page errors first (a syntax error silences a whole module), then tests reported "not registered", then failing tests by number, then plants not caught, then a frame that is blank or a renderAt that throws.',
        ''),
      acceptance: ['The page delivered is the one the last check ran on', 'The report gives the first and last check\'s numbers exactly, every failing test and every fix made'] },
    { id: 'checked', title: 'First pass page', role: 'frontend', column: 5, row: 0, output: 'First pass page',
      task: 'Hands the page the first pass delivered on to the second as a file, byte for byte, with no model.',
      acceptance: ['The first pass\'s page, unchanged'],
      assemble: { template: '{{in:from_test}}', fileOnly: true, fileName: piece.file } },
    { id: 'test2', title: 'Look and fix', role: 'frontend', column: 6, row: 0, sandbox: true, output: piece.name, outputType: 'html', report: 'Look report',
      task: passSteps(piece, `You are ${piece.name}'s second pass, working in the sandbox computer: the first pass made the page run, and you make it look and move as the design says. Your inputs give you the page the first pass delivered as a file in /inputs (${piece.file}), its report, and the design and the look and sound direction as text. Keep every fix the first pass made.\n1. Note the time (date +%s > /tmp/start), copy the page into the workspace (cp /inputs/*${piece.file} ${piece.file}) and run: ${check}. Then look at the frames: if you have the workspace_view tool, view check/frames.jpg and say in one line per frame what you see; if you do not, judge the frames by their numbers alone and say so in the report.`,
        `Fix what the frames show, in this order: a frame over the draw budget (${chars(piece.check.drawCalls)} draw calls, ${chars(piece.check.triangles)} triangles) or frames that do not move; then what the pictures get wrong against the design and the direction:\n${piece.look}\nThen any test the first pass left failing.`,
        'what each frame shows (seen with workspace_view, or judged by numbers only),'),
      acceptance: ['The page delivered is the one the last check ran on', 'The report says what each frame shows and whether it was seen or judged by numbers'] },
    { id: 'review', title: 'Review', role: 'review', column: 7, row: 0, output: 'Review record', sandbox: true,
      task: 'Read the two passes\' reports against the design. Report which acceptance tests pass and fail after the second pass, by number and owner; which planted failures were caught; the frames\' numbers (the most draw calls and triangles in a frame against the budget, still or moving, any blank frame); what the second pass says each frame shows, and whether it saw the frames or judged them by numbers; what the fixes of each pass changed; and which parts of the design no test and no frame covers. This is a static review: say "not actually run" for anything the reports do not show, and claim nothing beyond them; at most 350 words.',
      acceptance: ['Static review and actual execution are kept strictly apart'] },
  ];
  const edges: OfficialWorkflowEdge[] = [
    { from: 'design', to: 'direction', label: 'Design' },
    ...builders.map(node => ({ from: 'design', to: node.id, label: 'Design' })),
    ...piece.modules.filter(module => module.art).map(module => ({ from: 'direction', to: module.id, label: 'Look and sound direction' })),
    ...builders.map(node => ({ from: node.id, to: 'page', label: node.output })),
    { from: 'page', to: 'test', label: 'Assembled page', port: 'file' },
    { from: 'design', to: 'test', label: 'Design' },
    { from: 'test', to: 'checked', label: 'First pass page' },
    { from: 'checked', to: 'test2', label: 'First pass page', port: 'file' },
    { from: 'test', to: 'test2', label: 'First pass report', port: 'report' },
    { from: 'design', to: 'test2', label: 'Design' },
    { from: 'direction', to: 'test2', label: 'Look and sound direction' },
    { from: 'test', to: 'review', label: 'Test report', port: 'report' },
    { from: 'test2', to: 'review', label: 'Look report', port: 'report' },
    { from: 'design', to: 'review', label: 'Design' },
  ];
  return { id: piece.id, title: piece.title, stack: 'r186', fonts: true, brief: piece.brief, nodes, edges };
}
