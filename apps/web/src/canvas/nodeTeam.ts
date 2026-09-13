/** Tenant-persisted collaboration contract; runtime capabilities are supplied by the host. */
export type NodeTeamMode = 'sequential' | 'parallel' | 'debate' | 'review';
export type NodeTeamRuntime = 'pi' | 'openai-agents';
export type NodeTeamTool = 'calculator' | 'current_time';
export const NODE_TEAM_RUNTIMES: readonly NodeTeamRuntime[] = ['pi', 'openai-agents'];
export const NODE_TEAM_TOOLS: readonly NodeTeamTool[] = ['calculator', 'current_time'];
export const nodeTeamRuntimeLabel = (runtime: string): string => runtime === 'pi' ? 'Pi' : runtime === 'openai-agents' ? 'OpenAI Agents JS' : runtime;
export type NodeTeamModelCatalogs = Partial<Record<NodeTeamRuntime, readonly string[]>>;
export interface NodeTeamMember {
  id: string;
  name: string;
  role: string;
  instructions: string;
  /** Empty inherits the node team's runtime. */
  runtime: '' | NodeTeamRuntime;
  /** Empty inherits the bound node model only within the same runtime, otherwise its server default. */
  model: string;
  context: 'task' | 'shared';
  tools: NodeTeamTool[];
}
export interface NodeTeam {
  version: 1;
  mode: NodeTeamMode;
  runtime: NodeTeamRuntime;
  maxRounds: number;
  maxTurns: number;
  timeoutSeconds: number;
  members: NodeTeamMember[];
}
export interface NodeTeamIssue { path: string; message: string }
export const NODE_TEAM_MODES: readonly NodeTeamMode[] = ['sequential', 'parallel', 'debate', 'review'];
const record = (raw: unknown): Record<string, unknown> | null => raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;

/** Validate before execution/save, without coercing invalid imported configuration into a run. */
export function validateNodeTeam(raw: unknown, allowedModels?: ReadonlyArray<string> | NodeTeamModelCatalogs, locale: 'zh' | 'en' = 'en'): NodeTeamIssue[] {
  const issues: NodeTeamIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });
  const message = (en: string, zh: string) => locale === 'zh' ? zh : en;
  const team = record(raw);
  if (!team) return [{ path: 'team', message: message('Team configuration must be an object.', '团队配置必须是对象。') }];
  if (team.version !== 1) issue('version', message('Unsupported team configuration version.', '不支持此团队配置版本。'));
  if (!NODE_TEAM_MODES.includes(team.mode as NodeTeamMode)) issue('mode', message('Choose a supported collaboration mode.', '请选择受支持的协作方式。'));
  if (!NODE_TEAM_RUNTIMES.includes(team.runtime as NodeTeamRuntime)) issue('runtime', message('Choose Pi or OpenAI Agents JS for the team.', '团队执行框架请选择 Pi 或 OpenAI Agents JS。'));
  for (const [key, min, max] of [['maxRounds', 1, 8], ['maxTurns', 1, 64], ['timeoutSeconds', 10, 1800]] as const) {
    if (typeof team[key] !== 'number' || !Number.isInteger(team[key]) || (team[key] as number) < min || (team[key] as number) > max) {
      const label = { maxRounds: '最多轮数', maxTurns: '最多模型调用次数', timeoutSeconds: '节点超时秒数' }[key];
      issue(key, message(`${key} must be an integer from ${min} to ${max}.`, `${label}必须是 ${min} 至 ${max} 的整数。`));
    }
  }
  if (!Array.isArray(team.members) || team.members.length < 1 || team.members.length > 8) {
    issue('members', message('A team must contain 1 to 8 members.', '团队必须包含 1 至 8 个成员。'));
    return issues;
  }
  if (team.mode === 'review' && team.members.length < 2) issue('members', message('Review mode requires a worker and a reviewer.', '审核模式至少需要一位执行者和一位审核者。'));
  if (typeof team.maxTurns === 'number' && team.maxTurns < team.members.length) issue('maxTurns', message('Allow at least one model call per member.', '调用次数上限至少需要覆盖每位成员的一次调用。'));
  const ids = new Set<string>();
  for (const [index, rawMember] of team.members.entries()) {
    const prefix = `members.${index}`;
    const member = record(rawMember);
    if (!member) { issue(prefix, message('Member configuration must be an object.', '成员配置必须是对象。')); continue; }
    for (const [field, required, max] of [['id', true, 128], ['name', true, 128], ['role', true, 512], ['instructions', false, 16000], ['model', false, 256]] as const) {
      if (typeof member[field] !== 'string' || (required && !(member[field] as string).trim()) || [...(member[field] as string)].length > max) {
        const label = { id: '成员 ID', name: '名称', role: '职责', instructions: '专属指令', model: '模型' }[field];
        issue(`${prefix}.${field}`, message(`${field} ${required ? 'is required and ' : ''}must contain at most ${max} characters.`, `${label}${required ? '不能为空，且' : ''}最多 ${max} 个字符。`));
      }
    }
    if (typeof member.id === 'string') {
      if (ids.has(member.id)) issue(`${prefix}.id`, message('Each member must have a unique ID.', '成员 ID 不能重复。'));
      ids.add(member.id);
    }
    if (member.runtime !== '' && !NODE_TEAM_RUNTIMES.includes(member.runtime as NodeTeamRuntime)) issue(`${prefix}.runtime`, message('Member runtime must inherit, use Pi, or use OpenAI Agents JS.', '成员执行框架必须继承团队默认、使用 Pi 或 OpenAI Agents JS。'));
    const runtime = (member.runtime || team.runtime) as NodeTeamRuntime;
    if (member.context !== 'task' && member.context !== 'shared') issue(`${prefix}.context`, message('Choose task-only or shared context.', '请选择仅任务上下文或共享上下文。'));
    if (!Array.isArray(member.tools) || member.tools.some(tool => !NODE_TEAM_TOOLS.includes(tool as NodeTeamTool)) || new Set(member.tools).size !== member.tools.length || (runtime !== 'openai-agents' && member.tools.length)) {
      issue(`${prefix}.tools`, message('Only OpenAI Agents JS supports the calculator and current_time tools, without duplicates. Pi tools must be empty.', '仅 OpenAI Agents JS 可使用 calculator 和 current_time 工具，且不能重复；Pi 工具列表必须为空。'));
    }
    const models = Array.isArray(allowedModels) ? allowedModels : (allowedModels as NodeTeamModelCatalogs | undefined)?.[runtime];
    if (models && typeof member.model === 'string' && member.model && !models.includes(member.model)) {
      const label = nodeTeamRuntimeLabel(runtime);
      issue(`${prefix}.model`, message(`This model is absent from the current ${label} catalog.`, `此模型不在当前 ${label} 模型清单中，请重新选择。`));
    }
  }
  return issues;
}

/** Strip unrecognised metadata/credential fields; preserve valid values and member order exactly. */
export function sanitizeNodeTeam(raw: unknown): NodeTeam | null {
  if (validateNodeTeam(raw).length) return null;
  const team = raw as NodeTeam;
  return { version: 1, mode: team.mode, runtime: team.runtime, maxRounds: team.maxRounds,
    maxTurns: team.maxTurns, timeoutSeconds: team.timeoutSeconds,
    members: team.members.map(member => ({ id: member.id, name: member.name, role: member.role,
      instructions: member.instructions, runtime: member.runtime, model: member.model, context: member.context, tools: [...member.tools] })),
  };
}
export function nodeTeamFingerprint(team?: NodeTeam): string | null {
  if (!team) return null;
  return JSON.stringify(sanitizeNodeTeam(team) ?? team);
}
export function nodeTeamTurnEstimate(team: NodeTeam): number {
  if (team.mode === 'debate') return team.members.length * team.maxRounds + 1;
  if (team.mode === 'review') return team.members.length * team.maxRounds;
  return team.members.length;
}
let sequence = 0;
export function createNodeTeamMember(overrides: Partial<Omit<NodeTeamMember, 'id' | 'tools'>> = {}): NodeTeamMember {
  sequence += 1;
  return { id: `member-${Date.now().toString(36)}-${sequence.toString(36)}`, name: 'Agent', role: 'Contributor',
    instructions: '', runtime: '', model: '', context: 'shared', ...overrides, tools: [] };
}
export function createNodeTeam(node: { title: string; persona: string; model: string; runtime?: string }, locale: 'zh' | 'en' = 'zh'): NodeTeam {
  const zh = locale === 'zh';
  return { version: 1, mode: 'sequential', runtime: NODE_TEAM_RUNTIMES.includes(node.runtime as NodeTeamRuntime) ? node.runtime as NodeTeamRuntime : 'pi', maxRounds: 2, maxTurns: 8, timeoutSeconds: 300,
    members: [
      createNodeTeamMember({ name: node.title || (zh ? '执行者' : 'Worker'), role: zh ? '执行者' : 'Worker', instructions: node.persona, model: node.model }),
      createNodeTeamMember({ name: zh ? '复核与汇总' : 'Reviewer and summarizer', role: zh ? '复核与汇总' : 'Reviewer and summarizer',
        instructions: zh ? '检查已有结果，指出遗漏，汇总为符合节点输出要求的最终结果。' : 'Check the available results, identify omissions, and produce a final result that satisfies the node output requirements.' }),
    ],
  };
}
