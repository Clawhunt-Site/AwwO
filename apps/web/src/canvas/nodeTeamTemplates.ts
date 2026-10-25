import { createNodeTeamMember, newTeamRuntime, nodeTeamTurnEstimate, type NodeTeam, type NodeTeamMode } from './nodeTeam';
import type { UiLocale } from '../locale';

/** The closed set of team template ids. The plan gate keeps the same list (planner_progress.go planTeamTemplateIDs). */
export const NODE_TEAM_TEMPLATE_IDS = ['draft-review', 'research-panel', 'debate-verdict', 'plan-build-check', 'expert-review', 'translate-review'] as const;
export type NodeTeamTemplateId = typeof NODE_TEAM_TEMPLATE_IDS[number];

/** Who a member is and what it does. A template or a plan never sets a member's model, effort, runtime or tools: those
 *  are the user's, chosen in the team editor's runtime-linked selectors. */
export interface NodeTeamMemberBrief { name: string; role: string; instructions: string }
interface NodeTeamTemplateText { title: string; summary: string; members: readonly NodeTeamMemberBrief[] }
export interface NodeTeamTemplate { id: NodeTeamTemplateId; mode: NodeTeamMode; maxRounds: number; zh: NodeTeamTemplateText; en: NodeTeamTemplateText }
/** A team as a template or a plan describes it, before the node's runtime and the user's member settings join it. */
export interface NodeTeamShape { mode: NodeTeamMode; maxRounds: number; members: readonly NodeTeamMemberBrief[] }

const brief = (name: string, role: string, does: string, doesNot: string, doneWhen: string, locale: UiLocale): NodeTeamMemberBrief => ({
  name, role, instructions: locale === 'zh' ? `负责：${does}\n不负责：${doesNot}\n完成标准：${doneWhen}` : `Does: ${does}\nDoes not: ${doesNot}\nDone when: ${doneWhen}`,
});

// The position of each member is its job: the last one aggregates, judges or reviews (awwo-node-teams.md §3).
const TEMPLATES: readonly NodeTeamTemplate[] = [
  { id: 'draft-review', mode: 'review', maxRounds: 2,
    zh: { title: '撰写与审核', summary: '一人撰写，一人对照要求审核，不合格就返工。', members: [
      brief('撰写者', '按节点任务撰写完整交付', '按节点的任务、输入和输出要求写出完整交付；收到审核意见时逐条修改。', '自己宣布通过，或删减节点要求的内容。', '交付覆盖节点的每一条要求，可以直接交给审核者。', 'zh'),
      brief('审核者', '对照要求审核并给出结论', '逐条对照节点的任务要求和验收标准检查交付；不合格时写出具体、可执行的修改意见。', '自己重写交付，或提出节点没有要求的新内容。', '每条要求都核对过；全部满足才批准，并把可以直接交付的最终结果放在批准结果里。', 'zh'),
    ] },
    en: { title: 'Draft and review', summary: 'One member drafts, one reviews against the requirements and sends failed work back for revision.', members: [
      brief('Writer', 'Write the complete delivery for the node task', 'write the complete delivery the node’s task, inputs and output requirements ask for; revise it point by point when the reviewer sends feedback.', 'approve your own work or drop anything the node requires.', 'the delivery covers every requirement of the node and is ready for review.', 'en'),
      brief('Reviewer', 'Review against the requirements and decide', 'check the delivery against each of the node’s task requirements and acceptance criteria; when it falls short, write specific, actionable revision notes.', 'rewrite the delivery yourself or ask for anything the node does not require.', 'every requirement has been checked; approve only when all are met, with the final delivery ready to hand over in the approved result.', 'en'),
    ] } },
  { id: 'research-panel', mode: 'parallel', maxRounds: 2,
    zh: { title: '多角度调研与汇总', summary: '三人分别从资料、核查、反方三个角度同时调研，最后一人汇总。', members: [
      brief('资料调研', '梳理关键事实与资料', '围绕节点任务梳理关键事实、数据和来源，标明每条信息出自哪里。', '下结论或给建议。', '列出可以核对的要点，并注明哪些信息仍不确定。', 'zh'),
      brief('事实核查', '找出可疑与缺失的信息', '找出任务涉及的常见误区、可疑说法和缺失信息，说明可疑的理由。', '重复列出普通事实。', '每个疑点都写明理由和核实方法。', 'zh'),
      brief('反方视角', '提出反对意见与风险', '从反对者、竞争对手和风险的角度审视任务，写出最有分量的反对理由和代价。', '附和主流结论，或提出与任务无关的反对。', '每条反方观点或风险都写明依据。', 'zh'),
      brief('汇总者', '汇总成最终交付', '阅读其他成员的结果，去重、对比、处理分歧，写成符合节点输出要求的最终交付。', '加入没有成员依据的新事实。', '最终交付覆盖节点要求，分歧处写明取舍理由，仍不确定的信息明确标注。', 'zh'),
    ] },
    en: { title: 'Research from several angles', summary: 'Three members research side by side — sources, fact-checking and the opposing view — and the last one combines their work.', members: [
      brief('Researcher', 'Gather the key facts and sources', 'gather the key facts, figures and sources for the node’s task, saying where each one comes from.', 'draw conclusions or make recommendations.', 'the points listed can be checked, and what is still uncertain is marked.', 'en'),
      brief('Fact checker', 'Find doubtful and missing information', 'find the common misconceptions, doubtful claims and missing information the task touches, with the reason each is doubtful.', 'repeat ordinary facts.', 'every doubt has its reason and a way to verify it.', 'en'),
      brief('Devil’s advocate', 'Raise objections and risks', 'look at the task as an opponent, a competitor and a risk reviewer would, and write the strongest objections and their costs.', 'agree with the prevailing view or raise objections unrelated to the task.', 'every objection or risk states what it rests on.', 'en'),
      brief('Synthesizer', 'Combine the results into the final delivery', 'read the other members’ results, remove duplicates, compare them and resolve disagreements in the final delivery the node’s output requirements ask for.', 'add facts no member supported.', 'the final delivery covers the node’s requirements, explains each choice where members disagreed and marks what is still uncertain.', 'en'),
    ] } },
  { id: 'debate-verdict', mode: 'debate', maxRounds: 2,
    zh: { title: '正反辩论与裁决', summary: '正反两方轮流讨论，裁决者权衡双方后给出结论。', members: [
      brief('正方', '为方案或观点辩护', '为任务中的方案或观点给出最有力的支持理由，并回应反方此前的质疑。', '回避反方的关键质疑。', '每轮都回应对方的要点，论据具体、可以核对。', 'zh'),
      brief('反方', '质疑并指出风险', '指出方案或观点的漏洞、风险和更好的替代，并回应正方此前的论点。', '为反对而反对，或提出与任务无关的质疑。', '每轮都给出具体的质疑和依据。', 'zh'),
      brief('裁决者', '权衡双方并给出结论', '每轮点出双方最强和最弱的论点；讨论结束后权衡双方，给出明确结论、理由和仍然存在的风险，写成符合节点输出要求的最终交付。', '偏袒任何一方，或采纳没有依据的说法。', '结论明确，理由能追溯到讨论中的论点。', 'zh'),
    ] },
    en: { title: 'Debate and verdict', summary: 'Two members argue for and against in turns; the judge weighs both and gives the verdict.', members: [
      brief('Advocate', 'Argue for the proposal', 'make the strongest case for the proposal or claim in the task, and answer the opponent’s earlier objections.', 'avoid the opponent’s key objections.', 'each round answers the other side’s points with specific, checkable arguments.', 'en'),
      brief('Opponent', 'Challenge it and name the risks', 'point out the proposal’s gaps, risks and better alternatives, and answer the advocate’s earlier arguments.', 'object for the sake of objecting or raise points unrelated to the task.', 'each round gives specific objections with what they rest on.', 'en'),
      brief('Judge', 'Weigh both sides and decide', 'name the strongest and weakest arguments on each side in every round; when the discussion ends, weigh both and give a clear verdict, its reasons and the risks that remain, as the final delivery the node’s output requirements ask for.', 'favour either side or accept unsupported claims.', 'the verdict is clear and its reasons trace back to arguments made in the discussion.', 'en'),
    ] } },
  { id: 'plan-build-check', mode: 'sequential', maxRounds: 2,
    zh: { title: '方案、实现与自查', summary: '先出方案，再按方案实现，最后检查并修订成最终交付。', members: [
      brief('方案设计', '拆解任务并给出方案', '拆解节点任务，写出实现方案：步骤、关键决定和需要注意的约束。', '直接写最终交付。', '方案覆盖节点的每条要求，后面的成员照着就能做。', 'zh'),
      brief('实现', '按方案完成交付', '按方案写出完整交付；方案有遗漏时直接补上并说明。', '改变节点的输出格式或范围。', '交付完整，可以直接使用。', 'zh'),
      brief('自查修订', '检查并修订成最终交付', '对照节点的任务要求和验收标准检查交付，直接修正问题，输出修订后的最终交付。', '只写评语而不修改。', '最终交付满足每条要求，并符合节点的输出要求。', 'zh'),
    ] },
    en: { title: 'Plan, build and check', summary: 'One member plans, the next builds to the plan, and the last checks and fixes the result.', members: [
      brief('Planner', 'Break the task down and plan it', 'break the node’s task down and write the plan: steps, key decisions and the constraints to watch.', 'write the final delivery.', 'the plan covers every requirement of the node and the next member can follow it.', 'en'),
      brief('Builder', 'Build the delivery to the plan', 'write the complete delivery to the plan; fill any gap in the plan and say so.', 'change the node’s output format or scope.', 'the delivery is complete and ready to use.', 'en'),
      brief('Checker', 'Check and fix it into the final delivery', 'check the delivery against the node’s task requirements and acceptance criteria, fix what is wrong and output the corrected final delivery.', 'only comment without fixing.', 'the final delivery meets every requirement and the node’s output requirements.', 'en'),
    ] } },
  { id: 'expert-review', mode: 'parallel', maxRounds: 2,
    zh: { title: '专家评审团', summary: '产品、技术、体验三位评审同时给出意见，主审汇总并排出优先级。', members: [
      brief('产品评审', '从用户价值与需求评审', '从用户价值、需求覆盖和优先级评审任务中的方案或交付。', '评审技术实现细节。', '列出主要问题和改进建议，并标明轻重。', 'zh'),
      brief('技术评审', '从可行性与风险评审', '从技术可行性、成本、安全和维护风险评审任务中的方案或交付。', '评审产品取舍。', '列出主要问题和改进建议，并标明轻重。', 'zh'),
      brief('体验评审', '从使用体验评审', '从易用性、可访问性和表达清晰度评审任务中的方案或交付。', '评审技术实现细节。', '列出主要问题和改进建议，并标明轻重。', 'zh'),
      brief('主审汇总', '汇总评审意见并排序', '汇总各位评审的意见，合并重复、处理冲突、按轻重排出优先级，写成符合节点输出要求的最终评审。', '加入没有评审依据的新意见。', '每条意见都写明出处和建议的处理方式。', 'zh'),
    ] },
    en: { title: 'Expert panel', summary: 'Product, engineering and experience reviewers give their views side by side; the lead reviewer combines and ranks them.', members: [
      brief('Product reviewer', 'Review for user value and needs', 'review the proposal or delivery in the task for user value, coverage of needs and priorities.', 'review technical implementation details.', 'the main issues and suggestions are listed with their severity.', 'en'),
      brief('Engineering reviewer', 'Review for feasibility and risk', 'review the proposal or delivery in the task for technical feasibility, cost, security and maintenance risk.', 'review product trade-offs.', 'the main issues and suggestions are listed with their severity.', 'en'),
      brief('Experience reviewer', 'Review for the user experience', 'review the proposal or delivery in the task for ease of use, accessibility and clarity.', 'review technical implementation details.', 'the main issues and suggestions are listed with their severity.', 'en'),
      brief('Lead reviewer', 'Combine and rank the reviews', 'combine the reviewers’ findings, merge duplicates, resolve conflicts and rank them by severity in the final review the node’s output requirements ask for.', 'add findings no reviewer made.', 'every finding names its source and a suggested way to handle it.', 'en'),
    ] } },
  { id: 'translate-review', mode: 'review', maxRounds: 2,
    zh: { title: '翻译与审校', summary: '译者翻译，审校对照原文检查，不合格就返工。', members: [
      brief('译者', '翻译完整内容', '按节点要求把内容完整译成目标语言，保留原意、术语和格式；收到审校意见时逐条修改。', '增删原文内容。', '译文完整通顺，术语前后一致。', 'zh'),
      brief('审校', '对照原文审校', '逐段对照原文检查漏译、错译、术语和语气；有问题时写出具体的修改意见。', '按个人偏好改写已经准确的译文。', '没有漏译和错译才批准，并把最终译文放在批准结果里。', 'zh'),
    ] },
    en: { title: 'Translate and review', summary: 'One member translates, the reviewer checks it against the source and sends failed work back for revision.', members: [
      brief('Translator', 'Translate the complete content', 'translate the content completely into the target language the node asks for, keeping its meaning, terms and formatting; revise it point by point when the reviewer sends feedback.', 'add to or cut the source.', 'the translation is complete, reads naturally and uses its terms consistently.', 'en'),
      brief('Reviewer', 'Review it against the source', 'check the translation against the source passage by passage for omissions, mistranslations, terms and tone; write specific revision notes for any problem.', 'rewrite an accurate translation to your own taste.', 'approve only with nothing left out or mistranslated, with the final translation in the approved result.', 'en'),
    ] } },
];

export const nodeTeamTemplates = (): readonly NodeTeamTemplate[] => TEMPLATES;
export const isNodeTeamTemplateId = (value: unknown): value is NodeTeamTemplateId => NODE_TEAM_TEMPLATE_IDS.includes(value as NodeTeamTemplateId);
export const nodeTeamTemplate = (id: string): NodeTeamTemplate | undefined => TEMPLATES.find(template => template.id === id);
export const nodeTeamTemplateShape = (template: NodeTeamTemplate, locale: UiLocale): NodeTeamShape =>
  ({ mode: template.mode, maxRounds: template.maxRounds, members: template[locale].members });

/** The most model calls one team run may make (the editor's and the server's bound on maxTurns). */
export const NODE_TEAM_MAX_CALLS = 64;
// A thinking model's answer can take minutes, so a team gets 180 s for every call it plans, counted one after another
// because members also wait for the workspace's free concurrency slots (a parallel team's workers queue on a workspace
// that runs one call at a time). Within the team bound of 1800 s and never below the editor's default 300 s, which can cut a
// two-round debate off before its verdict. The run's own deadline (AWWO_RUN_TIMEOUT) still bounds the whole run.
const SECONDS_PER_CALL = 180;
export const nodeTeamTimeoutFor = (team: Pick<NodeTeam, 'mode' | 'maxRounds'> & { members: readonly unknown[] }): number =>
  Math.min(1800, Math.max(300, SECONDS_PER_CALL * nodeTeamTurnEstimate(team)));
/** The rounds a debate or a review of `count` members can finish within NODE_TEAM_MAX_CALLS, at most `rounds`: past it a
 *  debate's verdict or a review's last pass never runs and the team fails having spent every call
 *  (team_turn_budget_exhausted). Other modes do not use rounds. */
export function nodeTeamFittingRounds(mode: NodeTeamMode, count: number, rounds: number): number {
  if (mode === 'debate') return Math.max(1, Math.min(rounds, Math.floor((NODE_TEAM_MAX_CALLS - 1) / count)));
  if (mode === 'review') return Math.max(1, Math.min(rounds, Math.floor(NODE_TEAM_MAX_CALLS / count)));
  return rounds;
}
/** A member's name as two teams are matched by it: as a plan writes it, trimmed. */
const memberKey = (name: string): string => name.trim();

/** The team `shape` describes, for `node`: a new team runs where its node runs (newTeamRuntime), and its new members
 *  inherit the node's model. A member of `previous` (the node's
 *  current team) under the same name, trimmed, keeps its id and its own settings (model, effort, runtime, context,
 *  tools), so replacing a team never drops a choice the user made; where `previous` holds a name twice, its first member
 *  answers for it. The team keeps its runtime and its call and time limits, raised where the new team needs more; its
 *  rounds are cut to what NODE_TEAM_MAX_CALLS lets it finish. */
export function buildNodeTeam(shape: NodeTeamShape, node: { runtime?: string }, previous?: NodeTeam): NodeTeam {
  const runtime = previous?.runtime ?? newTeamRuntime(node);
  const kept = new Map<string, NodeTeam['members'][number]>();
  for (const member of previous?.members ?? []) if (!kept.has(memberKey(member.name))) kept.set(memberKey(member.name), member);
  const members = shape.members.map(({ name, role, instructions }) => {
    const own = kept.get(memberKey(name));
    kept.delete(memberKey(name));
    return own ? { ...own, role, instructions, tools: [...own.tools] } : createNodeTeamMember({ name, role, instructions });
  });
  const team: NodeTeam = { version: 1, mode: shape.mode, runtime, maxRounds: nodeTeamFittingRounds(shape.mode, members.length, shape.maxRounds),
    maxTurns: NODE_TEAM_MAX_CALLS, timeoutSeconds: 1800, members };
  return { ...team,
    maxTurns: Math.min(NODE_TEAM_MAX_CALLS, Math.max(nodeTeamTurnEstimate(team), members.length, previous?.maxTurns ?? 0)),
    timeoutSeconds: Math.min(1800, Math.max(nodeTeamTimeoutFor(team), previous?.timeoutSeconds ?? 0)) };
}

export const createNodeTeamFromTemplate = (template: NodeTeamTemplate, node: { runtime?: string }, locale: UiLocale, previous?: NodeTeam): NodeTeam =>
  buildNodeTeam(nodeTeamTemplateShape(template, locale), node, previous);
