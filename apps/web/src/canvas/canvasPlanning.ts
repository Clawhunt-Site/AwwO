import { canvasStorage, workspaceStorage } from './canvasStorage';
import { canvasFetch, currentSaaSCanvas } from '../saas/canvasBridge';
import { gatewayApiBase } from '../chatAutomations';
import { getAgentTemplateForNode, getAgentTemplates } from './agentTemplates';
import { figureRole } from './figureKit/figureKit';
import type { CanvasDocument } from './canvasDoc';
import { CANVAS_PLAN_NODE_OPERATION_TYPES, CANVAS_PLAN_OPERATION_TYPES, CANVAS_PLAN_PROTOCOL, DEFAULT_MODEL_REFERENCE, HOSTED_PAGE_TEMPLATE_ID, MEDIA_PLAN_TEMPLATE_IDS, PLAN_TEMPLATE_IDS,
  canvasPlanRevision, hostedPageOutputs, parseCanvasPlan, sharedRequirements, withMediaNodes, type CanvasPlan, type CanvasPlanOperationType } from './canvasPlan';
import { isTaskFrame } from './taskFrame';
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
   *  validating = the plan arrived and is being checked; retrying = a malformed plan is being retried. */
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
  /** 1 for the first attempt, 2 for the single retry of a malformed plan. */
  attempt: number;
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
/** What a host can add to the planner's view: the models nodes can run, and each node's last run. */
export interface PlanningExtras { models?: ReadonlyArray<PlanModel>; runs?: Readonly<Record<string, PlanRunState | undefined>> }

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
 *  the protocol leaves it out; it is dropped rather than the whole plan refused. Review loops are not supported. */
function saasPlan(plan: CanvasPlan, locale: UiLocale): CanvasPlan {
  if (plan.operations.some(operation => operation.type === 'set_execution' || operation.type === 'set_edge_kind'
    || (operation.type === 'connect' && operation.kind !== undefined && operation.kind !== 'data'))) {
    throw new Error(canvasText(locale, 'planning.unsupportedSaaS'));
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
  const saas = currentSaaSCanvas() !== null;
  const offeredMedia = saas ? MEDIA_PLAN_TEMPLATE_IDS.filter(kind => mediaKinds.includes(kind)) : [];
  const models = extras.models?.length ? extras.models : undefined;
  // A request copied to several nodes is shown once and named; the plan keeps it by that name (sharedRequirements).
  const requirements = sharedRequirements(doc);
  const refOf = new Map([...requirements].map(([ref, text]) => [text, ref]));
  const graph = {
    ...(requirements.size ? { requirements: Object.fromEntries(requirements) } : {}),
    nodes: doc.nodes.map(node => {
      if (node.kind === 'form') return { id: node.id, kind: node.kind, title: node.title, fields: node.fields };
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
      if (media) return { id: node.id, templateId: media, title: node.title, prompt: activeNodeThread(node).draft, ...runView(extras.runs?.[node.id]) };
      const template = getAgentTemplateForNode(node, locale);
      // A figure node's persona carries the kit guide after its role; the planner only reads (and writes) the role.
      const roleOf = (persona: string | undefined) => (template?.id === 'figure' && persona !== undefined ? figureRole(persona) : persona);
      const persona = roleOf(node.persona);
      const frame = isTaskFrame(node.taskFrame) ? node.taskFrame : undefined;
      return { id: node.id, templateId: template?.id, title: node.title,
        // Templates already declare responsibilities below. Preserve only user-authored differences.
        ...(persona !== roleOf(template?.persona) ? { persona } : {}),
        ...(frame?.constraints.length ? { constraints: frame.constraints.map(item => refOf.get(item) ?? item) } : {}),
        ...(frame?.acceptanceCriteria.length ? { acceptanceCriteria: frame.acceptanceCriteria } : {}),
        // The planner sees a node's model only where it can change one; an unset node runs the workspace default.
        ...(models ? { model: node.model || DEFAULT_MODEL_REFERENCE } : {}),
        ...(node.team ? { team: true } : {}),
        inputs: node.contract?.inputs.map(({ id, label, type, required, value }) => ({ id, label, type, required, value })),
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
  return [
    planningProtocol(saas, offeredMedia, Boolean(models)),
    guidance[0], guidance[1] + mediaGuidance, ...(saas ? [] : [orchestrationGuidance(locale, Boolean(models))]), ...guidance.slice(2, 4),
    `${guidance[4]}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(templates)}`,
    ...(models ? [`${modelHeading}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(models.map(({ id, name, efforts, paid }) => ({ id, name,
      ...(efforts?.length ? { efforts } : {}), ...(paid ? { paid: true } : {}) })))}`] : []),
    `${guidance[5]}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(graph)}`,
    `${guidance[6]}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(messages.slice(-10).map(({ role, content, status }) => ({ role, content, status })))}`,
  ].join('\n\n');
}

/** A node's last run as the planner reads it: the state, and the reason a failure or a block showed, kept short. */
function runView(run: PlanRunState | undefined): { run?: PlanRunState } {
  if (!run?.state) return {};
  const detail = run.detail?.trim();
  return { run: { state: run.state, ...(detail && (run.state === 'failed' || run.state === 'blocked') ? { detail: Array.from(detail).slice(0, 300).join('') } : {}) } };
}

/** A planner failure that kept the server's code, so the caller can tell a malformed plan — worth
 * one more attempt — from a runtime fault, a quota rejection or a cancellation, which are not. */
class PlanFailure extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PlanFailure';
  }
}

/** A plan the model produced but that does not hold up: the structure went wrong, nothing was
 * applied, and the same request often succeeds. Nothing else is retried. */
function malformedPlan(error: unknown): boolean {
  return error instanceof PlanFailure && error.code === 'invalid_canvas_plan';
}

/** Read a progress-reporting planner stream. The host that produced the stream owns the run
 * lifecycle (including stall detection and cancellation); this only projects frames to the UI
 * and returns the single proposal frame. An ended stream without a proposal is a failure, never
 * an empty plan — the canvas must not change on a lost connection. */
async function readPlanStream(body: ReadableStream<Uint8Array>, locale: UiLocale,
  observed: { last: PlanProgress }, onProgress?: PlanProgressReporter): Promise<unknown> {
  let proposal: { plan: unknown } | null = null;
  let failure = '';
  let failureCode = '';
  await readSseFrames(body, (_event, frame: any) => {
    if (proposal || failure) return;
    if (frame?.type === 'progress') {
      observed.last = observedProgress(frame, observed.last);
      onProgress?.(observed.last);
    } else if (frame?.type === 'plan') proposal = { plan: frame.plan };
    else if (frame?.type === 'error') {
      failure = typeof frame.error === 'string' && frame.error.trim() ? frame.error : canvasText(locale, 'planning.unavailable');
      failureCode = typeof frame.code === 'string' ? frame.code : '';
    }
  });
  if (failure) throw new PlanFailure(failure, failureCode);
  if (!proposal) throw new Error(canvasText(locale, 'planning.interrupted'));
  return (proposal as { plan: unknown }).plan;
}

/** One planning attempt: its own run on the host, its own progress stream. A rejected plan is
 * reported as a PlanFailure carrying the reason so the caller can decide about another attempt. */
async function planOnce(prompt: string, doc: CanvasDocument, messages: PlanningMessage[], signal: AbortSignal,
  locale: UiLocale, saas: boolean, observed: { last: PlanProgress }, onProgress?: PlanProgressReporter, options?: PlanRequestOptions): Promise<CanvasPlan> {
  const response = await canvasFetch(`${gatewayApiBase()}/canvas/plan`, {
    method: 'POST', credentials: 'include', signal,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
    body: JSON.stringify({ prompt, context: buildPlanningContext(doc, messages, locale, options?.mediaKinds, { models: options?.models, runs: options?.runs }), ...(saas ? { revision: canvasPlanRevision(doc),
      ...(options?.recoveryOperationId !== undefined ? { recoveryOperationId: options.recoveryOperationId } : {}) } : {}) }),
  });
  // A progress stream carries its own terminal frames, so its transport status is already 200.
  // Probed defensively: a non-streaming planner (and a minimal test double) may expose neither
  // headers nor a body, and must keep taking the plain JSON path rather than throwing here.
  const contentType = typeof response.headers?.get === 'function' ? response.headers.get('content-type') : null;
  const streaming = response.ok && Boolean(response.body) && (contentType || '').includes('text/event-stream');
  let raw: unknown;
  if (streaming) {
    raw = await readPlanStream(response.body!, locale, observed, onProgress);
  } else {
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new PlanFailure(typeof payload?.error === 'string' ? payload.error : canvasText(locale, 'planning.unavailable'), typeof payload?.code === 'string' ? payload.code : '');
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
    throw new PlanFailure(error instanceof Error && error.message ? error.message : canvasText(locale, 'planning.invalidResponse'), 'invalid_canvas_plan');
  }
  // A capability violation is deliberately NOT retryable. The plan is well formed; the model chose an
  // operation this workspace does not support, which the prompt already rules out, so it is a decision
  // rather than a slip and asking again would spend another run to be told the same thing.
  if (saas) plan = saasPlan(plan, locale);
  return plan;
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

/** `mediaKinds`: the media nodes the workspace can generate, which the planner may then add. */
export type PlanRequestOptions = { recoveryOperationId?: string; mediaKinds?: ReadonlyArray<MediaKind> } & PlanningExtras;
export async function requestCanvasPlan(prompt: string, doc: CanvasDocument, messages: PlanningMessage[], signal: AbortSignal,
  locale: UiLocale = 'zh', onProgress?: PlanProgressReporter, options?: PlanRequestOptions): Promise<CanvasPlan> {
  const scope = currentSaaSCanvas();
  const saas = scope !== null;
  const observed = { last: { stage: 'queued', characters: 0, nodes: 0, edges: 0, reasoning: 0, attempt: 1 } as PlanProgress };
  // Exactly one more attempt, and only for a malformed plan. A second retry would let a persistently
  // broken model spend the workspace's run quota in a loop, and retrying a runtime fault, a quota
  // rejection or a cancellation would spend it on something that cannot succeed. Each attempt is its
  // own run on the host, so what it costs stays visible rather than hidden inside one operation.
  let diagnosis: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      const plan = await planOnce(prompt, doc, messages, signal, locale, saas, observed, onProgress, options);
      if (signal.aborted || currentSaaSCanvas() !== scope) throw new PlanFailure(canvasText(locale, 'planning.interrupted'), 'planning_scope_changed');
      return plan;
    } catch (error) {
      // A late old-workspace failure must never turn the malformed-plan retry into an admission
      // under whichever tenant happens to be active now.
      if (currentSaaSCanvas() !== scope) throw new PlanFailure(error instanceof Error ? error.message : canvasText(locale, 'planning.interrupted'), 'planning_scope_changed');
      if (error instanceof PlanFailure && ['planning_recovery_required', 'planning_recovery_storage', 'unauthorized'].includes(error.code)) throw error;
      // The first failure describes what the model actually produced. The retry is our own
      // mitigation, so if it fails too its reason must not replace that diagnosis — reporting
      // "no plan was returned" for what was really an unsupported operation tells the reader
      // nothing they can act on.
      if (attempt > 0) throw diagnosis;
      if (signal.aborted || options?.recoveryOperationId !== undefined || !malformedPlan(error)) throw error;
      diagnosis = error;
      // The next attempt starts from nothing, so the counts restart with it; keeping the previous
      // ones would report work that no longer exists. The attempt number stays on every report
      // that follows, so the reader knows this is the second run rather than a restart.
      observed.last = { stage: 'retrying', characters: 0, nodes: 0, edges: 0, reasoning: 0, attempt: 2 };
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
