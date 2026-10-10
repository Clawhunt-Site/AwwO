import { AGENT_TEMPLATES, createAgentTemplate, type AgentTemplateId } from './agentTemplates';
import type { CanvasDocument, CanvasNode, SessionNode } from './canvasDoc';
import { invalidateOutputs } from './invalidateOutputs';
import { normalizeContract, validateContractFields, type ContractField, type ContractFieldType } from './nodeContracts';
import { arrangeNodePositions } from './nodePresentation';
import { canConnect, edgeId, portsFor, type PortSpec } from './ports';
import { findCycle } from './runGraph';
import type { UiLocale } from '../locale';
import { TASK_FRAME_MAX_ENTRY_LENGTH, TASK_FRAME_MAX_TOTAL_LENGTH } from './taskFrame';

export type CanvasPlanFieldChanges = Partial<Pick<ContractField, 'label' | 'type' | 'required' | 'help' | 'placeholder'>>;
export type CanvasPlanOperation =
  | { type: 'add_node'; ref: string; templateId: AgentTemplateId; title?: string; persona?: string; inputValues?: Record<string, string> }
  | { type: 'update_node'; nodeId: string; title?: string; persona?: string }
  | { type: 'set_input'; nodeId: string; fieldId: string; value: string }
  | { type: 'add_field'; nodeId: string; side: 'input' | 'output'; field: ContractField }
  | { type: 'update_field'; nodeId: string; side: 'input' | 'output'; fieldId: string; changes: CanvasPlanFieldChanges }
  | { type: 'remove_field'; nodeId: string; side: 'input' | 'output'; fieldId: string }
  | { type: 'remove_node'; nodeId: string }
  | { type: 'connect'; fromNode: string; fromField: string; toNode: string; toField: string; kind?: 'data' | 'feedback' }
  | { type: 'set_edge_kind'; edgeId: string; kind: 'data' | 'feedback' }
  | { type: 'set_execution'; mode: 'workflow' }
  | { type: 'set_execution'; mode: 'review'; maxRounds: number; reviewerNodeId: string; verdictFieldId: string }
  | { type: 'disconnect'; edgeId: string };

export type CanvasPlanOperationType = CanvasPlanOperation['type'];
const OPERATION_TYPES = ['add_node', 'update_node', 'set_input', 'add_field', 'update_field', 'remove_field', 'remove_node',
  'connect', 'set_edge_kind', 'set_execution', 'disconnect'] as const satisfies ReadonlyArray<CanvasPlanOperationType>;
// An operation type added to CanvasPlanOperation but not listed above fails to compile here.
const everyOperationListed: [Exclude<CanvasPlanOperationType, typeof OPERATION_TYPES[number]>] extends [never] ? true : never = true;
void everyOperationListed;
/** Every operation type a plan may contain: the closed set planning progress may name. */
export const CANVAS_PLAN_OPERATION_TYPES: ReadonlySet<string> = new Set(OPERATION_TYPES);
/** The operation types that concern one node, beside which progress may name that node's template. */
export const CANVAS_PLAN_NODE_OPERATION_TYPES: ReadonlySet<string> = new Set(['add_node', 'update_node', 'set_input', 'add_field',
  'update_field', 'remove_field', 'remove_node'] satisfies CanvasPlanOperationType[]);

export interface CanvasPlan { version: 1; summary: string; operations: CanvasPlanOperation[] }
/** `adjustments` says, in the request's language, what was applied differently from how the plan wrote it
 *  (a connection given its own input, a link a field change broke) or left out (a connection that would loop). */
export interface AppliedCanvasPlan { doc: CanvasDocument; addedNodeIds: string[]; summary: string; adjustments: string[] }

export const CANVAS_PLAN_PROTOCOL = `只返回一个 JSON 对象，不要执行任何操作：
{"version":1,"summary":"简短说明","operations":[...]}
允许的 operations（未知键会被拒绝）：
add_node: {type:"add_node",ref:string,templateId:"general"|"frontend"|"backend"|"data"|"users"|"materials"|"review",title?:string,persona?:string,inputValues?:{[已有输入字段ID]:string}}
update_node: {type:"update_node",nodeId:string,title?:string,persona?:string}
set_input: {type:"set_input",nodeId:string,fieldId:string,value:string}
add_field: {type:"add_field",nodeId:string,side:"input"|"output",field:{id:string,label:string,type:"text"|"markdown"|"html"|"number"|"boolean"|"file",required:boolean,value:"",help?:string,placeholder?:string}}
update_field: {type:"update_field",nodeId:string,side:"input"|"output",fieldId:string,changes:{label?:string,type?:上述字段类型,required?:boolean,help?:string,placeholder?:string}}
remove_field: {type:"remove_field",nodeId:string,side:"input"|"output",fieldId:string}
remove_node: {type:"remove_node",nodeId:string}
connect: {type:"connect",fromNode:string,fromField:string,toNode:string,toField:string,kind?:"data"|"feedback"}
set_edge_kind: {type:"set_edge_kind",edgeId:string,kind:"data"|"feedback"}
set_execution: {type:"set_execution",mode:"workflow"} 或 {type:"set_execution",mode:"review",maxRounds:1到5的整数,reviewerNodeId:string,verdictFieldId:string}
disconnect: {type:"disconnect",edgeId:string}
nodeId/fromNode/toNode/reviewerNodeId 必须为当前画布中提供的真实节点ID，或前面 add_node 的唯一 ref；不允许前向引用。ref 不得与既有ID重名。
connect 使用字段ID（如schema、api，不加in:/out:前缀）；旧节点可使用其实际context/result/data端口ID。连线必须类型匹配，单输入只能连接一个来源。kind默认data，本轮data连线不得成环。feedback将上一轮反馈传回上游，可构成跨轮闭环；workflow模式保留但不执行feedback。
互审Graph使用set_execution mode:review，maxRounds/reviewerNodeId/verdictFieldId必填；最终评审节点必须已存在且verdictFieldId指向其boolean输出，true通过、false继续。先创建节点和判定字段，再设置互审。工作流模式禁止携带互审额外字段。反馈环路和Agent绑定在用户启动时校验，此协议仅编辑结构，不启动运行。
新增节点完整使用对应角色模板。字段值都是字符串；布尔值用"true"/"false"，数字用数字字符串，file为引用字符串。add_field.value必须为空；输入内容通过set_input填写。严禁生成或填写任何输出值。
改变已连接字段类型或删除字段前须先disconnect。remove_node 明确删除该节点及其关联连线。
只能修改白名单：禁止binding/runtime/model/effort/threads/issueId/preview/lastOutput/templateId等执行状态修改；禁止命令执行、创建真实Agent、发消息、运行节点、文件写入、部署、付款等副作用。布局由应用安排新增节点，不能提交x/y/w/h。
最多100个操作、JSON最多120000字符、summary最多1000字符；ID/ref最多128字符，title/label最多200字符，persona最多8000字符，输入value最多16000字符，help/placeholder最多2000字符；每个节点每侧最多64字段。`;

const LIMITS = { raw: 120000, operations: 100, id: 128, title: 200, persona: 8000, value: 16000, help: 2000, fields: 64 } as const;
const FIELD_TYPES = ['text', 'markdown', 'html', 'number', 'boolean', 'file'];
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

function fail(message: string): never { throw new Error(`画布方案：${message}`); }
function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${location}必须是对象。`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${location}必须是普通 JSON 对象。`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], location: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key) || RESERVED.has(key)) fail(`${location}不允许字段「${key}」。`);
}
function text(value: unknown, location: string, max: number, empty = true): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(`${location}必须是${empty ? '' : '非空'}字符串，最多 ${max} 字符。`);
  return value;
}
function id(value: unknown, location: string): string {
  const result = text(value, location, LIMITS.id, false);
  if (result.trim() !== result || /[\s\u0000-\u001f]/.test(result) || RESERVED.has(result)) fail(`${location}不是有效 ID。`);
  return result;
}
function side(value: unknown, location: string): 'input' | 'output' {
  if (value !== 'input' && value !== 'output') fail(`${location}必须是 input 或 output。`);
  return value;
}
function edgeKind(value: unknown, location: string): 'data' | 'feedback' {
  if (value !== 'data' && value !== 'feedback') fail(`${location}必须是 data 或 feedback。`);
  return value;
}
function optionalText(raw: Record<string, unknown>, key: string, max: number, location: string, empty = true): Record<string, string> {
  return Object.hasOwn(raw, key) ? { [key]: text(raw[key], `${location}.${key}`, max, empty) } : {};
}
function fieldChanges(value: unknown, location: string): CanvasPlanFieldChanges {
  const raw = object(value, location);
  keys(raw, ['label', 'type', 'required', 'help', 'placeholder'], location);
  if (!Object.keys(raw).length) fail(`${location}没有要修改的字段。`);
  const result: CanvasPlanFieldChanges = {
    ...optionalText(raw, 'label', LIMITS.title, location, false),
    ...optionalText(raw, 'help', LIMITS.help, location),
    ...optionalText(raw, 'placeholder', LIMITS.help, location),
  };
  if (Object.hasOwn(raw, 'type')) {
    if (!FIELD_TYPES.includes(raw.type as string)) fail(`${location}.type不是支持的字段类型。`);
    result.type = raw.type as ContractField['type'];
  }
  if (Object.hasOwn(raw, 'required')) {
    if (typeof raw.required !== 'boolean') fail(`${location}.required必须是布尔值。`);
    result.required = raw.required;
  }
  return result;
}

/** Parse and normalize only the explicit protocol. All callers, including apply, use this gate. */
export function parseCanvasPlan(value: unknown): CanvasPlan {
  let rawValue = value;
  if (typeof rawValue === 'string') {
    if (rawValue.length > LIMITS.raw) fail(`JSON 超过 ${LIMITS.raw} 字符。`);
    const trimmed = rawValue.trim();
    const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    try { rawValue = JSON.parse(fence ? fence[1] : trimmed); } catch { fail('无法读取 JSON，请返回完整的方案对象。'); }
  }
  let serialized: string | undefined;
  try { serialized = JSON.stringify(rawValue); } catch { fail('对象无法序列化为 JSON。'); }
  if (!serialized || serialized.length > LIMITS.raw) fail(`JSON 必须有效且不超过 ${LIMITS.raw} 字符。`);
  const raw = object(rawValue, '方案');
  keys(raw, ['version', 'summary', 'operations'], '方案');
  if (raw.version !== 1) fail('仅支持协议 version: 1。');
  const summary = text(raw.summary, 'summary', 1000, false);
  if (!Array.isArray(raw.operations) || raw.operations.length > LIMITS.operations) fail(`operations 必须是数组，最多 ${LIMITS.operations} 项。`);
  const refs = new Set<string>();
  const operations = raw.operations.map((value, index): CanvasPlanOperation => {
    const location = `第 ${index + 1} 个操作`;
    const op = object(value, location);
    const nodeId = () => id(op.nodeId, `${location}.nodeId`);
    const fieldId = () => id(op.fieldId, `${location}.fieldId`);
    switch (op.type) {
      case 'add_node': {
        keys(op, ['type', 'ref', 'templateId', 'title', 'persona', 'inputValues'], location);
        const ref = id(op.ref, `${location}.ref`);
        if (refs.has(ref)) fail(`重复的新增节点引用「${ref}」。`);
        refs.add(ref);
        if (!AGENT_TEMPLATES.some(item => item.id === op.templateId)) fail(`${location}.templateId不是可用模板。`);
        let inputValues: Record<string, string> | undefined;
        if (Object.hasOwn(op, 'inputValues')) {
          const values = object(op.inputValues, `${location}.inputValues`);
          if (Object.keys(values).length > LIMITS.fields) fail(`${location}输入字段过多。`);
          inputValues = Object.create(null) as Record<string, string>;
          for (const [key, value] of Object.entries(values)) inputValues[id(key, '输入字段 ID')] = text(value, `${location}.inputValues.${key}`, LIMITS.value);
        }
        return { type: 'add_node', ref, templateId: op.templateId as AgentTemplateId,
          ...optionalText(op, 'title', LIMITS.title, location, false), ...optionalText(op, 'persona', LIMITS.persona, location),
          ...(inputValues ? { inputValues } : {}),
        };
      }
      case 'update_node':
        keys(op, ['type', 'nodeId', 'title', 'persona'], location);
        if (!Object.hasOwn(op, 'title') && !Object.hasOwn(op, 'persona')) fail(`${location}没有要修改的节点属性。`);
        return { type: 'update_node', nodeId: nodeId(), ...optionalText(op, 'title', LIMITS.title, location, false), ...optionalText(op, 'persona', LIMITS.persona, location) };
      case 'set_input':
        keys(op, ['type', 'nodeId', 'fieldId', 'value'], location);
        return { type: 'set_input', nodeId: nodeId(), fieldId: fieldId(), value: text(op.value, `${location}.value`, LIMITS.value) };
      case 'add_field': {
        keys(op, ['type', 'nodeId', 'side', 'field'], location);
        const rawField = object(op.field, `${location}.field`);
        keys(rawField, ['id', 'label', 'type', 'required', 'value', 'help', 'placeholder'], `${location}.field`);
        if (rawField.value !== '') fail(`${location}新字段 value 必须为空；输入值请使用 set_input，禁止生成输出值。`);
        const { id: fieldId, value: _value, ...changes } = rawField;
        const normalized = fieldChanges(changes, `${location}.field`);
        if (!normalized.type || normalized.required === undefined || normalized.label === undefined) fail(`${location}新字段缺少 label/type/required。`);
        return { type: 'add_field', nodeId: nodeId(), side: side(op.side, location), field: { ...normalized, id: id(fieldId, '字段 ID'), label: normalized.label, type: normalized.type, required: normalized.required, value: '' } };
      }
      case 'update_field':
        keys(op, ['type', 'nodeId', 'side', 'fieldId', 'changes'], location);
        return { type: 'update_field', nodeId: nodeId(), side: side(op.side, location), fieldId: fieldId(), changes: fieldChanges(op.changes, `${location}.changes`) };
      case 'remove_field':
        keys(op, ['type', 'nodeId', 'side', 'fieldId'], location);
        return { type: 'remove_field', nodeId: nodeId(), side: side(op.side, location), fieldId: fieldId() };
      case 'remove_node':
        keys(op, ['type', 'nodeId'], location);
        return { type: 'remove_node', nodeId: nodeId() };
      case 'connect':
        keys(op, ['type', 'fromNode', 'fromField', 'toNode', 'toField', 'kind'], location);
        return { type: 'connect', fromNode: id(op.fromNode, '来源节点'), fromField: id(op.fromField, '来源字段'), toNode: id(op.toNode, '目标节点'), toField: id(op.toField, '目标字段'),
          ...(Object.hasOwn(op, 'kind') ? { kind: edgeKind(op.kind, `${location}.kind`) } : {}) };
      case 'set_edge_kind':
        keys(op, ['type', 'edgeId', 'kind'], location);
        return { type: 'set_edge_kind', edgeId: text(op.edgeId, '连线 ID', 600, false), kind: edgeKind(op.kind, `${location}.kind`) };
      case 'set_execution':
        if (op.mode === 'workflow') {
          keys(op, ['type', 'mode'], location);
          return { type: 'set_execution', mode: 'workflow' };
        }
        keys(op, ['type', 'mode', 'maxRounds', 'reviewerNodeId', 'verdictFieldId'], location);
        if (op.mode !== 'review') fail(`${location}.mode必须是 workflow 或 review。`);
        if (typeof op.maxRounds !== 'number' || !Number.isInteger(op.maxRounds) || op.maxRounds < 1 || op.maxRounds > 5) fail(`${location}.maxRounds必须是 1 到 5 之间的整数。`);
        return { type: 'set_execution', mode: 'review', maxRounds: op.maxRounds,
          reviewerNodeId: id(op.reviewerNodeId, `${location}.reviewerNodeId`), verdictFieldId: id(op.verdictFieldId, `${location}.verdictFieldId`) };
      case 'disconnect':
        keys(op, ['type', 'edgeId'], location);
        return { type: 'disconnect', edgeId: text(op.edgeId, '连线 ID', 600, false) };
      default: return fail(`${location}不支持操作「${String(op.type)}」。`);
    }
  });
  return { version: 1, summary, operations };
}

function checkGraph(doc: CanvasDocument): void {
  const nodes = new Map<string, CanvasNode>();
  for (const node of doc.nodes) {
    if (nodes.has(node.id)) fail(`节点 ID「${node.id}」重复。`);
    nodes.set(node.id, node);
  }
  const edgeIds = new Set<string>();
  const checked: CanvasDocument['edges'] = [];
  for (const edge of doc.edges) {
    if (edgeIds.has(edge.id)) fail(`连线 ID「${edge.id}」重复。`);
    edgeIds.add(edge.id);
    const from = nodes.get(edge.fromNode);
    const to = nodes.get(edge.toNode);
    const output = from && portsFor(from).find(port => port.side === 'output' && port.id === edge.fromPort);
    const input = to && portsFor(to).find(port => port.side === 'input' && port.id === edge.toPort);
    if (!output || !input) fail(`连线「${edge.id}」引用的节点或字段不存在；请先显式 disconnect。`);
    if (output.dataType !== input.dataType || output.dataType !== edge.dataType) fail(`连线「${edge.id}」类型不匹配；请先显式 disconnect 后修改字段并重新连接。`);
    if (!canConnect(doc.nodes, checked, { nodeId: edge.fromNode, portId: edge.fromPort }, { nodeId: edge.toNode, portId: edge.toPort })) fail(`连线「${edge.id}」重复、自连接或目标输入已被占用。`);
    checked.push(edge);
  }
  if (findCycle(doc.nodes, doc.edges.filter(edge => edge.kind !== 'feedback')).length) fail('本轮数据连线产生回环，无法应用。');
}

function checkExecution(doc: CanvasDocument): void {
  if (!doc.execution) return;
  if (doc.execution.mode !== 'review' || !Number.isInteger(doc.execution.maxRounds) || doc.execution.maxRounds < 1 || doc.execution.maxRounds > 5) {
    fail('互审策略必须限制为 1 到 5 轮。');
  }
  const { reviewerNodeId, verdictFieldId } = doc.execution;
  const node = doc.nodes.find(node => node.id === reviewerNodeId);
  if (node?.kind !== 'session') fail('最终评审必须引用当前画布中的 Agent 节点。');
  if (!node.contract?.outputs.some(field => field.id === verdictFieldId && field.type === 'boolean')) {
    fail('最终评审的判定字段必须是已声明的 boolean 输出。');
  }
}

/** Records one thing applied differently from how the plan wrote it, in the request's language. */
type Adjust = (zh: string, en: string) => void;
const titleOf = (node: CanvasNode): string => node.title.trim() || node.id;
const NEW_FIELD_ID = /^[A-Za-z0-9_-]{1,48}$/;

/** A field a plan named, read the way models name fields: its exact id, the id with its port prefix, the id in
 *  another case, or the field's label. */
function namedField<T extends { id: string; label: string }>(fields: ReadonlyArray<T>, reference: string, prefix: 'in:' | 'out:'): T | undefined {
  const id = reference.startsWith(prefix) ? reference.slice(prefix.length) : reference;
  const folded = id.trim().toLowerCase();
  return fields.find(field => field.id === id) ?? fields.find(field => field.id.toLowerCase() === folded)
    ?? fields.find(field => field.label.trim().toLowerCase() === folded);
}

/** The output a connection starts from. A node with a single output (a form, a legacy session) has only one. */
function plannedOutput(node: CanvasNode, reference: string): PortSpec | undefined {
  const outputs = portsFor(node).filter(port => port.side === 'output');
  if (node.kind === 'session' && node.contract) {
    const field = namedField(node.contract.outputs, reference, 'out:');
    return field && outputs.find(port => port.id === `out:${field.id}`);
  }
  return outputs.find(port => port.id === reference) ?? (outputs.length === 1 ? outputs[0] : undefined);
}

function plannedInput(node: CanvasNode, reference: string): PortSpec | undefined {
  const inputs = portsFor(node).filter(port => port.side === 'input');
  if (node.kind === 'session' && node.contract) {
    const field = namedField(node.contract.inputs, reference, 'in:');
    return field && inputs.find(port => port.id === `in:${field.id}`);
  }
  return inputs.find(port => port.id === reference);
}

/** Fill one input, or say why it was left alone: a field that is not there, or a value its type does not take,
 *  costs that one value rather than the whole plan. Outputs are never reached from here. */
function setInput(node: CanvasNode, fieldId: string, value: string, adjust: Adjust): void {
  const fields: ReadonlyArray<{ id: string; label: string; value: string }> | undefined = node.kind === 'form' ? node.fields : node.contract?.inputs;
  const field = fields && namedField(fields, fieldId, 'in:');
  if (!field) {
    adjust(`没有填写「${titleOf(node)}」的「${fieldId}」：它没有这个输入`, `Left “${fieldId}” on “${titleOf(node)}” unfilled: it has no such input`);
    return;
  }
  if (node.kind === 'session') {
    const errors = validateContractFields([{ ...field as ContractField, required: false, value }]);
    if (errors.length) {
      const name = field.label || field.id;
      adjust(`没有填写「${titleOf(node)}」的「${name}」：${errors.join(' ')}`, `Left “${name}” on “${titleOf(node)}” unfilled: ${errors.join(' ')}`);
      return;
    }
  }
  (field as { value: string }).value = value;
}

/** The contract type a new input needs to take a delivery from this output. */
function inputTypeFor(from: CanvasNode, output: PortSpec): ContractFieldType | null {
  if (from.kind === 'session' && from.contract) return from.contract.outputs.find(field => `out:${field.id}` === output.id)?.type ?? null;
  if (output.dataType === 'text') return 'markdown';
  return output.dataType === 'number' || output.dataType === 'boolean' || output.dataType === 'file' ? output.dataType : null;
}

/**
 * Make the connection a plan asked for. Models often wire a second source into an input that already has one,
 * point at an input of another type, or name an input the node does not have; each of those used to fail the
 * whole plan after its call was spent. Here the target gets an input of its own for that delivery instead, and
 * the change is said. A connection that cannot be made at all (no such output, a loop) is left out and said.
 */
function connectPlanned(draft: CanvasDocument, from: CanvasNode, to: CanvasNode, op: Extract<CanvasPlanOperation, { type: 'connect' }>, locale: UiLocale, adjust: Adjust): void {
  const fromTitle = titleOf(from); const toTitle = titleOf(to);
  if (from.id === to.id) { adjust(`跳过了「${fromTitle}」连到自己的连线`, `Skipped a connection from “${fromTitle}” to itself`); return; }
  const output = plannedOutput(from, op.fromField);
  if (!output) {
    adjust(`跳过了一条连线：「${fromTitle}」没有输出「${op.fromField}」`, `Skipped a connection: “${fromTitle}” has no output “${op.fromField}”`);
    return;
  }
  const start = { nodeId: from.id, portId: output.id };
  const loops = () => findCycle(draft.nodes, draft.edges.filter(edge => edge.kind !== 'feedback')).length > 0;
  const link = (portId: string): boolean => {
    const end = { nodeId: to.id, portId };
    draft.edges.push({ id: edgeId(start, end), fromNode: from.id, fromPort: output.id, toNode: to.id, toPort: portId, dataType: output.dataType,
      ...(op.kind ? { kind: op.kind } : {}) });
    if (op.kind !== 'feedback' && loops()) { draft.edges.pop(); return false; }
    return true;
  };
  const skipLoop = () => adjust(`跳过了「${fromTitle}」→「${toTitle}」：这条连线会形成回环`, `Skipped “${fromTitle}” → “${toTitle}”: it would form a loop`);
  const wanted = plannedInput(to, op.toField);
  if (wanted) {
    // The same wire again changes nothing.
    if (draft.edges.some(edge => edge.fromNode === from.id && edge.fromPort === output.id && edge.toNode === to.id && edge.toPort === wanted.id)) return;
    if (canConnect(draft.nodes, draft.edges, start, { nodeId: to.id, portId: wanted.id })) { if (!link(wanted.id)) skipLoop(); return; }
  }
  const type = inputTypeFor(from, output);
  if (to.kind !== 'session' || !to.contract || !type || to.contract.inputs.length >= LIMITS.fields) {
    adjust(`跳过了一条连线：「${toTitle}」不能新增输入来接收「${fromTitle}」的交付`, `Skipped a connection: “${toTitle}” cannot take a new input for the delivery from “${fromTitle}”`);
    return;
  }
  const contract = to.contract;
  const sourceField = from.kind === 'session' ? from.contract?.outputs.find(field => `out:${field.id}` === output.id) : undefined;
  const sourceLabel = sourceField?.label.trim() || sourceField?.id || (locale === 'en' ? 'Delivery' : '交付');
  const requested = op.toField.replace(/^in:/, '');
  const taken = (id: string) => contract.inputs.some(field => field.id === id);
  const base = !wanted && NEW_FIELD_ID.test(requested) && !taken(requested) ? requested
    : NEW_FIELD_ID.test(sourceField?.id ?? '') ? sourceField!.id : 'input';
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  // A label the plan wrote in words (not an id) names the new input; otherwise it says what it receives.
  const label = (!wanted && !NEW_FIELD_ID.test(requested) && requested.trim() ? requested.trim()
    : locale === 'en' ? `${sourceLabel} (from ${fromTitle})` : `${sourceLabel}（来自${fromTitle}）`).slice(0, LIMITS.title);
  const help = (locale === 'en' ? `Added for a connection: receives “${sourceLabel}” from “${fromTitle}”.` : `连线时新增：接收「${fromTitle}」的「${sourceLabel}」。`).slice(0, LIMITS.help);
  contract.inputs.push({ id, label, type, required: false, value: '', help });
  if (!normalizeContract(contract) || !canConnect(draft.nodes, draft.edges, start, { nodeId: to.id, portId: `in:${id}` })) {
    contract.inputs.pop();
    adjust(`跳过了一条连线：「${toTitle}」不能新增输入来接收「${fromTitle}」的交付`, `Skipped a connection: “${toTitle}” cannot take a new input for the delivery from “${fromTitle}”`);
    return;
  }
  if (!link(`in:${id}`)) { contract.inputs.pop(); skipLoop(); return; }
  const wantedField = wanted && namedField(contract.inputs, wanted.id, 'in:');
  const wantedName = wantedField?.label || wantedField?.id || op.toField;
  const occupied = Boolean(wanted && !wanted.multi && draft.edges.some(edge => edge.toNode === to.id && edge.toPort === wanted.id));
  const reason = !wanted ? [`「${toTitle}」原来没有输入「${op.toField}」`, `“${toTitle}” had no input “${op.toField}”`]
    : occupied ? [`「${toTitle}」的「${wantedName}」已经接了别的来源`, `“${wantedName}” on “${toTitle}” already had a source`]
      : [`「${toTitle}」的「${wantedName}」类型不同`, `“${wantedName}” on “${toTitle}” takes another type`];
  adjust(`${reason[0]}，已新增输入「${label}」接收「${fromTitle}」的「${sourceLabel}」`, `${reason[1]}, so a new input “${label}” receives “${sourceLabel}” from “${fromTitle}”`);
}

/** Drop the links a field change left without a matching pair of ports, saying each one. */
function disconnectBroken(draft: CanvasDocument, nodeId: string, adjust: Adjust): void {
  const byId = new Map(draft.nodes.map(node => [node.id, node]));
  draft.edges = draft.edges.filter(edge => {
    if (edge.fromNode !== nodeId && edge.toNode !== nodeId) return true;
    const from = byId.get(edge.fromNode); const to = byId.get(edge.toNode);
    const output = from && portsFor(from).find(port => port.side === 'output' && port.id === edge.fromPort);
    const input = to && portsFor(to).find(port => port.side === 'input' && port.id === edge.toPort);
    if (output && input && output.dataType === input.dataType && output.dataType === edge.dataType) return true;
    const left = from ? titleOf(from) : edge.fromNode; const right = to ? titleOf(to) : edge.toNode;
    adjust(`已断开「${left}」→「${right}」：相连的字段被删除或改了类型`, `Disconnected “${left}” → “${right}”: a field it used was removed or changed type`);
    return false;
  });
}

/** Validate against a private clone, then return one complete document. No partial writes: an operation that
 *  cannot apply as written is either repaired or left out, and each such case is listed in `adjustments`. */
export function applyCanvasPlan(doc: CanvasDocument, value: CanvasPlan, locale: UiLocale = 'zh', originalRequest = ''): AppliedCanvasPlan {
  const plan = parseCanvasPlan(value);
  const adjustments: string[] = [];
  const adjust: Adjust = (zh, en) => { if (adjustments.length < LIMITS.operations) adjustments.push(locale === 'en' ? en : zh); };
  const requestCharacters = Array.from(originalRequest);
  if (requestCharacters.length > TASK_FRAME_MAX_TOTAL_LENGTH) fail('原始请求超过任务要求的长度限制。');
  const constraints: string[] = [];
  if (originalRequest.trim()) {
    for (let start = 0; start < requestCharacters.length; start += TASK_FRAME_MAX_ENTRY_LENGTH) {
      constraints.push(requestCharacters.slice(start, start + TASK_FRAME_MAX_ENTRY_LENGTH).join(''));
    }
  }
  const draft = structuredClone(doc);
  const originalIds = new Set(doc.nodes.map(node => node.id));
  const refs = new Map<string, string>();
  const addedNodeIds: string[] = [];
  const resolve = (reference: string): CanvasNode => {
    const node = draft.nodes.find(item => item.id === (refs.get(reference) ?? reference));
    if (!node) fail(`节点引用「${reference}」不在当前画布，或尚未创建 / 已删除。`);
    return node;
  };
  for (const op of plan.operations) {
    switch (op.type) {
      case 'add_node': {
        if (originalIds.has(op.ref) || draft.nodes.some(node => node.id === op.ref)) fail(`新增引用「${op.ref}」与已有节点 ID 冲突。`);
        const node = createAgentTemplate(op.templateId, { x: 0, y: 0 }, locale);
        // Carry the human's exact request separately from the model-authored persona.
        // Every new downstream reviewer receives it even if an upstream draft drifts.
        if (constraints.length) node.taskFrame = { version: 1, source: 'manual', constraints: [...constraints], acceptanceCriteria: [] };
        if (op.title !== undefined) node.title = op.title;
        if (op.persona !== undefined) node.persona = op.persona;
        for (const [fieldId, value] of Object.entries(op.inputValues ?? {})) setInput(node, fieldId, value, adjust);
        draft.nodes.push(node); refs.set(op.ref, node.id); addedNodeIds.push(node.id);
        break;
      }
      case 'update_node': {
        const node = resolve(op.nodeId);
        if (op.persona !== undefined && node.kind !== 'session') fail('表单节点不能设置 persona。');
        if (op.title !== undefined) node.title = op.title;
        if (op.persona !== undefined && node.kind === 'session') node.persona = op.persona;
        break;
      }
      case 'set_input': setInput(resolve(op.nodeId), op.fieldId, op.value, adjust); break;
      case 'add_field':
      case 'update_field':
      case 'remove_field': {
        const node = resolve(op.nodeId);
        if (node.kind !== 'session') fail('输入输出结构编辑仅适用于 Agent 节点。');
        node.contract ??= { version: 1, inputs: [], outputs: [] };
        const fields = op.side === 'input' ? node.contract.inputs : node.contract.outputs;
        const sideName = op.side === 'input' ? ['输入', 'input'] : ['输出', 'output'];
        if (op.type === 'add_field') {
          const existing = fields.find(field => field.id === op.field.id);
          if (existing) {
            // A field the node already has, added again (often a template field the model did not see): the plan's
            // definition of it is what it wants, so the field is updated to it rather than the plan refused.
            const { id: _id, value: _value, ...definition } = op.field;
            const next = { ...existing, ...definition };
            const same = (['label', 'type', 'required', 'help', 'placeholder'] as const).every(key => next[key] === existing[key]);
            const errors = validateContractFields([{ ...next, required: false }]);
            if (errors.length) adjust(`没有改动「${titleOf(node)}」已有的${sideName[0]}「${existing.label || existing.id}」：${errors.join(' ')}`,
              `Left the existing ${sideName[1]} “${existing.label || existing.id}” on “${titleOf(node)}” as it was: ${errors.join(' ')}`);
            else if (!same) {
              Object.assign(existing, next);
              adjust(`「${titleOf(node)}」已有${sideName[0]}「${existing.label || existing.id}」，已按方案更新它`, `“${titleOf(node)}” already had the ${sideName[1]} “${existing.label || existing.id}”; it was updated as planned`);
            }
          } else {
            if (fields.length >= LIMITS.fields) fail(`每侧最多 ${LIMITS.fields} 个字段。`);
            fields.push({ ...op.field });
          }
        } else {
          const field = namedField(fields, op.fieldId, op.side === 'input' ? 'in:' : 'out:');
          const index = field ? fields.indexOf(field) : -1;
          if (index < 0) {
            adjust(`跳过了对「${titleOf(node)}」${sideName[0]}「${op.fieldId}」的${op.type === 'remove_field' ? '删除' : '修改'}：没有这个字段`,
              `Skipped ${op.type === 'remove_field' ? 'removing' : 'changing'} the ${sideName[1]} “${op.fieldId}” on “${titleOf(node)}”: there is no such field`);
          } else if (op.type === 'remove_field') fields.splice(index, 1);
          else {
            const next = { ...fields[index], ...op.changes };
            const errors = validateContractFields([{ ...next, required: false }]);
            if (errors.length) adjust(`没有改动「${titleOf(node)}」的「${fields[index].label || fields[index].id}」：已有内容与新类型不兼容（${errors.join(' ')}）`,
              `Left “${fields[index].label || fields[index].id}” on “${titleOf(node)}” as it was: its content does not fit the new type (${errors.join(' ')})`);
            else fields[index] = next;
          }
        }
        if (!normalizeContract(node.contract)) fail('输入输出结构无效。');
        disconnectBroken(draft, node.id, adjust);
        checkGraph(draft);
        break;
      }
      case 'remove_node': {
        const node = resolve(op.nodeId);
        draft.nodes = draft.nodes.filter(item => item.id !== node.id);
        draft.edges = draft.edges.filter(edge => edge.fromNode !== node.id && edge.toNode !== node.id);
        break;
      }
      case 'disconnect': {
        // Nothing to remove is not a reason to throw the rest of the plan away.
        if (!draft.edges.some(edge => edge.id === op.edgeId)) { adjust(`连线「${op.edgeId}」不在画布上，无需断开`, `The connection “${op.edgeId}” is not on the canvas; nothing to disconnect`); break; }
        draft.edges = draft.edges.filter(edge => edge.id !== op.edgeId);
        break;
      }
      case 'set_execution': {
        if (op.mode === 'workflow') delete draft.execution;
        else {
          const reviewer = resolve(op.reviewerNodeId);
          draft.execution = { mode: 'review', maxRounds: op.maxRounds, reviewerNodeId: reviewer.id, verdictFieldId: op.verdictFieldId };
          checkExecution(draft);
        }
        break;
      }
      case 'set_edge_kind': {
        const edge = draft.edges.find(edge => edge.id === op.edgeId);
        if (!edge) fail(`连线「${op.edgeId}」不在当前画布。`);
        edge.kind = op.kind;
        checkGraph(draft);
        break;
      }
      case 'connect': {
        connectPlanned(draft, resolve(op.fromNode), resolve(op.toNode), op, locale, adjust);
        checkGraph(draft);
        break;
      }
    }
  }
  checkGraph(draft);
  checkExecution(draft);
  const added = new Set(addedNodeIds);
  const survivors = draft.nodes.filter(node => added.has(node.id));
  const oldNodes = draft.nodes.filter(node => !added.has(node.id));
  const right = oldNodes.length ? Math.max(...oldNodes.map(node => node.x + node.w)) + 100 : 80;
  const arranged = arrangeNodePositions(survivors, draft.edges.filter(edge => edge.kind !== 'feedback' && added.has(edge.fromNode) && added.has(edge.toNode)));
  const positions = new Map(arranged.map(node => [node.id, { x: node.x + right - 80, y: node.y }]));
  draft.nodes = draft.nodes.map(node => positions.has(node.id) ? { ...node, ...positions.get(node.id)! } : node);
  draft.updatedAt = Date.now();
  return { doc: invalidateOutputs(doc, draft), addedNodeIds: survivors.map(node => node.id), summary: plan.summary, adjustments };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Compact deterministic conflict fingerprint. Viewport/navigation changes are intentionally free. */
export function canvasPlanRevision(doc: CanvasDocument): string {
  const serialized = canonical({ version: doc.version, nodes: doc.nodes, edges: doc.edges, execution: doc.execution });
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index += 1) hash = BigInt.asUintN(64, (hash ^ BigInt(serialized.charCodeAt(index))) * 0x100000001b3n);
  return `cp1-${serialized.length}-${hash.toString(16).padStart(16, '0')}`;
}

/** Whether a plan changed nothing but the nodes it added: deleting them (and their edges) gives back the canvas it was
 *  applied to. Only then does their absence say the plan is gone. */
export function onlyAddedNodes(before: CanvasDocument, after: CanvasDocument, addedNodeIds: readonly string[]): boolean {
  const added = new Set(addedNodeIds);
  return added.size > 0 && canvasPlanRevision({ ...after, nodes: after.nodes.filter(node => !added.has(node.id)),
    edges: after.edges.filter(edge => !added.has(edge.fromNode) && !added.has(edge.toNode)) }) === canvasPlanRevision(before);
}
