import { expect, it } from 'vitest';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { createOfficialDocument } from '../src/saas/examples/officialWorkflows';
import { THREE_MODULES_IMPORT_MAP } from '../src/canvas/previewModules';
import type { SessionNode } from '../src/canvas/canvasDoc';

const WORKFLOWS = Object.values(PRODUCTION_WORKFLOWS);
// A case's media nodes (image and video generators, officialMedia.ts) are not agents: on its card the media of one
// stage count as one slot of the team, beside that stage's agents.
const stagesOf = (id: string) => {
  const workflow = PRODUCTION_WORKFLOWS[id];
  const media = workflow.media ?? [];
  return [...new Set([...workflow.nodes, ...media].map(node => node.column))].sort((a, b) => a - b)
    .map(column => workflow.nodes.filter(node => node.column === column).length + (media.some(value => value.column === column) ? 1 : 0));
};

it('gives every case its canvas here, the knowledge base’s too', () => {
  expect(Object.keys(PRODUCTION_WORKFLOWS).sort()).toEqual(PRODUCTION_CASES.map(item => item.id).sort());
  for (const item of WORKFLOWS) expect(PRODUCTION_WORKFLOWS[item.id]).toBe(item);
});

it('shows on each card exactly the team its canvas has, stage by stage', () => {
  for (const item of PRODUCTION_CASES)
    expect(item.stages.map(stage => stage.length), item.id).toEqual(stagesOf(item.id));
});

it('is a valid DAG that runs left to right and compiles into its one English canvas', () => {
  for (const item of WORKFLOWS) {
    const ids = item.nodes.map(node => node.id);
    expect(new Set(ids).size, item.id).toBe(ids.length);
    const media = item.media ?? [];
    const column = new Map([...item.nodes, ...media].map(node => [node.id, node.column]));
    expect(column.size, item.id).toBe(ids.length + media.length);
    const keys = item.edges.map(edge => `${edge.from}->${edge.to}`);
    expect(new Set(keys).size, item.id).toBe(keys.length);
    // A media node's result reaches the pages it feeds as a soft wire: a hand-off like any edge.
    const feeds = media.flatMap(value => (value.feeds ?? []).map(to => ({ from: value.id, to })));
    // A media node made from another one's picture (a colour version, a clip of the same car) waits for that picture
    // inside the media stage: the picture is an image node of the same canvas, in the same column.
    const references = media.flatMap(value => (value.references ?? []).map(from => ({ from, to: value.id })));
    for (const reference of references) {
      expect(media.find(value => value.id === reference.from)?.kind, `${item.id}: ${reference.from}->${reference.to}`).toBe('image');
      expect(reference.from, item.id).not.toBe(reference.to);
      expect(column.get(reference.to), `${item.id}: ${reference.from}->${reference.to}`).toBe(column.get(reference.from));
    }
    for (const edge of [...item.edges, ...feeds]) {
      expect(column.has(edge.from) && column.has(edge.to), `${item.id}: ${edge.from}->${edge.to}`).toBe(true);
      // Every handoff goes to a later stage, so stages are the dependency order and there is no cycle.
      expect(column.get(edge.to)!, `${item.id}: ${edge.from}->${edge.to}`).toBeGreaterThan(column.get(edge.from)!);
    }
    for (const value of media) expect(item.nodes.some(node => value.feeds?.includes(node.id) && node.outputType === 'html'), `${item.id}/${value.id}`).toBe(true);
    // A column is a stage: each node past the first stage receives something from the stage right before it.
    for (const node of item.nodes.filter(value => value.column > 0))
      expect([...item.edges, ...feeds].some(edge => edge.to === node.id && column.get(edge.from) === node.column - 1), `${item.id}/${node.id}`).toBe(true);
    const document = createOfficialDocument(item);
    expect(document.nodes).toHaveLength(item.nodes.length + media.length);
    expect(document.edges).toHaveLength(item.edges.length + feeds.length + references.length);
    // The media nodes follow the agents in the workflow's order; a reference is the picture's result into the node's
    // reference input.
    const mediaNode = (id: string) => document.nodes[item.nodes.length + media.findIndex(value => value.id === id)];
    for (const reference of references)
      expect(document.edges.filter(edge => edge.fromNode === mediaNode(reference.from).id && edge.fromPort === 'result'
        && edge.toNode === mediaNode(reference.to).id && edge.toPort === 'reference' && edge.dataType === 'image'), `${item.id}: ${reference.from}->${reference.to}`).toHaveLength(1);
    for (const node of (document.nodes as SessionNode[]).filter(value => value.contract)) {
      const inputs = node.contract!.inputs.map(field => field.id);
      expect(new Set(inputs).size).toBe(inputs.length);
      // One source per input port, as the server's DAG check requires.
      for (const input of inputs.filter(value => value !== 'brief'))
        expect(document.edges.filter(edge => edge.toNode === node.id && edge.toPort === `in:${input}`)).toHaveLength(1);
    }
  }
});

it('refuses a media reference that names no picture of the same canvas', () => {
  const item = PRODUCTION_WORKFLOWS['aurora-gt'];
  const pointing = (to: string) => item.media!.map(value => value.id === 'red' ? { ...value, references: [to] } : value);
  expect(() => createOfficialDocument({ ...item, media: pointing('drive') })).toThrow('Invalid official media reference: drive -> red');
  expect(() => createOfficialDocument({ ...item, media: pointing('red') })).toThrow('Invalid official media reference: red -> red');
  expect(() => createOfficialDocument({ ...item, media: pointing('page') })).toThrow('Invalid official media reference: page -> red');
});

it('ends every canvas in a review and delivers exactly one self-contained HTML build', () => {
  for (const item of WORKFLOWS) {
    const last = Math.max(...item.nodes.map(node => node.column));
    expect(item.nodes.filter(node => node.column === last).map(node => node.role), item.id).toEqual(['review']);
    const builds = item.nodes.filter(node => node.outputType === 'html');
    expect(builds, item.id).toHaveLength(1);
    // Sized for Claude Opus 5.5: one call of at most 32,000 output tokens, its own thinking included. A 2D build writes the
    // page itself (16,000 characters); a 3D build pastes the scene code an upstream node delivered and only wires it
    // (24,000), as the knowledge base's page does with its data and business layer, or, where the scene is split into two
    // half-size modules (7,000 each), pastes both (28,000). The car plant's
    // page pastes its six modules (36,000); the largest cases build in two steps, a wiring node writing only the code that
    // connects the modules and a page that only pastes the modules and the wiring (56,000).
    const limit = [56000, 36000, 28000, 24000, 16000].find(size => builds[0].task.includes(`Delivery: one HTML file of at most ${size.toLocaleString('en-US')} characters.`));
    expect(limit, item.id).toBeDefined();
    const pastes = limit === 56000;
    expect(builds[0].task, item.id).toContain('this node makes one call of at most about 32,000 output tokens');
    // Half-size scene modules belong to the 28,000-character assembly; the larger cases size every module on its own.
    if (limit === 24000 || limit === 28000) {
      const halves = item.nodes.filter(node => node.task.includes('Output only the code, at most 7,000 characters.'));
      expect(halves.length, item.id).toBe(limit === 28000 ? 2 : 0);
    }
    expect(builds[0].task).toContain(pastes ? 'This step only pastes' : limit !== 16000 ? 'This step only assembles' : 'this step only implements and assembles them');
    if (pastes) {
      // The page that only pastes takes its glue from the one wiring node, in the stage right before it.
      const wiring = item.nodes.filter(node => node.task.includes('it is the program’s entry point'));
      expect(wiring.map(node => node.column), item.id).toEqual([builds[0].column - 1]);
      expect(item.edges.some(edge => edge.from === wiring[0].id && edge.to === builds[0].id), item.id).toBe(true);
    }
    expect(builds[0].task).toMatch(/no localStorage, cookies or network requests/);
    // The one external script a build may name is the three.js release AwwO's previews supply: r128 by its tag, or
    // r186 as ES modules through the import map (a canvas on `stack: 'r186'`), which its one module script imports from.
    if (item.stack === 'r186') {
      expect(builds[0].task, item.id).toContain(THREE_MODULES_IMPORT_MAP);
      expect(builds[0].task, item.id).toContain("import * as THREE from 'three';");
      expect(builds[0].task, item.id).not.toContain('three.js/r128');
      for (const node of item.nodes) expect(node.task, `${item.id}/${node.id}`).not.toMatch(/three\.js r128|global THREE/);
    } else expect(builds[0].task).toContain('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js');
    expect(item.edges.some(edge => edge.from === builds[0].id && item.nodes.find(node => node.id === edge.to)?.role === 'review'), item.id).toBe(true);
  }
});

it('holds the knowledge base’s workspace to a SaaS product’s look and has it paste code and data, not a 3D scene', () => {
  // Its page takes the 3D builds' assembly rules with two of them replaced; a replacement that no longer finds its text
  // would quietly leave the 3D rule in place.
  const page = PRODUCTION_WORKFLOWS['knowledge-base'].nodes.find(node => node.outputType === 'html')!;
  expect(page.task).toContain('paste the code and data delivered upstream exactly as delivered');
  expect(page.task).toContain('The look must reach the standard of a leading SaaS product');
  expect(page.task).not.toMatch(/3D code delivered upstream|commercial key-art/);
});

it('writes every text in English and claims no real brand, footage or production system', () => {
  for (const item of WORKFLOWS) {
    const texts = [item.title, item.brief, ...item.nodes.flatMap(node => [node.title, node.task, node.output, ...node.acceptance]),
      ...item.edges.map(edge => edge.label), ...(item.media ?? []).flatMap(value => [value.title, value.prompt])];
    for (const text of texts) {
      expect(text.trim(), item.id).not.toBe('');
      // English throughout, the titles its pages show included.
      expect(text, item.id).not.toMatch(/\p{Script=Han}/u);
    }
    // A case's limits are told to its nodes, in their tasks (the 32,000-token call above), not in a note of its own.
    expect('limitations' in item, item.id).toBe(false);
    expect(JSON.stringify(item)).not.toMatch(/paperclip/i);
  }
  const ad = PRODUCTION_WORKFLOWS['summer-ad'];
  expect(ad.brief).toContain('Pre-produce a 30-second summer ad for a fictional brand’s blood-orange sparkling drink');
  expect(ad.brief).toContain('do not generate, or claim to have filmed or generated, real footage');
  expect(PRODUCTION_WORKFLOWS['3d-configurator'].brief).toContain('the fictional brand Orvia');
  expect(PRODUCTION_WORKFLOWS['port-twin'].brief).toContain('label the page “simulated data”');
});

it('keeps every node’s fixed prompt well inside what Claude Opus 5.5 leaves for input', () => {
  for (const item of WORKFLOWS) for (const node of (createOfficialDocument(item).nodes as SessionNode[]).filter(value => value.contract?.inputs.length)) {
    // Persona, brief and output policy are sent twice (system and user); upstream outputs add the rest. The runtime's
    // system prompt allows 32,768 characters, so the fixed part stays far below it.
    const fixed = new TextEncoder().encode(node.persona + node.contract!.inputs[0].value).byteLength;
    expect(fixed, `${item.id}/${node.title}`).toBeLessThan(16000);
  }
});
