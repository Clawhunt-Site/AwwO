import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { EPIC_WORKFLOWS } from '../src/saas/epicWorkflows';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { createOfficialDocument } from '../src/saas/examples/officialWorkflows';
import { createOfficialCopyDocument } from '../src/saas/examples/OfficialCopySetup';
import { canonicalCanvasText } from '../src/saas/productionCanvasText';
import { assembleTemplate, templateIssues, MAX_ASSEMBLE_OUTPUT_BYTES } from '../src/canvas/assembleNode';
import { SANDBOX_RUNTIME } from '../src/canvas/nodeRuntime';
import { sanitizeDocument, type AssembleNode, type MediaParams, type SessionNode } from '../src/canvas/canvasDoc';
import { canConnect, isSoftMediaFeed, reconcileEdges } from '../src/canvas/ports';
import { findCycle } from '../src/canvas/runGraph';
import { invalidMediaParams, mediaKindOf, parseMediaCatalogue, type MediaModel } from '../src/canvas/mediaCatalog';

// The epic canvases (epicWorkflows.ts): a whole game on the flagship pattern (saas-flagship-workflows.test.ts) with its
// own media nodes, so the checks below are the flagship's, widened where media nodes feed the builders.
const EPICS = Object.values(EPIC_WORKFLOWS);
const PALLWARD = EPIC_WORKFLOWS.pallward;
const MODULES = ['core', 'render', 'assets', 'physics', 'terrain', 'dressing', 'castle', 'input', 'camera', 'anim', 'combat',
  'fighter', 'player', 'ai', 'bosses', 'world', 'fx', 'audio', 'hud', 'menus'];

// The node prompt the API admits (128,000 bytes) and the per-task budget the flagship builders are held to.
const MAX_PROMPT_BYTES = 128000;
const MAX_TASK_CHARS = 20000;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
// What a node's task says it delivers, in characters; a report without a stated limit, and a media node's file list.
const deliveryLimit = (task: string) => Number(/at most ([\d,]+) characters in all/i.exec(task)?.[1].replace(/,/g, '') ?? 0);
const REPORT_BYTES = 16000;
const MEDIA_INPUT_BYTES = 1200;
// A spec node embeds its template whole, as a builder embeds the kernel: the rest of its task is held to the budget.
const TEMPLATE = /## Part [AB] - [\s\S]*?End of the template\./;
const outsideTemplate = (task: string) => task.replace(TEMPLATE, '');

// The 3D and image models' closed settings, as the API publishes them (backend tripo.go, tripo_motion.go,
// media_glb_textures.go, xtasy.go): the client's own validation (invalidMediaParams) is run on every media node against
// them.
const label: [string, string] = ['Setting', 'Setting'];
const ANIMATED = ['biped', 'quadruped', 'hexapod', 'octopod', 'serpentine', 'aquatic'];
const CHAIN_PARAMS = [
  { name: 'rig', type: 'enum', values: ['none', 'biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic'], default: 'none', label },
  { name: 'motion', type: 'enum', values: ['none', 'locomotion', 'combat', 'full'], default: 'none', label, requires: { param: 'rig', values: ANIMATED } },
  { name: 'inPlace', type: 'boolean', default: true, label, requires: { param: 'motion', values: ['locomotion', 'combat', 'full'] } },
  // The size the stored textures keep. Like the rig and its clips, it shapes what follows the model task (tripoChainParams).
  { name: 'textureSize', type: 'enum', values: ['original', '2048', '1024', '512'], default: 'original', label },
];
const TEXTURE_PARAMS = [
  { name: 'texture', type: 'boolean', default: true, label }, { name: 'pbr', type: 'boolean', default: true, label },
  { name: 'textureQuality', type: 'enum', values: ['standard', 'detailed'], default: 'standard', label },
];
const CATALOGUE = parseMediaCatalogue({ configured: true, available: true, models: [
  { id: 'tripo.p1', name: '3D', vendor: 'media', kind: 'model3d', prompt: { minLength: 1, maxLength: 1024 }, references: 1, params: [...TEXTURE_PARAMS,
    { name: 'faceLimit', type: 'integer', min: 500, max: 20000, default: 5000, label },
    { name: 'negativePrompt', type: 'text', maxLength: 255, label }, { name: 'autoSize', type: 'boolean', default: false, label }, ...CHAIN_PARAMS] },
  { id: 'tripo.v3-1', name: '3D HD', vendor: 'media', kind: 'model3d', prompt: { minLength: 1, maxLength: 1024 }, references: 1, params: [...TEXTURE_PARAMS,
    { name: 'geometryQuality', type: 'enum', values: ['standard', 'detailed'], default: 'standard', label },
    { name: 'faceLimit', type: 'integer', min: 1000, max: 500000, label },
    { name: 'negativePrompt', type: 'text', maxLength: 255, label }, { name: 'autoSize', type: 'boolean', default: false, label }, ...CHAIN_PARAMS] },
  { id: 'xt.seedream-5-pro', name: 'Image', vendor: 'media', kind: 'image', prompt: { minLength: 1, maxLength: 32000 }, references: 1, params: [
    { name: 'aspectRatio', type: 'enum', values: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'], default: '1:1', label },
    { name: 'resolution', type: 'enum', values: ['2K', '1K'], default: '2K', label }] },
] });
// The clips each animation set puts on a skeleton, file by file (tripoHumanoidSets, tripoCreaturePresets): the first
// file carries the model, a later one clips only.
const HUMANOID_SETS: Record<string, string[][]> = {
  locomotion: [['idle', 'walk', 'run', 'jump', 'fall']],
  combat: [['idle', 'walk', 'run', 'slash', 'hurt']],
  full: [['idle', 'walk', 'run', 'slash', 'hurt'], ['dive', 'climb', 'jump', 'fall', 'turn'], ['shoot']],
};
const CREATURE_CLIP: Record<string, string> = { quadruped: 'walk', hexapod: 'walk', octopod: 'walk', serpentine: 'march', aquatic: 'march' };
const clipFiles = (params: MediaParams | undefined): string[][] => {
  const rig = typeof params?.rig === 'string' ? params.rig : 'none';
  const motion = typeof params?.motion === 'string' ? params.motion : 'none';
  if (rig === 'none' || motion === 'none') return [];
  return rig === 'biped' ? HUMANOID_SETS[motion] : [[CREATURE_CLIP[rig]]];
};
// The clips the game plays on a humanoid (B5): every one must be among its files.
const PLAYED_CLIPS = ['idle', 'walk', 'run', 'slash', 'dive', 'climb', 'jump', 'fall', 'shoot'];

const builders = (item: typeof PALLWARD) => item.nodes.filter(node => node.task.includes('Rules for every module'));
const duties = (task: string) => task.slice(0, task.indexOf('Pallward kernel contract (fixed'));
const agentsOf = (document: ReturnType<typeof createOfficialDocument>) =>
  document.nodes.filter((node): node is SessionNode => node.kind === 'session' && !mediaKindOf(node.agentKind));
const mediaOf = (document: ReturnType<typeof createOfficialDocument>) =>
  document.nodes.filter((node): node is SessionNode => node.kind === 'session' && mediaKindOf(node.agentKind) !== null);

it('is not listed as a case before a run of it is published', () => {
  for (const item of EPICS) expect(PRODUCTION_WORKFLOWS[item.id], item.id).toBeUndefined();
  expect(Object.keys(EPIC_WORKFLOWS)).toEqual(['pallward']);
});

it('has the design\'s 71 nodes, well under the 200-node cap: 3 design nodes, 10 concepts, 33 models, 20 builders, assembly, two fix passes with the first one\'s page between them, and review', () => {
  const document = createOfficialDocument(PALLWARD);
  expect(PALLWARD.nodes).toHaveLength(28);
  expect(PALLWARD.media).toHaveLength(43);
  expect(document.nodes).toHaveLength(71);
  expect(document.nodes.length).toBeLessThanOrEqual(200);
  expect(PALLWARD.media!.filter(spec => spec.kind === 'image')).toHaveLength(10);
  expect(PALLWARD.media!.filter(spec => spec.kind === 'model3d')).toHaveLength(33);
  expect(builders(PALLWARD).map(node => node.id)).toEqual(MODULES);
  // 81 wires between agents and assembly nodes, one from each model into the assets builder, one from each concept into
  // its model.
  expect(PALLWARD.edges).toHaveLength(81);
  expect(document.edges).toHaveLength(124);
  expect(PALLWARD.stack).toBe('r186');
  expect(PALLWARD.fonts).toBe(true);
});

it('compiles into one acyclic DAG that runs left to right, every wire compatible and every input fed exactly once', () => {
  for (const item of EPICS) {
    const document = createOfficialDocument(item);
    expect(findCycle(document.nodes, document.edges)).toEqual([]);
    expect(reconcileEdges(document.nodes, document.edges)).toEqual(document.edges);
    const connected: typeof document.edges = [];
    for (const edge of document.edges) {
      expect(canConnect(document.nodes, connected, { nodeId: edge.fromNode, portId: edge.fromPort }, { nodeId: edge.toNode, portId: edge.toPort }),
        `${edge.fromNode}->${edge.toNode}`).toBe(true);
      connected.push(edge);
    }
    // Columns grow along every wire, or a wire runs down one column (the design room: spec, then tech and art).
    const place = new Map([...item.nodes, ...(item.media ?? [])].map(node => [node.id, [node.column, node.row] as const]));
    expect(place.size, item.id).toBe(item.nodes.length + (item.media?.length ?? 0));
    const wires = [...item.edges.map(edge => [edge.from, edge.to]),
      ...(item.media ?? []).flatMap(spec => [...(spec.feeds ?? []).map(to => [spec.id, to]), ...(spec.references ?? []).map(from => [from, spec.id])])];
    for (const [from, to] of wires) {
      const [a, b] = [place.get(from)!, place.get(to)!];
      expect(b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]), `${from}->${to}`).toBe(true);
    }
    const last = Math.max(...item.nodes.map(node => node.column));
    expect(item.nodes.filter(node => node.column === last).map(node => node.role)).toEqual(['review']);
    // Two fix passes: the first pass's page reaches the second as a file through an assemble node.
    expect(item.nodes.filter(node => node.outputType === 'html').map(node => node.id)).toEqual(['test', 'test2']);
    for (const node of document.nodes) {
      for (const field of node.kind === 'session' || node.kind === 'assemble' ? (node.contract?.inputs ?? []) : []) {
        if (field.id === 'brief') continue;
        const into = document.edges.filter(edge => edge.toNode === node.id && edge.toPort === `in:${field.id}`);
        expect(into, `${node.title}/${field.id}`).toHaveLength(1);
        if (field.id.startsWith('media_')) {
          // A 3D model's files, a soft wire: a model that was not made leaves the builder a note instead.
          const from = document.nodes.find(value => value.id === into[0].fromNode)!;
          expect(into[0].dataType).toBe('file');
          expect(isSoftMediaFeed(from, node, into[0])).toBe(true);
        } else expect(into[0].dataType, `${node.title}/${field.id}`).toBe(field.type === 'file' ? 'file' : 'text');
      }
    }
    // Every builder reads the Tech spec; all but assets the Game spec; the visual and sound ones the art direction.
    for (const node of builders(item)) {
      const from = item.edges.filter(edge => edge.to === node.id).map(edge => edge.from).sort();
      const art = ['render', 'terrain', 'dressing', 'castle', 'fx', 'audio', 'hud', 'menus'].includes(node.id);
      expect(from, node.id).toEqual([...(art ? ['art'] : []), ...(node.id === 'assets' ? [] : ['spec']), 'tech']);
    }
  }
});

it('makes every concept and model on the settings the API takes: 2K square concepts, low-poly models rigged and animated by the real sets', () => {
  const models = new Map(CATALOGUE.models.map(model => [model.id, model]));
  expect(models.size).toBe(3);
  for (const spec of PALLWARD.media!) {
    const model = models.get(spec.model) as MediaModel;
    expect(model?.kind, spec.id).toBe(spec.kind);
    expect(invalidMediaParams(model, spec.params), spec.id).toEqual([]);
    expect(spec.prompt.length, spec.id).toBeLessThanOrEqual(model.kind === 'image' ? 32000 : 1024);
    // Every title starts with its asset id, by which the assets builder maps each input.
    expect(spec.title.startsWith(`${spec.id} · `), spec.id).toBe(true);
    if (spec.kind === 'image') {
      expect(spec.params).toEqual({ aspectRatio: '1:1', resolution: '2K' });
      expect(spec.feeds ?? []).toEqual([]);
      continue;
    }
    // The design asks for high detail nowhere in the core tier: every model is the low-poly game asset.
    expect(spec.model, spec.id).toBe('tripo.p1');
    expect(spec.feeds).toEqual(['assets']);
    expect(Object.keys(spec.params ?? {}).filter(name => !['texture', 'pbr', 'textureQuality', 'faceLimit', 'rig', 'motion', 'inPlace', 'textureSize'].includes(name))).toEqual([]);
    // A painted model keeps its textures at 1,024 pixels, the size a page of dozens of models can embed; a banded one has none.
    expect(spec.params?.textureSize, spec.id).toBe(spec.params?.texture ? '1024' : undefined);
    const rig = spec.params?.rig ?? 'none';
    if (rig === 'biped') expect(spec.params, spec.id).toMatchObject({ motion: 'full', inPlace: true });
    else if (rig === 'none') expect(spec.params?.motion ?? 'none', spec.id).toBe('none');
    else expect(['quadruped', 'hexapod']).toContain(rig);
    // A model made from a painting takes it as its one reference; a weapon or prop from words only.
    for (const source of spec.references ?? []) expect(PALLWARD.media!.find(entry => entry.id === source)?.kind).toBe('image');
    expect((spec.references ?? []).length).toBeLessThanOrEqual(model.references);
  }
  // Ten concepts, each the reference of the model of its subject.
  const references = PALLWARD.media!.flatMap(spec => (spec.references ?? []).map(source => [source, spec.id]));
  expect(references).toHaveLength(10);
  for (const [source, target] of references) expect(source.slice(2)).toBe(target.slice(2));
  // Every humanoid has every clip the game plays, in three files; a beast its walk.
  for (const spec of PALLWARD.media!.filter(entry => entry.kind === 'model3d' && entry.params?.rig)) {
    const files = clipFiles(spec.params);
    if (spec.params!.rig === 'biped') {
      expect(files, spec.id).toHaveLength(3);
      for (const clip of PLAYED_CLIPS) expect(files.flat(), `${spec.id}/${clip}`).toContain(clip);
    } else expect(files, spec.id).toEqual([['walk']]);
  }
});

it('tells the assets and animation builders and the Tech spec the files and clips the model nodes really hand over', () => {
  const task = (id: string) => PALLWARD.nodes.find(node => node.id === id)!.task;
  const clips = new Set(PALLWARD.media!.flatMap(spec => clipFiles(spec.params).flat()));
  expect([...clips].sort()).toEqual(['climb', 'dive', 'fall', 'hurt', 'idle', 'jump', 'run', 'shoot', 'slash', 'turn', 'walk']);
  for (const id of ['assets', 'anim', 'tech']) {
    for (const clip of clips) expect(task(id), `${id}/${clip}`).toMatch(new RegExp(`\\b${clip}\\b`));
    for (const file of HUMANOID_SETS.full.map((_, index) => `model-${index + 1}.glb`)) expect(task(id), `${id}/${file}`).toContain(file);
  }
  // The manifest: every asset in the priority order, its height and grip.
  const assets = duties(task('assets'));
  for (const spec of PALLWARD.media!.filter(entry => entry.kind === 'model3d')) expect(assets, spec.id).toMatch(new RegExp(`\\d+\\. ${spec.id}: `));
  const order = [...assets.matchAll(/^(\d+)\. ([a-z_]+): /gm)].map(match => Number(match[1]));
  expect(order).toEqual(Array.from({ length: 33 }, (_, index) => index + 1));
});

it('assembles the page from all twenty builders with no model, in init order, and hands it to the sandbox as a file', () => {
  for (const item of EPICS) {
    const document = createOfficialDocument(item);
    const pages = document.nodes.filter((node): node is AssembleNode => node.kind === 'assemble');
    expect(pages.map(node => node.title)).toEqual(['Assembly', 'First pass page']);
    // The second assemble node hands the first fix pass's page, byte for byte, to the second as a file.
    const handover = pages[1];
    expect([handover.template, handover.fileName, (handover.contract?.inputs ?? []).map(field => field.id)]).toEqual(['{{in:from_test}}', 'pallward.html', ['from_test']]);
    expect(handover.contract?.outputs.map(field => [field.id, field.type])).toEqual([['file', 'file']]);
    const passed = assembleTemplate(handover.template, { from_test: '<!DOCTYPE html>\n<html><body>page</body></html>' });
    expect(passed.ok && passed.text).toBe('<!DOCTYPE html>\n<html><body>page</body></html>');
    const page = pages[0];
    const inputs = (page.contract?.inputs ?? []).map(field => field.id);
    expect(inputs).toEqual(MODULES.map(id => `from_${id}`));
    expect(templateIssues(page.template, inputs)).toEqual([]);
    expect(page.fileName).toBe('pallward.html');
    expect(page.contract?.outputs.map(field => [field.id, field.type])).toEqual([['file', 'file']]);
    const values = Object.fromEntries(inputs.map(id => [id, '```javascript\nconsole.log("' + id + '</script>");\n```']));
    const built = assembleTemplate(page.template, values);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.text.startsWith('<!DOCTYPE html>') && built.text.trimEnd().endsWith('</html>')).toBe(true);
    expect(built.text).not.toContain('```');
    // Each module in its own script tag after its marker, in the kernel's init order, then the boot.
    const at = MODULES.map(id => built.text.indexOf(`<!-- module: ${id} -->\n<script>console.log("from_${id}<\\/script>");</script>`));
    expect(at.every(index => index > 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const boot = built.text.indexOf('<script type="module">');
    expect(boot).toBeGreaterThan(at[at.length - 1]);
    // The kernel the builders share: its init order and its G.lib are the page's.
    const kernel = builders(item)[0].task;
    expect(/Init order: ([a-z, ]+)\./.exec(kernel)?.[1].split(', ')).toEqual(MODULES);
    const lib = (text: string) => /G\.lib = \{ ([A-Za-z, ]+) \}/.exec(text)?.[1].split(', ');
    expect(lib(built.text)).toEqual(lib(kernel));
    const imports = built.text.split('\n').filter(line => line.startsWith('import ')).join('\n');
    for (const name of lib(kernel)!) expect(imports, name).toMatch(new RegExp(`\\b${name}\\b`));
    expect(built.text).toContain('<script type="importmap">');
    expect(built.text.indexOf("G.on('ready'")).toBeLessThan(built.text.indexOf('G.boot('));
    // Room for every module at its limit.
    const limits = builders(item).reduce((sum, node) => sum + deliveryLimit(node.task), 0);
    expect(limits).toBe(374000);
    expect(bytes(page.template) + limits * 1.1).toBeLessThan(MAX_ASSEMBLE_OUTPUT_BYTES);
    // The page file reaches the sandbox test, and only its report reaches the review.
    const wire = document.edges.find(edge => edge.fromNode === page.id);
    expect(wire && [wire.fromPort, wire.dataType]).toEqual(['out:file', 'file']);
    const test = document.nodes.find((node): node is SessionNode => node.kind === 'session' && node.id === wire!.toNode);
    expect(test?.runtime).toBe(SANDBOX_RUNTIME);
    expect(test!.contract?.outputs.map(field => [field.id, field.type])).toEqual([['result', 'html'], ['report', 'markdown']]);
    const review = document.nodes.find(node => node.kind === 'session' && node.title === 'Review')!;
    expect(document.edges.filter(edge => edge.toNode === review.id && edge.fromNode === test!.id).map(edge => edge.fromPort)).toEqual(['out:report']);
  }
});

it('gives every builder the same fixed kernel contract, API sheet and rules, within the flagships\' task budget', () => {
  for (const item of EPICS) {
    const team = builders(item);
    expect(new Set(team.map(node => node.column)).size).toBe(1);
    const contract = (task: string) => task.slice(task.indexOf('kernel contract (fixed'), task.indexOf('Rules for every module'));
    expect(contract(team[0].task).length).toBeGreaterThan(3000);
    expect(contract(team[0].task)).toContain('Pallward API sheet (fixed');
    const document = createOfficialDocument(item);
    for (const node of team) {
      expect(contract(node.task), node.id).toBe(contract(team[0].task));
      expect(node.sandbox, node.id).toBe(true);
      expect(node.task, node.id).toContain(`node --check ${node.id}.js`);
      expect(node.task, node.id).toContain(`call workspace_publish with field "result" and path "${node.id}.js"`);
      expect(node.task, node.id).toContain('G.tests.plant');
      expect(node.task.length, node.id).toBeLessThan(MAX_TASK_CHARS);
      expect(deliveryLimit(node.task), node.id).toBeGreaterThanOrEqual(12000);
      const tile = document.nodes.find((value): value is SessionNode => value.kind === 'session' && value.title === node.title);
      expect(tile?.runtime, node.id).toBe(SANDBOX_RUNTIME);
    }
    // The other nodes too; a spec node's template, embedded whole, is held to the prompt limit below instead.
    for (const node of item.nodes) expect(outsideTemplate(node.task).length, node.id).toBeLessThan(MAX_TASK_CHARS);
  }
});

it('owns every acceptance test and planted failure of the Tech spec in exactly one builder, by its owner', () => {
  const tech = PALLWARD.nodes.find(node => node.id === 'tech')!.task;
  const testOwners = new Map([...tech.matchAll(/^(\d+)\. ([a-z]+)\b/gm)].map(match => [Number(match[1]), match[2]]));
  expect([...testOwners.keys()]).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
  const plantOwners = new Map([...tech.matchAll(/^\| P(\d\d) \| ([a-z]+) \|/gm)].map(match => [Number(match[1]), match[2]]));
  expect([...plantOwners.keys()]).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
  const tests = new Map<number, string>();
  const plants = new Map<number, string>();
  for (const node of builders(PALLWARD)) {
    const text = duties(node.task).slice(duties(node.task).indexOf('Your duties'));
    const [, from, to] = /Tests (\d+)-(\d+)/.exec(text) ?? [];
    for (let n = Number(from); n <= Number(to); n++) {
      expect(tests.has(n), `test ${n}`).toBe(false);
      tests.set(n, node.id);
    }
    for (const match of text.matchAll(/\bP(\d\d)\b/g)) {
      expect(plants.get(Number(match[1])) ?? node.id, `P${match[1]}`).toBe(node.id);
      plants.set(Number(match[1]), node.id);
    }
  }
  expect(new Map([...tests].sort(([a], [b]) => a - b))).toEqual(testOwners);
  expect(new Map([...plants].sort(([a], [b]) => a - b))).toEqual(plantOwners);
});

it('carries the Game spec and Tech spec templates whole, with room to write them, and keeps every node prompt under 128,000 bytes', () => {
  const task = (id: string) => PALLWARD.nodes.find(node => node.id === id)!.task;
  for (const [id, first, last] of [['spec', '### A1 Scope', '### A10 Flow'], ['tech', '### B1 Map', '### B9 Unknowns']] as const) {
    const template = TEMPLATE.exec(task(id))?.[0] ?? '';
    expect(template, id).toContain(first);
    expect(template, id).toContain(last);
    expect(deliveryLimit(task(id)), id).toBeGreaterThan(template.length);
  }
  expect(deliveryLimit(task('art'))).toBe(10000);
  // A prompt: the node's persona and its task input, plus everything its wires bring at most.
  const document = createOfficialDocument(PALLWARD);
  const specOf = new Map([...PALLWARD.nodes].map(node => [node.title, node]));
  const byNode = new Map(document.nodes.map(node => [node.id, node]));
  for (const node of agentsOf(document)) {
    const own = bytes(node.persona) + bytes(node.contract!.inputs.find(field => field.id === 'brief')!.value);
    const brought = document.edges.filter(edge => edge.toNode === node.id && (edge.dataType !== 'file' || edge.toPort.startsWith('in:media_')))
      .reduce((sum, edge) => {
        const from = byNode.get(edge.fromNode)!;
        if (from.kind === 'session' && mediaKindOf(from.agentKind)) return sum + MEDIA_INPUT_BYTES;
        const limit = deliveryLimit(specOf.get(from.title)?.task ?? '');
        return sum + (limit ? Math.ceil(limit * 1.1) : REPORT_BYTES);
      }, 0);
    expect(own + brought, node.title).toBeLessThan(MAX_PROMPT_BYTES);
  }
});

it('mints a fresh canvas for every copy, keeps every agent in its sandbox computer, and reloads unchanged', () => {
  for (const item of EPICS) {
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
    for (const node of mediaOf(second)) {
      const spec = item.media!.find(entry => entry.title === node.title)!;
      expect([node.agentKind, node.model, node.runtime]).toEqual([spec.kind, spec.model, '']);
      expect(node.mediaParams).toEqual(spec.params);
      expect(node.threads?.map(thread => thread.draft)).toEqual([spec.prompt]);
    }
    expect(JSON.stringify(item)).toBe(before);
    const restored = sanitizeDocument(JSON.parse(JSON.stringify(second)));
    second.nodes.forEach((node, index) => expect(restored.nodes[index], `${index}`).toMatchObject(node));
    expect(restored.edges).toEqual(second.edges);
    const copy = createOfficialCopyDocument(item, { runtime: 'openai-agents', model: 'gate-only', label: 'Gate only' });
    for (const node of agentsOf(copy)) expect([node.runtime, node.model], node.title).toEqual([SANDBOX_RUNTIME, '']);
    for (const node of mediaOf(copy)) expect(node.model).not.toBe('');
    expect(canonicalCanvasText(copy)).toBe(canonicalCanvasText(second));
  }
});

it('writes the canvas in English and names no product, company or other game', () => {
  for (const item of EPICS) {
    // The media nodes' model ids are settings, not text a node reads.
    const text = JSON.stringify({ ...item, media: item.media?.map(spec => ({ ...spec, model: '' })) });
    expect(text).not.toMatch(/\p{Script=Han}/u);
    expect(text).not.toMatch(/photoshop|adobe|gimp|affinity photo|pixelmator|paperclip|tripo|seedream|x-?tasy|runninghub|jimeng|openai|anthropic|claude|gemini|chromium|swiftshader|dark souls|soulslike|elden|bloodborne|sekiro|fromsoft|unreal engine|\bunity\b/i);
  }
});

// The canvas a published run will be checked against. Its SHA-256 is pinned below so that any change to a task, a
// template, a wire or a media setting is made deliberately: update the snapshot (vitest -u) after reviewing the change.
// The canonical text is the agents', the assembly's and the wires' (a published record carries its hash); it leaves out
// the media nodes' models, prompts and settings, so those are pinned by a second hash.
it('pins the canonical canvas text, its assembly template and sandbox runtimes included', () => {
  const text = canonicalCanvasText(createOfficialDocument(PALLWARD));
  expect(text).toContain('{{in:from_core}}');
  expect(text).toContain('{{in:from_menus}}');
  expect(text).toContain('"pallward.html"');
  expect(text).toContain(`"${SANDBOX_RUNTIME}"`);
  const plain = { ...PALLWARD, nodes: PALLWARD.nodes.map(node => ({ ...node, sandbox: undefined })) };
  expect(canonicalCanvasText(createOfficialDocument(plain))).not.toBe(text);
  expect(createHash('sha256').update(text).digest('hex')).toMatchInlineSnapshot(`"7774dea723f4e14ee069263ec53a8de4b053a3787b50a02b176515621fd68a57"`);
  expect(createHash('sha256').update(JSON.stringify(PALLWARD.media)).digest('hex')).toMatchInlineSnapshot(`"a85991f713fee8afff2f72b232dbea6357ebb8102c3d462d68b57b72821f3c01"`);
});
