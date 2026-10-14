import type { AgentTemplateId } from '../../canvas/agentTemplates';
import { createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../../canvas/canvasDoc';
import type { ContractField } from '../../canvas/nodeContracts';
import { updateNodeDraft } from '../../canvas/nodeThreads';
import { edgeId } from '../../canvas/ports';
import { THREE_MODULES_IMPORT_MAP } from '../../canvas/previewImportMap';
import type { OfficialMediaNode } from './officialMedia';

/** Every production case is English, in both interface languages (owner 2026-10-14): its canvas, tasks and
 * deliveries are written and run in English, so a copy is the same canvas whatever the reader's language. */
export interface OfficialWorkflowNode {
  readonly id: string;
  readonly title: string;
  readonly role: AgentTemplateId;
  readonly task: string;
  readonly output: string;
  readonly outputType?: 'markdown' | 'html';
  readonly acceptance: ReadonlyArray<string>;
  readonly column: number;
  readonly row: number;
}
/** The canvas behind a homepage production case (productionWorkflows.ts), which createOfficialDocument
 * compiles into the canvas a member copies. */
export interface OfficialWorkflow {
  readonly id: string;
  readonly title: string;
  /** What its pages are built on. 'r186': three.js r186 as ES modules through the import map AwwO supplies
   * (previewModules.ts), and scripts that load the media nodes' files (a GLB, a texture) by their paths. Without it a
   * page is held to three.js r128 and shows media from markup only, as every case canvas published before 2026-10-15
   * was: their text, and so their recorded runs' checksums, stay as they ran. */
  readonly stack?: 'r186';
  readonly brief: string;
  readonly nodes: ReadonlyArray<OfficialWorkflowNode>;
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly label: string }>;
  /** Image, video and 3D nodes that generate the case's media in the same canvas run (officialMedia.ts). */
  readonly media?: ReadonlyArray<OfficialMediaNode>;
}

/** What a page node fed by the case's media nodes is told about the files it receives. */
const MEDIA_PAGE = '\n\nThe canvas’s media nodes hand you the files they generated (the “… (generated files)” inputs list each file’s relative path, such as node-id/image-1.png): the page uses them as its real key visual, pictures or sample clip, by exactly those paths, in an img, video or source src, a video poster or a CSS url(); never invent other file names, and never build these paths inside a script string. Keep any such path the page already has as it is. When an input says no file was made this time, finish with a design that does not need it.';
const MEDIA_MODEL_PAGE = ' A 3D model node hands over a GLB model and a rendered preview picture: the page shows the model by its preview picture (preview-1.*) and never puts the GLB in the page.';
// The same, for a workflow on three.js r186 (`stack: 'r186'`): a script may load the files by their paths too.
const MEDIA_PAGE_R186 = '\n\nThe canvas’s media nodes hand you the files they generated (the “… (generated files)” inputs list each file’s relative path, such as node-id/image-1.png): the page uses them as its real models, key visual, textures, pictures or clips, by exactly those paths — in an img, video or source src, a video poster or a CSS url(), or as one whole string literal a script loads (GLTFLoader for a .glb, TextureLoader for a picture used on a surface). Never invent other file names and never assemble a path from pieces. Keep any such path the page already has as it is. When an input says no file was made this time, finish with a design that does not need it.';
const MEDIA_MODEL_PAGE_R186 = ' A 3D model node hands over a GLB model and a rendered preview picture: a 3D scene loads the GLB with GLTFLoader by its path and shows the real model (scaled and centred from its bounding box, its longest horizontal axis along the direction it faces or travels); a flat page shows the preview picture (preview-1.*).';
/** The page rule of a workflow on three.js r186: the import map AwwO supplies, and nothing else from outside. */
const HTML_R186 = (pictures: boolean) => `\nDeliver a complete self-contained HTML document (html, head, body). Inline CSS, JavaScript, graphics and sample data. For 3D use three.js r186, which AwwO supplies with no network, through exactly this import map: ${THREE_MODULES_IMPORT_MAP}, importing 'three' and 'three/addons/…' in one module script; never paste a library’s source. No other external scripts, fonts, ${pictures ? 'images (the media nodes’ files excepted)' : 'images'} or network requests. Interactions must update real state.`;
/** Every agent's persona ends with this. */
const EVIDENCE = 'This is an official reference workflow awaiting execution. Use actual inputs; never present a demo, plan or static check as successful execution. List unverified items when execution or capabilities are unavailable. Do not deploy, send messages or connect production data.';

/** Mint a clean document, never clone bindings, conversations, credentials or sample results.
 * A production case's copy adds its recorded deliveries afterwards (productionCopy.ts); the canvas
 * its run record is pinned to never carries them.
 * Each incoming edge has a distinct contract field so fan-in is valid on the SaaS DAG runner.
 * Runtime and model selection are left to the workspace's existing initialization policy. */
export function createOfficialDocument(item: OfficialWorkflow): CanvasDocument {
  // The case's media nodes, made first so the pages they feed can name their inputs after them.
  const media = (item.media ?? []).map(spec => ({ spec, node: officialMediaNode(spec) }));
  const nodes = item.nodes.map((spec): SessionNode => {
    const base = createSessionNode(['frontend', 'backend', 'users'].includes(spec.role) ? 'coding' : 'llm',
      { x: spec.column * 680, y: spec.row * 560 });
    const incoming = item.edges.filter(edge => edge.to === spec.id);
    const pictures = media.filter(entry => entry.spec.feeds?.includes(spec.id)).map(entry => entry.spec);
    const inputs: ContractField[] = [{
      id: 'brief', label: 'Task and boundaries', type: 'markdown', required: true,
      value: `${item.brief}\n\n${spec.task}`,
    }, ...incoming.map((edge): ContractField => ({
      id: `from_${edge.from}`, label: edge.label, type: 'markdown', required: true, value: '',
      help: 'Supplied by the actual upstream output.',
    })), ...pictures.map((picture): ContractField => ({
      id: `media_${picture.id}`, label: `${picture.title} (generated files)`,
      type: 'markdown', required: true, value: '',
      help: 'Supplied by the canvas’s media node once it generates: the files’ relative paths, or a note that none was made.',
    }))];
    const outputType = spec.outputType ?? 'markdown';
    const modern = item.stack === 'r186';
    const html = outputType === 'html'
      ? modern ? HTML_R186(pictures.length > 0)
        : `\nDeliver a complete self-contained HTML document (html, head, body). Inline CSS, JavaScript, graphics and sample data; the only external script allowed is AwwO’s built-in three.js r128 (https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js) — no other external scripts, module imports, fonts, ${pictures.length ? 'external images (the files the media nodes hand you excepted)' : 'images'} or network requests. Interactions must update real state.` : '';
    const models = pictures.some(picture => picture.kind === 'model3d');
    const shows = pictures.length
      ? modern ? `${MEDIA_PAGE_R186}${models ? MEDIA_MODEL_PAGE_R186 : ''}` : `${MEDIA_PAGE}${models ? MEDIA_MODEL_PAGE : ''}` : '';
    return { ...base, title: spec.title, w: 560, h: 420,
      // These nodes have purpose-built contracts; assigning a built-in templateId would display
      // that template's unrelated guide instead of the official case's task and acceptance.
      persona: `${spec.task}\n\nAcceptance:\n${spec.acceptance.map(check => `- ${check}`).join('\n')}\n\n${EVIDENCE}${html}${shows}`,
      contract: { version: 1, inputs, outputs: [{ id: 'result', label: spec.output, type: outputType, required: true, value: '',
        help: spec.acceptance.join('\n') }] },
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
function officialMediaNode(spec: OfficialMediaNode): SessionNode {
  const base = createSessionNode(spec.kind, { x: spec.column * 680, y: spec.row * 560 });
  const node: SessionNode = { ...base, title: spec.title, model: spec.model, ...(spec.params ? { mediaParams: { ...spec.params } } : {}) };
  return updateNodeDraft(node, spec.prompt);
}
