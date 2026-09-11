import { canvasStorage } from './canvasStorage';
import { canvasFetch, currentSaaSCanvas } from '../saas/canvasBridge';
import { gatewayApiBase } from '../chatAutomations';
import { getAgentTemplateForNode, getAgentTemplates } from './agentTemplates';
import type { CanvasDocument } from './canvasDoc';
import { CANVAS_PLAN_PROTOCOL, parseCanvasPlan, type CanvasPlan } from './canvasPlan';
import type { UiLocale } from '../locale';
import { canvasText } from './i18n';
import { readSseFrames } from '../sse';

export interface PlanningMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'applied' | 'error' | 'stale';
}
export interface PlanningConversation { draft: string; messages: PlanningMessage[] }
export const PLANNING_STORAGE_KEY = 'awwo.canvas.planning.v1';

/** Observed planner progress. Every field is a real measurement, never an estimated percentage:
 * the runtime does not know the plan's final length, so a progress bar would be fabricated. */
export interface PlanProgress {
  /** queued = accepted, waiting for a runtime slot; running = runtime started, nothing emitted yet;
   *  streaming = the plan text is actually arriving; validating = stream ended, checking the proposal. */
  stage: 'queued' | 'running' | 'streaming' | 'validating';
  /** Characters of plan text received so far. */
  characters: number;
  /** Nodes the streamed proposal has declared so far (counted from completed add_node markers). */
  nodes: number;
}
export type PlanProgressReporter = (progress: PlanProgress) => void;


/** Keep the shared structural protocol, with only the Go host's supported operations/types. */
function planningProtocol(saas: boolean): string {
  if (!saas) return CANVAS_PLAN_PROTOCOL;
  return CANVAS_PLAN_PROTOCOL.split('\n').filter(line =>
    !/^(set_edge_kind:|set_execution:|互审Graph使用)/.test(line),
  ).map(line => line.startsWith('connect 使用')
    ? 'connect 使用字段ID（如schema、api，不加in:/out:前缀）；旧节点可使用其实际context/result/data端口ID。连线必须类型匹配，单输入只能连接一个来源，全图不得成环。'
    : line.replaceAll('|"html"', '').replace(',kind?:"data"|"feedback"', '').replace('/reviewerNodeId', '')).join('\n');
}

function assertSaaSPlan(plan: CanvasPlan, locale: UiLocale): void {
  if (plan.operations.some(operation => operation.type === 'set_execution' || operation.type === 'set_edge_kind'
    || (operation.type === 'connect' && operation.kind !== undefined)
    || (operation.type === 'add_field' && operation.field.type === 'html')
    || (operation.type === 'update_field' && operation.changes.type === 'html'))) {
    throw new Error(canvasText(locale, 'planning.unsupportedSaaS'));
  }
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
          && m.content.length <= 20_000 && (m.status === undefined || ['applied', 'error', 'stale'].includes(m.status));
      }).slice(-60) : [],
    };
  } catch { return { draft: '', messages: [] }; }
}

export function savePlanningConversation(value: PlanningConversation): void {
  try { canvasStorage().setItem(PLANNING_STORAGE_KEY, JSON.stringify({ draft: value.draft, messages: value.messages.slice(-60) })); }
  catch { /* The current conversation remains in memory if local persistence is unavailable. */ }
}

/** Supply the current structure, never execution credentials, transcripts or generated artifacts. */
export function buildPlanningContext(doc: CanvasDocument, messages: PlanningMessage[], locale: UiLocale = 'zh'): string {
  const saas = currentSaaSCanvas() !== null;
  const graph = {
    nodes: doc.nodes.map(node => {
      if (node.kind === 'form') return { id: node.id, kind: node.kind, title: node.title, fields: node.fields };
      const template = getAgentTemplateForNode(node, locale);
      return { id: node.id, templateId: template?.id, title: node.title,
        // Templates already declare responsibilities below. Preserve only user-authored differences.
        ...(node.persona !== template?.persona ? { persona: node.persona } : {}),
        inputs: node.contract?.inputs.map(({ id, label, type, required, value }) => ({ id, label, type, required, value })),
        outputs: node.contract?.outputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
      };
    }),
    edges: doc.edges.map(({ id, fromNode, fromPort, toNode, toPort, kind }) => ({ id, fromNode, fromPort, toNode, toPort, kind: kind ?? 'data' })),
    execution: doc.execution ? { mode: doc.execution.mode, maxRounds: doc.execution.maxRounds,
      reviewerNodeId: doc.execution.reviewerNodeId, verdictFieldId: doc.execution.verdictFieldId } : { mode: 'workflow' },
  };
  const templates = getAgentTemplates(locale).map(item => ({ id: item.id, title: item.title, responsibility: item.subtitle,
    inputs: item.inputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
    outputs: item.outputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
  }));
  const guidance = locale === 'en' ? [
    'You are the AwwO canvas architecture assistant. Arrange independent Agent nodes, input/output contracts, and real dependencies around the user goal. Produce a structural plan, not execution results.',
    'Software products commonly need data, backend, identity, frontend, and review responsibilities; select only what the request needs. Put core business requirements in the root node input and pass downstream inputs through exact field connections. '
      + (saas ? 'This SaaS host supports one-pass workflows and text, markdown, number, boolean or file fields. Do not create review policies, feedback connections or HTML fields. '
        : 'For iterative challenges and verification, add explicit feedback edges and a bounded review policy with a boolean verdict output; first-round feedback inputs should be optional or have an explicit seed. Use html or markdown output types when those document formats are requested. ')
      + 'Mark unknown information for confirmation. Never invent completed files, accounts, or APIs.',
    'The current canvas is the source of truth and may contain manual edits or undo results. Nodes without persona use their template responsibility. On a non-empty canvas, make the smallest relevant change and retain unrelated nodes and existing content. Delete only when the user asks. Reference existing nodes by ID, never by a guessed name. A new-node ref exists only within this operation list.',
    'Return protocol JSON only. Write summary in concise English and include any necessary open question. Do not call tools or execute the project. When information is insufficient, return empty operations and ask one concrete question in summary.',
    'Component templates', 'Current canvas', 'Conversation context (intent only; current canvas takes precedence)',
  ] : [
    '你是 AwwO 的画布架构助手。根据用户目标安排独立 Agent 节点、输入输出契约和真实依赖。生成的是结构方案，不是执行成果。',
    '软件产品通常包含数据、后端、用户身份、前端、验收等职责；根据需求选用，内容任务不必强行创建软件节点。核心业务需求应写入根节点输入；下游输入通过准确的字段连线接收。'
      + (saas ? '此SaaS工作区支持单次工作流，字段类型为text、markdown、number、boolean、file；不要创建互审策略、反馈连线或HTML字段。'
        : '需要反复质疑验证时，添加明确feedback连线、有限轮次互审策略与boolean判定输出；首轮反馈输入应可选或有明确初始值。用户指定文档格式时使用html或markdown输出类型。')
      + '对未知信息写明待确认，不虚构已完成的文件、账户或接口。',
    '当前画布是事实来源，可能已经被用户手工调整或撤销。未列persona的节点沿用模板职责。非空画布优先做最小增量修改，保留无关节点与已有内容；只有用户要求删除时才删除。使用已有节点ID引用，不按名称猜ID。新建节点ref仅供本次操作引用。',
    '只返回协议JSON。summary用简洁中文说明本次结构改动及必要的待确认事项。不要调用工具或执行项目。没有足够信息可返回空operations并在summary提出一个具体问题。',
    '组件模板', '当前画布', '对话上下文（仅作意图参考，以当前画布为准）',
  ];
  return [
    planningProtocol(saas),
    ...guidance.slice(0, 4),
    `${guidance[4]}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(templates)}`,
    `${guidance[5]}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(graph)}`,
    `${guidance[6]}${locale === 'zh' ? '：' : ':'}\n${JSON.stringify(messages.slice(-10).map(({ role, content, status }) => ({ role, content, status })))}`,
  ].join('\n\n');
}

/** Read a progress-reporting planner stream. The host that produced the stream owns the run
 * lifecycle (including stall detection and cancellation); this only projects frames to the UI
 * and returns the single proposal frame. An ended stream without a proposal is a failure, never
 * an empty plan — the canvas must not change on a lost connection. */
async function readPlanStream(body: ReadableStream<Uint8Array>, locale: UiLocale,
  observed: { last: PlanProgress }, onProgress?: PlanProgressReporter): Promise<unknown> {
  let proposal: { plan: unknown } | null = null;
  let failure = '';
  await readSseFrames(body, (_event, frame: any) => {
    if (proposal || failure) return;
    if (frame?.type === 'progress') {
      const count = (value: unknown, fallback: number) =>
        typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
      observed.last = {
        stage: frame.stage === 'queued' || frame.stage === 'running' || frame.stage === 'validating' ? frame.stage : 'streaming',
        characters: count(frame.characters, observed.last.characters),
        nodes: count(frame.nodes, observed.last.nodes),
      };
      onProgress?.(observed.last);
    } else if (frame?.type === 'plan') proposal = { plan: frame.plan };
    else if (frame?.type === 'error') failure = typeof frame.error === 'string' && frame.error.trim() ? frame.error : canvasText(locale, 'planning.unavailable');
  });
  if (failure) throw new Error(failure);
  if (!proposal) throw new Error(canvasText(locale, 'planning.interrupted'));
  return (proposal as { plan: unknown }).plan;
}

export async function requestCanvasPlan(prompt: string, doc: CanvasDocument, messages: PlanningMessage[], signal: AbortSignal,
  locale: UiLocale = 'zh', onProgress?: PlanProgressReporter): Promise<CanvasPlan> {
  const saas = currentSaaSCanvas() !== null;
  const response = await canvasFetch(`${gatewayApiBase()}/canvas/plan`, {
    method: 'POST', credentials: 'include', signal,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
    body: JSON.stringify({ prompt, context: buildPlanningContext(doc, messages, locale) }),
  });
  // A progress stream carries its own terminal frames, so its transport status is already 200.
  // Probed defensively: a non-streaming planner (and a minimal test double) may expose neither
  // headers nor a body, and must keep taking the plain JSON path rather than throwing here.
  const contentType = typeof response.headers?.get === 'function' ? response.headers.get('content-type') : null;
  const streaming = response.ok && Boolean(response.body) && (contentType || '').includes('text/event-stream');
  const observed = { last: { stage: 'queued', characters: 0, nodes: 0 } as PlanProgress };
  let raw: unknown;
  if (streaming) {
    raw = await readPlanStream(response.body!, locale, observed, onProgress);
  } else {
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : canvasText(locale, 'planning.unavailable'));
    if (!payload || !Object.hasOwn(payload, 'plan')) throw new Error(canvasText(locale, 'planning.invalidResponse'));
    raw = payload.plan;
  }
  // Keep the measured counts; only the stage advances. Zeroing them would misreport the work done.
  onProgress?.({ ...observed.last, stage: 'validating' });
  const plan = parseCanvasPlan(raw);
  if (saas) assertSaaSPlan(plan, locale);
  return plan;
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
