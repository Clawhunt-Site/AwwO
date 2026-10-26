import { AGENT_TEMPLATES, createAgentTemplate, type AgentTemplateId } from './agentTemplates';
import { createSessionNode, nodeContract, type CanvasDocument, type CanvasNode, type SessionNode } from './canvasDoc';
import { canvasText } from './i18n';
import { invalidateOutputs } from './invalidateOutputs';
import { normalizeContract, validateContractFields, type ContractField, type ContractFieldType } from './nodeContracts';
import { arrangeNodePositions } from './nodePresentation';
import { updateNodeDraft } from './nodeThreads';
import { mediaKindOf, type MediaKind } from './mediaCatalog';
import { canConnect, canFeed, edgeId, isMediaSessionNode, portsFor, reconcileEdges, type PortSpec } from './ports';
import { findCycle } from './runGraph';
import type { UiLocale } from '../locale';
import { cleanTaskFrame, isTaskFrame, taskFrameError, TASK_FRAME_MAX_ENTRIES, TASK_FRAME_MAX_ENTRY_LENGTH, TASK_FRAME_MAX_TOTAL_LENGTH, type TaskFrame } from './taskFrame';
import { figurePersona } from './figureKit/figureKit';
import { SANDBOX_RUNTIME, automaticEntry } from './nodeRuntime';
import { NODE_TEAM_LIMITS, NODE_TEAM_MODES, NODE_TEAM_RUNTIMES, inheritingRuntime, newTeamRuntime, nodeTeamRuntimeLabel, validateNodeTeam, type NodeTeam, type NodeTeamMode, type NodeTeamRuntime } from './nodeTeam';
import { NODE_TEAM_MAX_CALLS, NODE_TEAM_TEMPLATE_IDS, buildNodeTeam, isNodeTeamTemplateId, nodeTeamTemplate, nodeTeamTemplateShape, type NodeTeamMemberBrief, type NodeTeamTemplateId } from './nodeTeamTemplates';

/** The media kinds a plan may add as nodes (templateId image, video or model3d): generators that make one asset from a
 *  prompt instead of running an Agent. A host offers the planner only the kinds its workspace can generate. */
export const MEDIA_PLAN_TEMPLATE_IDS: ReadonlyArray<MediaKind> = ['image', 'video', 'model3d'];
export type PlanTemplateId = AgentTemplateId | MediaKind;
const isMediaTemplate = (value: unknown): value is MediaKind => MEDIA_PLAN_TEMPLATE_IDS.includes(value as MediaKind);
/** Every template id a plan may declare, media nodes included: planning progress names a node only by one of these.
 *  Literal ids (checked against AgentTemplateId), so building it at load never reads another module's bindings. */
const AGENT_PLAN_TEMPLATE_IDS = ['general', 'frontend', 'backend', 'data', 'users', 'materials', 'review', 'figure'] as const satisfies ReadonlyArray<AgentTemplateId>;
export const PLAN_TEMPLATE_IDS: ReadonlySet<string> = new Set<string>([...AGENT_PLAN_TEMPLATE_IDS, ...MEDIA_PLAN_TEMPLATE_IDS]);

/** On a hosted canvas a frontend node the assistant adds is the page itself: its one model call delivers one complete
 *  HTML page (a site, a game or a tool) that opens and runs in 成果, where the template's delivery notes, preview link
 *  and checks would describe files and servers that call cannot make. The planner is shown it this way
 *  (buildPlanningContext) and a plan's frontend node is made this way (applyCanvasPlan), so the two agree on its one
 *  output, which every case tutorial used to set by hand in developer mode (owner request 2026-10-15). */
export const HOSTED_PAGE_TEMPLATE_ID = 'frontend' satisfies AgentTemplateId;
export function hostedPageOutputs(locale: UiLocale): ContractField[] {
  return [{ id: 'page', label: locale === 'en' ? 'Page' : '网页', type: 'html', required: true, value: '',
    help: locale === 'en' ? 'One complete HTML page that works as soon as it is opened.' : '一页完整的 HTML，打开就能使用。' }];
}
/** Its brief when the plan writes none: the frontend template's own speaks of code locations, preview links and test
 *  records, which a page delivered in one call does not have. */
export function hostedPagePersona(locale: UiLocale): string {
  return locale === 'en'
    ? 'Delivers one page that works as soon as it is opened in a browser: a website, game or tool as one complete HTML file, its CSS and JavaScript inside it. Uses what the nodes wired into it deliver and pastes their code unchanged. Writes no notes, code locations or preview links, and relies on no server, account or tool to install.'
    : '负责交付一页打开就能用的网页、游戏或小工具：一个完整的 HTML 文件，CSS 与 JavaScript 写在页面里，在浏览器里直接打开就能使用。使用上游节点交来的内容，代码原样粘贴、不改写。不写说明文字、代码位置或预览链接，不依赖服务器、账号或需要安装的工具。';
}
/** The built-in design skills (backend/internal/app/skills) such a page runs with: rules that make a page read as
 *  designed, and the patterns that mark one as default model output. A plan never names skills (planning.go refuses
 *  keys it does not know); a member removes them in the node's 配置 like any others. The API refuses to run a node
 *  naming a skill it does not have, so these stay skills it ships (design_skills_test.go checks them). */
export const HOSTED_PAGE_SKILLS: readonly string[] = ['builtin:design-craft', 'builtin:anti-ai-slop'];
/** The UTF-16 units a node's own text may take in its system prompt (nodePromptUnits) for it to keep those skills: the
 *  API refuses a run whose system prompt passes 32,768 units (graph_runs.go), and the skills, the rest of the output
 *  policy and every note a run can add leave about 15,800. design_skills_test.go pins this. */
export const HOSTED_PAGE_SKILL_ROOM = 14000;
/** The example of an output's shape the API's output policy writes beside its fields (graphOutputPolicy);
 *  design_skills_test.go checks these against the policy. */
const POLICY_EXAMPLE_HTML = '<html><head></head><body>Actual result</body></html>';
const POLICY_EXAMPLE_FILE = { name: 'deliverable.txt', content: '<actual file text>' };
const policyExample = (field: ContractField) => field.type === 'number' ? 0 : field.type === 'boolean' ? false
  : field.type === 'html' ? POLICY_EXAMPLE_HTML : field.type === 'file' ? POLICY_EXAMPLE_FILE : `<actual ${field.id} content>`;
/** What a node's own text takes of its system prompt: its brief and task requirements (graphSystemPrompt,
 *  taskFrameSystemPrompt) and its output fields with the example of their shape (graphOutputPolicy), all of which the
 *  API writes as JSON. Its encoding/json writes what JSON.stringify does, except <, > and & and the two line
 *  separators, as six-unit escapes. */
export function nodePromptUnits(node: SessionNode): number {
  const units = (value: unknown) => {
    const text = JSON.stringify(value);
    let count = text.length;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 0x3c || code === 0x3e || code === 0x26 || code === 0x2028 || code === 0x2029) count += 5;
    }
    return count;
  };
  const outputs = node.contract?.outputs ?? [];
  const fields = outputs.map(field => ({ help: field.help ?? '', id: field.id, label: field.label, placeholder: field.placeholder ?? '',
    required: field.required, type: field.type }));
  return units(node.persona) + (isTaskFrame(node.taskFrame) ? units(node.taskFrame) : 0)
    + (outputs.length ? units(fields) + units(Object.fromEntries(outputs.map(field => [field.id, policyExample(field)]))) : 0);
}
/** Whether a node carries exactly the design skills a planned page is given (in any order). */
const carriesPageSkills = (node: SessionNode) => node.skills?.length === HOSTED_PAGE_SKILLS.length
  && HOSTED_PAGE_SKILLS.every(ref => node.skills!.includes(ref));
/** The parts of a node nodePromptUnits counts, to tell whether a plan changed them (task requirements without the blank
 *  entries the API drops). */
const promptText = (node: SessionNode) => JSON.stringify([node.persona, isTaskFrame(node.taskFrame) ? cleanTaskFrame(node.taskFrame) : null,
  (node.contract?.outputs ?? []).map(field => [field.id, field.label, field.type, field.required, field.help ?? '', field.placeholder ?? ''])]);

export type CanvasPlanFieldChanges = Partial<Pick<ContractField, 'label' | 'type' | 'required' | 'help' | 'placeholder'>>;
export type CanvasPlanOperation =
  | { type: 'add_node'; ref: string; templateId: PlanTemplateId; title?: string; persona?: string; inputValues?: Record<string, string>; constraints?: string[]; acceptanceCriteria?: string[] }
  | { type: 'update_node'; nodeId: string; title?: string; persona?: string }
  /** A node's task requirements: each list given replaces that list (constraints it must follow, criteria its delivery
   *  is checked against), except that on a node the same plan adds the user's request stays its first constraint; a
   *  list left out stays as it is. */
  | { type: 'set_task'; nodeId: string; constraints?: string[]; acceptanceCriteria?: string[] }
  /** A node's model (one the host offered the planner), and its reasoning effort; the runtime is AwwO's (nodeRuntime.ts). */
  | { type: 'set_model'; nodeId: string; model: string; effort?: string }
  /** An Agent node's collaboration team, replacing any it has: a template's, or the members the plan writes. Never a
   *  model, effort, runtime or tool (nodeTeamTemplates.ts buildNodeTeam). */
  | { type: 'set_team'; nodeId: string; template: NodeTeamTemplateId }
  | { type: 'set_team'; nodeId: string; mode: NodeTeamMode; maxRounds?: number; members: NodeTeamMemberBrief[] }
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
const OPERATION_TYPES = ['add_node', 'update_node', 'set_task', 'set_model', 'set_team', 'set_input', 'add_field', 'update_field', 'remove_field', 'remove_node',
  'connect', 'set_edge_kind', 'set_execution', 'disconnect'] as const satisfies ReadonlyArray<CanvasPlanOperationType>;
// An operation type added to CanvasPlanOperation but not listed above fails to compile here.
const everyOperationListed: [Exclude<CanvasPlanOperationType, typeof OPERATION_TYPES[number]>] extends [never] ? true : never = true;
void everyOperationListed;
/** Every operation type a plan may contain: the closed set planning progress may name. */
export const CANVAS_PLAN_OPERATION_TYPES: ReadonlySet<string> = new Set(OPERATION_TYPES);
/** The operation types that concern one node, beside which progress may name that node's template. */
export const CANVAS_PLAN_NODE_OPERATION_TYPES: ReadonlySet<string> = new Set(['add_node', 'update_node', 'set_task', 'set_model', 'set_team', 'set_input', 'add_field',
  'update_field', 'remove_field', 'remove_node'] satisfies CanvasPlanOperationType[]);

export interface CanvasPlan { version: 1; summary: string; operations: CanvasPlanOperation[] }
/** `adjustments` says, in the request's language, what was applied differently from how the plan wrote it
 *  (a connection given its own input, a link a field change broke) or left out (a connection that would loop). */
/** `modelSetNodeIds`: the nodes a set_model step put on a model, the workspace default included, which a host's own
 *  model for new nodes must leave as the plan set them. */
export interface AppliedCanvasPlan { doc: CanvasDocument; addedNodeIds: string[]; summary: string; adjustments: string[]; modelSetNodeIds: string[] }
/** What a host tells a plan about the media nodes it can run: the model a new node of each kind starts on (a kind
 *  missing here cannot be added), and the longest prompt a model takes. */
export interface CanvasPlanMedia { models: Partial<Record<MediaKind, string>>; promptMax: (model: string) => number | undefined }
/** What a host tells a plan about the chat models its nodes can run (the palette): a set_model names one of these, by id
 *  or by its name, and may pick one of the levels its entry advertises. Without it a plan cannot change a model. */
export interface CanvasPlanModelChoice { runtime: string; model: string; available: boolean; name?: string; efforts?: ReadonlyArray<string> }
/** `userChosen`: the models only a user may choose, which a plan never puts a node on (userChosenModels.ts planModelsOf). */
export interface CanvasPlanModels { choices: ReadonlyArray<CanvasPlanModelChoice>; userChosen?: ReadonlyArray<{ model: string; name?: string }> }

/** The fields of each node a plan's context showed only in part (canvasPlanning.ts fitPlanningContext): 'persona',
 *  'constraints' (its own items or a shared requirement it holds), 'acceptanceCriteria', 'input:<field id>' (a form's
 *  fields and a media node's prompt too) and 'team' (a member's name, role or instructions). The plan leaves them as
 *  they are, since its planner never saw them whole, and writes no text copied from a shortened one anywhere
 *  (applyCanvasPlan). An empty set: only the conversation was cut. */
export type PlanContextCondensed = ReadonlyMap<string, ReadonlySet<string>>;
/** A PlanContextCondensed as the planning recovery journal keeps it beside its request (plannerRecovery.ts). */
export type PlanContextCondensedJSON = Array<[string, string[]]>;
const condensedPlans = new WeakMap<object, PlanContextCondensed>();
/** Say that a plan was made from a shortened view of the canvas; applyCanvasPlan then honours it for that plan. */
export function markPlanContextCondensed(plan: CanvasPlan, condensed: PlanContextCondensed): void { condensedPlans.set(plan, condensed); }
export function planContextCondensed(plan: unknown): PlanContextCondensed | undefined {
  return plan !== null && typeof plan === 'object' ? condensedPlans.get(plan) : undefined;
}
const sizedPlans = new WeakMap<object, string>();
/** Say which model a hosted planner sized the Agent nodes a plan adds without set_model for: the one the request its run
 *  was made from named (planNewNodeModel.ts; "default" for the workspace default), which the host's plan frame says, a
 *  resume's too (canvasBridge.ts). The host then puts those nodes on it (assistantModel.ts planComponentModel). */
export function markPlanNewNodeModel(plan: CanvasPlan, model: string): void { sizedPlans.set(plan, model); }
const teamPlans = new WeakSet<object>();
/** Say that the request a plan's run was made from offered set_team (planContextOffersTeams), which the host's plan frame
 *  says, a resume's and another tab's run too (canvasBridge.ts). Only such a plan gives a node a team: a request that did
 *  not offer it showed every team only as `team: true`, and a set_team would replace a team its planner never read. */
export function markPlanOffersTeams(plan: CanvasPlan): void { teamPlans.add(plan); }
export function planOffersTeams(plan: unknown): boolean { return plan !== null && typeof plan === 'object' && teamPlans.has(plan); }
/** The model markPlanNewNodeModel gave a plan, or undefined where none was given (a request stored before plans said it,
 *  a host without plan frames). */
export function planNewNodeModel(plan: unknown): string | undefined {
  return plan !== null && typeof plan === 'object' ? sizedPlans.get(plan) : undefined;
}
export const condensedToJSON = (condensed: PlanContextCondensed): PlanContextCondensedJSON => [...condensed].map(([id, fields]) => [id, [...fields]]);
/** The set a journal or a host kept, or undefined for anything not shaped as one. Any document's set is one: it names
 *  only nodes and fields its request's context showed, which the journal bounds with that request (plannerRecovery.ts). */
export function condensedFromJSON(value: unknown): PlanContextCondensed | undefined {
  if (!Array.isArray(value)) return undefined;
  const condensed = new Map<string, Set<string>>();
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !Array.isArray(item[1])
      || !item[1].every((field: unknown) => typeof field === 'string')) return undefined;
    // A node named twice keeps the fields of both.
    condensed.set(item[0], new Set([...(condensed.get(item[0]) ?? []), ...item[1]]));
  }
  return condensed;
}
/** The words a shortened text ends with in a plan's context: how many more characters the canvas keeps. */
export function condensedMark(left: number, locale: UiLocale): string {
  return locale === 'en' ? `… [${left} more characters not shown; kept as they are]` : `…〔另有 ${left} 字未显示，保持原样〕`;
}
// Matched loosely: a model copying the words may change the ellipsis, the brackets, the spaces (a line broken and
// indented, in the number too), the number's digit grouping or the end. The number and the spaces are bounded, one run
// of separators between two digits, so that no text makes the match slow.
const CONDENSED_MARK = /另有\s{0,40}\d(?:[,，.'\s]{0,40}\d){0,12}\s{0,40}字\s{0,40}未显示|\d(?:[,.'\s]{0,40}\d){0,12}\s{1,40}more\s{1,40}characters?\s{1,40}not\s{1,40}shown/i;
/** Whether a text carries shortened text from a plan's context, which a plan made from one must never write. */
export const carriesCondensedText = (text: string | undefined): boolean => text !== undefined && CONDENSED_MARK.test(text);

const TEAM_TEMPLATE_CHOICES = NODE_TEAM_TEMPLATE_IDS.map(id => `"${id}"`).join('|');
/** A team's limits in a plan: the team editor's and the API's (nodeTeam.ts NODE_TEAM_LIMITS), so every member the planner
 *  is shown can be written back. */
const TEAM_LIMITS = NODE_TEAM_LIMITS;

export const CANVAS_PLAN_PROTOCOL = `只返回一个 JSON 对象，不要执行任何操作：
{"version":1,"summary":"简短说明","operations":[...]}
允许的 operations（未知键会被拒绝）：
add_node: {type:"add_node",ref:string,templateId:"general"|"frontend"|"backend"|"data"|"users"|"materials"|"review"|"figure",title?:string,acceptanceCriteria:string[],persona?:string,inputValues?:{[已有输入字段ID]:string},constraints?:string[]}
新增 Agent 节点的 add_node 必须写 acceptanceCriteria：1 到 3 条，每条是能对照这个节点自己的交付逐条核对的检查。
update_node: {type:"update_node",nodeId:string,title?:string,persona?:string}
set_task: {type:"set_task",nodeId:string,constraints?:string[],acceptanceCriteria?:string[]}
set_model: {type:"set_model",nodeId:string,model:string,effort?:string}
set_team: {type:"set_team",nodeId:string,template:${TEAM_TEMPLATE_CHOICES}} 或 {type:"set_team",nodeId:string,mode:"sequential"|"parallel"|"debate"|"review",maxRounds?:1到${TEAM_LIMITS.rounds}的整数,members:[{name:string,role:string,instructions?:string}]}
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
set_task 改任务要求：constraints=约束，acceptanceCriteria=可逐条核对交付的验收标准；给出的列表整体替换；每列表≤20条、每条≤2000字、合计≤12000字；新节点约束默认为原始请求，给它的 constraints 接在其后；@R1 等即 requirements 原文。
set_model 是唯一能改模型的操作，只能改用 models 中的模型：model 写 id（"default"=工作区默认），effort 只能是该模型列出的档位；执行引擎由应用选择。
set_team 把一个 Agent 节点配成协作团队，整体替换它已有的团队：template 写「协作团队模板」中一个模板的 id；或自己写 mode 和 1到${TEAM_LIMITS.members}位 members（review至少2位；成员名称不重复，名称最多${TEAM_LIMITS.name}字符、职责最多${TEAM_LIMITS.role}字符、指令最多${TEAM_LIMITS.instructions}字符；maxRounds只用于debate和review，默认2）。成员顺序就是分工：sequential的最后一位交付，parallel和debate的最后一位汇总或裁决，review的最后一位审核。成员只写名称、职责和指令：模型、思考强度、执行框架和工具由用户设置，新成员继承节点模型，同名成员保留用户已选的设置。每位成员每轮都是一次模型调用，所以只在用户要求团队、多人协作、审核返工、辩论或多角度时使用；工作区Agent、表单和媒体节点不能配团队。
新增节点完整使用对应角色模板。字段值都是字符串；布尔值用"true"/"false"，数字用数字字符串，file为引用字符串。add_field.value必须为空；输入内容通过set_input填写。严禁生成或填写任何输出值。
改变已连接字段类型或删除字段前须先disconnect。remove_node 明确删除该节点及其关联连线。
只能修改白名单：禁止binding/runtime/model/effort/threads/issueId/preview/lastOutput/templateId等执行状态修改；禁止命令执行、创建真实Agent、发消息、运行节点、文件写入、部署、付款等副作用。布局由应用安排新增节点，不能提交x/y/w/h。
最多100个操作、JSON最多120000字符、summary最多1000字符；ID/ref最多128字符，title/label最多200字符，persona最多8000字符，输入value最多16000字符，help/placeholder最多2000字符；每个节点每侧最多64字段。`;

const LIMITS = { raw: 120000, operations: 100, id: 128, title: 200, persona: 8000, value: 16000, help: 2000, fields: 64 } as const;
const SET_TEAM_LINE = CANVAS_PLAN_PROTOCOL.split('\n').find(line => line.startsWith('set_team:'))!;
/** Whether a planning context offered set_team: its protocol has the set_team line only then (canvasPlanning.ts
 *  planningProtocol), and with it the teams' members and the team templates. */
export const planContextOffersTeams = (context: string | undefined): boolean => (context ?? '').split('\n').includes(SET_TEAM_LINE);

const MEDIA_KIND_WORDS: Record<MediaKind, string> = { image: '图片', video: '视频', model3d: '3D 模型', audio: '音频' };
/** How many of a plan's notes the canvas panel shows (CanvasSurface), the rest counted: applyCanvasPlan's grouped notes,
 *  at most four, always come first among them. */
export const PLAN_NOTES_SHOWN = 6;
/** A new node's task lists a note names, in Chinese and in English. */
const TASK_LIST_WORDS = { constraints: ['约束', 'constraints'], criteria: ['验收标准', 'acceptance criteria'],
  both: ['约束和验收标准', 'constraints and acceptance criteria'] } as const;
type TaskLists = keyof typeof TASK_LIST_WORDS;
/** Which task lists a step gave, or none. */
function givenLists(constraints: boolean, criteria: boolean): TaskLists | undefined {
  return constraints && criteria ? 'both' : constraints ? 'constraints' : criteria ? 'criteria' : undefined;
}
function joinLists(a: TaskLists, b: TaskLists): TaskLists { return a === b ? a : 'both'; }
/** The first five items joined, and the rest said by `rest` with how many they are; up to five, the last joined by
 *  `last` ("and" in English). */
function firstFive(items: string[], separator: string, rest: (more: number) => string, last = separator): string {
  if (items.length > 5) return items.slice(0, 5).join(separator) + rest(items.length - 5);
  return items.length > 1 ? `${items.slice(0, -1).join(separator)}${last}${items[items.length - 1]}` : items.join('');
}

/**
 * The protocol with media nodes offered: add_node may also name the given kinds, and one line says what a media node
 * is and how to write one. Without kinds it is the protocol unchanged, so a workspace that cannot generate media is
 * never told about media nodes.
 */
export function withMediaNodes(protocol: string, kinds: ReadonlyArray<MediaKind>): string {
  const offered = MEDIA_PLAN_TEMPLATE_IDS.filter(kind => kinds.includes(kind));
  if (!offered.length) return protocol;
  const names = offered.map(kind => `${kind}=${MEDIA_KIND_WORDS[kind]}`).join('、');
  const line = `媒体节点（templateId 为 ${names}）：只在需求明确需要生成这类素材时添加，每个素材一个节点；在 inputValues.prompt 写这个素材完整、具体的生成提示词`
    + '（主体、风格、构图或镜头、材质与配色；3D 模型只写单个物体或角色，不超过 1000 字），不写 persona、constraints、acceptanceCriteria 和其他输入。'
    + '媒体节点的输出端口 ID 为 result（图片、视频为对应类型，3D 模型为 file），图片节点和 3D 模型节点另有 reference 输入，可接上游图片节点的 result 作为参考图（按图改图、按图生成 3D 模型；先出角色或产品图、再做 3D 时就这样连）；视频节点的 reference 输入可接多个上游图片节点（每个要在视频里保持样子的人物、物品、场景各一条线）；连线只能接到类型相同的输入。'
    + '画布运行会按连线顺序生成媒体节点：提示词是节点自己的提示词，后面接上连到它 context 输入的上游文字；每次生成计入当天的生成次数。已有媒体节点的提示词用 set_input 的 fieldId:"prompt" 修改。';
  return protocol.split('\n').flatMap(text => text.startsWith('add_node:')
    ? [text.replace('|"review"', `|"review"${offered.map(kind => `|"${kind}"`).join('')}`), line] : [text]).join('\n');
}
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
/** A task-requirement list: strings within the task frame's limits (taskFrame.ts, task_frame.go). Blank entries are
 *  kept here and dropped when the frame is cleaned; the frame's total is checked once both lists are known. */
function textList(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.length > TASK_FRAME_MAX_ENTRIES) fail(`${location}必须是数组，最多 ${TASK_FRAME_MAX_ENTRIES} 项。`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || Array.from(item).length > TASK_FRAME_MAX_ENTRY_LENGTH) fail(`${location}第 ${index + 1} 项必须是字符串，最多 ${TASK_FRAME_MAX_ENTRY_LENGTH} 字符。`);
    return item;
  });
}
function optionalList(raw: Record<string, unknown>, key: 'constraints' | 'acceptanceCriteria', location: string): Partial<Record<typeof key, string[]>> {
  return Object.hasOwn(raw, key) ? { [key]: textList(raw[key], `${location}.${key}`) } : {};
}
const EFFORT_LEVEL = /^[a-z][a-z0-9_-]{0,31}$/;
/** A team member's text, counted in characters as the team editor (nodeTeam.ts) and the plan gate (planning.go) count it. */
function memberText(value: unknown, location: string, max: number, empty: boolean): string {
  if (typeof value !== 'string' || Array.from(value).length > max || (!empty && !value.trim())) fail(`${location}必须是${empty ? '' : '非空'}字符串，最多 ${max} 字符。`);
  return value;
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
        keys(op, ['type', 'ref', 'templateId', 'title', 'persona', 'inputValues', 'constraints', 'acceptanceCriteria'], location);
        const ref = id(op.ref, `${location}.ref`);
        if (refs.has(ref)) fail(`重复的新增节点引用「${ref}」。`);
        refs.add(ref);
        if (!AGENT_TEMPLATES.some(item => item.id === op.templateId) && !isMediaTemplate(op.templateId)) fail(`${location}.templateId不是可用模板。`);
        let inputValues: Record<string, string> | undefined;
        if (Object.hasOwn(op, 'inputValues')) {
          const values = object(op.inputValues, `${location}.inputValues`);
          if (Object.keys(values).length > LIMITS.fields) fail(`${location}输入字段过多。`);
          inputValues = Object.create(null) as Record<string, string>;
          for (const [key, value] of Object.entries(values)) inputValues[id(key, '输入字段 ID')] = text(value, `${location}.inputValues.${key}`, LIMITS.value);
        }
        return { type: 'add_node', ref, templateId: op.templateId as PlanTemplateId,
          ...optionalText(op, 'title', LIMITS.title, location, false), ...optionalText(op, 'persona', LIMITS.persona, location),
          ...(inputValues ? { inputValues } : {}), ...optionalList(op, 'constraints', location), ...optionalList(op, 'acceptanceCriteria', location),
        };
      }
      case 'set_task': {
        keys(op, ['type', 'nodeId', 'constraints', 'acceptanceCriteria'], location);
        if (!Object.hasOwn(op, 'constraints') && !Object.hasOwn(op, 'acceptanceCriteria')) fail(`${location}没有要修改的任务要求。`);
        return { type: 'set_task', nodeId: nodeId(), ...optionalList(op, 'constraints', location), ...optionalList(op, 'acceptanceCriteria', location) };
      }
      case 'set_model': {
        keys(op, ['type', 'nodeId', 'model', 'effort'], location);
        // Counted in characters, as the plan gate counts it (planning.go), so a name both accept is the same name.
        if (typeof op.model !== 'string' || Array.from(op.model).length > LIMITS.title || !op.model.trim()) fail(`${location}.model必须是非空字符串，最多 ${LIMITS.title} 字符。`);
        const model = op.model;
        if (Object.hasOwn(op, 'effort') && (typeof op.effort !== 'string' || (op.effort !== '' && !EFFORT_LEVEL.test(op.effort)))) fail(`${location}.effort不是有效的思考强度档位。`);
        return { type: 'set_model', nodeId: nodeId(), model: model.trim(), ...(typeof op.effort === 'string' && op.effort ? { effort: op.effort } : {}) };
      }
      case 'set_team': {
        if (Object.hasOwn(op, 'template')) {
          keys(op, ['type', 'nodeId', 'template'], location);
          if (!isNodeTeamTemplateId(op.template)) fail(`${location}.template不是可用的协作团队模板。`);
          return { type: 'set_team', nodeId: nodeId(), template: op.template };
        }
        keys(op, ['type', 'nodeId', 'mode', 'maxRounds', 'members'], location);
        if (!NODE_TEAM_MODES.includes(op.mode as NodeTeamMode)) fail(`${location}.mode必须是 sequential、parallel、debate 或 review。`);
        if (Object.hasOwn(op, 'maxRounds') && (typeof op.maxRounds !== 'number' || !Number.isInteger(op.maxRounds) || op.maxRounds < 1 || op.maxRounds > TEAM_LIMITS.rounds)) {
          fail(`${location}.maxRounds必须是 1 到 ${TEAM_LIMITS.rounds} 之间的整数。`);
        }
        if (!Array.isArray(op.members) || op.members.length < 1 || op.members.length > TEAM_LIMITS.members) fail(`${location}.members必须有 1 到 ${TEAM_LIMITS.members} 位成员。`);
        if (op.mode === 'review' && op.members.length < 2) fail(`${location}审核模式至少需要两位成员。`);
        const names = new Set<string>();
        const members = op.members.map((value, index): NodeTeamMemberBrief => {
          const at = `${location}.members[${index}]`;
          const member = object(value, at);
          keys(member, ['name', 'role', 'instructions'], at);
          const name = memberText(member.name, `${at}.name`, TEAM_LIMITS.name, false).trim();
          if (names.has(name)) fail(`${location}有重名成员「${name}」。`);
          names.add(name);
          return { name, role: memberText(member.role, `${at}.role`, TEAM_LIMITS.role, false).trim(),
            instructions: Object.hasOwn(member, 'instructions') ? memberText(member.instructions, `${at}.instructions`, TEAM_LIMITS.instructions, true) : '' };
        });
        return { type: 'set_team', nodeId: nodeId(), mode: op.mode as NodeTeamMode, ...(typeof op.maxRounds === 'number' ? { maxRounds: op.maxRounds } : {}), members };
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
    if (!from || !output || !input) fail(`连线「${edge.id}」引用的节点或字段不存在；请先显式 disconnect。`);
    // The rule the canvas and the run use (canFeed here, edgeTypesFit in the API): the same type, or a picture, clip or
    // 3D model from a media node into a text input. The edge keeps its source's type.
    if (!canFeed(from, output, input) || edge.dataType !== output.dataType) fail(`连线「${edge.id}」类型不匹配；请先显式 disconnect 后修改字段并重新连接。`);
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

/** A media node takes one input, its prompt: the draft its next Send generates from, cut to what its model takes. */
function setMediaPrompt(node: SessionNode, fieldId: string, value: string, media: CanvasPlanMedia | undefined, adjust: Adjust): void {
  if (fieldId.replace(/^in:/, '').trim().toLowerCase() !== 'prompt') {
    adjust(`没有填写「${titleOf(node)}」的「${fieldId}」：媒体节点只接受提示词（prompt）`,
      `Left “${fieldId}” on “${titleOf(node)}” unfilled: a media node takes only its prompt`);
    return;
  }
  const max = media?.promptMax(node.model) ?? LIMITS.value;
  const characters = Array.from(value.trim());
  if (characters.length > max) adjust(`「${titleOf(node)}」的提示词超过 ${max} 字，已截断`, `The prompt of “${titleOf(node)}” was over ${max} characters and was shortened`);
  node.threads = updateNodeDraft(node, characters.slice(0, max).join('')).threads;
}

/** Say that a text the plan's context showed only in part was left as it is (zhName / enName: the text's name). */
function keptPartialAdjust(node: CanvasNode, zhName: string, enName: string, adjust: Adjust): void {
  adjust(`没有改动「${titleOf(node)}」的「${zhName}」：画布内容较多，这次规划只给助手看了它的开头。要改它，可以直接在节点里改，或在请求里写明这个节点的名称`,
    `Left the ${enName} of “${titleOf(node)}” as it was: the canvas is large, and this plan showed the assistant only its beginning. To change it, edit it in the node, or name the node in your request`);
}
/** Say that a text was left as it was because it copied text the plan's context showed only in part; on a node the plan
 *  adds (`added`), that the node was added without it. */
function copiedAdjust(node: CanvasNode, zhName: string, enName: string, adjust: Adjust, added = false): void {
  if (added) adjust(`新增的「${titleOf(node)}」没有写入「${zhName}」：方案给的内容抄了只显示了开头的文字`,
    `Added “${titleOf(node)}” without the ${enName} the plan gave it: that text copied text the plan saw only in part`);
  else adjust(`没有改动「${titleOf(node)}」的「${zhName}」：新的内容抄了只显示了开头的文字`,
    `Left the ${enName} of “${titleOf(node)}” as it was: the new text copied text the plan saw only in part`);
}

/** What a plan made from a shortened view of the canvas may not write (PlanContextCondensed): `partial` says which fields
 *  of the node it is applied to the view showed only in part; copied shortened text is refused everywhere. `added`: the
 *  node is one the plan adds. */
interface ShownInPart { partial: (field: string) => boolean; added?: boolean }

/** Fill one input, or say why it was left alone: a field that is not there, or a value its type does not take,
 *  costs that one value rather than the whole plan. Outputs are never reached from here. `shown`: the plan came from a
 *  shortened view, whose fields shown only in part stay as they are. */
function setInput(node: CanvasNode, fieldId: string, value: string, adjust: Adjust, media?: CanvasPlanMedia, shown?: ShownInPart): void {
  if (shown && carriesCondensedText(value)) { copiedAdjust(node, fieldId, fieldId, adjust, shown.added); return; }
  if (node.kind === 'session' && mediaKindOf(node.agentKind)) {
    if (shown?.partial('input:prompt')) { keptPartialAdjust(node, canvasText('zh', 'planning.mediaPrompt'), canvasText('en', 'planning.mediaPrompt'), adjust); return; }
    setMediaPrompt(node, fieldId, value, media, adjust);
    return;
  }
  const fields: ReadonlyArray<{ id: string; label: string; value: string }> | undefined = node.kind === 'form' ? node.fields : nodeContract(node)?.inputs;
  const field = fields && namedField(fields, fieldId, 'in:');
  if (!field) {
    adjust(`没有填写「${titleOf(node)}」的「${fieldId}」：它没有这个输入`, `Left “${fieldId}” on “${titleOf(node)}” unfilled: it has no such input`);
    return;
  }
  if (shown?.partial(`input:${field.id}`)) { keptPartialAdjust(node, field.label || field.id, field.label || field.id, adjust); return; }
  if (node.kind === 'session') {
    const errors = validateContractFields([{ ...field as ContractField, required: false, value }]);
    if (errors.length) {
      const name = field.label || field.id;
      adjust(`没有填写「${titleOf(node)}」的「${name}」：${errors.join(' ')}`, `Left “${name}” on “${titleOf(node)}” unfilled: the value does not fit this field`);
      return;
    }
  }
  (field as { value: string }).value = value;
}

/** The contract type a new input needs to take a delivery from this output. */
function inputTypeFor(from: CanvasNode, output: PortSpec): ContractFieldType | null {
  if (from.kind === 'session' && from.contract) return from.contract.outputs.find(field => `out:${field.id}` === output.id)?.type ?? null;
  if (output.dataType === 'text') return 'markdown';
  // A picture, a clip or a sound from a media node is read through a text input (canFeed): the page gets the files' paths.
  if (isMediaSessionNode(from) && output.id === 'result' && (output.dataType === 'image' || output.dataType === 'video' || output.dataType === 'audio')) return 'markdown';
  return output.dataType === 'number' || output.dataType === 'boolean' || output.dataType === 'file' ? output.dataType : null;
}

/**
 * Make the connection a plan asked for. Models often wire a second source into an input that already has one,
 * point at an input of another type, or name an input the node does not have; each of those used to fail the
 * whole plan after its call was spent. Here the target gets an input of its own for that delivery instead, and
 * the change is said. A connection that cannot be made at all (no such output, a loop) is left out and said.
 * `copied`: whether a text copies one the plan's context showed only in part, which never names a new input.
 */
function connectPlanned(draft: CanvasDocument, from: CanvasNode, to: CanvasNode, op: Extract<CanvasPlanOperation, { type: 'connect' }>, locale: UiLocale, adjust: Adjust,
  copied: (text: string) => boolean): void {
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
  // A picture or a clip into an input the plan typed as a file: a media result feeds a text input (canFeed), so that
  // input, still empty and unwired, becomes a text input under the plan's own name, instead of a second input beside
  // it that nothing would ever fill.
  const retyped = wanted && to.kind === 'session' && isMediaSessionNode(from) && output.id === 'result'
    && (output.dataType === 'image' || output.dataType === 'video' || output.dataType === 'audio')
    ? to.contract?.inputs.find(field => `in:${field.id}` === wanted.id && field.type === 'file' && !String(field.value ?? '').trim())
    : undefined;
  if (wanted && retyped && !draft.edges.some(edge => edge.toNode === to.id && edge.toPort === wanted.id)) {
    retyped.type = 'markdown';
    if (canConnect(draft.nodes, draft.edges, start, { nodeId: to.id, portId: wanted.id }) && link(wanted.id)) {
      const name = retyped.label || retyped.id;
      adjust(`「${toTitle}」的「${name}」改为文本输入，用来接收「${fromTitle}」的图片或视频`,
        `“${name}” on “${toTitle}” is now a text input, so it takes the picture or clip from “${fromTitle}”`);
      return;
    }
    retyped.type = 'file';
  }
  // The plan named an input that already has another source, and this delivery already reaches the node through an
  // input of its own (an earlier repair, or the same plan sent again): nothing to add, rather than another copy of
  // that input. An input the plan names that the node lacks is still created under that name.
  if (wanted && draft.edges.some(edge => edge.fromNode === from.id && edge.fromPort === output.id && edge.toNode === to.id)) return;
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
  const label = (!wanted && !NEW_FIELD_ID.test(requested) && requested.trim() && !copied(requested) ? requested.trim()
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
  const reason = !wanted && copied(op.toField) ? [`「${toTitle}」原来没有方案写的那个输入`, `“${toTitle}” had no input of the name the plan wrote`]
    : !wanted ? [`「${toTitle}」原来没有输入「${op.toField}」`, `“${toTitle}” had no input “${op.toField}”`]
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
    if (from && output && input && canFeed(from, output, input) && output.dataType === edge.dataType) return true;
    const left = from ? titleOf(from) : edge.fromNode; const right = to ? titleOf(to) : edge.toNode;
    adjust(`已断开「${left}」→「${right}」：相连的字段被删除或改了类型`, `Disconnected “${left}” → “${right}”: a field it used was removed or changed type`);
    return false;
  });
}

/** The constraint texts several Agent nodes share (typically a request copied to every node a plan added), named @R1,
 *  @R2 … in the order they first appear. The planner reads each shared text once (canvasPlanning.ts) and writes its
 *  name to keep it; the same table, built from the same document, expands the names when the plan is applied. */
export function sharedRequirements(doc: CanvasDocument): Map<string, string> {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const node of doc.nodes) {
    if (node.kind !== 'session' || !isTaskFrame(node.taskFrame)) continue;
    for (const item of new Set(node.taskFrame.constraints)) {
      if (!item.trim()) continue;
      if (!counts.has(item)) order.push(item);
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
  }
  const table = new Map<string, string>();
  for (const item of order) if ((counts.get(item) ?? 0) > 1) table.set(`@R${table.size + 1}`, item);
  return table;
}
const REQUIREMENT_REF = /^@R\d+$/;
/** What a plan's team for `node` should be told about, against the team the node had before the plan (`previous`): rounds
 *  cut to fit one run's calls; members with a model of their own who left; and where the team runs, for a member
 *  without a model of its own inherits the node's only on the node's runtime as the API resolves it
 *  (runtime_workers.go resolveTeam), and one elsewhere gets that runtime's default model. */
function teamNotes(node: SessionNode, team: NodeTeam, previous: NodeTeam | undefined, asked: number, adjust: Adjust): void {
  const title = titleOf(node);
  if (team.maxRounds < asked) adjust(`「${title}」的 ${team.members.length} 人团队按 ${asked} 轮要超过一次运行最多 ${NODE_TEAM_MAX_CALLS} 次模型调用，已改为 ${team.maxRounds} 轮`,
    `The team of ${team.members.length} on “${title}” would need more than the ${NODE_TEAM_MAX_CALLS} model calls one run may make in ${asked} rounds, so it has ${team.maxRounds}`);
  // Members the user put on a model of their own who are not in the team: their choice goes with them.
  const dropped = (previous?.members ?? []).filter(member => member.model && !team.members.some(kept => kept.id === member.id));
  if (dropped.length) adjust(`「${title}」换了团队成员：原来单独选了模型的${dropped.map(member => `「${member.name}」`).join('、')}不在新团队里`,
    `The team of “${title}” changed: ${dropped.map(member => `“${member.name}”`).join(', ')}, with a model of ${dropped.length === 1 ? 'its' : 'their'} own, ${dropped.length === 1 ? 'is' : 'are'} not in it`);
  const where = nodeTeamRuntimeLabel(team.runtime);
  const apart = team.members.filter(member => !member.model && (member.runtime || team.runtime) !== inheritingRuntime(node));
  if (apart.length) adjust(`「${title}」的团队仍在 ${where} 上运行（有成员单独设置了执行框架、模型或工具）：${apart.map(member => `「${member.name}」`).join('、')}没有单独设置模型，使用所在执行框架的默认模型，不继承节点的模型`,
    `The team of “${title}” stays on ${where} (a member has a runtime, a model or tools of its own): ${apart.map(member => `“${member.name}”`).join(', ')} ${apart.length === 1 ? 'has' : 'have'} no model of ${apart.length === 1 ? 'its' : 'their'} own and ${apart.length === 1 ? 'uses' : 'use'} that runtime’s default model, not the node’s`);
  else if (previous && previous.runtime !== team.runtime) adjust(`「${title}」的团队改在节点所在的 ${where} 上运行，成员继承节点的模型`,
    `The team of “${title}” now runs on ${where}, where the node runs, and its members inherit the node’s model`);
}

/** The model a set_model may name for the workspace's default: the node then runs the server's default model. */
export const DEFAULT_MODEL_REFERENCE = 'default';

/** Validate against a private clone, then return one complete document. No partial writes: an operation that
 *  cannot apply as written is either repaired or left out, and each such case is listed in `adjustments`. On a
 *  `hosted` canvas a frontend node the plan adds delivers one html page (hostedPageOutputs), and where `pageSkills`
 *  it runs with the design skills while they fit (HOSTED_PAGE_SKILLS). A set_team applies only where the host runs node
 *  teams (`teams`) and the request the plan was made from offered set_team (planOffersTeams). */
export function applyCanvasPlan(doc: CanvasDocument, value: CanvasPlan, locale: UiLocale = 'zh', originalRequest = '', media?: CanvasPlanMedia,
  models?: CanvasPlanModels, hosted = false, pageSkills = hosted, teams = false): AppliedCanvasPlan {
  const plan = parseCanvasPlan(value);
  const teamsOffered = planOffersTeams(value);
  // Every note is kept, so the count the panel gives of those it does not show is true.
  const adjustments: string[] = [];
  const adjust: Adjust = (zh, en) => { adjustments.push(locale === 'en' ? en : zh); };
  // Task requirements the plan gave a node it adds (with add_node, or a set_task after it) and that were not written are
  // said apart from that list, before it, in at most four notes that name the nodes (five, the rest counted), so that
  // no other note pushes them out of what the reader is shown (PLAN_NOTES_SHOWN): media nodes given task lists (they
  // have none), lists that copied shortened text, lists that did not fit, and requirement names the canvas does not
  // have. Each note names a node once, with every list it lost; a node the plan removes again is not named.
  type Lost = { node: CanvasNode; lists: TaskLists };
  const mediaGiven = new Map<string, Lost & { kind: MediaKind }>();
  const copiedFor = new Map<string, Lost>();
  const tooLongFor = new Map<string, Lost>();
  const unknownFor = new Map<string, { node: CanvasNode; names: Set<string> }>();
  const lose = (group: Map<string, Lost>, node: CanvasNode, lists: TaskLists | undefined) => {
    if (!lists) return;
    const entry = group.get(node.id);
    if (entry) entry.lists = joinLists(entry.lists, lists);
    else group.set(node.id, { node, lists });
  };
  const loseMedia = (node: CanvasNode, kind: MediaKind, lists: TaskLists | undefined) => {
    if (!lists) return;
    const entry = mediaGiven.get(node.id);
    if (entry) entry.lists = joinLists(entry.lists, lists);
    else mediaGiven.set(node.id, { node, kind, lists });
  };
  const loseName = (node: CanvasNode, name: string) => {
    const entry = unknownFor.get(node.id);
    if (entry) entry.names.add(name);
    else unknownFor.set(node.id, { node, names: new Set([name]) });
  };
  // A plan made from a shortened view of the canvas leaves what that view showed only in part as it is, and writes no
  // text copied from a shortened one. In any other plan such words are the reader's own, written as given.
  const condensed = planContextCondensed(value);
  const shownOf = (node: CanvasNode, added = false): ShownInPart | undefined => condensed && { partial: field => condensed.get(node.id)?.has(field) ?? false, added };
  const copied = (text: string | undefined) => condensed !== undefined && carriesCondensedText(text);
  const requestCharacters = Array.from(originalRequest);
  if (requestCharacters.length > TASK_FRAME_MAX_TOTAL_LENGTH) fail('原始请求超过任务要求的长度限制。');
  const constraints: string[] = [];
  if (originalRequest.trim()) {
    for (let start = 0; start < requestCharacters.length; start += TASK_FRAME_MAX_ENTRY_LENGTH) {
      constraints.push(requestCharacters.slice(start, start + TASK_FRAME_MAX_ENTRY_LENGTH).join(''));
    }
  }
  const draft = structuredClone(doc);
  // The shared requirement names the planner saw, from the document it was shown.
  const requirements = sharedRequirements(doc);
  // A wire whose field was deleted or retyped by hand is not drawn, so it cannot be disconnected; it is dropped
  // here as the board drops it, instead of failing every later plan.
  const base = { ...doc, edges: reconcileEdges(doc.nodes, doc.edges) };
  const stale = draft.edges.length - base.edges.length;
  if (stale > 0) adjust(`清理了 ${stale} 条已失效的连线：相连的字段已被删除或改了类型`, `Removed ${stale} stale connection(s) whose field was removed or changed type`);
  draft.edges = structuredClone(base.edges);
  const originalIds = new Set(doc.nodes.map(node => node.id));
  const refs = new Map<string, string>();
  // New-node refs left out (a media kind this workspace cannot generate); each was said once, so steps naming one skip.
  const skipped = new Set<string>();
  const addedNodeIds: string[] = [];
  const modelSetNodeIds = new Set<string>();
  // Each node's team before this plan, and the nodes this plan gave a team (set_team).
  const originalTeams = new Map(doc.nodes.flatMap(node => node.kind === 'session' && node.team ? [[node.id, node.team] as const] : []));
  const teamedHere = new Set<string>();
  // The rounds each node's last set_team asked for, against which its team is said to have been cut.
  const teamAsked = new Map<string, number>();
  const find = (reference: string): CanvasNode | undefined => draft.nodes.find(item => item.id === (refs.get(reference) ?? reference));
  const resolve = (reference: string): CanvasNode => {
    const node = find(reference);
    if (!node) fail(`节点引用「${reference}」不在当前画布，或尚未创建 / 已删除。`);
    return node;
  };
  // A shared requirement's name stands for its text; a name the canvas does not have is left out, and said (to `skip`
  // when given one).
  const expand = (node: CanvasNode, items: string[], skip?: (name: string) => void) => items.flatMap(item => {
    const named = requirements.get(item.trim());
    if (named !== undefined) return [named];
    if (REQUIREMENT_REF.test(item.trim())) {
      if (skip) skip(item.trim());
      else adjust(`跳过了「${titleOf(node)}」的约束「${item.trim()}」：画布上没有这条原始需求`, `Skipped the constraint “${item.trim()}” on “${titleOf(node)}”: the canvas has no such requirement`);
      return [];
    }
    return [item];
  });
  // A connection to a node the plan only creates further on is made once every other step has run.
  const later: Array<Extract<CanvasPlanOperation, { type: 'connect' }>> = [];
  for (const op of plan.operations) {
    switch (op.type) {
      case 'add_node': {
        if (originalIds.has(op.ref) || draft.nodes.some(node => node.id === op.ref)) fail(`新增引用「${op.ref}」与已有节点 ID 冲突。`);
        if (isMediaTemplate(op.templateId)) {
          // A media node is a generator, not a role: no persona, contract or task frame; its prompt is its draft, and it
          // generates when the user sends it.
          const kind = op.templateId;
          const model = media?.models[kind];
          const label = canvasText(locale, kind === 'video' ? 'node.video' : kind === 'model3d' ? 'node.model3d' : 'node.image');
          if (!model) {
            skipped.add(op.ref);
            adjust(`没有添加「${op.title ?? label}」：此工作区现在不能生成${MEDIA_KIND_WORDS[kind]}`,
              `Did not add “${op.title ?? label}”: this workspace cannot generate ${kind === 'model3d' ? '3D models' : `${kind}s`} now`);
            break;
          }
          const node: SessionNode = { ...createSessionNode(kind, { x: 0, y: 0 }), title: copied(op.title) ? label : op.title ?? label, model };
          if (copied(op.title)) copiedAdjust(node, '名称', 'title', adjust, true);
          // It has no task frame, so task lists given it are said to be left out rather than dropped without a word.
          loseMedia(node, kind, givenLists(Boolean(op.constraints?.some(item => item.trim())), Boolean(op.acceptanceCriteria?.some(item => item.trim()))));
          for (const [fieldId, value] of Object.entries(op.inputValues ?? {})) setInput(node, fieldId, value, adjust, media, shownOf(node, true));
          draft.nodes.push(node); refs.set(op.ref, node.id); addedNodeIds.push(node.id);
          break;
        }
        const node = createAgentTemplate(op.templateId, { x: 0, y: 0 }, locale);
        if (hosted && op.templateId === HOSTED_PAGE_TEMPLATE_ID && node.contract) {
          node.contract = { ...node.contract, outputs: hostedPageOutputs(locale) };
          node.persona = hostedPagePersona(locale);
          if (pageSkills) node.skills = [...HOSTED_PAGE_SKILLS];
        }
        // A new node never takes text copied from one the plan's context showed only in part; what it is added
        // without is said under the name it gets.
        if (copied(op.title)) copiedAdjust(node, '名称', 'title', adjust, true);
        else if (op.title !== undefined) node.title = op.title;
        let persona = op.persona;
        if (copied(persona)) { copiedAdjust(node, '人设', 'persona', adjust, true); persona = undefined; }
        // Task lists that copy shortened text are left out whole (said with the grouped notes).
        const copiedCriteria = Boolean(op.acceptanceCriteria?.some(copied));
        const copiedOwn = Boolean(op.constraints?.some(copied));
        const criteria = copiedCriteria ? undefined : op.acceptanceCriteria;
        const own = copiedOwn ? undefined : op.constraints;
        lose(copiedFor, node, givenLists(copiedOwn, copiedCriteria));
        // Carry the human's exact request separately from the model-authored persona.
        // Every new downstream reviewer receives it even if an upstream draft drifts. Constraints the plan gives the new
        // node come after it (the request is the node's own first constraint, never replaced by them).
        const added = own ? [...new Set(expand(node, own, name => loseName(node, name)))].filter(item => !constraints.includes(item)) : [];
        // Whether what is kept of the plan's constraints holds a shared requirement's text (named or written out).
        const shared = new Set(requirements.values());
        const namesRequirement = added.some(item => shared.has(item));
        if (constraints.length || added.length || criteria?.length) {
          const frameOf = (own: string[], checks: string[]) => cleanTaskFrame({ version: 1, source: 'manual', constraints: [...constraints, ...own], acceptanceCriteria: [...checks] });
          // The request is always kept whole; of the plan's own constraints and acceptance criteria, what would push the
          // frame past its limits is left out: one list where the other fits beside the request (the checks the plan
          // wrote kept, unless what is kept of its constraints holds a shared requirement's text, the user's own words),
          // else both.
          const tooLong = (lists: TaskLists) => lose(tooLongFor, node, lists);
          const whole = frameOf(added, criteria ?? []);
          const both = Boolean(added.length && criteria?.length);
          const checksFit = both && !taskFrameError(frameOf([], criteria ?? []));
          const ownFit = both && !taskFrameError(frameOf(added, []));
          if (!taskFrameError(whole)) node.taskFrame = whole;
          else if (ownFit && (!checksFit || namesRequirement)) {
            tooLong('criteria');
            node.taskFrame = frameOf(added, []);
          } else if (checksFit) {
            tooLong('constraints');
            node.taskFrame = frameOf([], criteria ?? []);
          } else {
            tooLong(both ? 'both' : added.length ? 'constraints' : 'criteria');
            if (constraints.length) node.taskFrame = { version: 1, source: 'manual', constraints: [...constraints], acceptanceCriteria: [] };
          }
        }
        // A figure node's page is built with AwwO's figure kit: a planned persona replaces its role, never the guide.
        if (persona !== undefined) node.persona = op.templateId === 'figure' ? figurePersona(persona) : persona;
        for (const [fieldId, value] of Object.entries(op.inputValues ?? {})) setInput(node, fieldId, value, adjust, undefined, shownOf(node, true));
        draft.nodes.push(node); refs.set(op.ref, node.id); addedNodeIds.push(node.id);
        break;
      }
      case 'update_node': {
        if (skipped.has(op.nodeId)) break;
        const node = resolve(op.nodeId);
        if (op.persona !== undefined && node.kind !== 'session') fail('表单节点不能设置 persona。');
        if (copied(op.title)) copiedAdjust(node, '名称', 'title', adjust);
        else if (op.title !== undefined) node.title = op.title;
        if (op.persona !== undefined && node.kind === 'session' && !mediaKindOf(node.agentKind)) {
          if (shownOf(node)?.partial('persona')) keptPartialAdjust(node, '人设', 'persona', adjust);
          else if (copied(op.persona)) copiedAdjust(node, '人设', 'persona', adjust);
          else node.persona = node.templateId === 'figure' ? figurePersona(op.persona) : op.persona;
        }
        break;
      }
      case 'set_task': {
        if (skipped.has(op.nodeId)) break;
        const node = resolve(op.nodeId);
        // What a node this plan adds does not get is said with the grouped notes; for any other node, in the list.
        const isNew = addedNodeIds.includes(node.id);
        const kind = node.kind === 'session' ? mediaKindOf(node.agentKind) : null;
        if (node.kind !== 'session' || kind) {
          if (isNew && kind) loseMedia(node, kind, givenLists(Boolean(op.constraints?.some(item => item.trim())), Boolean(op.acceptanceCriteria?.some(item => item.trim()))));
          else adjust(`没有改动「${titleOf(node)}」的任务要求：只有 Agent 节点有任务要求`, `Left “${titleOf(node)}” as it was: only an Agent node has task requirements`);
          break;
        }
        if (node.taskFrame !== undefined && !isTaskFrame(node.taskFrame)) {
          adjust(`没有改动「${titleOf(node)}」的任务要求：它们的版本不能在这里修改`, `Left the task requirements of “${titleOf(node)}” as they were: their version cannot be edited here`);
          break;
        }
        const current: TaskFrame = isTaskFrame(node.taskFrame) ? node.taskFrame : { version: 1, source: 'manual', constraints: [], acceptanceCriteria: [] };
        // A list the plan's context showed only in part, or one that copies such text, stays as it is.
        const kept = (list: string[] | undefined, field: 'constraints' | 'acceptanceCriteria', zh: string, en: string) => {
          if (!list) return false;
          if (shownOf(node)?.partial(field)) keptPartialAdjust(node, zh, en, adjust);
          else if (list.some(copied)) {
            if (isNew) lose(copiedFor, node, field === 'constraints' ? 'constraints' : 'criteria');
            else copiedAdjust(node, zh, en, adjust);
          } else return false;
          return true;
        };
        const setConstraints = kept(op.constraints, 'constraints', '约束', 'constraints') ? undefined : op.constraints;
        const setCriteria = kept(op.acceptanceCriteria, 'acceptanceCriteria', '验收标准', 'acceptance criteria') ? undefined : op.acceptanceCriteria;
        // A node this plan adds keeps the user's request as its first constraint, as add_node gives it: the constraints
        // a set_task gives it replace only those after it.
        const nextConstraints = setConstraints && (isNew
          ? [...constraints, ...new Set(expand(node, setConstraints, name => loseName(node, name)).filter(item => !constraints.includes(item)))]
          : expand(node, setConstraints));
        const next = cleanTaskFrame({ ...current, ...(nextConstraints ? { constraints: nextConstraints } : {}),
          ...(setCriteria ? { acceptanceCriteria: [...setCriteria] } : {}) });
        if (taskFrameError(next)) {
          if (isNew) lose(tooLongFor, node, givenLists(Boolean(setConstraints?.some(item => item.trim())), Boolean(setCriteria?.some(item => item.trim()))));
          else adjust(`没有改动「${titleOf(node)}」的任务要求：超过了长度限制（每个列表最多 ${TASK_FRAME_MAX_ENTRIES} 条，合计最多 ${TASK_FRAME_MAX_TOTAL_LENGTH} 字）`,
            `Left the task requirements of “${titleOf(node)}” as they were: they exceed the limits (${TASK_FRAME_MAX_ENTRIES} entries per list, ${TASK_FRAME_MAX_TOTAL_LENGTH} characters in all)`);
          break;
        }
        node.taskFrame = next;
        break;
      }
      case 'set_model': {
        if (skipped.has(op.nodeId)) break;
        const node = resolve(op.nodeId);
        const title = titleOf(node);
        if (node.kind !== 'session' || mediaKindOf(node.agentKind)) {
          adjust(`没有改动「${title}」的模型：图片、视频和 3D 节点由媒体模型生成，表单没有模型`, `Left the model of “${title}” as it was: image, video and 3D nodes use media models, and a form has none`);
          break;
        }
        // A team this plan gave a node that had none follows the model wherever the plan puts it, as it would have had the
        // plan set the model first: its members are all new and inherit the node's model. A team the node had before the
        // plan runs as it is set up, whatever a set_team of the plan kept of it (members' runtimes, models and tools).
        const planned = Boolean(node.team) && teamedHere.has(node.id) && !originalTeams.has(node.id);
        if ((node.team && !planned) || node.agentRef) {
          adjust(`没有改动「${title}」的模型：它是团队或工作区 Agent，按自己的设置运行`, `Left the model of “${title}” as it was: a team or a workspace Agent runs as it is set up`);
          break;
        }
        const follow = () => { if (node.team) node.team = { ...node.team, runtime: newTeamRuntime(node) }; };
        const wanted = op.model.trim();
        if (wanted.toLowerCase() === DEFAULT_MODEL_REFERENCE) { node.runtime = ''; node.model = ''; node.effort = ''; follow(); modelSetNodeIds.add(node.id); break; }
        const choices = models?.choices ?? [];
        const folded = wanted.toLowerCase();
        const id = choices.find(choice => choice.model === wanted)?.model
          ?? choices.find(choice => choice.model.toLowerCase() === folded || (choice.name ?? '').trim().toLowerCase() === folded)?.model;
        const entry = id ? automaticEntry(id, choices) : undefined;
        const own = entry ? undefined : models?.userChosen?.find(choice => choice.model === wanted
          || choice.model.toLowerCase() === folded || (choice.name ?? '').trim().toLowerCase() === folded);
        if (own) {
          const name = own.name || own.model;
          adjust(`没有把「${title}」改用「${name}」：这个模型只能由你自己在节点设置里选，助手不替你选`,
            `Did not switch “${title}” to “${name}”: only you can choose this model, in the node’s settings; the assistant does not choose it for you`);
          break;
        }
        if (!entry) {
          adjust(`没有把「${title}」改用「${wanted}」：此工作区现在没有可用的这个模型`, `Did not switch “${title}” to “${wanted}”: this workspace has no such model ready`);
          break;
        }
        // Never a model whose runtime runs no team: the team would stay behind on another runtime.
        if (planned && !NODE_TEAM_RUNTIMES.includes(entry.runtime as NodeTeamRuntime)) {
          adjust(`没有把「${title}」改用「${entry.name || entry.model}」：它的协作团队不能在这个模型的执行引擎上运行`,
            `Did not switch “${title}” to “${entry.name || entry.model}”: its team cannot run on that model’s engine`);
          break;
        }
        const effort = op.effort && entry.efforts?.includes(op.effort) ? op.effort : '';
        if (op.effort && !effort) adjust(`「${title}」改用了「${entry.name || entry.model}」，它没有「${op.effort}」这档思考强度，使用模型默认`,
          `“${title}” now uses “${entry.name || entry.model}”, which has no “${op.effort}” reasoning effort; it uses the model’s default`);
        node.runtime = entry.runtime; node.model = entry.model; node.effort = effort;
        follow();
        modelSetNodeIds.add(node.id);
        break;
      }
      case 'set_team': {
        if (skipped.has(op.nodeId)) break;
        const node = resolve(op.nodeId);
        const title = titleOf(node);
        if (!teams) {
          adjust(`没有给「${title}」配团队：此工作区现在没有能运行协作团队的执行引擎`, `Did not give “${title}” a team: this workspace has no engine that runs teams now`);
          break;
        }
        if (!teamsOffered) {
          adjust(`没有给「${title}」配团队：这份方案所依据的请求没有提供协作团队配置`, `Did not give “${title}” a team: the request this plan was made from did not offer teams`);
          break;
        }
        if (node.kind !== 'session' || mediaKindOf(node.agentKind)) {
          adjust(`没有给「${title}」配团队：只有 Agent 节点能配协作团队`, `Did not give “${title}” a team: only an Agent node can have one`);
          break;
        }
        if (node.agentRef) {
          adjust(`没有给「${title}」配团队：它使用工作区 Agent，按那个 Agent 的设置运行`, `Did not give “${title}” a team: it runs a workspace Agent as that Agent is set up`);
          break;
        }
        // A sandbox node runs one agent in its sandbox computer; the API refuses a team on it (runtime_workers.go).
        if (node.runtime === SANDBOX_RUNTIME) {
          adjust(`没有给「${title}」配团队：它在沙箱电脑里运行，只能是单个 Agent`, `Did not give “${title}” a team: it runs in a sandbox computer, as one Agent`);
          break;
        }
        // A team runs where its node runs (newTeamRuntime), which it cannot on an engine that runs no team.
        if (node.runtime && !NODE_TEAM_RUNTIMES.includes(node.runtime as NodeTeamRuntime)) {
          adjust(`没有给「${title}」配团队：它的执行引擎不能运行协作团队`, `Did not give “${title}” a team: its engine does not run teams`);
          break;
        }
        // A team the plan's context showed only in part could hold instructions the planner never read.
        if (shownOf(node)?.partial('team')) { keptPartialAdjust(node, '协作团队', 'team', adjust); break; }
        if ('members' in op && op.members.some(member => copied(member.name) || copied(member.role) || copied(member.instructions))) {
          copiedAdjust(node, '协作团队', 'team', adjust, addedNodeIds.includes(node.id));
          break;
        }
        const shape = 'template' in op ? nodeTeamTemplateShape(nodeTeamTemplate(op.template)!, locale)
          : { mode: op.mode, maxRounds: op.maxRounds ?? 2, members: op.members };
        // Against the team the node had before this plan: the user's member settings and limits are there, never in a
        // team an earlier step of the same plan wrote.
        const previous = originalTeams.get(node.id);
        const team = buildNodeTeam(shape, node, previous);
        // The editor's own checks, without a model catalogue: new members choose no model, so none can be missing.
        if (validateNodeTeam(team, undefined, locale).length) {
          adjust(`没有给「${title}」配团队：这个团队配置无效`, `Did not give “${title}” a team: the team is not valid`);
          break;
        }
        // What the team is like is said once the plan is applied, of the team the node ends with (teamNotes).
        teamAsked.set(node.id, shape.maxRounds);
        node.team = team;
        teamedHere.add(node.id);
        break;
      }
      case 'set_input': if (!skipped.has(op.nodeId)) { const node = resolve(op.nodeId); setInput(node, op.fieldId, op.value, adjust, media, shownOf(node)); } break;
      case 'add_field':
      case 'update_field':
      case 'remove_field': {
        if (skipped.has(op.nodeId)) break;
        const node = resolve(op.nodeId);
        if (node.kind !== 'session') fail('输入输出结构编辑仅适用于 Agent 节点。');
        if (mediaKindOf(node.agentKind)) {
          // An image, video or 3D node's ports are its generator's; a contract would replace them and its result.
          adjust(`没有改动「${titleOf(node)}」的输入输出：图片、视频和 3D 节点的输入输出是固定的`,
            `Left the inputs and outputs of “${titleOf(node)}” as they are: image, video and 3D nodes have fixed ones`);
          break;
        }
        const written = op.type === 'add_field' ? op.field : op.type === 'update_field' ? op.changes : undefined;
        if (written && [written.label, written.help, written.placeholder].some(copied)) {
          const name = op.type === 'add_field' ? op.field.label || op.field.id : op.fieldId;
          copiedAdjust(node, name, name, adjust);
          break;
        }
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
              `Left the existing ${sideName[1]} “${existing.label || existing.id}” on “${titleOf(node)}” as it was: the planned definition is not valid`);
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
              `Left “${fields[index].label || fields[index].id}” on “${titleOf(node)}” as it was: its content does not fit the new type`);
            else fields[index] = next;
          }
        }
        if (!normalizeContract(node.contract)) fail('输入输出结构无效。');
        disconnectBroken(draft, node.id, adjust);
        checkGraph(draft);
        break;
      }
      case 'remove_node': {
        if (skipped.has(op.nodeId)) break;
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
        const from = find(op.fromNode); const to = find(op.toNode);
        if (!from || !to) { later.push(op); break; }
        connectPlanned(draft, from, to, op, locale, adjust, copied);
        checkGraph(draft);
        break;
      }
    }
  }
  for (const op of later) {
    const from = find(op.fromNode); const to = find(op.toNode);
    if (!from || !to) {
      const missing = !from ? op.fromNode : op.toNode;
      // A media node this workspace cannot generate was already said; its connections go with it.
      if (skipped.has(missing)) continue;
      adjust(`跳过了一条连线：节点「${missing}」不在画布上`, `Skipped a connection: the node “${missing}” is not on the canvas`);
      continue;
    }
    connectPlanned(draft, from, to, op, locale, adjust, copied);
  }
  // A team the plan gave a node is described as it ends: a later set_team on the same node replaces what an earlier one
  // would have said, and a node the plan removes says nothing.
  for (const id of teamedHere) {
    const node = draft.nodes.find(item => item.id === id);
    if (node?.kind === 'session' && node.team) teamNotes(node, node.team, originalTeams.get(id), teamAsked.get(id) ?? node.team.maxRounds, adjust);
  }
  checkGraph(draft);
  checkExecution(draft);
  const added = new Set(addedNodeIds);
  // A node with the design skills whose own text, as this plan leaves it, would leave its system prompt too little room
  // runs without them rather than be refused for its size: a page the plan adds, or one whose brief, task or fields it
  // changed. A node already saved loses them only by an empty list (the server keeps a node's skills for a save that
  // leaves the list out).
  const before = new Map(doc.nodes.flatMap(node => node.kind === 'session' ? [[node.id, promptText(node)] as const] : []));
  for (const node of draft.nodes) {
    if (node.kind !== 'session' || !carriesPageSkills(node) || nodePromptUnits(node) <= HOSTED_PAGE_SKILL_ROOM) continue;
    if (added.has(node.id)) { delete node.skills; continue; }
    if (before.get(node.id) === promptText(node)) continue;
    node.skills = [];
    adjust(`「${titleOf(node)}」不再带设计技能（design-craft、anti-ai-slop）：带上它们，这个节点的说明、任务要求和交付字段会超出一次调用能发给模型的量`,
      `“${titleOf(node)}” no longer carries the design skills (design-craft, anti-ai-slop): with them, its brief, task requirements and output fields would be more than one call can send its model`);
  }
  const survivors = draft.nodes.filter(node => added.has(node.id));
  const oldNodes = draft.nodes.filter(node => !added.has(node.id));
  const right = oldNodes.length ? Math.max(...oldNodes.map(node => node.x + node.w)) + 100 : 80;
  const arranged = arrangeNodePositions(survivors, draft.edges.filter(edge => edge.kind !== 'feedback' && added.has(edge.fromNode) && added.has(edge.toNode)));
  const positions = new Map(arranged.map(node => [node.id, { x: node.x + right - 80, y: node.y }]));
  draft.nodes = draft.nodes.map(node => positions.has(node.id) ? { ...node, ...positions.get(node.id)! } : node);
  draft.updatedAt = Date.now();
  const en = locale === 'en';
  const onCanvas = new Set(draft.nodes.map(node => node.id));
  const left = <T extends { node: CanvasNode }>(group: Map<string, T>) => [...group.values()].filter(entry => onCanvas.has(entry.node.id));
  const words = (lists: TaskLists) => TASK_LIST_WORDS[lists][en ? 1 : 0];
  const notices: string[] = [];
  const mediaLost = left(mediaGiven);
  if (mediaLost.length === 1) {
    const [{ node, kind, lists }] = mediaLost;
    notices.push(en ? `“${titleOf(node)}” is a media node, which has no task requirements: the ${words(lists)} given it were left out; put requirements in its prompt`
      : `「${titleOf(node)}」是${MEDIA_KIND_WORDS[kind]}节点，没有任务要求：给它的${words(lists)}没有写入，要求请写进它的提示词`);
  } else if (mediaLost.length) {
    const what = mediaLost.every(entry => entry.lists === mediaLost[0].lists) ? words(mediaLost[0].lists) : en ? 'task requirements' : '任务要求';
    const names = mediaLost.map(({ node }) => en ? `“${titleOf(node)}”` : `「${titleOf(node)}」`);
    notices.push(en ? `${firstFive(names, ', ', more => ` and ${more} more`, ' and ')} are media nodes, which have no task requirements: the ${what} given them were left out; put requirements in their prompts`
      : `${firstFive(names, '、', () => `等 ${names.length} 个节点`)}是媒体节点，没有任务要求：给它们的${what}没有写入，要求请写进各自的提示词`);
  }
  const copiedLists = left(copiedFor);
  if (copiedLists.length === 1) {
    const [{ node, lists }] = copiedLists;
    notices.push(en ? `Added “${titleOf(node)}” without the ${words(lists)} the plan gave it: that text copied text the plan saw only in part`
      : `新增的「${titleOf(node)}」没有写入「${words(lists)}」：方案给的内容抄了只显示了开头的文字`);
  } else if (copiedLists.length) {
    const nodes = copiedLists.map(({ node, lists }) => en ? `“${titleOf(node)}” without its ${words(lists)}` : `「${titleOf(node)}」没有写入${words(lists)}`);
    notices.push(en ? `Added ${firstFive(nodes, ', ', more => ` and ${more} more node${more === 1 ? '' : 's'} without theirs`, ' and ')}: the text the plan gave them copied text it saw only in part`
      : `新增的${firstFive(nodes, '、', () => `，共 ${nodes.length} 个节点`)}：方案给的内容抄了只显示了开头的文字`);
  }
  const tooLongLists = left(tooLongFor);
  if (tooLongLists.length) {
    const lists = tooLongLists.map(({ node, lists }) => en ? `the ${words(lists)} of “${titleOf(node)}”` : `「${titleOf(node)}」的${words(lists)}`);
    const listed = en ? firstFive(lists, ', ', more => ` and those of ${more} more node${more === 1 ? '' : 's'}`, ' and ')
      : firstFive(lists, '、', () => `等 ${lists.length} 个节点的任务要求`);
    notices.push(en ? `${listed.charAt(0).toUpperCase()}${listed.slice(1)} were too long and were left out (task requirements allow ${TASK_FRAME_MAX_ENTRIES} entries per list and ${TASK_FRAME_MAX_TOTAL_LENGTH} characters in all)`
      : `${listed}太长，没有写入（每个列表最多 ${TASK_FRAME_MAX_ENTRIES} 条，合计最多 ${TASK_FRAME_MAX_TOTAL_LENGTH} 字）`);
  }
  const unknownNames = left(unknownFor);
  if (unknownNames.length) {
    const which = unknownNames.map(({ node, names }) => {
      const quoted = [...names].map(name => en ? `“${name}”` : `「${name}」`);
      return en ? `${firstFive(quoted, ', ', more => ` and ${more} more`, ' and ')} on “${titleOf(node)}”` : `「${titleOf(node)}」的约束${firstFive(quoted, '、', () => `等 ${quoted.length} 条`)}`;
    });
    notices.push(en ? `Skipped constraints that name a requirement the canvas does not have: ${firstFive(which, '; ', more => `; and on ${more} more node${more === 1 ? '' : 's'}`, '; and ')}`
      : `跳过了画布上没有的原始需求：${firstFive(which, '；', more => `；另有 ${more} 个节点`)}`);
  }
  return { doc: invalidateOutputs(base, draft), addedNodeIds: survivors.map(node => node.id), summary: plan.summary, adjustments: [...notices, ...adjustments],
    modelSetNodeIds: draft.nodes.filter(node => modelSetNodeIds.has(node.id)).map(node => node.id) };
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
