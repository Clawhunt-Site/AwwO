import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_TEMPLATE_IDS, createAgentTemplate } from '../src/canvas/agentTemplates';
import { createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { applyCanvasPlan, CANVAS_PLAN_PROTOCOL, PLAN_TEMPLATE_IDS, parseCanvasPlan, withMediaNodes, type CanvasPlanMedia } from '../src/canvas/canvasPlan';
import { buildPlanningContext, observedProgress } from '../src/canvas/canvasPlanning';
import { mediaGroupLabel, mediaModelLabel, parseMediaCatalogue, replacementMediaModel } from '../src/canvas/mediaCatalog';
import { activeNodeThread } from '../src/canvas/nodeThreads';
import { replaceRetiredMediaModels } from '../src/canvas/retiredMediaModels';
import { runScopeWithoutMedia } from '../src/canvas/runScope';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

afterEach(() => clearSaaSCanvas());
const tenant = { id: 'tenant', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 } as const;
const media: CanvasPlanMedia = { models: { image: 'xt.seedream-5-pro', model3d: 'tripo.p1' }, promptMax: model => model === 'tripo.p1' ? 20 : 32000 };
const plan = (operations: unknown[]) => parseCanvasPlan({ version: 1, summary: 'S', operations });
const sessions = (doc: CanvasDocument) => doc.nodes.filter((node): node is SessionNode => node.kind === 'session');

describe('media nodes in canvas plans', () => {
  it('parses image, video and 3D templates and still refuses unknown ones', () => {
    expect(plan([{ type: 'add_node', ref: 'hero', templateId: 'model3d', inputValues: { prompt: 'a knight' } }]).operations[0]).toMatchObject({ templateId: 'model3d' });
    expect(() => plan([{ type: 'add_node', ref: 'x', templateId: 'audio' }])).toThrow('templateId');
    for (const id of [...AGENT_TEMPLATE_IDS, 'image', 'video', 'model3d']) expect(PLAN_TEMPLATE_IDS.has(id)).toBe(true);
  });

  it('offers the planner only the media kinds the workspace can generate, never the provider', () => {
    expect(withMediaNodes(CANVAS_PLAN_PROTOCOL, [])).toBe(CANVAS_PLAN_PROTOCOL);
    const offered = withMediaNodes(CANVAS_PLAN_PROTOCOL, ['image', 'model3d']);
    expect(offered).toContain('|"review"|"image"|"model3d"');
    expect(offered).not.toContain('"video"');
    expect(offered).toContain('inputValues.prompt');
    // A local canvas cannot generate media: nothing about media nodes reaches its planner.
    expect(buildPlanningContext(emptyDocument(), [], 'zh', ['image'])).not.toContain('媒体节点');
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const context = buildPlanningContext(emptyDocument(), [], 'zh', ['image', 'model3d']);
    expect(context).toContain('媒体节点（templateId 为 image=图片、model3d=3D 模型）');
    expect(context).toContain('"id":"model3d"');
    expect(context).toContain('为每个素材添加一个对应的媒体节点');
    expect(context).not.toMatch(/x-?tasy|tripo|runninghub/i);
    expect(buildPlanningContext(emptyDocument(), [], 'zh')).not.toContain('媒体节点');
  });

  it('describes an existing media node to the planner by kind and prompt, not by model', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const image = { ...createSessionNode('image', { x: 0, y: 0 }), model: 'xt.xtasy-3', title: 'Cover', threads: [{ id: 'default', title: 'Session 1', issueId: null, preview: '', draft: 'a lighthouse', createdAt: 0, lastOutput: null }] } as SessionNode;
    const context = buildPlanningContext({ ...emptyDocument(), nodes: [image] }, [], 'en', ['image']);
    expect(context).toContain(`{"id":"${image.id}","templateId":"image","title":"Cover","prompt":"a lighthouse"}`);
    expect(context).not.toContain('xt.xtasy-3');
  });

  it('adds a media node on the offered model, its prompt as the draft and cut to what the model takes', () => {
    const applied = applyCanvasPlan(emptyDocument(), plan([
      { type: 'add_node', ref: 'poster', templateId: 'image', title: '海报主视觉', inputValues: { prompt: '  a red bicycle on a beach  ' } },
      { type: 'add_node', ref: 'hero', templateId: 'model3d', persona: 'ignored', inputValues: { prompt: 'a knight in silver armour, full body', style: 'x' } },
    ]), 'zh', '做一张海报和一个角色', media);
    const [poster, hero] = sessions(applied.doc);
    expect(poster).toMatchObject({ agentKind: 'image', model: 'xt.seedream-5-pro', title: '海报主视觉', binding: null, persona: '' });
    expect(activeNodeThread(poster).draft).toBe('a red bicycle on a beach');
    expect(poster.taskFrame).toBeUndefined();
    expect(poster.contract).toBeUndefined();
    expect(hero).toMatchObject({ agentKind: 'model3d', model: 'tripo.p1', title: '3D 模型 Agent', persona: '' });
    expect(Array.from(activeNodeThread(hero).draft)).toHaveLength(20);
    expect(applied.adjustments.join('\n')).toMatch(/提示词超过 20 字/);
    expect(applied.adjustments.join('\n')).toMatch(/只接受提示词/);
    expect(applied.addedNodeIds).toEqual([poster.id, hero.id]);
  });

  it('leaves out a kind the workspace cannot generate, and every step naming it, without failing the plan', () => {
    const writer = createAgentTemplate('general', { x: 0, y: 0 });
    const applied = applyCanvasPlan({ ...emptyDocument(), nodes: [writer] }, plan([
      { type: 'add_node', ref: 'clip', templateId: 'video', inputValues: { prompt: 'a drone shot' } },
      { type: 'set_input', nodeId: 'clip', fieldId: 'prompt', value: 'again' },
      { type: 'update_node', nodeId: 'clip', title: 'Clip' },
      { type: 'connect', fromNode: 'clip', fromField: 'result', toNode: writer.id, toField: 'context' },
      { type: 'update_node', nodeId: writer.id, title: 'Writer' },
    ]), 'zh', '', media);
    expect(sessions(applied.doc).map(node => node.id)).toEqual([writer.id]);
    expect(applied.adjustments).toEqual([expect.stringMatching(/没有添加「视频 Agent」：此工作区现在不能生成视频/)]);
    expect(sessions(applied.doc)[0].title).toBe('Writer');
    // Without media facts (a local canvas, the other planner) no media node is ever added.
    expect(applyCanvasPlan(emptyDocument(), plan([{ type: 'add_node', ref: 'p', templateId: 'image' }])).doc.nodes).toEqual([]);
  });

  it('rewrites an existing media node prompt with set_input and wires its result like any output', () => {
    const image = { ...createSessionNode('image', { x: 0, y: 0 }), model: 'xt.seedream-5-pro' };
    const model = { ...createSessionNode('model3d', { x: 0, y: 300 }), model: 'tripo.p1' };
    const game = createAgentTemplate('frontend', { x: 600, y: 0 });
    const applied = applyCanvasPlan({ ...emptyDocument(), nodes: [image, model, game] }, plan([
      { type: 'set_input', nodeId: image.id, fieldId: 'prompt', value: 'a sunset' },
      { type: 'add_field', nodeId: game.id, side: 'input', field: { id: 'hero_model', label: 'Hero model', type: 'file', required: false, value: '' } },
      { type: 'connect', fromNode: model.id, fromField: 'result', toNode: game.id, toField: 'hero_model' },
    ]), 'en', '', media);
    expect(activeNodeThread(sessions(applied.doc)[0]).draft).toBe('a sunset');
    expect(applied.doc.edges).toEqual([expect.objectContaining({ fromNode: model.id, fromPort: 'result', toNode: game.id, toPort: 'in:hero_model', dataType: 'file' })]);
    expect(applied.adjustments).toEqual([]);
  });

  it('names a media node in planning progress', () => {
    const previous = { stage: 'streaming' as const, characters: 0, nodes: 0, edges: 0, reasoning: 0, attempt: 1 };
    expect(observedProgress({ stage: 'streaming', nodes: 1, template: 'model3d', operation: 'add_node', target: 'model3d' }, previous))
      .toMatchObject({ template: 'model3d', operation: 'add_node', target: 'model3d' });
  });
});

describe('a page that uses the pictures and the clip of media nodes', () => {
  // The rule the canvas and the run share (canFeed, edgeTypesFit in the API): a media result feeds a text input.
  // A plan used to be held to exact types instead, so every plan that wired a picture into a page was refused whole.
  const media2: CanvasPlanMedia = { models: { image: 'xt.seedream-5-pro', video: 'xt.xtasy-v3' }, promptMax: () => 32000 };
  const image = { ...createSessionNode('image', { x: 0, y: 0 }), model: 'xt.seedream-5-pro' };
  const video = { ...createSessionNode('video', { x: 0, y: 300 }), model: 'xt.xtasy-v3' };
  const page = createAgentTemplate('frontend', { x: 600, y: 0 });
  const doc = () => ({ ...emptyDocument(), nodes: [image, video, page] });
  const field = (applied: { doc: CanvasDocument }, id: string) =>
    (applied.doc.nodes.find(node => node.id === page.id) as SessionNode).contract!.inputs.find(item => item.id === id);

  it('wires a picture and a clip into text inputs of the page, the edges keeping their source type', () => {
    const applied = applyCanvasPlan(doc(), plan([
      { type: 'add_field', nodeId: page.id, side: 'input', field: { id: 'hero_clip', label: 'Hero clip', type: 'markdown', required: true, value: '' } },
      { type: 'add_field', nodeId: page.id, side: 'input', field: { id: 'cover', label: 'Cover picture', type: 'text', required: true, value: '' } },
      { type: 'connect', fromNode: video.id, fromField: 'result', toNode: page.id, toField: 'hero_clip' },
      { type: 'connect', fromNode: image.id, fromField: 'result', toNode: page.id, toField: 'cover' },
    ]), 'en', '', media2);
    expect(applied.doc.edges).toEqual([
      expect.objectContaining({ fromNode: video.id, fromPort: 'result', toNode: page.id, toPort: 'in:hero_clip', dataType: 'video' }),
      expect.objectContaining({ fromNode: image.id, fromPort: 'result', toNode: page.id, toPort: 'in:cover', dataType: 'image' }),
    ]);
    expect(applied.adjustments).toEqual([]);
  });

  it('makes an empty input the plan typed as a file a text input for a picture, under its own name', () => {
    const applied = applyCanvasPlan(doc(), plan([
      { type: 'add_field', nodeId: page.id, side: 'input', field: { id: 'hero_shot', label: 'Hero shot', type: 'file', required: true, value: '' } },
      { type: 'connect', fromNode: image.id, fromField: 'result', toNode: page.id, toField: 'hero_shot' },
    ]), 'en', '', media2);
    expect(field(applied, 'hero_shot')).toMatchObject({ type: 'markdown', label: 'Hero shot', required: true });
    expect(applied.doc.edges).toEqual([expect.objectContaining({ fromNode: image.id, toPort: 'in:hero_shot', dataType: 'image' })]);
    expect(applied.adjustments).toEqual([expect.stringContaining('“Hero shot” on')]);
  });

  it('keeps a picture wired into a text input when the plan edits that page again afterwards', () => {
    // A later add_field on the page re-checks its wires (disconnectBroken): the media wire must pass the same rule.
    const applied = applyCanvasPlan(doc(), plan([
      { type: 'add_field', nodeId: page.id, side: 'input', field: { id: 'cover', label: 'Cover', type: 'markdown', required: true, value: '' } },
      { type: 'connect', fromNode: image.id, fromField: 'result', toNode: page.id, toField: 'cover' },
      { type: 'add_field', nodeId: page.id, side: 'input', field: { id: 'caption', label: 'Caption', type: 'markdown', required: false, value: '' } },
    ]), 'en', '', media2);
    expect(applied.doc.edges).toEqual([expect.objectContaining({ fromNode: image.id, toPort: 'in:cover', dataType: 'image' })]);
    expect(applied.adjustments).toEqual([]);
  });

  it('gives the page a text input of its own for a clip when the plan names an input it does not have', () => {
    const applied = applyCanvasPlan(doc(), plan([
      { type: 'connect', fromNode: video.id, fromField: 'result', toNode: page.id, toField: 'opening_clip' },
    ]), 'en', '', media2);
    expect(field(applied, 'opening_clip')).toMatchObject({ type: 'markdown' });
    expect(applied.doc.edges).toEqual([expect.objectContaining({ fromNode: video.id, toPort: 'in:opening_clip', dataType: 'video' })]);
    expect(applied.adjustments.join('\n')).not.toMatch(/Skipped a connection/);
  });
});

describe('canvas runs and media nodes', () => {
  const text = createAgentTemplate('general', { x: 0, y: 0 });
  const image = { ...createSessionNode('image', { x: 0, y: 300 }), model: 'xt.seedream-5-pro' };
  it('runs the canvas or a component without its media nodes, and is unchanged when there are none', () => {
    expect(runScopeWithoutMedia([text, image])).toEqual({ scope: [text.id] });
    expect(runScopeWithoutMedia([text])).toEqual({ scope: undefined });
    expect(runScopeWithoutMedia([text, image], [image.id, text.id])).toEqual({ scope: [text.id] });
    expect(runScopeWithoutMedia([text, image], [text.id])).toEqual({ scope: [text.id] });
    expect(runScopeWithoutMedia([text, image], [image.id])).toBeNull();
    expect(runScopeWithoutMedia([])).toEqual({ scope: undefined });
  });
});

describe('retired media models and provider names', () => {
  const model = (id: string, name: string, vendor: string, kind: 'image' | 'video') => ({ id, name, vendor, kind, prompt: { minLength: 1, maxLength: 32000 }, params: [] });
  const catalogue = parseMediaCatalogue({ configured: true, available: true, limits: { runsPerDay: 30, timeoutSeconds: 1200 }, models: [
    model('xt.seedream-5-pro', 'Seedream 5.0 Pro', 'bytedance', 'image'), model('xt.gpt-image-2', 'GPT Image 2', 'openai', 'image'),
    model('xt.xtasy-v3', 'Video V3', 'xtasy', 'video'),
  ] });

  it('moves a node off a retired model to the same family, else to the first model of its kind', () => {
    expect(replacementMediaModel(catalogue, 'image', 'rh.gpt-image-2')).toBe('xt.gpt-image-2');
    expect(replacementMediaModel(catalogue, 'image', 'rh.midjourney-v7')).toBe('xt.seedream-5-pro');
    expect(replacementMediaModel(catalogue, 'video', 'rh.kling-v3-pro')).toBe('xt.xtasy-v3');
    expect(replacementMediaModel(catalogue, 'image', 'xt.gpt-image-2')).toBeNull();
    expect(replacementMediaModel(catalogue, 'model3d', 'rh.anything')).toBeNull();
    expect(replacementMediaModel(undefined, 'image', 'rh.gpt-image-2')).toBeNull();
    // A deployment that still runs the retired generator offers its models: they stay.
    const offered = parseMediaCatalogue({ configured: true, available: true, models: [model('rh.gpt-image-2', 'GPT Image 2', 'openai', 'image')] });
    expect(replacementMediaModel(offered, 'image', 'rh.gpt-image-2')).toBeNull();
  });

  it('keeps the rest of the node, its results included, with settings back to the new model defaults', () => {
    const old = { ...createSessionNode('image', { x: 0, y: 0 }), model: 'rh.seedream-v5-pro', mediaParams: { resolution: '2k' },
      lastOutput: { text: '{"type":"awwo.media"}', at: 1, source: 'run' }, binding: { companyId: 't', agentId: 'a', agentName: 'A' },
      threads: [{ id: 'default', title: 'Session 1', issueId: 'i', preview: '', draft: 'a cat', createdAt: 0, lastOutput: null, model: 'rh.seedream-v5-pro' }] } as unknown as SessionNode;
    const writer = createAgentTemplate('general', { x: 400, y: 0 });
    const doc = { ...emptyDocument(), nodes: [old, writer] };
    const moved = replaceRetiredMediaModels(doc, catalogue)!;
    const node = moved.nodes[0] as SessionNode;
    expect(node).toMatchObject({ model: 'xt.seedream-5-pro', lastOutput: old.lastOutput, binding: old.binding, title: old.title });
    expect(node.mediaParams).toBeUndefined();
    expect(node.threads?.[0]).toMatchObject({ model: 'xt.seedream-5-pro', draft: 'a cat', issueId: 'i' });
    expect(moved.nodes[1]).toBe(writer);
    expect(replaceRetiredMediaModels(moved, catalogue)).toBeNull();
  });

  it('shows every media model in one media group by its generic name, never by provider or maker', () => {
    expect(mediaGroupLabel('zh')).toBe('媒体');
    expect(mediaGroupLabel('en')).toBe('Media');
    const labelled = parseMediaCatalogue({ configured: true, available: true, models: [
      { ...model('xt.gpt-image-2', 'Old name', 'media', 'image'), label: ['图片 · 超清多张', 'Image · Ultra HD batch'] }] }).models[0];
    expect(mediaModelLabel(labelled, 'zh')).toBe('图片 · 超清多张');
    expect(mediaModelLabel(labelled, 'en')).toBe('Image · Ultra HD batch');
  });
});
