import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { SHOWPIECES, SHOWPIECE_WORKFLOWS } from '../src/saas/showpieceWorkflows';
import { showpieceCheck, showpieceKernel, showpiecePage } from '../src/saas/showpieceRules';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { createOfficialDocument } from '../src/saas/examples/officialWorkflows';
import { createOfficialCopyDocument } from '../src/saas/examples/OfficialCopySetup';
import { canonicalCanvasText } from '../src/saas/productionCanvasText';
import { assembleTemplate, templateIssues, MAX_ASSEMBLE_OUTPUT_BYTES } from '../src/canvas/assembleNode';
import { SANDBOX_RUNTIME } from '../src/canvas/nodeRuntime';
import { MAX_CANVAS_NODES, sanitizeDocument, type AssembleNode, type SessionNode } from '../src/canvas/canvasDoc';
import { canConnect, reconcileEdges } from '../src/canvas/ports';
import { findCycle } from '../src/canvas/runGraph';
import { THREE_MODULE_FILES } from '../src/canvas/previewModules.generated';

// The showpiece canvases (showpieceWorkflows.ts, showpieceRules.ts): one page whose shape, light and sound are computed,
// on the flagship pattern (saas-flagship-workflows.test.ts, saas-epic-workflows.test.ts) with what a piece that moves
// adds: a clock renderAt can replay, one script that is its attract mode, and two passes that check its frames.
const CANVASES = Object.values(SHOWPIECE_WORKFLOWS);
const GATHER = SHOWPIECE_WORKFLOWS['gather-glass'];
const MOSSGREEN = SHOWPIECE_WORKFLOWS['mossgreen-golf'];
const FREIGHT = SHOWPIECE_WORKFLOWS['night-freight-yard'];
const piece = (id: string) => SHOWPIECES.find(item => item.id === id)!;

// The node prompt the API admits (128,000 bytes) and the per-task budget the flagship builders are held to.
const MAX_PROMPT_BYTES = 128000;
const MAX_TASK_CHARS = 20000;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const deliveryLimit = (task: string) => Number(/at most ([\d,]+) characters in all/i.exec(task)?.[1].replace(/,/g, '') ?? 0);
const REPORT_BYTES = 16000;
// The design node embeds its template whole, as a builder embeds the kernel: the rest of its task is held to the budget.
const TEMPLATE = /The template:\n[\s\S]*?End of the template\./;
const outsideTemplate = (task: string) => task.replace(TEMPLATE, '');
const builders = (item: typeof GATHER) => item.nodes.filter(node => node.task.includes('Rules for every module'));
const duties = (task: string) => task.slice(task.indexOf('Your duties'), task.indexOf('kernel contract (fixed'));
const agentsOf = (document: ReturnType<typeof createOfficialDocument>) => document.nodes.filter((node): node is SessionNode => node.kind === 'session');

it('is no case until a run of it is published', () => {
  expect(Object.keys(SHOWPIECE_WORKFLOWS)).toEqual(SHOWPIECES.map(item => item.id));
  expect(Object.keys(SHOWPIECE_WORKFLOWS)).toEqual(['gather-glass', 'mossgreen-golf', 'night-freight-yard']);
  for (const item of CANVASES) expect(PRODUCTION_WORKFLOWS[item.id], item.id).toBeUndefined();
});

it('has a design room of two, a builder per module, the assembly, two passes with the first one\'s page between them, and a review', () => {
  for (const item of CANVASES) {
    const spec = piece(item.id);
    const document = createOfficialDocument(item);
    expect(item.nodes.map(node => node.id)).toEqual(['design', 'direction', ...spec.modules.map(module => module.id), 'page', 'test', 'checked', 'test2', 'review']);
    expect(document.nodes).toHaveLength(spec.modules.length + 7);
    expect(document.nodes.length).toBeLessThanOrEqual(MAX_CANVAS_NODES);
    expect(builders(item).map(node => node.id)).toEqual(spec.modules.map(module => module.id));
    expect(spec.modules[0].id).toBe('core');
    expect([item.stack, item.fonts, item.media]).toEqual(['r186', true, undefined]);
  }
  expect(builders(GATHER).map(node => node.id)).toEqual(['core', 'render', 'glass', 'look', 'bench', 'hands', 'sound', 'panel']);
  expect(builders(MOSSGREEN).map(node => node.id)).toEqual(['core', 'render', 'course', 'ball', 'play', 'world', 'hands', 'sound', 'panel']);
  expect(builders(FREIGHT).map(node => node.id)).toEqual(['core', 'render', 'yard', 'train', 'walker', 'pilot', 'world', 'hands', 'sound', 'panel']);
});

it('compiles into one acyclic DAG that runs left to right, every wire compatible and every input fed exactly once', () => {
  for (const item of CANVASES) {
    const spec = piece(item.id);
    const document = createOfficialDocument(item);
    expect(findCycle(document.nodes, document.edges)).toEqual([]);
    expect(reconcileEdges(document.nodes, document.edges)).toEqual(document.edges);
    const connected: typeof document.edges = [];
    for (const edge of document.edges) {
      expect(canConnect(document.nodes, connected, { nodeId: edge.fromNode, portId: edge.fromPort }, { nodeId: edge.toNode, portId: edge.toPort }), `${edge.fromNode}->${edge.toNode}`).toBe(true);
      connected.push(edge);
    }
    const place = new Map(item.nodes.map(node => [node.id, [node.column, node.row] as const]));
    expect(new Set(item.nodes.map(node => `${node.column}/${node.row}`)).size, item.id).toBe(item.nodes.length);
    for (const edge of item.edges) expect(place.get(edge.to)![0], `${edge.from}->${edge.to}`).toBeGreaterThan(place.get(edge.from)![0]);
    const last = Math.max(...item.nodes.map(node => node.column));
    expect(item.nodes.filter(node => node.column === last).map(node => node.role)).toEqual(['review']);
    // Two passes deliver the page: the first pass's reaches the second as a file through an assemble node.
    expect(item.nodes.filter(node => node.outputType === 'html').map(node => node.id)).toEqual(['test', 'test2']);
    for (const node of document.nodes) {
      for (const field of node.kind === 'session' || node.kind === 'assemble' ? (node.contract?.inputs ?? []) : []) {
        if (field.id === 'brief') continue;
        const into = document.edges.filter(edge => edge.toNode === node.id && edge.toPort === `in:${field.id}`);
        expect(into, `${node.title}/${field.id}`).toHaveLength(1);
        expect(into[0].dataType, `${node.title}/${field.id}`).toBe(field.type === 'file' ? 'file' : 'text');
      }
    }
    // Every builder reads the design; the ones that draw or sound read the direction too.
    for (const node of builders(item)) {
      const from = item.edges.filter(edge => edge.to === node.id).map(edge => edge.from).sort();
      expect(from, node.id).toEqual([...(spec.modules.find(module => module.id === node.id)!.art ? ['design', 'direction'] : ['design'])]);
      expect(node.task.includes('and the look and sound direction in your inputs'), node.id).toBe(from.includes('direction'));
    }
    // The second pass reads the first one's report, the design and the direction; the review both reports and the design.
    const into = (id: string) => item.edges.filter(edge => edge.to === id).map(edge => `${edge.from}${edge.port ? `.${edge.port}` : ''}`).sort();
    expect(into('test2')).toEqual(['checked.file', 'design', 'direction', 'test.report']);
    expect(into('review')).toEqual(['design', 'test.report', 'test2.report']);
  }
});

it('assembles the page from every builder with no model, in init order, on the three.js files the preview supplies', () => {
  for (const item of CANVASES) {
    const spec = piece(item.id);
    const modules = spec.modules.map(module => module.id);
    const document = createOfficialDocument(item);
    const pages = document.nodes.filter((node): node is AssembleNode => node.kind === 'assemble');
    expect(pages.map(node => node.title)).toEqual(['Assembly', 'First pass page']);
    const handover = pages[1];
    expect([handover.template, handover.fileName, (handover.contract?.inputs ?? []).map(field => field.id)]).toEqual(['{{in:from_test}}', spec.file, ['from_test']]);
    expect(handover.contract?.outputs.map(field => [field.id, field.type])).toEqual([['file', 'file']]);
    const page = pages[0];
    const inputs = (page.contract?.inputs ?? []).map(field => field.id);
    expect(inputs).toEqual(modules.map(id => `from_${id}`));
    expect(page.template).toBe(showpiecePage(spec));
    expect(templateIssues(page.template, inputs)).toEqual([]);
    expect(page.fileName).toBe(spec.file);
    expect(page.contract?.outputs.map(field => [field.id, field.type])).toEqual([['file', 'file']]);
    const values = Object.fromEntries(inputs.map(id => [id, '```javascript\nconsole.log("' + id + '</script>");\n```']));
    const built = assembleTemplate(page.template, values);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.text.startsWith('<!DOCTYPE html>') && built.text.trimEnd().endsWith('</html>')).toBe(true);
    expect(built.text).not.toContain('```');
    const at = modules.map(id => built.text.indexOf(`<!-- module: ${id} -->\n<script>console.log("from_${id}<\\/script>");</script>`));
    expect(at.every(index => index > 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const boot = built.text.indexOf('<script type="module">');
    expect(boot).toBeGreaterThan(at[at.length - 1]);
    // The kernel the builders share: its init order and its G.lib are the page's.
    const kernel = showpieceKernel(spec);
    expect(/Init order: ([a-z, ]+)\./.exec(kernel)?.[1].split(', ')).toEqual(modules);
    const lib = (text: string) => /G\.lib = \{ ([A-Za-z, ]+) \}/.exec(text)?.[1].split(', ');
    expect(lib(built.text)).toEqual(lib(kernel));
    expect(lib(kernel)).toEqual(spec.lib.map(([name]) => name));
    const imports = built.text.split('\n').filter(line => line.startsWith('import '));
    for (const name of lib(kernel)!) expect(imports.join('\n'), name).toMatch(new RegExp(`\\b${name}\\b`));
    // Every import is literal and one of the files AwwO's preview supplies (previewModules.generated.ts), which the
    // sandbox's page check answers too: a page that names another file meets a blocked request in both.
    const supplied = new Set(Object.keys(THREE_MODULE_FILES));
    for (const line of imports) {
      const from = /from '([^']+)';$/.exec(line)?.[1] ?? '';
      const file = from === 'three' ? 'build/three.module.js' : from.replace(/^three\/addons\//, 'examples/jsm/');
      expect(supplied.has(file), line).toBe(true);
    }
    expect(built.text).toContain('<script type="importmap">');
    expect(built.text.indexOf("G.on('ready'")).toBeLessThan(built.text.indexOf('G.boot('));
    expect(built.text).not.toMatch(/\n\n/);
    // Room for every module at its limit.
    const limits = builders(item).reduce((sum, node) => sum + deliveryLimit(node.task), 0);
    expect(limits).toBe(spec.modules.reduce((sum, module) => sum + module.limit, 0));
    expect(bytes(page.template) + limits * 1.1).toBeLessThan(MAX_ASSEMBLE_OUTPUT_BYTES);
    // The page file reaches the sandbox test, and only reports reach the review.
    const wire = document.edges.find(edge => edge.fromNode === page.id);
    expect(wire && [wire.fromPort, wire.dataType]).toEqual(['out:file', 'file']);
    const test = document.nodes.find((node): node is SessionNode => node.kind === 'session' && node.id === wire!.toNode);
    expect(test?.runtime).toBe(SANDBOX_RUNTIME);
    expect(test!.contract?.outputs.map(field => [field.id, field.type])).toEqual([['result', 'html'], ['report', 'markdown']]);
    const review = document.nodes.find(node => node.kind === 'session' && node.title === 'Review')!;
    expect(document.edges.filter(edge => edge.toNode === review.id && edge.dataType === 'text').map(edge => edge.fromPort).sort()).toEqual(['out:report', 'out:report', 'out:result']);
  }
});

it('gives every builder the same fixed kernel contract, API sheet and rules, within the flagships\' task budget', () => {
  for (const item of CANVASES) {
    const spec = piece(item.id);
    const team = builders(item);
    expect(new Set(team.map(node => node.column)).size).toBe(1);
    const contract = (task: string) => task.slice(task.indexOf('kernel contract (fixed'), task.indexOf('Rules for every module'));
    expect(contract(team[0].task).length).toBeGreaterThan(3000);
    expect(contract(team[0].task)).toContain(`${spec.global} API sheet (fixed`);
    expect(contract(team[0].task)).toContain(showpieceKernel(spec).slice(spec.name.length + 1));
    const document = createOfficialDocument(item);
    for (const node of team) {
      expect(contract(node.task), node.id).toBe(contract(team[0].task));
      expect(node.sandbox, node.id).toBe(true);
      expect(node.task, node.id).toContain(`node --check ${node.id}.js`);
      expect(node.task, node.id).toContain(`call workspace_publish with field "result" and path "${node.id}.js"`);
      expect(node.task, node.id).toContain('G.tests.plant');
      expect(node.task.length, node.id).toBeLessThan(MAX_TASK_CHARS);
      expect(deliveryLimit(node.task), node.id).toBeGreaterThanOrEqual(12000);
      // The API sheet names every module's namespace, and the kernel's first script is the core.
      expect(spec.api, node.id).toContain(node.id === 'core' ? 'System orders' : `- ${node.id}: G.${node.id} = {`);
      const tile = document.nodes.find((value): value is SessionNode => value.kind === 'session' && value.title === node.title);
      expect(tile?.runtime, node.id).toBe(SANDBOX_RUNTIME);
    }
    expect(team[0].task).toContain(`it alone creates window.${spec.global}`);
    for (const node of item.nodes) expect(outsideTemplate(node.task).length, node.id).toBeLessThan(MAX_TASK_CHARS);
  }
});

it('says what a piece that moves needs: a clock renderAt replays, one script, and a seed', () => {
  for (const item of CANVASES) {
    const kernel = showpieceKernel(piece(item.id));
    for (const words of ['window.renderAt(t)', 'window.__ready is false until G.boot has run every init', 'The same t gives the same picture every time', 'at most 3 steps', 'G.script = [[t, action, argument], ...]',
      'and never under reduced motion or while recording', 'G.SEED', 'Nothing calls Math.random', 'G.checksum()', 'window.awwoSelfTest = () => G.tests.run()'])
      expect(kernel, words).toContain(words);
    // Every builder is held to it, and the hands builder writes the script the design gives.
    for (const node of builders(item)) expect(node.task, node.id).toContain('no Math.random, no Date, no performance.now in the simulation or the drawing');
    expect(duties(builders(item).find(node => node.id === 'hands')!.task)).toContain('G.script is A7');
  }
});

it('owns every acceptance test and planted failure of the design in exactly one builder, by its owner', () => {
  for (const item of CANVASES) {
    const design = item.nodes.find(node => node.id === 'design')!.task;
    const testOwners = new Map([...design.matchAll(/^(\d+)\. ([a-z]+): /gm)].map(match => [Number(match[1]), match[2]]));
    const count = testOwners.size;
    expect(count).toBeGreaterThanOrEqual(20);
    expect([...testOwners.keys()]).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    const plantRows = [...design.matchAll(/^\| P(\d+) \| ([a-z]+) \| [^|]+ \| ([\d, ]+) \|$/gm)];
    const plantOwners = new Map(plantRows.map(match => [Number(match[1]), match[2]]));
    expect([...plantOwners.keys()]).toEqual(Array.from({ length: plantOwners.size }, (_, index) => index + 1));
    expect(plantOwners.size).toBeGreaterThanOrEqual(6);
    // A plant is caught by tests of its own owner, so a builder can prove it alone.
    for (const [, , owner, catches] of plantRows) for (const number of catches.split(', ')) expect(testOwners.get(Number(number)), `P by ${owner} caught by ${number}`).toBe(owner);
    const tests = new Map<number, string>();
    const plants = new Map<number, string>();
    for (const node of builders(item)) {
      const text = duties(node.task);
      const [, from, to] = /Tests (\d+)-(\d+)/.exec(text) ?? [];
      expect(from, node.id).toBeDefined();
      for (let n = Number(from); n <= Number(to); n++) {
        expect(tests.has(n), `test ${n}`).toBe(false);
        tests.set(n, node.id);
      }
      for (const match of text.matchAll(/\bP(\d+)\b/g)) {
        expect(plants.has(Number(match[1])), `P${match[1]}`).toBe(false);
        plants.set(Number(match[1]), node.id);
      }
    }
    expect(new Map([...tests].sort(([a], [b]) => a - b))).toEqual(testOwners);
    expect(new Map([...plants].sort(([a], [b]) => a - b))).toEqual(plantOwners);
    // The brief counts them as the design does.
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
    const spoken = (n: number) => (n < 13 ? words[n] : n < 20 ? '' : `${['twenty', 'thirty', 'forty'][Math.floor(n / 10) - 2]}${n % 10 ? `-${words[n % 10]}` : ''}`);
    expect(item.brief.toLowerCase()).toContain(`${spoken(count)} acceptance tests and ${spoken(plantOwners.size)} planted failures`);
    expect(item.brief.toLowerCase()).toContain(`${spoken(builders(item).length)} builders`);
  }
});

it('checks the page as a piece that moves: its frames, their motion and a draw budget, in both passes', () => {
  for (const item of CANVASES) {
    const spec = piece(item.id);
    const command = showpieceCheck(spec);
    expect(command).toBe(`awwo-check-page ${spec.file} --out check --viewport ${spec.check.viewport} --wait-ms 3000 --timeout-ms 40000 --budget-ms 115000${spec.check.heldClock === false ? ' --no-held-clock' : ''} --frames ${spec.check.frames.join(',')} --expect-motion --max-draw-calls ${spec.check.drawCalls} --max-triangles ${spec.check.triangles}`);
    // Within the check's own limits (deploy/saas/workspace/tools: frames.mjs, awwo-check-page.mjs) and a 120 s command.
    expect(spec.check.frames.length).toBeGreaterThanOrEqual(3);
    // GATHER's text is the one its production run used; the two pieces after it leave out the held-clock reload, which a
    // heavy page cannot afford within one command on the software renderer.
    expect(spec.check.heldClock, item.id).toBe(item.id === 'gather-glass' ? undefined : false);
    expect(spec.check.frames.length).toBeLessThanOrEqual(8);
    expect([...spec.check.frames].sort((a, b) => a - b)).toEqual(spec.check.frames);
    expect(new Set(spec.check.frames).size).toBe(spec.check.frames.length);
    expect(spec.check.frames.every(t => t >= 0 && t <= 600)).toBe(true);
    expect(spec.check.viewport).toMatch(/^\d{3,4}x\d{3,4}$/);
    expect(Number(/--budget-ms (\d+)/.exec(command)![1])).toBeLessThan(120000);
    // The design's budget is the check's.
    const design = item.nodes.find(node => node.id === 'design')!.task;
    expect(design).toContain(`At most ${spec.check.drawCalls} draw calls and ${spec.check.triangles.toLocaleString('en-US')} triangles a frame`);
    for (const id of ['test', 'test2']) {
      const task = item.nodes.find(node => node.id === id)!.task;
      expect(task, id).toContain(command);
      expect(task, id).toContain('check/frames.jpg');
      expect(task, id).toContain(`workspace_publish with field "result" and path "${spec.file}"`);
      expect(task, id).toContain('Never weaken, delete or skip a test or a plant');
      expect(task, id).toContain('End with {"result": "", "report": ""}');
    }
    // The second pass looks at the frames where it can, and says which it did.
    const look = item.nodes.find(node => node.id === 'test2')!.task;
    expect(look).toContain('if you have the workspace_view tool, view check/frames.jpg');
    expect(look).toContain('judge the frames by their numbers alone and say so in the report');
    expect(look).toContain(spec.look);
    expect(item.nodes.find(node => node.id === 'review')!.task).toContain('whether it saw the frames or judged them by numbers');
  }
});

it('carries the design template whole, with room to write it, and keeps every node prompt under 128,000 bytes', () => {
  for (const item of CANVASES) {
    const spec = piece(item.id);
    const task = (id: string) => item.nodes.find(node => node.id === id)!.task;
    const template = TEMPLATE.exec(task('design'))?.[0] ?? '';
    expect(template).toContain(spec.design);
    expect(deliveryLimit(task('design'))).toBeGreaterThan(spec.design.length);
    expect(deliveryLimit(task('direction'))).toBe(8000);
    const document = createOfficialDocument(item);
    const specOf = new Map(item.nodes.map(node => [node.title, node]));
    const byNode = new Map(document.nodes.map(node => [node.id, node]));
    for (const node of agentsOf(document)) {
      const own = bytes(node.persona) + bytes(node.contract!.inputs.find(field => field.id === 'brief')!.value);
      const brought = document.edges.filter(edge => edge.toNode === node.id && edge.dataType !== 'file').reduce((sum, edge) => {
        const limit = deliveryLimit(specOf.get(byNode.get(edge.fromNode)!.title)?.task ?? '');
        return sum + (limit ? Math.ceil(limit * 1.1) : REPORT_BYTES);
      }, 0);
      expect(own + brought, node.title).toBeLessThan(MAX_PROMPT_BYTES);
    }
  }
});

it('mints a fresh canvas for every copy, keeps every agent in its sandbox computer, and reloads unchanged', () => {
  for (const item of CANVASES) {
    const before = JSON.stringify(item);
    const first = createOfficialDocument(item);
    const second = createOfficialDocument(item);
    const firstIDs = new Set(first.nodes.map(node => node.id));
    expect(second.nodes.every(node => !firstIDs.has(node.id))).toBe(true);
    for (const node of agentsOf(second)) {
      expect(node.binding).toBeNull(); expect(node.model).toBe(''); expect(node.effort).toBe('');
      expect(node.runtime, node.title).toBe(SANDBOX_RUNTIME);
      expect(node.contract!.outputs.every(field => field.value === '')).toBe(true);
    }
    expect(JSON.stringify(item)).toBe(before);
    const restored = sanitizeDocument(JSON.parse(JSON.stringify(second)));
    second.nodes.forEach((node, index) => expect(restored.nodes[index], `${index}`).toMatchObject(node));
    expect(restored.edges).toEqual(second.edges);
    const copy = createOfficialCopyDocument(item, { runtime: 'openai-agents', model: 'gate-only', label: 'Gate only' });
    for (const node of agentsOf(copy)) expect([node.runtime, node.model], node.title).toEqual([SANDBOX_RUNTIME, '']);
    expect(canonicalCanvasText(copy)).toBe(canonicalCanvasText(second));
  }
});

// GATHER's first production run (2026-11-11) died twice over: its render's resize() read the free part of the stage
// through G.panel.free(), whose own job was to call G.render.resize(), so the two recursed until the stack ran out; and its
// first pass, fixing that, was cut off at 25 minutes with the page published but never handed on.
it('makes the free part of the stage flow one way, and keeps both passes inside their 25 minutes', () => {
  for (const item of CANVASES) {
    const spec = piece(item.id);
    expect(spec.api, item.id).toContain('free() -> { x, y, w, h } (it only measures: no side effect)');
    expect(spec.api, item.id).toContain('the panel sets it, and render only reads it and never calls G.panel');
    const panel = spec.modules.find(module => module.id === 'panel')!.duties;
    expect(panel, item.id).toContain('render never calls G.panel, so the two never call each other');
    for (const node of builders(item)) expect(node.task, node.id).toContain('Calls go one way');
    for (const id of ['test', 'test2']) {
      const task = item.nodes.find(node => node.id === id)!.task;
      expect(task, id).toContain('Note the time (date +%s > /tmp/start)');
      expect(task, id).toContain('from minute 17 on run no more checks');
    }
  }
});

it('writes the canvas in English and names no product, company or other work', () => {
  for (const item of CANVASES) {
    const text = JSON.stringify(item);
    expect(text).not.toMatch(/\p{Script=Han}/u);
    expect(text).not.toMatch(/photoshop|adobe|paperclip|tripo|seedream|x-?tasy|runninghub|jimeng|openai|anthropic|claude|gemini|chromium|swiftshader|playwright|unreal engine|\bunity\b|murano|corning|chihuly|steuben/i);
  }
});

// The canvas a published run will be checked against. Its SHA-256 is pinned below so that any change to a task, a
// template or a wire is made deliberately: update the snapshot (vitest -u) after reviewing the change.
it('pins the canonical canvas text, its assembly template and sandbox runtimes included', () => {
  const text = canonicalCanvasText(createOfficialDocument(GATHER));
  expect(text).toContain('{{in:from_core}}');
  expect(text).toContain('{{in:from_panel}}');
  expect(text).toContain('"gather.html"');
  expect(text).toContain(`"${SANDBOX_RUNTIME}"`);
  const plain = { ...GATHER, nodes: GATHER.nodes.map(node => ({ ...node, sandbox: undefined })) };
  expect(canonicalCanvasText(createOfficialDocument(plain))).not.toBe(text);
  expect(createHash('sha256').update(text).digest('hex')).toMatchInlineSnapshot(`"787e3048d62f06723a2bcfe83b36b6c35092a2289fe13873749292df836df058"`);
  const moss = canonicalCanvasText(createOfficialDocument(MOSSGREEN));
  expect(moss).toContain('{{in:from_course}}');
  expect(moss).toContain('"mossgreen.html"');
  expect(createHash('sha256').update(moss).digest('hex')).toMatchInlineSnapshot(`"19120a9bbba0adab85249fbfd908f6665bd39d0fc2e3df7e1624a2a24c84b85d"`);
  const freight = canonicalCanvasText(createOfficialDocument(FREIGHT));
  expect(freight).toContain('{{in:from_pilot}}');
  expect(freight).toContain('"night-freight.html"');
  expect(createHash('sha256').update(freight).digest('hex')).toMatchInlineSnapshot(`"b9e4e22448c9654c7de2e24730e380cac7bd3c2e27776ec4e0f2e160eea34ea5"`);
});
