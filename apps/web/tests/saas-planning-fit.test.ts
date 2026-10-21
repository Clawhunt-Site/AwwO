import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { createFormNode, createSessionNode, emptyDocument, type CanvasDocument, type FormNode, type SessionNode } from '../src/canvas/canvasDoc';
import { applyCanvasPlan, carriesCondensedText, condensedFromJSON, condensedMark, markPlanContextCondensed, planContextCondensed, type CanvasPlan } from '../src/canvas/canvasPlan';
import { buildPlanningContext, fitPlanningContext, planningFocus, requestCanvasPlan, utf8Bytes, type PlanningMessage } from '../src/canvas/canvasPlanning';
import { activeNodeThread, updateNodeDraft } from '../src/canvas/nodeThreads';
import { resetAllSessions } from '../src/canvas/sessions';

vi.mock('../src/chatAutomations', () => ({ gatewayApiBase: () => '/fixture-gateway' }));

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); resetAllSessions(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetAllSessions(); });

const signal = () => new AbortController().signal;
const validPlan = { version: 1, summary: '新增一个任务组件。', operations: [{ type: 'add_node', ref: 'task', templateId: 'general' }] };
const long = (seed: string, characters: number) => seed.repeat(Math.ceil(characters / seed.length)).slice(0, characters);
const graphOf = (context: string, heading = '当前画布：') => {
  const start = context.indexOf(`${heading}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(context.slice(start + heading.length + 1).split('\n\n')[0]) as { requirements?: Record<string, string>; nodes: Array<Record<string, any>>; edges: unknown[] };
};

/** Like the canvas the assistant refused on 2026-10-21: few nodes whose briefs, requirements and inputs are long. */
function longCanvas(count: number, input = 8000): CanvasDocument {
  const nodes = Array.from({ length: count }, (_, i) => {
    const node: SessionNode = { ...createAgentTemplate('frontend', { x: i * 400, y: 0 }), id: `node-${i}`, title: `模块${i}`,
      persona: long(`第${i}个模块的职责说明。`, 3000) };
    node.contract!.inputs[0].value = long(`第${i}个模块的需求原文。`, input);
    node.taskFrame = { version: 1, source: 'manual', constraints: [long(`约束${i}。`, 1800)], acceptanceCriteria: [long(`验收${i}。`, 1200)] };
    return node;
  });
  return { ...emptyDocument(), nodes, edges: [{ id: 'wire', fromNode: 'node-0', fromPort: 'out:page', toNode: 'node-1', toPort: 'in:brief', dataType: 'text' }] };
}
const inputId = (doc: CanvasDocument, index: number) => (doc.nodes[index] as SessionNode).contract!.inputs[0].id;
const refused = (contextRoom?: number) => ({ ok: false, json: async () => ({ code: 'context_limit', error: '输入超出模型上下文限制，请缩短输入或减少历史内容。',
  ...(contextRoom === undefined ? {} : { contextRoom }) }) });
const accepted = () => ({ ok: true, json: async () => ({ plan: validPlan }) });
const sent = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(call => JSON.parse(call[1].body) as { prompt: string; context: string; condensed?: unknown });
const CROWDED = '这次要读的内容太多，助手放不下';

describe('a shortened view of a large canvas', () => {
  it('fits the room it is given with every node and connection, and names what it showed only in part', () => {
    const doc = longCanvas(9);
    expect(utf8Bytes(buildPlanningContext(doc, []))).toBeGreaterThan(300_000);
    const fitted = fitPlanningContext(doc, [], 'zh', [], {}, 60_000)!;
    expect(utf8Bytes(fitted.context)).toBeLessThanOrEqual(60_000);
    expect(fitted.shortened).toBe(true);
    const graph = graphOf(fitted.context);
    expect(graph.nodes.map(node => node.id)).toEqual(doc.nodes.map(node => node.id));
    expect(graph.edges).toEqual([{ id: 'wire', fromNode: 'node-0', fromPort: 'out:page', toNode: 'node-1', toPort: 'in:brief', kind: 'data' }]);
    expect(fitted.context).toContain('〔另有');
    expect(fitted.context).toContain('画布内容较多，部分长文字这次只显示了开头');
    doc.nodes.forEach((node, i) => expect([...fitted.condensed.get(node.id) ?? []].sort())
      .toEqual(['acceptanceCriteria', 'constraints', `input:${inputId(doc, i)}`, 'persona']));
  });

  it('is the whole context when that fits, the conversation cut before any node, and nothing at all when no outline fits', () => {
    const small = longCanvas(1, 200);
    const whole = buildPlanningContext(small, []);
    expect(fitPlanningContext(small, [], 'zh', [], {}, utf8Bytes(whole))).toEqual({ context: whole, condensed: new Map(), shortened: false });
    const turns: PlanningMessage[] = [{ id: 't', role: 'user', content: long('很长的一轮对话。', 5000) }];
    const withTurns = buildPlanningContext(small, turns);
    const cut = fitPlanningContext(small, turns, 'zh', [], {}, utf8Bytes(withTurns) - 1)!;
    expect(cut.condensed.size).toBe(0);
    expect(cut.shortened).toBe(true);
    expect(cut.context).toContain(`…〔另有 ${5000 - 1200} 字未显示，保持原样〕`);
    expect(graphOf(cut.context)).toEqual(graphOf(withTurns));
    expect(fitPlanningContext(longCanvas(9), [], 'zh', [], {}, 5_000)).toBeNull();
  });

  it('keeps the nodes a request is about whole the longest: named, selected, or failed last time', () => {
    const doc = longCanvas(9);
    expect([...planningFocus(doc, '把模块3的需求改一下')]).toEqual(['node-3']);
    expect([...planningFocus(doc, '看看 node-7', { runs: { 'node-5': { state: 'failed' } } }, ['node-1'])].sort()).toEqual(['node-1', 'node-5', 'node-7']);
    const fitted = fitPlanningContext(doc, [], 'zh', [], {}, 90_000, planningFocus(doc, '把模块3的需求改一下'))!;
    expect(fitted.condensed.has('node-3')).toBe(false);
    expect(fitted.condensed.size).toBe(8);
    expect(fitted.context).toContain((doc.nodes[3] as SessionNode).contract!.inputs[0].value);
  });

  it('protects every node holding a shared requirement it cut, and keeps one whole while a node holding it is', () => {
    const doc = longCanvas(3, 100);
    const shared = long('两个模块共同的原始需求。', 1800);
    for (const node of doc.nodes.slice(0, 2) as SessionNode[]) node.taskFrame = { ...node.taskFrame!, constraints: [shared] };
    const room = utf8Bytes(buildPlanningContext(doc, [])) - 15_000;
    const cut = fitPlanningContext(doc, [], 'zh', [], {}, room)!;
    expect(graphOf(cut.context).requirements?.['@R1']).not.toBe(shared);
    expect(cut.condensed.get('node-0')?.has('constraints')).toBe(true);
    expect(cut.condensed.get('node-1')?.has('constraints')).toBe(true);
    const named = fitPlanningContext(doc, [], 'zh', [], {}, room, planningFocus(doc, '改一下模块0'))!;
    expect(graphOf(named.context).requirements?.['@R1']).toBe(shared);
    expect(named.condensed.get('node-0')?.has('constraints') ?? false).toBe(false);
  });

  it('cuts a shared requirement only as far as the node holding it that keeps the most, once the request’s own node is cut too', () => {
    const doc = longCanvas(3, 100);
    const shared = long('两个模块共同的原始需求。', 1800);
    for (const node of doc.nodes.slice(0, 2) as SessionNode[]) node.taskFrame = { ...node.taskFrame!, constraints: [shared] };
    (doc.nodes[0] as SessionNode).persona = long('模块0很长的职责。', 20_000);
    const focus = planningFocus(doc, '改一下模块0');
    const fits = (room: number) => fitPlanningContext(doc, [], 'zh', [], {}, room, focus);
    // The smallest room in which the node the request is about still shows whole; with one byte less it is cut too, to
    // its 1,200 characters, while the other node holding the requirement shows none of its own.
    let low = 0, high = utf8Bytes(buildPlanningContext(doc, []));
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (fits(mid) && graphOf(fits(mid)!.context).nodes[0].persona === (doc.nodes[0] as SessionNode).persona) high = mid; else low = mid + 1;
    }
    const cut = fits(low - 1)!;
    expect(graphOf(cut.context).nodes[0].persona).toMatch(/〔另有 18800 字未显示，保持原样〕$/);
    expect(graphOf(cut.context).nodes[1].persona).toMatch(/^…〔另有 3000 字未显示，保持原样〕$/);
    expect(graphOf(cut.context).requirements?.['@R1']).toBe(`${shared.slice(0, 1200)}${condensedMark(600, 'zh')}`);
  });

  it('never hides a short value behind a longer note, cuts at whole characters, and speaks the reader’s language', () => {
    const doc = longCanvas(2, 100);
    (doc.nodes[0] as SessionNode).contract!.inputs[0].value = 'true';
    // One letter first: every emoji after it starts at an odd UTF-16 offset, where a cut by code units would split it.
    (doc.nodes[1] as SessionNode).persona = `x${'😀'.repeat(3000)}`;
    const cut = fitPlanningContext(doc, [], 'zh', [], {}, 20_000)!;
    const persona = graphOf(cut.context).nodes[1].persona as string;
    expect(persona).toMatch(/〔另有 \d+ 字未显示，保持原样〕$/);
    expect(persona.length).toBeGreaterThan(60);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(persona)).toBe(false);
    // The shortest view: every long text is a note, and a value shorter than its note stays as it is.
    let low = 0, high = utf8Bytes(buildPlanningContext(doc, []));
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (fitPlanningContext(doc, [], 'zh', [], {}, mid)) high = mid; else low = mid + 1;
    }
    const shortest = fitPlanningContext(doc, [], 'zh', [], {}, low)!;
    expect(graphOf(shortest.context).nodes[0].persona).toMatch(/^…〔另有 3000 字未显示，保持原样〕$/);
    expect(graphOf(shortest.context).nodes[0].inputs[0].value).toBe('true');
    expect(shortest.condensed.get('node-0')?.has(`input:${inputId(doc, 0)}`) ?? false).toBe(false);
    const english = fitPlanningContext(doc, [], 'en', [], {}, 20_000)!;
    expect(english.context).toMatch(/… \[\d+ more characters not shown; kept as they are\]/);
    expect(english.context).toContain('so some long texts are shown only in part this time');
  });

  it('cuts form values and media prompts too, and names them', () => {
    const form = createFormNode({ x: 0, y: 0 }) as FormNode;
    form.fields = [{ id: 'f1', label: '人工输入', value: long('表单里很长的原始内容。', 6000) }];
    const image = createSessionNode('image', { x: 400, y: 0 });
    image.threads = updateNodeDraft(image, long('一张很长的图片提示词。', 3000)).threads;
    const doc = { ...emptyDocument(), nodes: [form, image] };
    const fitted = fitPlanningContext(doc, [], 'zh', ['image'], {}, utf8Bytes(buildPlanningContext(doc, [], 'zh', ['image'])) - 1_000)!;
    expect(fitted.condensed.get(form.id)).toEqual(new Set(['input:f1']));
    expect(fitted.condensed.get(image.id)).toEqual(new Set(['input:prompt']));
  });
});

describe('a plan too large for its model', () => {
  it('is sent again with a shorter view of the same canvas when the refusal says how much fits, and the plan knows it', async () => {
    const doc = longCanvas(3, 2000);
    const fetchMock = vi.fn().mockResolvedValueOnce(refused(40_000)).mockResolvedValueOnce(accepted());
    vi.stubGlobal('fetch', fetchMock);
    const plan = await requestCanvasPlan('请组织这个项目', doc, [], signal());
    const [first, second] = sent(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.context).toBe(buildPlanningContext(doc, []));
    expect(second.prompt).toBe(first.prompt);
    expect(utf8Bytes(second.context)).toBeLessThanOrEqual(40_000);
    expect(planContextCondensed(plan)?.size).toBe(3);
  });

  it('sends a desktop host’s canvas whole, whatever its size: that host keeps bounds of its own', async () => {
    const doc = longCanvas(9);
    const fetchMock = vi.fn().mockResolvedValue(accepted());
    vi.stubGlobal('fetch', fetchMock);
    const plan = await requestCanvasPlan('请组织这个项目', doc, [], signal());
    expect(sent(fetchMock)[0].context).toBe(buildPlanningContext(doc, []));
    expect(planContextCondensed(plan)).toBeUndefined();
  });

  it('says what to do without asking again when no shorter view fits, and goes at most three times shorter', async () => {
    const none = vi.fn().mockResolvedValue(refused(0));
    vi.stubGlobal('fetch', none);
    await expect(requestCanvasPlan('请组织这个项目', longCanvas(3), [], signal())).rejects.toThrow(CROWDED);
    expect(none).toHaveBeenCalledOnce();
    // Each refusal leaves one byte less than was sent: three shorter views, then the reader is told.
    const shrinking = vi.fn(async (_url: string, init: RequestInit) => refused(utf8Bytes(JSON.parse(String(init.body)).context) - 1));
    vi.stubGlobal('fetch', shrinking);
    await expect(requestCanvasPlan('请组织这个项目', longCanvas(3), [], signal())).rejects.toThrow(CROWDED);
    expect(shrinking).toHaveBeenCalledTimes(4);
    const sizes = sent(shrinking).map(body => utf8Bytes(body.context));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThan(sizes[i - 1]);
    // A room no smaller than what was sent cannot be met by a shorter view: as much as was sent is refused.
    const same = vi.fn(async (_url: string, init: RequestInit) => refused(utf8Bytes(JSON.parse(String(init.body)).context)));
    vi.stubGlobal('fetch', same);
    await expect(requestCanvasPlan('请组织这个项目', longCanvas(3), [], signal())).rejects.toThrow(CROWDED);
    expect(same).toHaveBeenCalledOnce();
  });

  it('applies no plan whose host names fields it cannot read, and trusts a host that says the request was the whole canvas', async () => {
    const stream = (condensed: unknown) => new Response(`data: ${JSON.stringify({ type: 'plan', plan: validPlan, condensed })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream([['node-0', 'persona']])));
    await expect(requestCanvasPlan('请组织这个项目', longCanvas(1, 100), [], signal())).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream(null)));
    expect(planContextCondensed(await requestCanvasPlan('请组织这个项目', longCanvas(1, 100), [], signal()))).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream([['node-0', ['persona']], ['node-0', ['constraints']]])));
    expect(planContextCondensed(await requestCanvasPlan('请组织这个项目', longCanvas(1, 100), [], signal()))?.get('node-0'))
      .toEqual(new Set(['persona', 'constraints']));
  });

  it('reads a set of any size a valid canvas can make, and nothing that is not one', () => {
    // More nodes, longer ids and more fields than the old bounds took (10,000 nodes, 200 characters, 200 fields of 300).
    const wide: Array<[string, string[]]> = [...Array.from({ length: 12_000 }, (_, i): [string, string[]] => [`${'n'.repeat(300)}-${i}`, ['persona']]),
      ['wide', Array.from({ length: 250 }, (_, f) => `input:${'f'.repeat(400)}-${f}`)]];
    const read = condensedFromJSON(wide);
    expect(read?.size).toBe(12_001);
    expect(read?.get('wide')?.size).toBe(250);
    for (const bad of [null, {}, [['a']], [['a', 'persona']], [[1, ['persona']]], [['a', [1]]]]) expect(condensedFromJSON(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it('keeps a refusal that names no room, and a recovery’s request, as they were', async () => {
    const plain = vi.fn().mockResolvedValue(refused());
    vi.stubGlobal('fetch', plain);
    await expect(requestCanvasPlan('请组织这个项目', longCanvas(3), [], signal())).rejects.toThrow('输入超出模型上下文限制');
    expect(plain).toHaveBeenCalledOnce();
    const recovery = vi.fn().mockResolvedValue(refused(40_000));
    vi.stubGlobal('fetch', recovery);
    await expect(requestCanvasPlan('请组织这个项目', longCanvas(9), [], signal(), 'zh', undefined, { recoveryOperationId: 'execution-1' }))
      .rejects.toThrow('输入超出模型上下文限制');
    expect(recovery).toHaveBeenCalledOnce();
    expect(sent(recovery)[0].context).toBe(buildPlanningContext(longCanvas(9), []));
  });
});

describe('applying a plan made from a shortened view', () => {
  function canvas(): CanvasDocument {
    const node = (id: string, title: string): SessionNode => {
      const made: SessionNode = { ...createAgentTemplate('general', { x: 0, y: 0 }), id, title, persona: `${title}原来的职责` };
      made.contract!.inputs[0].value = `${title}原来的需求`;
      made.taskFrame = { version: 1, source: 'manual', constraints: [`${title}原来的约束`], acceptanceCriteria: [`${title}原来的验收`] };
      return made;
    };
    const form = createFormNode({ x: 0, y: 0 }) as FormNode;
    form.id = 'form';
    form.fields = [{ id: 'f1', label: '人工输入', value: '表单原来的内容' }];
    const image = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'image', model: 'rh.image' };
    image.threads = updateNodeDraft(image, '原来的图片提示词').threads;
    return { ...emptyDocument(), nodes: [node('a', '模块A'), node('b', '模块B'), form, image] };
  }
  const nodeOf = (doc: CanvasDocument, id: string) => doc.nodes.find(node => node.id === id) as SessionNode;
  const media = { models: { image: 'rh.image' }, promptMax: () => 4000 };

  it('leaves what the view showed only in part as it is, and says what to do', () => {
    const doc = canvas();
    const brief = inputId(doc, 0);
    const plan: CanvasPlan = { version: 1, summary: '调整两个模块。', operations: [
      { type: 'update_node', nodeId: 'a', title: '模块A2', persona: '改写的职责' },
      { type: 'set_input', nodeId: 'a', fieldId: brief, value: '改写的需求' },
      { type: 'set_task', nodeId: 'a', constraints: ['改写的约束'], acceptanceCriteria: ['改写的验收'] },
      { type: 'set_input', nodeId: 'form', fieldId: 'f1', value: '改写的表单内容' },
      { type: 'set_input', nodeId: 'image', fieldId: 'prompt', value: '改写的图片提示词' },
      { type: 'update_node', nodeId: 'b', persona: '模块B新的职责' },
      { type: 'set_input', nodeId: 'b', fieldId: brief, value: '模块B新的需求' },
    ] };
    markPlanContextCondensed(plan, new Map([['a', new Set(['persona', `input:${brief}`, 'constraints', 'acceptanceCriteria'])],
      ['form', new Set(['input:f1'])], ['image', new Set(['input:prompt'])]]));
    const applied = applyCanvasPlan(doc, plan, 'zh', '调整两个模块', media);
    const a = nodeOf(applied.doc, 'a'), b = nodeOf(applied.doc, 'b');
    expect(a.title).toBe('模块A2');
    expect(a.persona).toBe('模块A原来的职责');
    expect(a.contract!.inputs[0].value).toBe('模块A原来的需求');
    expect(a.taskFrame).toEqual(nodeOf(doc, 'a').taskFrame);
    expect((applied.doc.nodes.find(node => node.id === 'form') as FormNode).fields[0].value).toBe('表单原来的内容');
    expect(activeNodeThread(nodeOf(applied.doc, 'image')).draft).toBe('原来的图片提示词');
    expect(b.persona).toBe('模块B新的职责');
    expect(b.contract!.inputs[0].value).toBe('模块B新的需求');
    const kept = applied.adjustments.filter(line => line.includes('这次规划只给助手看了它的开头。要改它，可以直接在节点里改'));
    expect(kept).toHaveLength(6);
  });

  it('never writes text copied from what the view showed only in part, however the copy writes the note', () => {
    const doc = canvas();
    const brief = inputId(doc, 0);
    const copied = `模块A原来的${condensedMark(12, 'zh')}`;
    const loose = '模块A原来的...〔另有 12 字未显示〕';
    const english = `Module A's brief${condensedMark(40, 'en')}`;
    const plan: CanvasPlan = { version: 1, summary: '复用模块A的内容。', operations: [
      { type: 'add_node', ref: 'c', templateId: 'general', title: loose, persona: copied, acceptanceCriteria: [english], inputValues: { [brief]: copied } },
      { type: 'update_node', nodeId: 'b', title: english, persona: loose },
      { type: 'set_input', nodeId: 'b', fieldId: brief, value: copied },
      { type: 'set_task', nodeId: 'b', constraints: ['模块B原来的约束', copied] },
      { type: 'update_field', nodeId: 'b', side: 'input', fieldId: brief, changes: { help: english } },
      { type: 'add_field', nodeId: 'b', side: 'input', field: { id: 'extra', label: loose, type: 'text', required: false, value: '' } },
    ] };
    markPlanContextCondensed(plan, new Map());
    const applied = applyCanvasPlan(doc, plan, 'zh', '复用模块A的内容');
    const b = nodeOf(applied.doc, 'b'), c = nodeOf(applied.doc, applied.addedNodeIds[0]);
    expect(b).toEqual(nodeOf(doc, 'b'));
    expect(c.contract!.inputs[0].value).toBe('');
    expect(c.taskFrame?.acceptanceCriteria ?? []).toEqual([]);
    expect(JSON.stringify(applied.doc)).not.toMatch(/〔另有|more characters not shown/);
    expect(applied.adjustments.filter(line => line.includes('抄了只显示了开头的文字'))).toHaveLength(10);
  });

  it('knows the note however a copy rewrites it: brackets, spaces, digit grouping and the words around it', () => {
    for (const text of [condensedMark(12, 'zh'), condensedMark(1234, 'en'), '……（另有 12 字未显示）', '另有12字未显示', '[另有 1,234 字 未显示]', '另有 1 234 字未显示',
      '另有 1 234 字未显示', '(1,234 more characters not shown)', '1 234 more characters not shown', '1 more character not shown',
      '[12 more\n      characters not shown; kept as they are]', '〔另有 12\n        字未显示，保持原样〕', '〔另有 1\n      234 字未显示，保持原样〕',
      '[1,\n    234 more characters not shown]']) expect(carriesCondensedText(text), text).toBe(true);
    for (const text of ['另有 12 字', '还有 12 字未显示', 'more characters not shown', '12 more characters shown']) expect(carriesCondensedText(text), text).toBe(false);
    // No text makes the match slow: long runs of digits and spaces that end in neither note.
    const started = performance.now();
    for (const text of [`另有 ${'1 '.repeat(50_000)}x ${'9 '.repeat(50_000)}more`, `${'9'.repeat(100_000)} more characters`, `另有 ${'8'.repeat(100_000)} 字`,
      `1${' '.repeat(100_000)}more`]) expect(carriesCondensedText(text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('says a new node was added without the copied text, under the name the node gets', () => {
    const doc = canvas();
    const copied = `模块A原来的${condensedMark(12, 'zh')}`;
    const brief = inputId(doc, 0);
    const plan: CanvasPlan = { version: 1, summary: '新增模块C。', operations: [
      { type: 'add_node', ref: 'c', templateId: 'general', title: '模块C', persona: copied, acceptanceCriteria: ['能核对的交付'], inputValues: { [brief]: copied } },
      { type: 'add_node', ref: 'd', templateId: 'general', title: copied, acceptanceCriteria: ['能核对的交付'] },
    ] };
    markPlanContextCondensed(plan, new Map());
    const applied = applyCanvasPlan(doc, plan, 'zh', '新增模块C');
    const [c, d] = applied.addedNodeIds.map(id => nodeOf(applied.doc, id));
    expect(c.title).toBe('模块C');
    expect(c.taskFrame?.acceptanceCriteria).toEqual(['能核对的交付']);
    expect(c.contract!.inputs[0].value).toBe('');
    expect(d.title).toBe(createAgentTemplate('general', { x: 0, y: 0 }).title);
    expect(applied.adjustments).toEqual([`新增的「模块C」没有写入「人设」：方案给的内容抄了只显示了开头的文字`,
      `新增的「模块C」没有写入「${brief}」：方案给的内容抄了只显示了开头的文字`,
      `新增的「${d.title}」没有写入「名称」：方案给的内容抄了只显示了开头的文字`]);
    const english = applyCanvasPlan(doc, plan, 'en', 'Add module C');
    expect(english.adjustments[0]).toBe('Added “模块C” without the persona the plan gave it: that text copied text the plan saw only in part');
  });

  it('names a new input a connection makes by what it receives, never by copied text', () => {
    const doc = canvas();
    const output = nodeOf(doc, 'a').contract!.outputs[0].id;
    const named = '模块A原来的…〔另有12字未显示，保持原样〕';
    const plan: CanvasPlan = { version: 1, summary: '连接两个模块。', operations: [{ type: 'connect', fromNode: 'a', fromField: output, toNode: 'b', toField: named }] };
    markPlanContextCondensed(plan, new Map());
    const applied = applyCanvasPlan(doc, plan, 'zh', '连接两个模块');
    const added = nodeOf(applied.doc, 'b').contract!.inputs.at(-1)!;
    expect(added.label).not.toContain('另有');
    expect(added.label).toContain('（来自模块A）');
    // Nor does the reply quote the copied words.
    expect(applied.adjustments).toEqual([expect.stringMatching(/^「模块B」原来没有方案写的那个输入，已新增输入「.+（来自模块A）」/)]);
    // From the whole canvas, the words are the plan's own and name the input.
    const whole = { ...plan, operations: [...plan.operations] };
    expect(nodeOf(applyCanvasPlan(doc, whole, 'zh', '连接两个模块').doc, 'b').contract!.inputs.at(-1)!.label).toBe(named);
  });

  it('writes such words as given in a plan made from the whole canvas: there they are the reader’s own', () => {
    const doc = canvas();
    const quoted = `示例：${condensedMark(5, 'zh')}`;
    const applied = applyCanvasPlan(doc, { version: 1, summary: '写入示例。', operations: [{ type: 'set_input', nodeId: 'a', fieldId: inputId(doc, 0), value: quoted }] }, 'zh', '写入示例');
    expect(nodeOf(applied.doc, 'a').contract!.inputs[0].value).toBe(quoted);
    expect(applied.adjustments).toEqual([]);
  });
});
