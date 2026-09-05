import { gatewayApiBase } from '../chatAutomations';
import { AGENT_TEMPLATES, getAgentTemplateForNode } from './agentTemplates';
import type { CanvasDocument } from './canvasDoc';
import { CANVAS_PLAN_PROTOCOL, parseCanvasPlan, type CanvasPlan } from './canvasPlan';

export interface PlanningMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'applied' | 'error' | 'stale';
}
export interface PlanningConversation { draft: string; messages: PlanningMessage[] }
export const PLANNING_STORAGE_KEY = 'awwo.canvas.planning.v1';

export function loadPlanningConversation(): PlanningConversation {
  try {
    const raw = JSON.parse(localStorage.getItem(PLANNING_STORAGE_KEY) || '{}');
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
  try { localStorage.setItem(PLANNING_STORAGE_KEY, JSON.stringify({ draft: value.draft, messages: value.messages.slice(-60) })); }
  catch { /* The current conversation remains in memory if local persistence is unavailable. */ }
}

/** Supply the current structure, never execution credentials, transcripts or generated artifacts. */
export function buildPlanningContext(doc: CanvasDocument, messages: PlanningMessage[]): string {
  const graph = {
    nodes: doc.nodes.map(node => node.kind === 'form' ? { id: node.id, kind: node.kind, title: node.title, fields: node.fields }
      : { id: node.id, templateId: getAgentTemplateForNode(node)?.id, title: node.title, persona: node.persona,
        inputs: node.contract?.inputs, outputs: node.contract?.outputs.map(({ value: _value, ...field }) => field) }),
    edges: doc.edges.map(({ id, fromNode, fromPort, toNode, toPort }) => ({ id, fromNode, fromPort, toNode, toPort })),
  };
  const templates = AGENT_TEMPLATES.map(item => ({ id: item.id, title: item.title, responsibility: item.subtitle,
    inputs: item.inputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
    outputs: item.outputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
  }));
  return [
    CANVAS_PLAN_PROTOCOL,
    '你是 AwwO 的画布架构助手。根据用户目标安排独立 Agent 节点、输入输出契约和真实依赖。生成的是结构方案，不是执行成果。',
    '软件产品通常包含数据、后端、用户身份、前端、验收等职责；根据需求选用，内容任务不必强行创建软件节点。核心业务需求应写入根节点输入；下游输入通过准确的字段连线接收。对未知信息写明待确认，不虚构已完成的文件、账户或接口。',
    '当前画布是事实来源，可能已经被用户手工调整或撤销。非空画布优先做最小增量修改，保留无关节点与已有内容；只有用户要求删除时才删除。使用已有节点ID引用，不按名称猜ID。新建节点ref仅供本次操作引用。',
    '只返回协议JSON。summary用简洁中文说明本次结构改动及必要的待确认事项。不要调用工具或执行项目。没有足够信息可返回空operations并在summary提出一个具体问题。',
    `组件模板：\n${JSON.stringify(templates)}`,
    `当前画布：\n${JSON.stringify(graph)}`,
    `对话上下文（仅作意图参考，以当前画布为准）：\n${JSON.stringify(messages.slice(-10).map(({ role, content, status }) => ({ role, content, status })))}`,
  ].join('\n\n');
}

export async function requestCanvasPlan(prompt: string, doc: CanvasDocument, messages: PlanningMessage[], signal: AbortSignal): Promise<CanvasPlan> {
  const response = await fetch(`${gatewayApiBase()}/canvas/plan`, {
    method: 'POST', credentials: 'include', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ prompt, context: buildPlanningContext(doc, messages) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : '画布规划服务暂时不可用，请检查本地服务连接。');
  if (!payload || !Object.hasOwn(payload, 'plan')) throw new Error('规划服务未返回有效方案，画布未修改。');
  return parseCanvasPlan(payload.plan);
}

export async function readPlannerStatus(signal?: AbortSignal): Promise<{ available: boolean; provider: string; error?: string }> {
  try {
    const response = await fetch(`${gatewayApiBase()}/canvas/planner`, { credentials: 'include', signal });
    const value = await response.json();
    if (!response.ok) throw new Error('unavailable');
    return { available: value.available === true, provider: typeof value.provider === 'string' ? value.provider : '',
      error: typeof value.error === 'string' ? value.error : undefined };
  } catch { return { available: false, provider: '', error: '画布规划服务未连接。启动本地规划服务后可重试。' }; }
}
