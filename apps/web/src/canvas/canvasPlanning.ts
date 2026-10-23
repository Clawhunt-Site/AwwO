import { canvasStorage, workspaceStorage } from './canvasStorage';
import { canvasFetch, currentSaaSCanvas } from '../saas/canvasBridge';
import { gatewayApiBase } from '../chatAutomations';
import { getAgentTemplateForNode, getAgentTemplates } from './agentTemplates';
import { figureRole } from './figureKit/figureKit';
import type { CanvasDocument } from './canvasDoc';
import { CANVAS_PLAN_NODE_OPERATION_TYPES, CANVAS_PLAN_OPERATION_TYPES, CANVAS_PLAN_PROTOCOL, DEFAULT_MODEL_REFERENCE, HOSTED_PAGE_TEMPLATE_ID, MEDIA_PLAN_TEMPLATE_IDS, PLAN_TEMPLATE_IDS,
  canvasPlanRevision, condensedFromJSON, condensedMark, condensedToJSON, hostedPageOutputs, markPlanContextCondensed, markPlanNewNodeModel, parseCanvasPlan,
  sharedRequirements, withMediaNodes, type CanvasPlan, type CanvasPlanOperationType, type PlanContextCondensed } from './canvasPlan';
import { isTaskFrame } from './taskFrame';
import { NEW_NODE_LINE } from './planNewNodeModel';
import { mediaKindOf, type MediaKind } from './mediaCatalog';
import { activeNodeThread } from './nodeThreads';
import type { UiLocale } from '../locale';
import { canvasText } from './i18n';
import { readSseFrames } from '../sse';

export interface PlanningMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** `unconfirmed`: a task that may have started; the host reconciles it. */
  status?: 'applied' | 'error' | 'stale' | 'unconfirmed';
  /** How the server routed this turn, in a host that also does tasks (see assistantRouting.ts). */
  route?: 'plan' | 'execute';
  /** The task an executed turn started; the host draws it. */
  taskId?: string;
  /** An unconfirmed turn's submission identity, which a reconcile settles. */
  operationId?: string;
  /** The nodes an applied plan added: while none of them is on the canvas, the plan counts as undone. */
  nodes?: string[];
  /** A hand-over's whole request (the earlier request, then the reader's correction), where `content` is the reader's
   *  own words: what a later correction hands over again. */
  request?: string;
}

/** The turns the planner reads: an executed turn is the workspace's business, not the canvas's. */
export const planningTurns = (messages: PlanningMessage[]) => messages.filter(message => message.route !== 'execute');
export interface PlanningConversation { draft: string; messages: PlanningMessage[] }
export const PLANNING_STORAGE_KEY = 'awwo.canvas.planning.v1';
/** Seconds the last successful plan took in this workspace on this device; a measurement, shown as
 * the next plan's expectation. Kept per workspace, not per canvas, so a new canvas has one too. */
export const PLAN_DURATION_STORAGE_KEY = 'awwo.canvas.planning.duration.v1';

/** Observed planner progress. Every field is a real measurement, never an estimated percentage:
 * the runtime does not know the plan's final length, so a completion ratio would be fabricated. */
export interface PlanProgress {
  /** queued = accepted, waiting for a runtime slot; running = runtime started, nothing observed yet;
   *  thinking = the model is reasoning before it writes; streaming = the plan is being written;
   *  validating = the plan arrived and is being checked; retrying = the single retry is starting (of a malformed plan,
   *  or of a run a provider fault cut short: `retry`). */
  stage: 'queued' | 'running' | 'thinking' | 'streaming' | 'validating' | 'retrying';
  /** Characters of plan text written so far. */
  characters: number;
  /** Nodes the proposal has declared so far (counted from whole add_node markers). */
  nodes: number;
  /** Connections the proposal has declared so far (counted from whole connect markers). */
  edges: number;
  /** Characters of reasoning the model produced before writing; a count, never its text. */
  reasoning: number;
  /** Template id of the node declared most recently, when the host observed one. */
  template?: string;
  /** Kind of operation the proposal is writing now, when the host observed one. */
  operation?: CanvasPlanOperationType;
  /** Template id of the node that operation concerns, when the proposal itself declared that node. */
  target?: string;
  /** 1 for the first attempt, 2 for the single retry. */
  attempt: number;
  /** Why the single retry runs, on the report that starts it: 'provider' for a run a provider fault cut short
   *  (providerFault); absent for a malformed plan. */
  retry?: 'provider';
}
export type PlanProgressReporter = (progress: PlanProgress) => void;

const PLAN_STAGES: ReadonlyArray<PlanProgress['stage']> = ['queued', 'running', 'thinking', 'streaming', 'validating', 'retrying'];

const validCount = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** The progress a host reported, merged over what was already observed. Counts that are
 * missing or malformed keep their previous value, so a bad frame cannot erase real work. A
 * frame is a whole snapshot, though, so its template, operation and target are taken as sent:
 * absent means the host has not observed one yet, and a previous one must not stand in for it. */
export function observedProgress(frame: Record<string, unknown>, previous: PlanProgress): PlanProgress {
  const count = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
  const stage = PLAN_STAGES.includes(frame.stage as PlanProgress['stage']) ? frame.stage as PlanProgress['stage'] : previous.stage;
  // Only a member of the closed template set is kept, and only beside the node count it was
  // reported with: a frame whose count is unusable cannot say which node the template names.
  const template = typeof frame.template === 'string' && PLAN_TEMPLATE_IDS.has(frame.template) && validCount(frame.nodes)
    ? frame.template : undefined;
  // Likewise only a member of the closed operation set, and a target only beside an operation on
  // one node: a node is named only through the operation that concerns it.
  const operation = typeof frame.operation === 'string' && CANVAS_PLAN_OPERATION_TYPES.has(frame.operation)
    ? frame.operation as CanvasPlanOperationType : undefined;
  const target = operation && CANVAS_PLAN_NODE_OPERATION_TYPES.has(operation) && typeof frame.target === 'string'
    && PLAN_TEMPLATE_IDS.has(frame.target) ? frame.target : undefined;
  return { stage, characters: count(frame.characters, previous.characters), nodes: count(frame.nodes, previous.nodes),
    edges: count(frame.edges, previous.edges), reasoning: count(frame.reasoning, previous.reasoning),
    ...(template ? { template } : {}), ...(operation ? { operation } : {}), ...(target ? { target } : {}), attempt: previous.attempt };
}

export function loadLastPlanDuration(): number | undefined {
  try {
    const value = Number(workspaceStorage().getItem(PLAN_DURATION_STORAGE_KEY));
    return Number.isInteger(value) && value > 0 && value <= 3_600 ? value : undefined;
  } catch { return undefined; }
}

export function saveLastPlanDuration(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3_600) return;
  try { workspaceStorage().setItem(PLAN_DURATION_STORAGE_KEY, String(Math.max(1, Math.round(seconds)))); }
  catch { /* An expectation is a convenience; without storage the next plan simply shows none. */ }
}


/** Keep the shared structural protocol, with only the Go host's supported operations/types, and the media nodes the
 *  workspace can generate (a hosted workspace only). A host that offers the planner no models leaves set_model out. */
function planningProtocol(saas: boolean, mediaKinds: ReadonlyArray<MediaKind> = [], models = false): string {
  const protocol = models ? CANVAS_PLAN_PROTOCOL : CANVAS_PLAN_PROTOCOL.split('\n').filter(line => !line.startsWith('set_model')).join('\n');
  if (!saas) return protocol;
  return withMediaNodes(protocol.split('\n').filter(line =>
    !/^(set_edge_kind:|set_execution:|互审Graph使用)/.test(line),
  ).map(line => line.startsWith('connect 使用')
    ? 'connect 使用字段ID（如schema、api，不加in:/out:前缀）；旧节点可使用其实际context/result/data端口ID。连线必须类型匹配，单输入只能连接一个来源，全图不得成环。'
    : line.replace(',kind?:"data"|"feedback"', '').replace('/reviewerNodeId', '')).join('\n'), mediaKinds);
}

/** A chat model a node can run, as the planner is told (the host's palette, each model once): its id for set_model,
 *  its name, the effort levels it offers, and whether a free workspace needs a paid plan for it. */
export interface PlanModel { id: string; name: string; efforts?: ReadonlyArray<string>; paid?: boolean }
/** How a node's last run ended, as the planner is told: its state and, for a failure or a block, the reason shown. */
export interface PlanRunState { state: string; detail?: string }
/** What a host can add to the planner's view: the models nodes can run, each node's last run, and the model the Agent
 *  nodes a plan adds without set_model take (the reader's choice for the canvas assistant, assistantModel.ts;
 *  DEFAULT_NEW_NODE_MODEL where they run the workspace default), which a hosted planner sizes their tasks by
 *  (planning_limits.go). */
export interface PlanningExtras { models?: ReadonlyArray<PlanModel>; runs?: Readonly<Record<string, PlanRunState | undefined>>; newNodeModel?: string }

/** What the planner is told about a node's brief, its requirements and how its last run went: the things a person used
 *  to set by hand in developer mode, which the assistant now sets itself (owner request 2026-10-15). A hosted
 *  workspace's planner has this, and how its nodes are sized for one call, in its server instructions
 *  (plannerInstructions, planning.go), which reach it without growing this context or its recovery journal. */
function orchestrationGuidance(locale: UiLocale, models: boolean): string {
  // A node out of time: production's were model calls that never answered (2026-10-16 to 10-19), which another model
  // fixes where the planner can set one (owner 2026-10-21); with no model to offer, the work is split or narrowed.
  return locale === 'en'
    ? 'Write each persona you add or rewrite as a self-contained brief: what the node receives, exactly what it delivers (format, scope, size) and what it must not do. '
      + 'Give every Agent node you add 1–3 acceptanceCriteria in add_node, checkable against its own delivery; change criteria or constraints with set_task when the user asks for other rules or checks. '
      + (models ? 'Use set_model only when the user asks for another model or a node failed because of its model. ' : '')
      + `A node’s run is how its last run ended. To fix a failed node: ${models ? 'an answer too long → split the work or narrow the delivery; out of time → another model' : 'an answer too long or out of time → split the work or narrow the delivery'}; a refused premium model → the default model; otherwise improve the brief. Say in summary what you changed.`
    : 'persona写成完整任务说明：收到什么、交付什么（格式、范围、篇幅）、不做什么。新增Agent节点在add_node写1到3条可对照其交付核对的acceptanceCriteria；改规则或检查用set_task。'
      + (models ? '仅在用户要求或节点因模型失败时用set_model。' : '')
      + `run是上次运行结果；修复失败：${models ? '太长拆分或缩小交付，超时换模型' : '太长或超时就拆分工作或缩小交付'}，高级模型被拒就换默认模型，否则改进说明。summary说明改动。`;
}

/** The plan a SaaS workspace can apply. `kind: "data"` on a connect is the default kind, which models add although
 *  the protocol leaves it out; it is dropped rather than the whole plan refused. Review loops are not supported: a plan
 *  with one is refused with its own code, which is never asked for again and is said as itself after a retry. */
function saasPlan(plan: CanvasPlan, locale: UiLocale): CanvasPlan {
  if (plan.operations.some(operation => operation.type === 'set_execution' || operation.type === 'set_edge_kind'
    || (operation.type === 'connect' && operation.kind !== undefined && operation.kind !== 'data'))) {
    throw new PlanFailure(canvasText(locale, 'planning.unsupportedSaaS'), 'unsupported_plan_operation');
  }
  return { ...plan, operations: plan.operations.map(operation => {
    if (operation.type !== 'connect' || operation.kind === undefined) return operation;
    const { kind: _kind, ...plain } = operation;
    return plain;
  }) };
}

export function loadPlanningConversation(): PlanningConversation {
  try {
    const raw = JSON.parse(canvasStorage().getItem(PLANNING_STORAGE_KEY) || '{}');
    return {
      draft: typeof raw.draft === 'string' ? raw.draft.slice(0, 8_000) : '',
      messages: Array.isArray(raw.messages) ? raw.messages.filter((item: unknown): item is PlanningMessage => {
        if (!item || typeof item !== 'object') return false;
        const m = item as PlanningMessage;
        return typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
          && m.content.length <= 20_000 && (m.status === undefined || ['applied', 'error', 'stale', 'unconfirmed'].includes(m.status))
          && (m.route === undefined || m.route === 'plan' || m.route === 'execute')
          && (m.taskId === undefined || (typeof m.taskId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(m.taskId)))
          && (m.operationId === undefined || (typeof m.operationId === 'string' && /^execution-[0-9a-f-]{36}$/.test(m.operationId)))
          && (m.nodes === undefined || (Array.isArray(m.nodes) && m.nodes.length <= 200 && m.nodes.every(node => typeof node === 'string' && node.length <= 200)))
          && (m.request === undefined || (typeof m.request === 'string' && m.request.length <= 40_000));
      }).slice(-60) : [],
    };
  } catch { return { draft: '', messages: [] }; }
}

export function savePlanningConversation(value: PlanningConversation): void {
  try { canvasStorage().setItem(PLANNING_STORAGE_KEY, JSON.stringify({ draft: value.draft, messages: value.messages.slice(-60) })); }
  catch { /* The current conversation remains in memory if local persistence is unavailable. */ }
}

/** Supply the current structure, never execution credentials, transcripts or generated artifacts. `mediaKinds` are the
 *  media nodes this workspace can generate; only those are offered to the planner. `extras` add the models nodes can run
 *  (set_model is offered only with them) and how each node's last run ended. */
export function buildPlanningContext(doc: CanvasDocument, messages: PlanningMessage[], locale: UiLocale = 'zh', mediaKinds: ReadonlyArray<MediaKind> = [],
  extras: PlanningExtras = {}): string {
  return planningContext(doc, messages, locale, mediaKinds, extras, { ...WHOLE_VIEW });
}

/** How much of the canvas a planning context shows. `cap`: the characters kept of each long text of a node (its persona,
 *  requirements and criteria, input and form values, a media node's prompt), undefined for the whole text; a shared
 *  requirement keeps what the most generous of the nodes holding it keep. `turns` and `turnCap`: the latest conversation
 *  turns kept and the characters of each. The fields shown only in part are noted in `condensed`, node by node, and
 *  `shortened` says whether any text was cut, the conversation's included. */
interface PlanningView {
  cap: (nodeId: string) => number | undefined;
  turns: number;
  turnCap?: number;
  condensed?: Map<string, Set<string>>;
  shortened?: boolean;
}
const WHOLE_VIEW: PlanningView = { cap: () => undefined, turns: 10 };

function planningContext(doc: CanvasDocument, messages: PlanningMessage[], locale: UiLocale, mediaKinds: ReadonlyArray<MediaKind>,
  extras: PlanningExtras, view: PlanningView): string {
  const saas = currentSaaSCanvas() !== null;
  const offeredMedia = saas ? MEDIA_PLAN_TEMPLATE_IDS.filter(kind => mediaKinds.includes(kind)) : [];
  const models = extras.models?.length ? extras.models : undefined;
  // A shortened view shows a long text's first characters and says how many more the canvas keeps (condensedMark): only
  // where that is shorter than the text itself, so a short value is never hidden behind a longer note.
  let shortened = false;
  const shorten = (text: string, keep: number | undefined): string => {
    const characters = keep === undefined ? [] : Array.from(text);
    if (keep === undefined || characters.length <= keep) return text;
    const shown = characters.slice(0, keep).join('') + condensedMark(characters.length - keep, locale);
    if (utf8Bytes(shown) >= utf8Bytes(text)) return text;
    shortened = true;
    return shown;
  };
  const mark = (nodeId: string, field: string) => {
    if (!view.condensed) return;
    const fields = view.condensed.get(nodeId) ?? new Set<string>();
    view.condensed.set(nodeId, fields.add(field));
  };
  const short = <T>(nodeId: string, field: string, text: T): T => {
    if (typeof text !== 'string') return text;
    const shown = shorten(text, view.cap(nodeId));
    if (shown !== text) mark(nodeId, field);
    return shown as T;
  };
  // A request copied to several nodes is shown once and named; the plan keeps it by that name (sharedRequirements).
  const requirements = sharedRequirements(doc);
  const refOf = new Map([...requirements].map(([ref, text]) => [text, ref]));
  // The nodes holding each named requirement: it keeps what the most generous of them keeps, and when it is cut, every
  // one of them shows its constraints only in part.
  const holders = new Map<string, string[]>();
  for (const node of doc.nodes) {
    if (node.kind !== 'session' || !isTaskFrame(node.taskFrame)) continue;
    for (const item of node.taskFrame.constraints) {
      const ref = refOf.get(item);
      if (ref && !holders.get(ref)?.includes(node.id)) holders.set(ref, [...(holders.get(ref) ?? []), node.id]);
    }
  }
  const requirementCap = (ref: string): number | undefined => {
    const caps = (holders.get(ref) ?? []).map(id => view.cap(id));
    return caps.length === 0 || caps.includes(undefined) ? undefined : Math.max(...(caps as number[]));
  };
  const shownRequirements = [...requirements].map(([ref, text]) => {
    const shown = shorten(text, requirementCap(ref));
    if (shown !== text) for (const id of holders.get(ref) ?? []) mark(id, 'constraints');
    return [ref, shown] as const;
  });
  const graph = {
    ...(requirements.size ? { requirements: Object.fromEntries(shownRequirements) } : {}),
    nodes: doc.nodes.map(node => {
      if (node.kind === 'form') return { id: node.id, kind: node.kind, title: node.title,
        fields: view.cap(node.id) === undefined ? node.fields : node.fields.map(field => ({ ...field, value: short(node.id, `input:${field.id}`, field.value) })) };
      // An assemble node runs no model: the planner sees what it reads and delivers, not its page frame.
      if (node.kind === 'assemble') return { id: node.id, kind: node.kind, title: node.title,
        inputs: node.contract.inputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
        outputs: node.contract.outputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
        ...(node.lastOutput && !node.lastOutput.partial ? { delivered: true } : {}), ...runView(extras.runs?.[node.id]) };
      // An edit node runs no model either, and the planner does not make or change one: only that it is there.
      if (node.kind === 'edit') return { id: node.id, kind: node.kind, title: node.title,
        ...(node.lastOutput && !node.lastOutput.partial ? { delivered: true } : {}), ...runView(extras.runs?.[node.id]) };
      // A media node is described by what it makes and the prompt it will make it from, never by its model.
      const media = mediaKindOf(node.agentKind);
      if (media) return { id: node.id, templateId: media, title: node.title, prompt: short(node.id, 'input:prompt', activeNodeThread(node).draft), ...runView(extras.runs?.[node.id]) };
      const template = getAgentTemplateForNode(node, locale);
      // A figure node's persona carries the kit guide after its role; the planner only reads (and writes) the role.
      const roleOf = (persona: string | undefined) => (template?.id === 'figure' && persona !== undefined ? figureRole(persona) : persona);
      const persona = roleOf(node.persona);
      const frame = isTaskFrame(node.taskFrame) ? node.taskFrame : undefined;
      return { id: node.id, templateId: template?.id, title: node.title,
        // Templates already declare responsibilities below. Preserve only user-authored differences.
        ...(persona !== roleOf(template?.persona) ? { persona: short(node.id, 'persona', persona) } : {}),
        ...(frame?.constraints.length ? { constraints: frame.constraints.map(item => refOf.get(item) ?? short(node.id, 'constraints', item)) } : {}),
        ...(frame?.acceptanceCriteria.length ? { acceptanceCriteria: frame.acceptanceCriteria.map(item => short(node.id, 'acceptanceCriteria', item)) } : {}),
        // The planner sees a node's model only where it can change one; an unset node runs the workspace default.
        ...(models ? { model: node.model || DEFAULT_MODEL_REFERENCE } : {}),
        ...(node.team ? { team: true } : {}),
        inputs: node.contract?.inputs.map(({ id, label, type, required, value }) => ({ id, label, type, required, value: short(node.id, `input:${id}`, value) })),
        outputs: node.contract?.outputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
        ...(node.lastOutput && !node.lastOutput.partial ? { delivered: true } : {}),
        ...runView(extras.runs?.[node.id]),
      };
    }),
    edges: doc.edges.map(({ id, fromNode, fromPort, toNode, toPort, kind }) => ({ id, fromNode, fromPort, toNode, toPort, kind: kind ?? 'data' })),
    execution: doc.execution ? { mode: doc.execution.mode, maxRounds: doc.execution.maxRounds,
      reviewerNodeId: doc.execution.reviewerNodeId, verdictFieldId: doc.execution.verdictFieldId } : { mode: 'workflow' },
  };
  // A hosted canvas's frontend node is the page itself, as a plan then makes it (hostedPageOutputs).
  const page = (id: string) => saas && id === HOSTED_PAGE_TEMPLATE_ID;
  const templates = [...getAgentTemplates(locale).map(item => ({ id: item.id, title: item.title,
    responsibility: page(item.id) ? canvasText(locale, 'planning.pageResponsibility') : item.subtitle,
    inputs: item.inputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
    outputs: (page(item.id) ? hostedPageOutputs(locale) : item.outputs).map(({ id, label, type, required }) => ({ id, label, type, required })),
  })), ...offeredMedia.map(kind => ({ id: kind,
    title: canvasText(locale, kind === 'video' ? 'node.addVideo' : kind === 'model3d' ? 'node.addModel3d' : 'node.addImage'),
    responsibility: canvasText(locale, 'planning.mediaResponsibility', { kind: canvasText(locale, kind === 'video' ? 'media.kindVideo' : kind === 'model3d' ? 'media.kindModel3d' : 'media.kindImage') }),
    inputs: [{ id: 'prompt', label: canvasText(locale, 'planning.mediaPrompt'), type: 'text', required: true }],
    outputs: [{ id: 'result', label: canvasText(locale, 'planning.mediaResult'), type: kind === 'model3d' ? 'file' : kind, required: true }],
  }))];
  const guidance = locale === 'en' ? [
    'You are the AwwO canvas architecture assistant. Arrange independent Agent nodes, input/output contracts, and real dependencies around the user goal. Produce a structural plan, not execution results.',
    'Software products commonly need data, backend, identity, frontend, and review responsibilities; select only what the request needs. Put core business requirements in the root node input and pass downstream inputs through exact field connections. '
      + (saas ? 'This SaaS host supports one-pass workflows and text, markdown, html, number, boolean or file fields. Do not create review policies or feedback connections. '
        : 'For iterative challenges and verification, add explicit feedback edges and a bounded review policy with a boolean verdict output; first-round feedback inputs should be optional or have an explicit seed. Use html or markdown output types when those document formats are requested. ')
      + 'Choose the actual deliverable for each role: complete HTML for websites or games, Markdown for reports, real files for 3D models, Agent source or projects. Use one figure node per idea to explain how something works (explainer, diagram, interactive figure); add no fields to it. Keep meaningful handoffs and connect actual artifacts as well as their explanations to downstream reviewers. Roles are independent execution responsibilities, not fixed frontend/backend limitations. Requirements do not install tools; do not promise execution, archives or tests that the runtime cannot perform. Mark unknown information for confirmation. Never invent completed files, accounts, or APIs.',
    'The current canvas is the source of truth and may contain manual edits or undo results. Nodes without persona use their template responsibility. On a non-empty canvas, make the smallest relevant change and retain unrelated nodes and existing content. Delete only when the user asks. Reference existing nodes by ID, never by a guessed name. A new-node ref exists only within this operation list.',
    'Return protocol JSON only. Write summary in concise English and include any necessary open question. Do not call tools or execute the project. When information is insufficient, return empty operations and ask one concrete question in summary.',
    'Component templates', 'Current canvas', 'Conversation context (intent only; current canvas takes precedence)',
  ] : [
    '你是 AwwO 的画布架构助手。根据用户目标安排独立 Agent 节点、输入输出契约和真实依赖。生成的是结构方案，不是执行成果。',
    '软件产品通常包含数据、后端、用户身份、前端、验收等职责；根据需求选用，内容任务不必强行创建软件节点。核心业务需求应写入根节点输入；下游输入通过准确的字段连线接收。'
      + (saas ? '此SaaS工作区支持单次工作流，字段类型为text、markdown、html、number、boolean、file；不要创建互审策略或反馈连线。'
        : '需要反复质疑验证时，添加明确feedback连线、有限轮次互审策略与boolean判定输出；首轮反馈输入应可选或有明确初始值。用户指定文档格式时使用html或markdown输出类型。')
      + '按每个角色的职责选择实际交付：网页或游戏使用完整HTML，报告使用Markdown，3D模型、Agent源码或工程使用真实file。讲清楚原理、机制或算法怎么运转（原理图、图解、可交互讲解）时，每个原理用一个figure节点，不给它加字段。保留有意义的交接说明，也把实际产物连接给下游验收者。角色代表独立执行职责，不限于前端或后端。交付要求不会安装工具；不能承诺运行时无法执行的操作、归档或测试。对未知信息写明待确认，不虚构已完成的文件、账户或接口。',
    '当前画布是事实来源，可能已经被用户手工调整或撤销。未列persona的节点沿用模板职责。非空画布优先做最小增量修改，保留无关节点与已有内容；只有用户要求删除时才删除。使用已有节点ID引用，不按名称猜ID。新建节点ref仅供本次操作引用。',
    '只返回协议JSON。summary用简洁中文说明本次结构改动及必要的待确认事项。不要调用工具或执行项目。没有足够信息可返回空operations并在summary提出一个具体问题。',
    '组件模板', '当前画布', '对话上下文（仅作意图参考，以当前画布为准）',
  ];
  const mediaGuidance = !offeredMedia.length ? '' : locale === 'en'
    ? ' When the request needs pictures, video or 3D models as assets, add one matching media node per asset with its prompt written, rather than having a text Agent describe the asset or claim a file.'
    : '需要图片、视频或3D模型素材时，为每个素材添加一个对应的媒体节点并写好提示词，不要让文字Agent用描述代替生成或声称已有文件。';
  const modelHeading = locale === 'en' ? 'Models a node can run (for set_model; "default" is the workspace default)' : '节点可用的模型（供 set_model 使用；"default" 为工作区默认模型）';
  // The model the Agent nodes this plan adds without set_model take, as the host resolved it (only one a node can run,
  // or "default" for the workspace default): possibly one the model list leaves out, a model only a user may choose
  // (planModelsOf), which they still take.
  const newNodeModel = extras.newNodeModel || undefined;
  const newNodeLine = !newNodeModel ? '' : `${NEW_NODE_LINE[locale === 'en' ? 'en' : 'zh']}${JSON.stringify(newNodeModel)}`;
  const turns = (view.turns > 0 ? messages.slice(-view.turns) : []).map(({ role, content, status }) => ({ role, content: shorten(content, view.turnCap), status }));
  view.shortened = shortened;
  // Said only when a text was shortened, so the whole view's context is as it was.
  const shortenedNote = locale === 'en'
    ? 'The canvas is large, so some long texts are shown only in part this time, ending in "… [N more characters not shown; kept as they are]": the canvas keeps them whole. Do not rewrite them or copy shortened text into any operation. When the user wants to change exactly such a text, return empty operations and say in summary that the canvas is too large for that text to be read here: they can edit it in the node themselves, or name that node in the request if they have not.'
    : '画布内容较多，部分长文字这次只显示了开头，以「…〔另有 N 字未显示，保持原样〕」结尾：画布上的原文保持不变。不要改写这些文字，也不要把截短的文字写进任何操作。用户要改的正是被截短的内容时，返回空operations，并在summary里说明画布太大、这段文字这次读不全：可以直接在节点里修改，还没写明节点名称的话也可以写明后再发一次。';
  return [
    planningProtocol(saas, offeredMedia, Boolean(models)),
    guidance[0], guidance[1] + mediaGuidance, ...(saas ? [] : [orchestrationGuidance(locale, Boolean(models))]), ...guidance.slice(2, 4),
    `${guidance[4]}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(templates)}`,
    ...(models ? [`${modelHeading}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(models.map(({ id, name, efforts, paid }) => ({ id, name,
      ...(efforts?.length ? { efforts } : {}), ...(paid ? { paid: true } : {}) })))}`] : []),
    ...(newNodeLine ? [newNodeLine] : []),
    ...(shortened ? [shortenedNote] : []),
    `${guidance[5]}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(graph)}`,
    `${guidance[6]}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(turns)}`,
  ].join('\n\n');
}

/** The nodes a request is about, whose texts a shortened view keeps whole the longest: those selected, those named in
 *  the request (by title or id), and those whose last run failed or was blocked. */
export function planningFocus(doc: CanvasDocument, request: string, extras: PlanningExtras = {}, selected: ReadonlyArray<string> = []): Set<string> {
  const asked = request.toLowerCase();
  const focus = new Set(selected);
  for (const node of doc.nodes) {
    const title = node.title.trim().toLowerCase();
    const state = extras.runs?.[node.id]?.state;
    if ((Array.from(title).length >= 2 && asked.includes(title)) || request.includes(node.id) || state === 'failed' || state === 'blocked') focus.add(node.id);
  }
  return focus;
}

/** How each shortened view of the canvas cuts it, from the least to the most: the conversation first, then the long texts
 *  of the nodes the request is not about, those of the nodes it is about last. */
const FIT_LEVELS: ReadonlyArray<{ cap?: number; focusCap?: number; turns: number; turnCap?: number }> = [
  { turns: 10, turnCap: 1200 },
  { cap: 2000, turns: 10, turnCap: 1200 },
  { cap: 800, turns: 8, turnCap: 600 },
  { cap: 300, turns: 6, turnCap: 400 },
  { cap: 100, turns: 4, turnCap: 300 },
  { cap: 0, turns: 4, turnCap: 200 },
  { cap: 0, focusCap: 1200, turns: 2, turnCap: 200 },
  { cap: 0, focusCap: 300, turns: 2, turnCap: 120 },
  { cap: 0, focusCap: 0, turns: 0 },
];

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A view of the canvas for the planner: its context, the fields it showed only in part, and whether it cut any text at
 *  all (the conversation's included), which is what makes a plan made from it one made from a shortened view. */
export interface FittedPlanningContext { context: string; condensed: PlanContextCondensed; shortened: boolean }

/** The fullest view of the canvas whose context takes at most `room` UTF-8 bytes and `units` UTF-16 code units (a
 *  hosted plan's own bounds); null when even the shortest does not fit. Every node, field and connection is still there,
 *  only long texts are cut. */
export function fitPlanningContext(doc: CanvasDocument, messages: PlanningMessage[], locale: UiLocale, mediaKinds: ReadonlyArray<MediaKind>,
  extras: PlanningExtras, room: number, focus: ReadonlySet<string> = new Set(), units = Infinity): FittedPlanningContext | null {
  for (const level of FIT_LEVELS) {
    const view: PlanningView = { cap: id => (focus.has(id) ? level.focusCap : level.cap), turns: level.turns, turnCap: level.turnCap, condensed: new Map() };
    const context = planningContext(doc, messages, locale, mediaKinds, extras, view);
    if (context.length <= units && utf8Bytes(context) <= room) return { context, condensed: view.condensed!, shortened: view.shortened ?? false };
  }
  return null;
}

/** A node's last run as the planner reads it: the state, and the reason a failure or a block showed, kept short. */
function runView(run: PlanRunState | undefined): { run?: PlanRunState } {
  if (!run?.state) return {};
  const detail = run.detail?.trim();
  return { run: { state: run.state, ...(detail && (run.state === 'failed' || run.state === 'blocked') ? { detail: Array.from(detail).slice(0, 300).join('') } : {}) } };
}

/** A planner failure that kept the server's code, so the caller can tell a malformed plan or a run a provider fault
 * cut short — worth one more attempt — from a run out of room, a quota rejection or a cancellation, which are not. */
class PlanFailure extends Error {
  /** `contextRoom`: on a plan refused as too large, the bytes of canvas context the same request may carry.
   *  `recovered`: the outcome of a run the host attached to rather than started (the same request already in flight). */
  constructor(message: string, readonly code: string, readonly contextRoom?: number, readonly recovered = false) {
    super(message);
    this.name = 'PlanFailure';
  }
}

/** A plan the model produced but that does not hold up: the structure went wrong, nothing was
 * applied, and the same request often succeeds. A run a provider fault cut short is retried too (providerFault);
 * nothing else is. */
function malformedPlan(error: unknown): boolean {
  return error instanceof PlanFailure && error.code === 'invalid_canvas_plan';
}

/** The codes of a plan run that may have been cut short by its model service: its call failed for a reason the host
 * cannot name (runtime_failed), the service could not be reached (provider_unavailable), or the worker's stream ended
 * without an answer (runtime_stream_ended). Pi, which runs every hosted plan, reports every model failure but a size
 * refusal as MODEL_ERROR (runner.mjs), which is runtime_failed: a stream the service broke off, but also a throttle, a
 * content filter or a refused credential. So one is asked for again only from a run that had been answering
 * (PROVIDER_RETRY_AFTER_MS, PROVIDER_RETRY_BEFORE_MS). A run whose model wrote its whole output budget is output_limit
 * where its worker reported its usage (runs.go plannerSpentOutput), which is not asked for again. */
const PROVIDER_FAULTS: ReadonlySet<string> = new Set(['runtime_failed', 'provider_unavailable', 'runtime_stream_ended']);
function providerFault(error: unknown): boolean {
  return error instanceof PlanFailure && PROVIDER_FAULTS.has(error.code);
}
/** A provider fault is asked for again only from a run that had been answering when it failed: one that had written some
 * of its answer (plan text or reasoning) or had run PROVIDER_RETRY_AFTER_MS since it began. A refusal of the request
 * itself comes within seconds and with nothing written: a throttle or an outage there the worker has already asked of
 * the model's other route once (bedrock-bridge.ts, on Bedrock), and a refused credential or request would only be
 * refused again. A worker's stream that ended without an answer (runtime_stream_ended: a worker that stopped, as at a
 * deploy) is never a refusal of the request, so it needs only the other bound: a run that failed before
 * PROVIDER_RETRY_BEFORE_MS, since asking again past it would double a long wait, most often for a model that wrote its
 * whole budget, whose usage was not reported (about 432 s on qwen3.8-27b-p6). The figures (read only, 2026-10-23):
 *   - in the 14 days to that day, the plans of the planner model, Claude Haiku 4.5, completed in a median 18 s and at
 *     most 192 s, and its 29 that failed runtime_failed did so within 51 s;
 *   - of the 34 planner runs that failed runtime_failed from 2026-10-16 13:30Z to 2026-10-23 05:52Z, the 22 the model
 *     service refused outright and the 6 that ran out of room (each about 432 s) fall outside these bounds, and of the
 *     6 whose stream it broke off, five fall within them. */
const PROVIDER_RETRY_AFTER_MS = 10_000;
const PROVIDER_RETRY_BEFORE_MS = 180_000;

/** Read a progress-reporting planner stream. The host that produced the stream owns the run
 * lifecycle (including stall detection and cancellation); this only projects frames to the UI
 * and returns the single proposal frame. An ended stream without a proposal is a failure, never
 * an empty plan — the canvas must not change on a lost connection. */
async function readPlanStream(body: ReadableStream<Uint8Array>, locale: UiLocale,
  observed: { last: PlanProgress }, onProgress?: PlanProgressReporter): Promise<{ plan: unknown; condensed?: unknown; newNodeModel?: string; recovered?: boolean }> {
  let proposal: { plan: unknown; condensed?: unknown; newNodeModel?: string; recovered?: boolean } | null = null;
  let failure = '';
  let failureCode = '';
  let recovered = false;
  await readSseFrames(body, (_event, frame: any) => {
    if (proposal || failure) return;
    if (frame?.type === 'progress') {
      observed.last = observedProgress(frame, observed.last);
      onProgress?.(observed.last);
    } else if (frame?.type === 'plan') proposal = { plan: frame.plan, ...(Object.hasOwn(frame, 'condensed') ? { condensed: frame.condensed } : {}),
      ...(typeof frame.newNodeModel === 'string' && frame.newNodeModel ? { newNodeModel: frame.newNodeModel } : {}),
      ...(frame.recovered === true ? { recovered: true } : {}) };
    else if (frame?.type === 'error') {
      failure = typeof frame.error === 'string' && frame.error.trim() ? frame.error : canvasText(locale, 'planning.unavailable');
      failureCode = typeof frame.code === 'string' ? frame.code : '';
      recovered = frame.recovered === true;
    }
  });
  if (failure) throw new PlanFailure(failure, failureCode, undefined, recovered);
  if (!proposal) throw new Error(canvasText(locale, 'planning.interrupted'));
  return proposal;
}

/** A view of the canvas a plan is asked from (fitPlanningContext), or the whole context alone. */
type PlanView = Partial<FittedPlanningContext> & { context: string };

/** One planning attempt with this view of the canvas: its own run on the host, its own progress stream. A rejected
 * plan is reported as a PlanFailure carrying the reason so the caller can decide about another attempt. A hosted plan
 * also says what the request its run was made from showed (`condensed`): the fields it showed only in part, or null for
 * the whole canvas. The hosted app keeps that beside the request (plannerRecovery.ts), the one a resumed or another
 * tab's plan was made from too; undefined where the host does not say (the desktop gateway). */
async function planOnce(prompt: string, view: PlanView, doc: CanvasDocument, signal: AbortSignal,
  locale: UiLocale, saas: boolean, observed: { last: PlanProgress }, onProgress?: PlanProgressReporter,
  options?: PlanRequestOptions): Promise<{ plan: CanvasPlan; condensed?: PlanContextCondensed | null; newNodeModel?: string }> {
  const response = await canvasFetch(`${gatewayApiBase()}/canvas/plan`, {
    method: 'POST', credentials: 'include', signal,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
    body: JSON.stringify({ prompt, context: view.context, ...(saas ? { revision: canvasPlanRevision(doc),
      ...(options?.recoveryOperationId !== undefined ? { recoveryOperationId: options.recoveryOperationId } : {}),
      ...(view.shortened ? { condensed: condensedToJSON(view.condensed ?? new Map()) } : {}) } : {}) }),
  });
  // A progress stream carries its own terminal frames, so its transport status is already 200.
  // Probed defensively: a non-streaming planner (and a minimal test double) may expose neither
  // headers nor a body, and must keep taking the plain JSON path rather than throwing here.
  const contentType = typeof response.headers?.get === 'function' ? response.headers.get('content-type') : null;
  const streaming = response.ok && Boolean(response.body) && (contentType || '').includes('text/event-stream');
  let raw: unknown;
  let condensed: PlanContextCondensed | null | undefined;
  let newNodeModel: string | undefined;
  // A plan of a run the host attached to rather than started: if it does not hold up here, it is not asked for again.
  let recovered = false;
  if (streaming) {
    const proposal = await readPlanStream(response.body!, locale, observed, onProgress);
    raw = proposal.plan;
    newNodeModel = proposal.newNodeModel;
    recovered = proposal.recovered === true;
    // A set that cannot be read could let the plan write over what its view showed only in part: no plan is applied.
    if (Object.hasOwn(proposal, 'condensed')) {
      condensed = proposal.condensed === null ? null : condensedFromJSON(proposal.condensed);
      if (condensed === undefined) throw new Error(canvasText(locale, 'planning.invalidResponse'));
    }
  } else {
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new PlanFailure(typeof payload?.error === 'string' ? payload.error : canvasText(locale, 'planning.unavailable'), typeof payload?.code === 'string' ? payload.code : '',
      Number.isSafeInteger(payload?.contextRoom) && payload.contextRoom >= 0 ? payload.contextRoom : undefined);
    if (!payload || !Object.hasOwn(payload, 'plan')) throw new Error(canvasText(locale, 'planning.invalidResponse'));
    raw = payload.plan;
  }
  // Keep the measured counts; only the stage advances. Zeroing them would misreport the work done.
  onProgress?.({ ...observed.last, stage: 'validating' });
  // A plan that does not conform to the protocol failed for the same reason the server's own check
  // does — the model's structure came out wrong — so it is reported as the same retryable kind.
  let plan: CanvasPlan;
  try {
    plan = parseCanvasPlan(raw);
  } catch (error) {
    throw new PlanFailure(error instanceof Error && error.message ? error.message : canvasText(locale, 'planning.invalidResponse'), 'invalid_canvas_plan',
      undefined, recovered);
  }
  // A capability violation is deliberately NOT retryable. The plan is well formed; the model chose an
  // operation this workspace does not support, which the prompt already rules out, so it is a decision
  // rather than a slip and asking again would spend another run to be told the same thing.
  if (saas) plan = saasPlan(plan, locale);
  return { plan, ...(condensed !== undefined ? { condensed } : {}), ...(newNodeModel ? { newNodeModel } : {}) };
}

export type CanvasPlanRecovery = { pending: boolean; operationId?: string; prompt?: string; matches?: boolean };
/** `revision`: the document's canvasPlanRevision where the caller already has it (it hashes the whole canvas). */
export async function readCanvasPlanRecovery(doc: CanvasDocument, signal?: AbortSignal, revision?: string): Promise<CanvasPlanRecovery> {
  if (!currentSaaSCanvas()) return { pending: false };
  const response = await canvasFetch(`${gatewayApiBase()}/canvas/plan/recovery?revision=${encodeURIComponent(revision ?? canvasPlanRevision(doc))}`, { signal });
  const payload = await response.json();
  if (!response.ok) throw new PlanFailure(payload.error, payload.code);
  if (payload?.pending === true && (typeof payload.operationId !== 'string' || !payload.operationId)) throw new PlanFailure('Planning recovery identity is unavailable.', 'planning_recovery_required');
  return payload as CanvasPlanRecovery;
}
export async function cancelCanvasPlanRecovery(operationId: string, signal?: AbortSignal): Promise<void> {
  const response = await canvasFetch(`${gatewayApiBase()}/canvas/plan/recovery/cancel`, { method: 'POST', signal, body: JSON.stringify({ operationId }) });
  const payload = await response.json();
  if (!response.ok) throw new PlanFailure(payload.error, payload.code);
}

/** `mediaKinds`: the media nodes the workspace can generate, which the planner may then add. `selected`: the nodes the
 *  reader selected, whose texts a shortened view of the canvas keeps whole the longest (planningFocus). */
export type PlanRequestOptions = { recoveryOperationId?: string; mediaKinds?: ReadonlyArray<MediaKind>; selected?: ReadonlyArray<string> } & PlanningExtras;
// A hosted plan's own bounds (planning.go maxPlanContextUnits, maxRunPromptUnits and planContextRoomMargin), in UTF-16
// code units as its workers' transport counts them, one a Chinese character: a larger context is never sent whole there,
// and no view of it is sent larger. The desktop gateway takes its own (apps/gateway/src/canvas/routes.ts).
const MAX_PLAN_CONTEXT_UNITS = 120_000;
const MAX_PLAN_PROMPT_UNITS = 128_000;
const PLAN_REQUEST_JOIN_UNITS = '\n\nUser request:\n'.length;
const PLAN_CONTEXT_MARGIN = 256;
/** Shorter views a plan refused as too large may be asked again with, each shorter: a shorter request can also move to
 *  the operator's planner model (planner_model.go), with a budget of its own. */
const PLAN_SHRINKS = 3;
export async function requestCanvasPlan(prompt: string, doc: CanvasDocument, messages: PlanningMessage[], signal: AbortSignal,
  locale: UiLocale = 'zh', onProgress?: PlanProgressReporter, options?: PlanRequestOptions): Promise<CanvasPlan> {
  const scope = currentSaaSCanvas();
  const saas = scope !== null;
  const observed = { last: { stage: 'queued', characters: 0, nodes: 0, edges: 0, reasoning: 0, attempt: 1 } as PlanProgress };
  const extras: PlanningExtras = { models: options?.models, runs: options?.runs, newNodeModel: options?.newNodeModel };
  const units = saas ? Math.min(MAX_PLAN_CONTEXT_UNITS, MAX_PLAN_PROMPT_UNITS - PLAN_REQUEST_JOIN_UNITS - prompt.length) - PLAN_CONTEXT_MARGIN : Infinity;
  const fit = (room: number) => fitPlanningContext(doc, messages, locale, options?.mediaKinds ?? [], extras, room, planningFocus(doc, prompt, extras, options?.selected), units);
  // The canvas alone is too large, or the room the request, its files and the selected knowledge leave is too small.
  const contextFull = () => new PlanFailure(canvasText(locale, 'planning.contextFull'), 'context_limit');
  const contextCrowded = () => new PlanFailure(canvasText(locale, 'planning.contextCrowded'), 'context_limit');
  const whole = buildPlanningContext(doc, messages, locale, options?.mediaKinds, extras);
  const wholeFits = !saas || (whole.length <= MAX_PLAN_CONTEXT_UNITS && whole.length + PLAN_REQUEST_JOIN_UNITS + prompt.length <= MAX_PLAN_PROMPT_UNITS);
  // A recovery replays its run's own request, which the host keeps (plannerRecovery.ts): it is sent as it was.
  const first: PlanView | null = options?.recoveryOperationId !== undefined || wholeFits ? { context: whole } : fit(Infinity);
  if (!first) throw contextFull();
  let view: PlanView = first;
  let shrinks = 0;
  // Exactly one more attempt, and only for a malformed plan or a run a provider fault cut short while it was answering
  // (providerFault). A second retry would let a persistently broken model spend the workspace's run quota in a loop,
  // and retrying a run out of room, a quota rejection or a cancellation would spend it on something that cannot
  // succeed. Each attempt is its own run on the host, so what it costs stays visible rather than hidden inside one
  // operation.
  let diagnosis: unknown;
  for (let retried = false; ;) {
    // When this attempt's run began (its first report past the queue), for the bounds of a provider fault's retry.
    let began = 0;
    const report: PlanProgressReporter = progress => {
      if (!began && progress.stage !== 'queued' && progress.stage !== 'retrying') began = Date.now();
      onProgress?.(progress);
    };
    try {
      const { plan, condensed, newNodeModel } = await planOnce(prompt, view, doc, signal, locale, saas, observed, report, options);
      if (signal.aborted || currentSaaSCanvas() !== scope) throw new PlanFailure(canvasText(locale, 'planning.interrupted'), 'planning_scope_changed');
      // What the host kept with the request this plan's run was made from comes first, the whole canvas (null) too: a
      // resumed run's, or one another tab started, was made from that request rather than from the view built here.
      const shownInPart = condensed !== undefined ? condensed : view.shortened ? view.condensed : undefined;
      if (shownInPart) markPlanContextCondensed(plan, shownInPart);
      // So does the model its nodes were sized for, which the host's frame reads from that request (canvasBridge.ts): a
      // resume's named the one chosen then. A frame that names none (a request stored before requests named one, a host
      // without frames) leaves the plan unmarked.
      if (newNodeModel) markPlanNewNodeModel(plan, newNodeModel);
      return plan;
    } catch (error) {
      // A late old-workspace failure must never turn the malformed-plan retry into an admission
      // under whichever tenant happens to be active now.
      if (currentSaaSCanvas() !== scope) throw new PlanFailure(error instanceof Error ? error.message : canvasText(locale, 'planning.interrupted'), 'planning_scope_changed');
      if (error instanceof PlanFailure && ['planning_recovery_required', 'planning_recovery_storage', 'unauthorized'].includes(error.code)) throw error;
      // A plan too large for its model was refused before any run, with how much canvas context the same request may
      // carry: it goes again with a shorter view of the same canvas, which costs nothing (PLAN_SHRINKS times, each shorter).
      if (error instanceof PlanFailure && error.code === 'context_limit' && error.contextRoom !== undefined && !signal.aborted
        && options?.recoveryOperationId === undefined) {
        const next = shrinks < PLAN_SHRINKS && error.contextRoom < utf8Bytes(view.context) ? fit(error.contextRoom) : null;
        if (!next) throw contextCrowded();
        view = next;
        shrinks++;
        continue;
      }
      // The first failure describes what the model actually produced. The retry is our own
      // mitigation, so if it fails too its reason must not replace that diagnosis — reporting
      // "no plan was returned" for what was really an unsupported operation tells the reader
      // nothing they can act on. A provider fault says nothing of what the model produced, though: where one came
      // first, the second attempt's failure is said when it names its own cause (a plan out of room, a malformed plan).
      if (retried) throw providerFault(diagnosis) && error instanceof PlanFailure && error.code && !providerFault(error) ? error : diagnosis;
      // A run the host attached to rather than started (the same request already in flight, plannerRecovery.ts) is not
      // asked for again, as an explicit recovery is not.
      const attached = error instanceof PlanFailure && error.recovered;
      const ran = began ? Date.now() - began : 0;
      const ended = error instanceof PlanFailure && error.code === 'runtime_stream_ended';
      const provider = providerFault(error) && ran < PROVIDER_RETRY_BEFORE_MS
        && (ended || observed.last.characters > 0 || observed.last.reasoning > 0 || ran >= PROVIDER_RETRY_AFTER_MS);
      if (signal.aborted || options?.recoveryOperationId !== undefined || attached || !(malformedPlan(error) || provider)) throw error;
      diagnosis = error;
      retried = true;
      // The next attempt starts from nothing, so the counts restart with it; keeping the previous
      // ones would report work that no longer exists. The attempt number stays on every report
      // that follows, so the reader knows this is the second run rather than a restart; the report
      // that starts it says why it runs.
      observed.last = { stage: 'retrying', characters: 0, nodes: 0, edges: 0, reasoning: 0, attempt: 2, ...(provider ? { retry: 'provider' as const } : {}) };
      onProgress?.(observed.last);
    }
  }
}

export async function readPlannerStatus(signal?: AbortSignal, locale: UiLocale = 'zh'): Promise<{ available: boolean; provider: string; error?: string }> {
  try {
    const response = await canvasFetch(`${gatewayApiBase()}/canvas/planner`, { credentials: 'include', signal });
    const value = await response.json();
    if (!response.ok) throw new Error('unavailable');
    return { available: value.available === true, provider: typeof value.provider === 'string' ? value.provider : '',
      error: typeof value.error === 'string' ? value.error : undefined };
  } catch { return { available: false, provider: '', error: canvasText(locale, 'planning.disconnected') }; }
}
