import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILM_GUIDE, FILM_GUIDE_HEADING, filmPersona, filmRole } from '../src/canvas/filmKit/filmKit';
import { AGENT_TEMPLATE_IDS, createAgentTemplate, getAgentTemplate, getAgentTemplateForNode } from '../src/canvas/agentTemplates';
import { applyCanvasPlan, CANVAS_PLAN_PROTOCOL, parseCanvasPlan, PLAN_TEMPLATE_IDS } from '../src/canvas/canvasPlan';
import { buildPlanningContext } from '../src/canvas/canvasPlanning';
import { emptyDocument, sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { createModelNode } from '../src/canvas/canvasModelDrop';
import { requestJevPlan } from '../src/canvas/jevPlanning';
import { openContentOf } from '../src/canvas/nodePresentation';
import type { ModelPaletteSelection } from '../src/canvas/modelPalette';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import type { JevRequest } from '../src/saas/jev';

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
/** How many times a text holds another. */
const count = (text: string, part: string) => text.split(part).length - 1;
/** How each language's film template begins: its role, before the workflow, the checks and the kit guide. */
const ROLE = { zh: '负责把一个想法做成一支用代码画出、带声音的短片', en: 'Turn an idea into a short film drawn in code, with its own sound' } as const;

describe('the film template', () => {
  it('delivers one complete film page through a single html output, its guide after the role once, in both languages', () => {
    expect(AGENT_TEMPLATE_IDS.has('film')).toBe(true);
    for (const locale of ['zh', 'en'] as const) {
      const template = getAgentTemplate('film', locale);
      expect(template.id).toBe('film');
      expect(template.title).toBe(locale === 'zh' ? '代码影片' : 'Code film');
      expect(template.inputs.map(field => field.id)).toEqual(['idea', 'style']);
      expect(template.outputs).toMatchObject([{ id: 'film', type: 'html', required: true }]);
      expect(template.persona.startsWith(ROLE[locale])).toBe(true);
      expect(template.persona.endsWith(FILM_GUIDE)).toBe(true);
      expect(count(template.persona, FILM_GUIDE)).toBe(1);
      expect(count(template.persona, FILM_GUIDE_HEADING)).toBe(1);
      // The role keeps the template's own workflow and checks; only the guide follows it.
      expect(template.workflow.every(step => filmRole(template.persona).includes(step))).toBe(true);
      expect(template.checklist.every(item => filmRole(template.persona).includes(item))).toBe(true);
      expect(bytes(template.persona)).toBeLessThanOrEqual(31_000);
    }
  });

  it('keeps its template through a saved canvas, by its old title, and when a model is dropped with its persona', () => {
    const node = createAgentTemplate('film', { x: 0, y: 0 });
    expect(node.agentKind).toBe('llm');
    expect(node.templateId).toBe('film');
    expect(getAgentTemplateForNode(node)?.id).toBe('film');
    expect(getAgentTemplateForNode({ ...node, templateId: undefined, templateVersion: undefined })?.id).toBe('film');
    expect(sanitizeDocument(JSON.parse(JSON.stringify({ ...emptyDocument(), nodes: [node] }))).nodes[0]).toMatchObject({ templateId: 'film' });
    const shelf = createModelNode({ key: 'k', label: 'Model', displayName: 'Model', model: 'model-1', runtime: 'openai-agents', available: true } as unknown as ModelPaletteSelection, 'film', { x: 0, y: 0 }, 'zh');
    expect(shelf.templateId).toBe('film');
    expect(shelf.contract!.outputs.map(field => field.id)).toEqual(['film']);
    expect(shelf.persona.endsWith(FILM_GUIDE)).toBe(true);
    expect(count(shelf.persona, FILM_GUIDE)).toBe(1);
    expect(shelf.title).toBe('Model · 代码影片');
  });

  it('opens on its page, as a figure node does, even where its delivery field is no longer html', () => {
    const node = createAgentTemplate('film', { x: 0, y: 0 });
    expect(openContentOf(node)).toBe('page');
    const text: SessionNode = { ...node, contract: { ...node.contract!, outputs: node.contract!.outputs.map(field => ({ ...field, type: 'markdown' as const })) } };
    expect(openContentOf(text)).toBe('page');
    expect(openContentOf({ ...text, templateId: 'general' })).toBe('chat');
  });
});

describe('planning a film node', () => {
  it('is offered to the planner, keeps its guide when a plan writes its persona, and is read back without it', () => {
    expect(PLAN_TEMPLATE_IDS.has('film')).toBe(true);
    expect(CANVAS_PLAN_PROTOCOL).toContain('|"figure"|"film"');
    const role = '把咖啡店开业做成一支 15 秒的短片。';
    const plan = parseCanvasPlan({ version: 1, summary: '开业短片', operations: [
      { type: 'add_node', ref: 'opening', templateId: 'film', title: '咖啡店开业', persona: role, inputValues: { idea: '15 秒，给附近的上班族看' } },
    ] });
    const applied = applyCanvasPlan(emptyDocument(), plan);
    const node = applied.doc.nodes[0] as SessionNode;
    expect(node.templateId).toBe('film');
    expect(node.persona).toBe(filmPersona(role));
    expect(node.persona).toBe(`${role}\n\n${FILM_GUIDE}`);
    const updated = applyCanvasPlan(applied.doc, parseCanvasPlan({ version: 1, summary: '改角色', operations: [
      { type: 'update_node', nodeId: node.id, persona: '换成夜景开场。' },
    ] })).doc.nodes[0] as SessionNode;
    expect(updated.persona).toBe(`换成夜景开场。\n\n${FILM_GUIDE}`);
    const context = buildPlanningContext(applied.doc, []);
    expect(context).toContain(role);
    expect(context).not.toContain(FILM_GUIDE_HEADING);
    expect(context).toContain('"id":"film"');
    expect(context).toContain('每支片子用一个film节点');
    expect(buildPlanningContext(emptyDocument(), [], 'en')).toContain('Use one film node per short film');
  });
});

describe('the Jev planner', () => {
  const tenant = { id: 'film-test-tenant', name: 'Workspace', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
  const status = { provider: 'typesafe', model: 'jev-1.13.0', configured: true, enabled: true, canEvaluate: true,
    questionTypes: ['noul', 'choice', 'score'], limits: { maxQuestions: 16, maxRequestBytes: 65536 } };
  const runtime = { configured: true, available: true, models: [{ runtime: 'pi', id: 'shared-model', label: 'Platform model' }],
    runtimes: [{ id: 'pi', available: true, configured: true, tools: [], supportsEffortSelection: false }] };
  /** Jev's answer to every question: the given choice, or else the first one. */
  const answer = (request: JevRequest, choices: Record<string, string>) => ({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 2 },
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const choice = choices[id] || Object.keys(question.criteria)[0];
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }];
    })) });
  afterEach(() => { clearSaaSCanvas(); vi.unstubAllGlobals(); });

  it('offers no film role: like a figure node, a film node is planned by the canvas planner', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const requests: JevRequest[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/runtime')) return Response.json(runtime);
      if (url.endsWith('/typesafe')) return Response.json(status);
      const body = JSON.parse(String(init.body)) as JevRequest;
      requests.push(body);
      return Response.json(answer(body, { intent: 'clarify', role_1: 'omit', role_2: 'omit', role_3: 'omit' }));
    }));
    for (const locale of ['zh', 'en'] as const) {
      const result = await requestJevPlan('做一支 15 秒的咖啡店开业短片', emptyDocument(), [], new AbortController().signal, locale);
      expect(result.plan.operations).toEqual([]);
      const roles = Object.values(requests.at(-1)!.questions.role_1.criteria);
      const offered = (id: 'general' | 'figure' | 'film') => roles.some(text => text.startsWith(`${getAgentTemplate(id, locale).title}: `));
      expect([offered('general'), offered('figure'), offered('film')]).toEqual([true, false, false]);
    }
    expect(requests).toHaveLength(2);
  });
});
