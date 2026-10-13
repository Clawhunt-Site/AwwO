import type { AgentTemplateId } from '../../canvas/agentTemplates';
import { createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../../canvas/canvasDoc';
import type { ContractField } from '../../canvas/nodeContracts';
import { updateNodeDraft } from '../../canvas/nodeThreads';
import { edgeId } from '../../canvas/ports';
import type { UiLocale } from '../../locale';
import type { OfficialMediaNode } from './officialMedia';

export type Localized = Readonly<Record<UiLocale, string>>;
export type OfficialWorkflowCategory = 'design' | 'game' | '3d' | 'knowledge';
export interface OfficialWorkflowNode {
  readonly id: string;
  readonly title: Localized;
  readonly role: AgentTemplateId;
  readonly task: Localized;
  readonly output: Localized;
  readonly outputType?: 'markdown' | 'html';
  readonly acceptance: ReadonlyArray<Localized>;
  readonly column: number;
  readonly row: number;
}
/** The canvas behind a homepage production case (productionWorkflows.ts, recordedCanvases.ts), which
 * createOfficialDocument compiles into the canvas a member copies. */
export interface OfficialWorkflow {
  readonly id: string;
  readonly category: OfficialWorkflowCategory;
  readonly categoryLabel: Localized;
  readonly title: Localized;
  readonly summary: Localized;
  readonly description: Localized;
  readonly pattern: Localized;
  readonly brief: Localized;
  readonly accent: string;
  readonly nodes: ReadonlyArray<OfficialWorkflowNode>;
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly label: Localized }>;
  readonly artifacts: ReadonlyArray<Localized>;
  readonly limitations: Localized;
  /** A canvas kept as it ran, copied instead of compiling `nodes`, which then only lay it out and describe it. */
  readonly canvas?: RecordedCanvas;
  /** Image, video and 3D nodes that generate the case's media in the same canvas run (officialMedia.ts). */
  readonly media?: ReadonlyArray<OfficialMediaNode>;
}

/** One node of a recorded canvas: its title, persona and contract, word for word. */
export interface RecordedCanvasNode {
  readonly id: string;
  readonly title: string;
  readonly persona: string;
  readonly inputs: ReadonlyArray<ContractField>;
  readonly outputs: ReadonlyArray<ContractField>;
}
/** A case's canvas exactly as it ran, for a case whose canvas was not compiled from tasks here. */
export interface RecordedCanvas {
  /** The language it ran in; a copy keeps it in either interface language. */
  readonly locale: UiLocale;
  readonly nodes: ReadonlyArray<RecordedCanvasNode>;
  /** Each wire carries one output field of a node into one input field of another. */
  readonly wires: ReadonlyArray<{ readonly from: string; readonly output: string; readonly to: string; readonly input: string }>;
}
/** What a page node fed by the case's media nodes is told about the files it receives. */
const MEDIA_PAGE: Localized = {
  zh: '\n\n画布里的媒体节点会把它生成的文件交给你（输入「…（生成的文件）」列出每个文件的相对路径，如 节点ID/image-1.png）：页面把这些文件用作真实的主视觉、配图或样片，只写列出的路径，写在 img、video、source 的 src、video 的 poster 或 CSS 的 url() 里；不要编造别的文件名，不要在脚本字符串里拼这些路径。页面里已经写好的这些路径原样保留。输入说这次没有生成出文件时，用不依赖它的设计完成。',
  en: '\n\nThe canvas’s media nodes hand you the files they generated (the “… (generated files)” inputs list each file’s relative path, such as node-id/image-1.png): the page uses them as its real key visual, pictures or sample clip, by exactly those paths, in an img, video or source src, a video poster or a CSS url(); never invent other file names, and never build these paths inside a script string. Keep any such path the page already has as it is. When an input says no file was made this time, finish with a design that does not need it.',
};
const MEDIA_MODEL_PAGE: Localized = {
  zh: '3D 模型节点给出 GLB 模型和一张渲染预览图：页面用预览图（preview-1.*）展示这个模型，GLB 不放进页面。',
  en: ' A 3D model node hands over a GLB model and a rendered preview picture: the page shows the model by its preview picture (preview-1.*) and never puts the GLB in the page.',
};

/** Mint a clean document, never clone bindings, conversations, credentials or sample results.
 * A production case's copy adds its recorded deliveries afterwards (productionCopy.ts); the canvas
 * its run record is pinned to never carries them.
 * Each incoming edge has a distinct contract field so fan-in is valid on the SaaS DAG runner.
 * Runtime and model selection are left to the workspace's existing initialization policy. */
export function createOfficialDocument(item: OfficialWorkflow, locale: UiLocale): CanvasDocument {
  if (item.canvas) return createRecordedDocument(item, item.canvas);
  // The case's media nodes, made first so the pages they feed can name their inputs after them.
  const media = (item.media ?? []).map(spec => ({ spec, node: officialMediaNode(spec, locale) }));
  const nodes = item.nodes.map((spec): SessionNode => {
    const base = createSessionNode(['frontend', 'backend', 'users'].includes(spec.role) ? 'coding' : 'llm',
      { x: spec.column * 680, y: spec.row * 560 });
    const incoming = item.edges.filter(edge => edge.to === spec.id);
    const pictures = media.filter(entry => entry.spec.feeds?.includes(spec.id)).map(entry => entry.spec);
    const inputs: ContractField[] = [{
      id: 'brief', label: locale === 'zh' ? '任务与边界' : 'Task and boundaries', type: 'markdown', required: true,
      value: `${item.brief[locale]}\n\n${spec.task[locale]}`,
    }, ...incoming.map((edge): ContractField => ({
      id: `from_${edge.from}`, label: edge.label[locale], type: 'markdown', required: true, value: '',
      help: locale === 'zh' ? '由上游节点的真实输出提供。' : 'Supplied by the actual upstream output.',
    })), ...pictures.map((picture): ContractField => ({
      id: `media_${picture.id}`, label: locale === 'zh' ? `${picture.title.zh}（生成的文件）` : `${picture.title.en} (generated files)`,
      type: 'markdown', required: true, value: '',
      help: locale === 'zh' ? '画布里的媒体节点生成后提供：文件的相对路径，或这次没有生成出文件的说明。'
        : 'Supplied by the canvas’s media node once it generates: the files’ relative paths, or a note that none was made.',
    }))];
    const outputType = spec.outputType ?? 'markdown';
    const evidence = locale === 'zh'
      ? '这是待运行的官方参考工作流。只根据实际输入推进；不要把演示、计划或静态检查冒充成功执行。无法运行或缺少能力时，明确列出未验证项。不要自行部署、发送信息或连接生产数据。'
      : 'This is an official reference workflow awaiting execution. Use actual inputs; never present a demo, plan or static check as successful execution. List unverified items when execution or capabilities are unavailable. Do not deploy, send messages or connect production data.';
    const html = outputType === 'html' ? (locale === 'zh'
      ? `\n交付完整、自包含 HTML 文档（html、head、body）。CSS、JavaScript、图形和演示数据全部内嵌；外部脚本只能引用 AwwO 内置的 three.js r128（https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js），不使用其他外部脚本、模块导入、字体、${pictures.length ? '外部图片（媒体节点交给你的文件除外）' : '图片'}或网络请求。交互必须真的更新状态。`
      : `\nDeliver a complete self-contained HTML document (html, head, body). Inline CSS, JavaScript, graphics and sample data; the only external script allowed is AwwO’s built-in three.js r128 (https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js) — no other external scripts, module imports, fonts, ${pictures.length ? 'external images (the files the media nodes hand you excepted)' : 'images'} or network requests. Interactions must update real state.`) : '';
    const shows = pictures.length ? `${MEDIA_PAGE[locale]}${pictures.some(picture => picture.kind === 'model3d') ? MEDIA_MODEL_PAGE[locale] : ''}` : '';
    return { ...base, title: spec.title[locale], w: 560, h: 420,
      // These nodes have purpose-built contracts; assigning a built-in templateId would display
      // that template's unrelated guide instead of the official case's task and acceptance.
      persona: `${spec.task[locale]}\n\n${locale === 'zh' ? '验收要求' : 'Acceptance'}:\n${spec.acceptance.map(check => `- ${check[locale]}`).join('\n')}\n\n${evidence}${html}${shows}`,
      contract: { version: 1, inputs, outputs: [{ id: 'result', label: spec.output[locale], type: outputType, required: true, value: '',
        help: spec.acceptance.map(check => check[locale]).join('\n') }] },
    };
  });
  const byId = new Map(item.nodes.map((spec, index) => [spec.id, nodes[index]]));
  const edges = item.edges.map(link => {
    const source = byId.get(link.from);
    const target = byId.get(link.to);
    if (!source || !target) throw new Error(`Invalid official workflow edge: ${link.from} -> ${link.to}`);
    const from = { nodeId: source.id, portId: 'out:result' };
    const to = { nodeId: target.id, portId: `in:from_${link.from}` };
    return { id: edgeId(from, to), fromNode: from.nodeId, fromPort: from.portId,
      toNode: to.nodeId, toPort: to.portId, dataType: 'text' as const };
  });
  // Each media node's result into the pages that show it: a soft wire (ports.ts isSoftMediaFeed), which a picture that
  // was not made never holds back. The wire keeps its source's type.
  const mediaEdges = media.flatMap(({ spec, node }) => (spec.feeds ?? []).map(target => {
    const page = byId.get(target);
    if (!page) throw new Error(`Invalid official media wire: ${spec.id} -> ${target}`);
    const from = { nodeId: node.id, portId: 'result' };
    const to = { nodeId: page.id, portId: `in:media_${spec.id}` };
    return { id: edgeId(from, to), fromNode: from.nodeId, fromPort: from.portId, toNode: to.nodeId, toPort: to.portId,
      dataType: spec.kind === 'model3d' ? 'file' as const : spec.kind };
  }));
  // A media node made from another one's picture (a colour version, a clip of the same subject): that picture's result
  // into its reference input, an ordinary image wire, so it waits for the picture.
  const referenceEdges = media.flatMap(({ spec, node }) => (spec.references ?? []).map(source => {
    const picture = media.find(entry => entry.spec.id === source);
    if (!picture || picture.spec.kind !== 'image' || picture.node === node) throw new Error(`Invalid official media reference: ${source} -> ${spec.id}`);
    const from = { nodeId: picture.node.id, portId: 'result' };
    const to = { nodeId: node.id, portId: 'reference' };
    return { id: edgeId(from, to), fromNode: from.nodeId, fromPort: from.portId, toNode: to.nodeId, toPort: to.portId, dataType: 'image' as const };
  }));
  return { ...emptyDocument(), nodes: [...nodes, ...media.map(entry => entry.node)], edges: [...edges, ...mediaEdges, ...referenceEdges] };
}

/** A media node as the canvas makes one: its model and parameters chosen, its prompt in the draft a run or a Send
 * generates from, nothing bound and no conversation yet. */
function officialMediaNode(spec: OfficialMediaNode, locale: UiLocale): SessionNode {
  const base = createSessionNode(spec.kind, { x: spec.column * 680, y: spec.row * 560 });
  const node: SessionNode = { ...base, title: spec.title[locale], model: spec.model, ...(spec.params ? { mediaParams: { ...spec.params } } : {}) };
  return updateNodeDraft(node, spec.prompt[locale]);
}

/** A recorded canvas in the language it ran in, whatever the interface language: every title, persona,
 * field and wire as recorded, nothing added. The workflow's nodes give only the layout and the kind. */
function createRecordedDocument(item: OfficialWorkflow, canvas: RecordedCanvas): CanvasDocument {
  if (canvas.nodes.length !== item.nodes.length) throw new Error(`Recorded canvas ${item.id} does not match its workflow`);
  const nodes = item.nodes.map((spec): SessionNode => {
    const recorded = canvas.nodes.find(node => node.id === spec.id);
    if (!recorded) throw new Error(`Recorded canvas ${item.id} has no node ${spec.id}`);
    const base = createSessionNode(['frontend', 'backend', 'users'].includes(spec.role) ? 'coding' : 'llm',
      { x: spec.column * 680, y: spec.row * 560 });
    return { ...base, title: recorded.title, w: 560, h: 420, persona: recorded.persona,
      contract: { version: 1, inputs: recorded.inputs.map(field => ({ ...field })), outputs: recorded.outputs.map(field => ({ ...field })) } };
  });
  const byId = new Map(item.nodes.map((spec, index) => [spec.id, nodes[index]]));
  const edges = canvas.wires.map(wire => {
    const source = byId.get(wire.from);
    const target = byId.get(wire.to);
    if (!source || !target) throw new Error(`Invalid recorded wire: ${wire.from} -> ${wire.to}`);
    const from = { nodeId: source.id, portId: `out:${wire.output}` };
    const to = { nodeId: target.id, portId: `in:${wire.input}` };
    return { id: edgeId(from, to), fromNode: from.nodeId, fromPort: from.portId,
      toNode: to.nodeId, toPort: to.portId, dataType: 'text' as const };
  });
  return { ...emptyDocument(), nodes, edges };
}
