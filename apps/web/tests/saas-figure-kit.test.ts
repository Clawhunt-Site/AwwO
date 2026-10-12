import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import * as kit from '../../../third_party/anatomy/kit/iso-kit.mjs';
import * as lathe from '../../../third_party/anatomy/kit/lathe.mjs';
import * as tube from '../../../third_party/anatomy/kit/tube.mjs';
import * as gl from '../../../third_party/anatomy/kit/gl.mjs';
import { buildFigureKit } from '../scripts/build-figure-kit.mjs';
import { FIGURE_GUIDE, FIGURE_KIT_BYTES, FIGURE_KIT_SHA256, FIGURE_KIT_URL, GUIDE_HEADING, figurePersona, figureRole } from '../src/canvas/figureKit/figureKit';
import { loadPreviewLibraries, PREVIEW_LIBRARIES, previewScriptNeeds } from '../src/canvas/previewLibraries';
import { htmlPreviewDocument } from '../src/canvas/htmlDeliverable';
import { AGENT_TEMPLATE_IDS, createAgentTemplate, getAgentTemplate, getAgentTemplateForNode } from '../src/canvas/agentTemplates';
import { applyCanvasPlan, CANVAS_PLAN_PROTOCOL, parseCanvasPlan, PLAN_TEMPLATE_IDS } from '../src/canvas/canvasPlan';
import { buildPlanningContext } from '../src/canvas/canvasPlanning';
import { emptyDocument, sanitizeDocument } from '../src/canvas/canvasDoc';
import { createModelNode } from '../src/canvas/canvasModelDrop';
import type { ModelPaletteSelection } from '../src/canvas/modelPalette';

const web = join(__dirname, '..');
const kitFile = join(web, 'src', 'canvas', 'figureKit', 'anatomy-kit.js');
const kitText = readFileSync(kitFile, 'utf8');
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Runs the bundle the way a page does, in a fresh global, and returns its window.Anatomy. */
function kitInSandbox(): Record<string, any> {
  const sandbox: Record<string, unknown> = { console, addEventListener() {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(kitText, sandbox, { filename: 'anatomy-kit.js' });
  return sandbox.Anatomy as Record<string, any>;
}

/** The example page in the guide: the shape every figure node is told to copy. */
function guideExample(): string {
  const start = FIGURE_GUIDE.indexOf('```html', FIGURE_GUIDE.indexOf('### 5.'));
  const body = FIGURE_GUIDE.slice(start + '```html'.length);
  return body.slice(0, body.indexOf('```')).trim();
}

describe('the figure kit bundle', () => {
  it('is the deterministic build of the vendored anatomy modules, pinned by size and sha256', () => {
    expect(kitText).toBe(buildFigureKit());
    expect(bytes(kitText)).toBe(FIGURE_KIT_BYTES);
    expect(createHash('sha256').update(kitText).digest('hex')).toBe(FIGURE_KIT_SHA256);
    expect(/<\/script|<!--/i.test(kitText)).toBe(false);
    expect(kitText).toContain('MIT License');
    expect(kitText).toContain('Copyright (c) 2026 Ryan');
    expect(kitText).not.toContain('\r');
  });

  it('defines window.Anatomy with the upstream kit unchanged: same exports, same drawings', () => {
    const A = kitInSandbox();
    const added = ['G', 'T', 'GL', 'mount', 'run', 'loop', 'follow', 'spring', 'calm', 'version', 'commit'];
    expect(Object.keys(A).filter(key => !added.includes(key)).sort()).toEqual(Object.keys(kit).sort());
    expect(Object.keys(A.G).sort()).toEqual(Object.keys(lathe).sort());
    expect(Object.keys(A.T).sort()).toEqual(Object.keys(tube).sort());
    expect(Object.keys(A.GL).sort()).toEqual(Object.keys(gl).sort());
    expect(Object.isFrozen(A)).toBe(true);
    expect(A.version).toBe('1');
    expect(A.ISO_CSS).toBe(kit.ISO_CSS);
    const plan = { x: -60, y: -30, w: 120, d: 60, r: 6 };
    const P = kit.fitProjection([...kit.boxCorners(plan, -10, 0), [0, 0, 70]], 600, 380, { pad: 30, azimuth: 42 });
    expect(A.solidSvg(A.slabOf(plan, -10, 10, P, 8, 1.6), { tone: 'mid' })).toBe(kit.solidSvg(kit.slabOf(plan, -10, 10, P, 8, 1.6), { tone: 'mid' }));
    expect(A.radialTicks(0, 0, 18, 50, 5, 12, [1.3, 2.8], P)).toEqual(kit.radialTicks(0, 0, 18, 50, 5, 12, [1.3, 2.8], P));
    const frame = [[0, 0, 20], [1, 0, 0]] as const;
    expect(A.G.solidOf([[0, 6], [4, 6], [6, 4, 1], [12, 4]], A.G.frameAlong(...frame), P))
      .toEqual(lathe.solidOf([[0, 6], [4, 6], [6, 4, 1], [12, 4]], lathe.frameAlong(...frame), P));
    const route = lathe.fillet([[-40, 0, 5], [0, 0, 5], [0, 25, 30]], 8);
    expect(A.T.tubePieces(route, 2.4, P).map((piece: unknown) => A.T.tubeSvg(piece))).toEqual(tube.tubePieces(route, 2.4, P).map((piece: unknown) => tube.tubeSvg(piece)));
    const settled = { at: 0, rate: 0 };
    let steps = 0;
    while (!A.spring(settled, 10, 1 / 60, 420, 26) && steps < 1000) steps += 1;
    expect(settled).toEqual({ at: 10, rate: 0 });
    expect(A.follow(0, 10, 1 / 60, 0.28, true)).toBe(10);
  });

  it('is supplied to a running page for its fixed URL and inlined ahead of the page script', async () => {
    const library = PREVIEW_LIBRARIES.find(item => item.id === 'figure-kit-1')!;
    expect(library.urls).toEqual([FIGURE_KIT_URL]);
    expect(library.bytes).toBe(FIGURE_KIT_BYTES);
    expect(library.sha256).toBe(FIGURE_KIT_SHA256);
    expect(library.labelZh).toBe('原理图解组件');
    const page = guideExample();
    const needs = previewScriptNeeds(page);
    expect(needs.libraries.map(item => item.id)).toEqual(['figure-kit-1']);
    expect(needs.blocked).toEqual([]);
    const code = await loadPreviewLibraries(needs);
    expect(code.get(FIGURE_KIT_URL)).toBe(kitText);
    const doc = new DOMParser().parseFromString(htmlPreviewDocument(page, true, code), 'text/html');
    // The page's own scripts; the preview's head carries only AwwO's viewport script ahead of them.
    const scripts = Array.from(doc.body.querySelectorAll('script'));
    expect(scripts).toHaveLength(2);
    expect(scripts[0].textContent).toBe(kitText);
    expect(scripts[1].textContent).toContain('Anatomy.run(');
    expect(doc.querySelector('[src]')).toBeNull();
  });

  it('is served by the hosted site at the path of its URL', () => {
    const config = readFileSync(join(web, 'vite.saas.config.mjs'), 'utf8');
    expect(config).toContain(`const FIGURE_KIT_PATH = '${new URL(FIGURE_KIT_URL).pathname}';`);
    expect(config).toContain("join(root, 'src', 'canvas', 'figureKit', 'anatomy-kit.js')");
  });
});

describe('the figure guide', () => {
  it('names the kit URL, fits a node persona and shows a page whose script compiles', () => {
    expect(FIGURE_GUIDE.startsWith(GUIDE_HEADING)).toBe(true);
    expect(FIGURE_GUIDE).toContain(`<script src="${FIGURE_KIT_URL}"></script>`);
    expect(bytes(FIGURE_GUIDE)).toBeLessThan(18_000);
    const page = guideExample();
    expect(page.startsWith('<!doctype html>')).toBe(true);
    const script = page.slice(page.lastIndexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'));
    expect(() => new Function('Anatomy', script)).not.toThrow();
  });

  it('runs its example against the kit and draws a card with a live readout', () => {
    const A = kitInSandbox();
    const page = guideExample();
    const script = page.slice(page.lastIndexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'));
    let html = '';
    const parts: Record<string, { setAttribute: () => void; dataset: { part: string } }> = {};
    for (const part of ['carriage', 'plunger', 'needle']) parts[part] = { setAttribute() {}, dataset: { part } };
    const readout = { textContent: '' };
    const stage = { setAttribute() {}, addEventListener() {} };
    const svg = { querySelectorAll: () => Object.values(parts), getBoundingClientRect: () => ({ left: 0, width: 600 }) };
    const fake = { ...A, run: (build: () => void) => build(), mount: ({ html: markup }: { html: string }) => { html = markup; return { stage, svg, readout }; }, loop: () => () => {} };
    new Function('Anatomy', 'setTimeout', 'clearTimeout', script)(fake, () => 0, () => {});
    expect(html).toContain('class="iso-plate"');
    expect(html).toContain('data-part="carriage"');
    expect((html.match(/class="iso-solid/g) ?? []).length).toBeGreaterThanOrEqual(20);
    expect(readout.textContent).toBe('reads 18.0 px');
  });
});

describe('figure personas', () => {
  it('put the guide after the role once, and replace an older guide instead of adding another', () => {
    const persona = figurePersona('讲清楚令牌桶限流。');
    expect(persona).toBe(`讲清楚令牌桶限流。\n\n${FIGURE_GUIDE}`);
    expect(figurePersona(persona)).toBe(persona);
    expect(figureRole(persona)).toBe('讲清楚令牌桶限流。');
    const older = `新的角色。\n\n${GUIDE_HEADING}\nan older guide text`;
    expect(figurePersona(older)).toBe(`新的角色。\n\n${FIGURE_GUIDE}`);
    expect(figurePersona('')).toBe(FIGURE_GUIDE);
  });

  it('cut a long role at a character boundary so node setup accepts the persona', () => {
    const persona = figurePersona('长'.repeat(8000));
    expect(bytes(persona)).toBeLessThanOrEqual(31_000);
    expect(persona.endsWith(FIGURE_GUIDE)).toBe(true);
    expect(figureRole(persona)).toMatch(/^长+$/);
  });
});

describe('the figure template', () => {
  it('delivers one complete page through a single html output, in both languages', () => {
    expect(AGENT_TEMPLATE_IDS.has('figure')).toBe(true);
    for (const locale of ['zh', 'en'] as const) {
      const template = getAgentTemplate('figure', locale);
      expect(template.id).toBe('figure');
      expect(template.outputs).toHaveLength(1);
      expect(template.outputs[0]).toMatchObject({ id: 'figure', type: 'html', required: true });
      expect(template.inputs.map(field => field.id)).toEqual(['idea', 'facts']);
      expect(template.persona.endsWith(FIGURE_GUIDE)).toBe(true);
      expect(bytes(template.persona)).toBeLessThanOrEqual(31_000);
    }
    const node = createAgentTemplate('figure', { x: 0, y: 0 });
    expect(node.agentKind).toBe('llm');
    expect(node.templateId).toBe('figure');
    expect(getAgentTemplateForNode(node)?.id).toBe('figure');
    expect(sanitizeDocument(JSON.parse(JSON.stringify({ ...emptyDocument(), nodes: [node] }))).nodes[0]).toMatchObject({ templateId: 'figure' });
    const shelf = createModelNode({ key: 'k', label: 'Model', displayName: 'Model', model: 'model-1', runtime: 'openai-agents', available: true } as unknown as ModelPaletteSelection, 'figure', { x: 0, y: 0 }, 'zh');
    expect(shelf.contract!.outputs.map(field => field.id)).toEqual(['figure']);
    expect(shelf.persona.endsWith(FIGURE_GUIDE)).toBe(true);
    expect(shelf.title).toBe('Model · 原理图解');
  });

  it('is offered to the planner, keeps its guide when a plan writes its persona, and is read back without it', () => {
    expect(PLAN_TEMPLATE_IDS.has('figure')).toBe(true);
    expect(CANVAS_PLAN_PROTOCOL).toContain('|"review"|"figure"');
    const plan = parseCanvasPlan({ version: 1, summary: '令牌桶原理图', operations: [
      { type: 'add_node', ref: 'bucket', templateId: 'figure', title: '令牌桶限流', persona: '把令牌桶限流做成一台会滴令牌的机器。', inputValues: { idea: '容量 10，每秒补 2 个' } },
    ] });
    const applied = applyCanvasPlan(emptyDocument(), plan);
    const [node] = applied.doc.nodes;
    expect(node.kind === 'session' && node.persona).toBe(`把令牌桶限流做成一台会滴令牌的机器。\n\n${FIGURE_GUIDE}`);
    const updated = applyCanvasPlan(applied.doc, parseCanvasPlan({ version: 1, summary: '改角色', operations: [
      { type: 'update_node', nodeId: node.id, persona: '换成沙漏的比喻。' },
    ] })).doc.nodes[0];
    expect(updated.kind === 'session' && updated.persona).toBe(`换成沙漏的比喻。\n\n${FIGURE_GUIDE}`);
    const context = buildPlanningContext(applied.doc, []);
    expect(context).toContain('把令牌桶限流做成一台会滴令牌的机器。');
    expect(context).not.toContain(GUIDE_HEADING);
    expect(context).toContain('"id":"figure"');
    expect(context).toContain('每个原理用一个figure节点');
  });
});
