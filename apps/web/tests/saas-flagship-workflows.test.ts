import { expect, it } from 'vitest';
import { FLAGSHIP_WORKFLOWS } from '../src/saas/flagshipWorkflows';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { createOfficialDocument } from '../src/saas/examples/officialWorkflows';
import { canonicalCanvasText } from '../src/saas/productionCanvasText';
import { assembleTemplate, templateIssues } from '../src/canvas/assembleNode';
import { SANDBOX_RUNTIME } from '../src/canvas/nodeRuntime';
import type { AssembleNode, SessionNode } from '../src/canvas/canvasDoc';

const FLAGSHIPS = Object.values(FLAGSHIP_WORKFLOWS);

it('keeps flagship canvases apart from the published cases until a run of them is published', () => {
  for (const item of FLAGSHIPS) expect(PRODUCTION_WORKFLOWS[item.id], item.id).toBeUndefined();
});

it('compiles each flagship into one DAG that runs left to right: spec, builders, assembly, a sandbox test, review', () => {
  for (const item of FLAGSHIPS) {
    const column = new Map(item.nodes.map(node => [node.id, node.column]));
    expect(column.size, item.id).toBe(item.nodes.length);
    for (const edge of item.edges) expect(column.get(edge.to)!, `${edge.from}->${edge.to}`).toBeGreaterThan(column.get(edge.from)!);
    for (const node of item.nodes.filter(value => value.column > 0)) {
      expect(item.edges.some(edge => edge.to === node.id && column.get(edge.from) === node.column - 1), `${item.id}/${node.id}`).toBe(true);
    }
    const last = Math.max(...item.nodes.map(node => node.column));
    expect(item.nodes.filter(node => node.column === last).map(node => node.role)).toEqual(['review']);
    expect(item.nodes.filter(node => node.outputType === 'html').map(node => node.id), item.id).toHaveLength(1);
    const document = createOfficialDocument(item);
    expect(document.nodes).toHaveLength(item.nodes.length);
    expect(document.edges).toHaveLength(item.edges.length);
    // Every input is fed exactly once, through a wire of the right type.
    for (const node of document.nodes) {
      for (const field of node.kind === 'session' || node.kind === 'assemble' ? (node.contract?.inputs ?? []) : []) {
        if (field.id === 'brief') continue;
        const wires = document.edges.filter(edge => edge.toNode === node.id && edge.toPort === `in:${field.id}`);
        expect(wires, `${node.title}/${field.id}`).toHaveLength(1);
        expect(wires[0].dataType, `${node.title}/${field.id}`).toBe(field.type === 'file' ? 'file' : 'text');
      }
    }
  }
});

it('assembles the page from every builder with no model, and hands it to the sandbox as a file', () => {
  for (const item of FLAGSHIPS) {
    const document = createOfficialDocument(item);
    const pages = document.nodes.filter((node): node is AssembleNode => node.kind === 'assemble');
    expect(pages, item.id).toHaveLength(1);
    const page = pages[0];
    const inputs = (page.contract?.inputs ?? []).map(field => field.id);
    expect(templateIssues(page.template, inputs)).toEqual([]);
    expect(page.contract?.outputs.map(field => [field.id, field.type])).toEqual([['file', 'file']]);
    // A slot for every wire into the page, each in its own script tag, then the boot.
    const values = Object.fromEntries(inputs.map(id => [id, '```javascript\nconsole.log("' + id + '</script>");\n```']));
    const built = assembleTemplate(page.template, values);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.text.startsWith('<!DOCTYPE html>') && built.text.trimEnd().endsWith('</html>')).toBe(true);
    for (const id of inputs) expect(built.text).toContain(`console.log("${id}<\\/script>");`);
    expect(built.text).not.toContain('```');
    const wire = document.edges.find(edge => edge.fromNode === page.id);
    expect(wire && [wire.fromPort, wire.dataType]).toEqual(['out:file', 'file']);
    const test = document.nodes.find((node): node is SessionNode => node.kind === 'session' && node.id === wire!.toNode);
    expect(test?.runtime, item.id).toBe(SANDBOX_RUNTIME);
    expect(test!.contract?.outputs.map(field => [field.id, field.type])).toEqual([['result', 'html'], ['report', 'markdown']]);
    // The review reads the test report, never the whole page.
    const review = document.nodes.find(node => node.kind === 'session' && node.title === 'Review')!;
    expect(document.edges.filter(edge => edge.toNode === review.id && edge.fromNode === test!.id).map(edge => edge.fromPort)).toEqual(['out:report']);
  }
});

it('gives every builder the same fixed kernel contract and module rules, within the node prompt budget', () => {
  for (const item of FLAGSHIPS) {
    const builders = item.nodes.filter(node => node.task.includes('Rules for every module'));
    expect(builders.length, item.id).toBeGreaterThanOrEqual(6);
    expect(new Set(builders.map(node => node.column)).size, item.id).toBe(1);
    const contract = (task: string) => task.slice(task.indexOf('kernel contract (fixed'), task.indexOf('Rules for every module'));
    expect(contract(builders[0].task).length, item.id).toBeGreaterThan(3000);
    const document = createOfficialDocument(item);
    for (const node of builders) {
      expect(contract(node.task), node.id).toBe(contract(builders[0].task));
      // Each builder writes, checks and publishes its module in its own sandbox computer: no single model call has
      // to hold a whole module (Opus 5.5's cap per call is shared with its hidden thinking).
      expect(node.sandbox, node.id).toBe(true);
      expect(node.task, node.id).toContain(`node --check ${node.id}.js`);
      expect(node.task, node.id).toContain(`publish ${node.id}.js into your result output`);
      expect(node.task, node.id).toContain('U.tests.plant');
      const tile = document.nodes.find((value): value is SessionNode => value.kind === 'session' && value.title === node.title);
      expect(tile?.runtime, node.id).toBe(SANDBOX_RUNTIME);
    }
    for (const node of item.nodes) expect(node.task.length, `${item.id}/${node.id}`).toBeLessThan(20000);
  }
});

it('pins the assembly template and the sandbox runtime in the canvas text a published run is checked against', () => {
  for (const item of FLAGSHIPS) {
    const text = canonicalCanvasText(createOfficialDocument(item));
    expect(text).toContain('{{in:from_core}}');
    expect(text).toContain(`"${SANDBOX_RUNTIME}"`);
    const plain = { ...item, nodes: item.nodes.map(node => ({ ...node, sandbox: undefined })) };
    expect(canonicalCanvasText(createOfficialDocument(plain))).not.toBe(text);
  }
  // A published case without a sandbox node has the same text as before the runtime was pinned.
  const car = PRODUCTION_WORKFLOWS['car-plant'];
  expect(canonicalCanvasText(createOfficialDocument(car))).not.toContain(`"${SANDBOX_RUNTIME}"`);
});

it('writes every flagship in English and names no other product', () => {
  for (const item of FLAGSHIPS) {
    const text = JSON.stringify(item);
    expect(text).not.toMatch(/\p{Script=Han}/u);
    expect(text).not.toMatch(/photoshop|adobe|gimp|affinity photo|pixelmator|paperclip/i);
  }
});
