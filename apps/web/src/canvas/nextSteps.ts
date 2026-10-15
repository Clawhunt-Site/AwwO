import type { CanvasEdge, CanvasNode, SessionNode } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';
import { validateContractFields } from './nodeContracts';
import { reconcileEdges } from './ports';
import { reviewedProducers, reviewVerdict } from './reviewVerdict';
import type { RunNodeStatus } from './runGraph';

/** One thing the assistant offers to do next. Each names exactly what it acts on, so the host can carry it out.
 * `calls` is the fewest model calls the step spends: every Agent makes at least one, each team member one, and an
 * Agent that uses tools makes more, so it is a floor the host may quote as "at least". */
export type NextStep =
  | { kind: 'upgrade' }
  | { kind: 'switch-model'; nodeId: string }
  | { kind: 'open-failed'; nodeId: string }
  | { kind: 'rerun-failed'; nodeIds: string[] }
  | { kind: 'fill-inputs'; nodeId: string; fields: string[] }
  | { kind: 'run-all'; calls: number }
  | { kind: 'try-first'; nodeId: string; calls: number }
  | { kind: 'run-rest'; nodeIds: string[]; calls: number }
  /** Hand a review's findings to the Agent whose delivery it checked, then run that Agent and everything it feeds
   * (the review included) again. */
  | { kind: 'rework'; nodeId: string; reviewerId: string; calls: number }
  | { kind: 'open-review'; nodeId: string }
  /** Ask the canvas assistant to change the canvas so the failed nodes can finish (split a node, narrow its delivery,
   *  another model): a plan, which costs the planner's call, not a run. */
  | { kind: 'assistant-fix'; nodeIds: string[] }
  /** Ask the canvas assistant to fill in the inputs a run still needs, from the request and the canvas. */
  | { kind: 'assistant-fill'; nodeIds: string[] }
  | { kind: 'results' };

/** Why those steps, in one line the host words. */
export type NextSituation =
  | { kind: 'quota'; nodeTitle: string }
  | { kind: 'premium'; nodeTitle: string }
  | { kind: 'failed'; nodeTitle: string; count: number }
  /** Every node finished, but a review found the delivery wanting: `verdict` in its own words, `reason` its why. */
  | { kind: 'rejected'; nodeTitle: string; verdict: string; reason: string }
  /** Required inputs nothing feeds: `fields` in all, over `nodes` Agents; then a run of the whole canvas spends `calls`. */
  | { kind: 'inputs'; nodes: number; fields: number; calls: number }
  | { kind: 'fresh'; calls: number }
  | { kind: 'partial'; count: number }
  /** `approvedBy`: the review that passed the delivery, when there is one. */
  | { kind: 'complete'; approvedBy?: string };

export interface NextSteps { situation: NextSituation; steps: NextStep[] }

export interface NextStepsInput {
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  /** The latest run's state per node. */
  runs: Readonly<Record<string, RunNodeStatus | undefined>>;
  running: boolean;
  /** The canvas can run now: not read-only and the host's execution is available. */
  canRun: boolean;
  /** The host has a results view to open. */
  resultsAvailable: boolean;
  /** The host can offer the paid plans (a hosted workspace). */
  upgradeAvailable: boolean;
  /** Whether a failure's detail is a refusal by the free premium allowance (the host knows its wording). */
  isPremiumRefusal: (detail: string) => boolean;
  /** Whether a failure's detail is the workspace's own run allowance being full (today's calls, or runs at once). */
  isQuotaRefusal?: (detail: string) => boolean;
  /** The host can carry a review's findings into the reviewed Agent's next run (a hosted workspace's task
   * requirements reach its prompt; a local canvas's do not). */
  reworkAvailable?: boolean;
  /** The canvas assistant can plan now, so it can be asked to fix a failure or fill in inputs. */
  canPlan?: boolean;
}

const MAX_STEPS = 3;
/** A canvas this large is worth trying one node of first: a whole run spends a call per Agent at the least. */
const TRY_FIRST_FROM = 3;

/** Text Agents a canvas run executes; image and video nodes run on their own, so they are never "left to run". */
function agentNodes(nodes: ReadonlyArray<CanvasNode>): SessionNode[] {
  return nodes.filter((node): node is SessionNode => node.kind === 'session' && !mediaKindOf(node.agentKind));
}

const delivered = (node: SessionNode) => Boolean(node.lastOutput && !node.lastOutput.partial);

/** The fewest calls a run of these Agents makes: one per Agent, one per member of an Agent's team. */
function callsOf(agents: ReadonlyArray<SessionNode>): number {
  return agents.reduce((sum, node) => sum + Math.max(1, node.team?.members.length ?? 0), 0);
}

/** Every Agent whose own required inputs are empty, in canvas order: a wired input is checked once its value arrives,
 * as the run's preflight does, so only fields the reader has to fill in count. */
function missingInputs(agents: ReadonlyArray<SessionNode>, wired: ReadonlyArray<CanvasEdge>) {
  return agents.flatMap(node => {
    const fields = (node.contract?.inputs ?? [])
      .filter(field => !wired.some(edge => edge.toNode === node.id && edge.toPort === `in:${field.id}`))
      .filter(field => validateContractFields([field]).length > 0)
      .map(field => field.label || field.id);
    return fields.length ? [{ node, fields }] : [];
  });
}

/** Every Agent the given ones feed, themselves included: what a run started from them executes. */
function downstreamOf(roots: ReadonlyArray<SessionNode>, agents: ReadonlyArray<SessionNode>, wired: ReadonlyArray<CanvasEdge>): SessionNode[] {
  const reached = new Set(roots.map(node => node.id));
  for (let grew = true; grew;) {
    grew = false;
    for (const edge of wired) if (reached.has(edge.fromNode) && !reached.has(edge.toNode)) { reached.add(edge.toNode); grew = true; }
  }
  return agents.filter(node => reached.has(node.id));
}

/** What to do next with this canvas, worked out from the canvas alone, so the assistant can offer it unasked and
 * without spending a call. The most urgent situation wins: a failure, then a review that found the delivery wanting,
 * then everything a run would refuse for want of an input, then what has not run yet, then the results. Nothing is
 * offered while a run is going, or when no step could act. */
export function nextSteps(input: NextStepsInput): NextSteps | null {
  const { nodes, edges, runs, running, canRun, resultsAvailable, upgradeAvailable, isPremiumRefusal, isQuotaRefusal, reworkAvailable, canPlan } = input;
  if (running) return null;
  const agents = agentNodes(nodes);
  if (!agents.length) return null;
  const offer = (situation: NextSituation, steps: NextStep[], cap = MAX_STEPS): NextSteps | null =>
    steps.length ? { situation, steps: steps.slice(0, cap) } : null;

  // A delivery a person published by hand after the run (source 'manual') supersedes that run's failure: running the node
  // again would replace it, so it is not offered as the way on.
  const failed = agents.filter(node => runs[node.id]?.state === 'failed' && node.lastOutput?.source !== 'manual');
  if (failed.length) {
    const rerun: NextStep[] = canRun ? [{ kind: 'rerun-failed', nodeIds: failed.map(node => node.id) }] : [];
    // The workspace's own allowance stops every node alike, so it comes first; a rerun stays offered, as runs going
    // at once finish and the calls come back the next day.
    const quota = isQuotaRefusal ? failed.find(node => isQuotaRefusal(runs[node.id]?.detail ?? '')) : undefined;
    if (quota) return offer({ kind: 'quota', nodeTitle: quota.title }, [...(upgradeAvailable ? [{ kind: 'upgrade' as const }] : []), ...rerun]);
    const first = failed[0];
    if (isPremiumRefusal(runs[first.id]?.detail ?? '')) {
      return offer({ kind: 'premium', nodeTitle: first.title },
        [...(upgradeAvailable ? [{ kind: 'upgrade' as const }] : []), { kind: 'switch-model', nodeId: first.id }, ...rerun]);
    }
    // A failure the same settings would meet again (an answer too long, a call out of time) is the assistant's to fix
    // by changing the canvas; it is offered after running again, which a passing fault needs.
    const fix: NextStep[] = canPlan ? [{ kind: 'assistant-fix', nodeIds: failed.map(node => node.id) }] : [];
    return offer({ kind: 'failed', nodeTitle: first.title, count: failed.length }, [{ kind: 'open-failed', nodeId: first.id }, ...rerun, ...fix]);
  }

  const wired = reconcileEdges(nodes, edges.filter(edge => edge.kind !== 'feedback'));
  // Every node finished, yet a review found the delivery wanting: "7/7 succeeded" is not done. The way on is the
  // delivery reworked from the review's own findings, then reviewed again.
  for (const reviewer of agents) {
    const verdict = delivered(reviewer) ? reviewVerdict(reviewer) : null;
    if (!verdict || verdict.approved) continue;
    const producer = canRun && reworkAvailable ? reviewedProducers(reviewer, agents, wired)[0] : undefined;
    return offer({ kind: 'rejected', nodeTitle: reviewer.title, verdict: verdict.verdict, reason: verdict.reason }, [
      ...(producer ? [{ kind: 'rework' as const, nodeId: producer.id, reviewerId: reviewer.id, calls: callsOf(downstreamOf([producer], agents, wired)) }] : []),
      { kind: 'open-review', nodeId: reviewer.id },
    ]);
  }

  const missing = missingInputs(agents, wired);
  if (missing.length) {
    // Every node a run would refuse is listed at once, so nothing has to be found one failed run at a time; the
    // assistant can fill them all in, after them.
    return offer({ kind: 'inputs', nodes: missing.length, fields: missing.reduce((sum, item) => sum + item.fields.length, 0), calls: callsOf(agents) },
      [...missing.map(({ node, fields }) => ({ kind: 'fill-inputs' as const, nodeId: node.id, fields })),
        ...(canPlan ? [{ kind: 'assistant-fill' as const, nodeIds: missing.map(({ node }) => node.id) }] : [])], missing.length + (canPlan ? 1 : 0));
  }

  const pending = agents.filter(node => !delivered(node));
  if (pending.length === agents.length) {
    if (!canRun) return null;
    // A first Agent nothing feeds can run alone, so a larger canvas can be tried at the cost of one node.
    const root = agents.length >= TRY_FIRST_FROM ? agents.find(node => !wired.some(edge => edge.toNode === node.id)) : undefined;
    return offer({ kind: 'fresh', calls: callsOf(agents) },
      [{ kind: 'run-all', calls: callsOf(agents) }, ...(root ? [{ kind: 'try-first' as const, nodeId: root.id, calls: callsOf([root]) }] : [])]);
  }
  if (pending.length) {
    return offer({ kind: 'partial', count: pending.length },
      [...(canRun ? [{ kind: 'run-rest' as const, nodeIds: pending.map(node => node.id), calls: callsOf(pending) }] : []),
        ...(resultsAvailable ? [{ kind: 'results' as const }] : [])]);
  }
  const approvedBy = agents.find(node => reviewVerdict(node)?.approved)?.title;
  return offer({ kind: 'complete', ...(approvedBy ? { approvedBy } : {}) }, resultsAvailable ? [{ kind: 'results' }] : []);
}

// A message that only asks what the canvas still needs or what to do now is answered from nextSteps() above, which
// costs no call; anything with more in it goes to the assistant as before. The test is deliberately narrow: the
// whole message, once greetings, fillers and punctuation are gone, must be one of these questions.
const ZH_FILLER = /^(请问|那么|那|所以|好的|好|嗯|哦|我们|我|现在|目前|这个|这张|这里|这|画布|流程图|流程|工作流)/;
// 嘛 is left alone: it ends 干嘛 ("doing what").
const ZH_TAIL = /(呢|啊|呀|吗|吧|哈|啦|了吗)$/;
const ZH_MODAL = /^(应该|应当|需要|还要|还得|得|该|要)/;
const ZH_LEAD = /^(下一步|接下来|然后|之后|下面|现在)/;
const ZH_DO = new Set(['', '做什么', '干什么', '干嘛', '做啥', '干啥', '怎么做', '怎么办', '怎么弄', '如何做', '如何操作', '怎么操作']);
const ZH_ASK = new Set([
  '缺什么', '还缺什么', '缺啥', '还缺啥', '差什么', '还差什么', '缺哪些', '还缺哪些', '差哪些', '还差哪些', '少什么', '还少什么', '缺了什么',
  '怎么开始', '从哪开始', '从哪里开始', '从何开始', '如何开始', '怎么上手', '如何上手', '怎么用', '如何使用', '怎么使用', '怎么运行', '如何运行', '怎么跑',
  '有什么要决策的', '有什么要决定的', '有什么需要决定的', '有什么需要决策的', '决定什么', '决策什么', '填什么', '要填什么', '填哪些',
  '有什么建议', '给点建议', '给我建议', '给个建议', '建议', '能运行了', '可以运行了', '能跑了', '可以跑了', '能运行', '可以运行',
]);
const EN_ASK = new Set([
  'whats next', 'what next', 'what now', 'now what', 'next', 'next step', 'next steps', 'whats the next step', 'what is the next step',
  'whats missing', 'what is missing', 'what am i missing', 'what do i do', 'what should i do', 'what do i do next', 'what should i do next',
  'what do i need to do', 'what do i need to fill in', 'what do i need to decide', 'where do i start', 'how do i start', 'how to start',
  'how do i use this', 'how does this work', 'help', 'can i run it', 'is it ready', 'any suggestions', 'suggestions',
]);

export function isNextStepsQuestion(text: string): boolean {
  const raw = text.trim().toLowerCase();
  if (!raw || raw.length > 40) return false;
  if (/[a-z]/.test(raw) && !/[\u4e00-\u9fff]/.test(raw)) {
    const words = raw.replace(/[’'`]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^(so|ok|okay|and|then|hi|hey|please)\s+/, '').replace(/\s+(now|then|please)$/, '');
    return EN_ASK.has(words);
  }
  let s = raw.replace(/[\s\p{P}\p{S}]/gu, '');
  for (let previous = ''; previous !== s;) { previous = s; s = s.replace(ZH_TAIL, '').replace(ZH_FILLER, ''); }
  if (ZH_ASK.has(s) || ZH_ASK.has(s.replace(ZH_MODAL, ''))) return true;
  const rest = ZH_LEAD.test(s) ? s.replace(ZH_LEAD, '').replace(ZH_MODAL, '') : s.replace(ZH_MODAL, '');
  return (ZH_LEAD.test(s) || rest !== '') && ZH_DO.has(rest);
}

// "我看到运行后验收不通过，我该怎么办？": a short question about how the last run came out, which the host answers from
// the same advice when the canvas has such an outcome to act on. It must name the outcome and end asking what to do,
// so "验收不通过的话把前端改成 React" (an instruction) still goes to the assistant.
const ZH_OUTCOME = /验收|评审|审核|审查|复核|不通过|没通过|未通过|没过|驳回|不合格|失败|报错|出错|被拒|跑不了|跑不通|运行不了|用不了|不让用/;
const ZH_WHAT_NOW = /(?:怎么办|咋办|怎么处理|如何处理|怎么解决|如何解决|怎么修复?|如何修复|怎么改|如何改|怎么修改|如何修改|该怎么做|要怎么做|怎么弄|该做什么|下一步呢|然后呢|接下来呢)(?:呢|啊|呀|吗|吧|哈|啦)*$/;
const EN_OUTCOME = /\b(?:fail(?:ed|s|ing)?|review|rejected|errored|did ?n[o’']?t pass|not pass(?:ed)?|refused)\b/;
const EN_WHAT_NOW = /(?:what (?:should|do|can) i do(?: now| next| about it)?|what now|now what|what next|how (?:do|can) i fix (?:it|this|that)|how to fix (?:it|this|that))$/;

export function isOutcomeQuestion(text: string): boolean {
  const raw = text.trim().toLowerCase();
  if (!raw || raw.length > 40) return false;
  if (/[a-z]/.test(raw) && !/[\u4e00-\u9fff]/.test(raw)) {
    const words = raw.replace(/[’'`]/g, '’').replace(/[^a-z’\s]/g, ' ').replace(/\s+/g, ' ').trim();
    return EN_OUTCOME.test(words) && EN_WHAT_NOW.test(words);
  }
  const s = raw.replace(/[\s\p{P}\p{S}]/gu, '');
  return ZH_OUTCOME.test(s) && ZH_WHAT_NOW.test(s);
}

// 「画布的最后一个节点运行失败了」「处理失败」「节点报错了，帮我修一下」: a short message about the last run having
// failed, which the canvas answers itself while it has a failed node: it says what failed and why, and for anything
// but a question of why, runs the failed nodes again (the 「重新运行失败的节点」 step). A message that also asks for a
// change (「失败的节点改成 React」), says nothing failed, or is long is left to the assistant, which plans or works it.
const ZH_FAILURE = /失败|报错|出错|出了错|没跑通|跑不通|跑不了|跑不起来|没跑成|运行不了|运行不起来|执行不了|挂了|崩了/;
const ZH_NOT_FAILED = /(?:没有|没|不是|并未|未|不会|别)(?:运行|执行)?失败/;
const ZH_CHANGE = /改成|改为|换成|换为|替换|改用|修改|调整|优化|重写|美化|新增|增加|添加|加一个|加个|删除|删掉|去掉|移除|拆分|合并|连到|连接/;
const ZH_WHY = /为什么|为啥|怎么回事|什么原因|啥原因|原因是|原因呢|哪里错|错在哪/;
// It must be about this canvas's run: short (「处理失败」), or naming the canvas, a node, the run or "it". 「写一份项目失败
// 原因的分析报告」 is a task about failure in general, not this canvas's.
const ZH_REFERENCE = /节点|画布|运行|执行|组件|流程|工作流|智能体|上一个|最后一个|这个|那个|它|刚才|上次|这次/;
const EN_FAILURE = /\b(?:fail(?:ed|s|ing|ure)?|errored|crash(?:ed|es)?|broke(?:n)?)\b/;
const EN_CHANGE = /\b(?:change|switch|replace|rename|add|remove|delete|rewrite|use)\b/;
const EN_WHY = /\b(?:why|what happened|reason)\b/;
const EN_REFERENCE = /\b(?:nodes?|canvas|run|ran|step|component|workflow|agent|it|this|that|last)\b/;

/** 'fix' for a message about the failure to act on, 'why' for a question of why it failed, null for anything else. */
export function failureRequestKind(text: string): 'fix' | 'why' | null {
  const raw = text.trim().toLowerCase();
  if (!raw || [...raw].length > 60) return null;
  if (/[a-z]/.test(raw) && !/[\u4e00-\u9fff]/.test(raw)) {
    if (!EN_FAILURE.test(raw) || EN_CHANGE.test(raw) || /\b(?:not|never|didn[’']?t|hasn[’']?t|no)\b[^.?!]*\bfail/.test(raw)) return null;
    if (raw.length > 20 && !EN_REFERENCE.test(raw)) return null;
    return EN_WHY.test(raw) ? 'why' : 'fix';
  }
  const s = raw.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!ZH_FAILURE.test(s) || ZH_NOT_FAILED.test(s) || ZH_CHANGE.test(s)) return null;
  if ([...s].length > 12 && !ZH_REFERENCE.test(s)) return null;
  return ZH_WHY.test(s) ? 'why' : 'fix';
}

// 「运行」「开始运行」「跑一下」「run it」: a message that only asks to run the canvas is carried out here, as the run button
// would, rather than sent to the planner, which cannot run anything (owner request 2026-10-15: a reader who only talks to
// the assistant runs the canvas from it too). The whole message must be the request once politeness and the canvas's
// name are gone, so 「运行后告诉我效果」 or 「把前端改成 React 再运行」 still go to the assistant.
const ZH_RUN_FILLER = /^(请|请你|帮我|麻烦|麻烦你|那就|那|好的|好|就|现在|直接|可以|我要|我想)+/;
const ZH_RUN_TAIL = /(吧|吗|呗|啊|呀|一下|一下吧|看看|一遍|起来)+$/;
const ZH_RUN_ALL = new Set(['运行', '开始运行', '运行画布', '运行整张画布', '运行整个画布', '运行全部', '全部运行', '运行所有节点', '运行全部节点',
  '跑', '跑画布', '开跑', '开始跑', '执行', '开始执行', '执行画布', '启动', '开始', '试运行', '重新运行', '再运行', '重跑', '再跑']);
const ZH_RUN_REST = new Set(['运行剩下的', '运行剩下的节点', '运行剩余的', '运行剩余节点', '继续运行', '接着运行', '接着跑', '继续跑', '跑剩下的']);
const EN_RUN_ALL = new Set(['run', 'run it', 'run this', 'run the canvas', 'run the whole canvas', 'run everything', 'run all', 'run all nodes',
  'run the workflow', 'run the team', 'start', 'start it', 'start the run', 'go', 'execute', 'execute it', 'run it again', 'run again', 'rerun', 're run']);
const EN_RUN_REST = new Set(['run the rest', 'run the remaining nodes', 'run the remaining ones', 'continue', 'continue the run', 'keep going', 'resume']);

/** 'all' for a message that only asks to run the whole canvas, 'rest' for one that asks to run what has not run yet,
 *  null for anything else. */
export function runRequestKind(text: string): 'all' | 'rest' | null {
  const raw = text.trim().toLowerCase();
  if (!raw || [...raw].length > 30) return null;
  if (/[a-z]/.test(raw) && !/[一-鿿]/.test(raw)) {
    const words = raw.replace(/[’'`]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^(please|ok|okay|so|then|now|lets|let s|just|can you|could you)\s+/, '').replace(/\s+(now|please|for me|then)$/, '');
    return EN_RUN_ALL.has(words) ? 'all' : EN_RUN_REST.has(words) ? 'rest' : null;
  }
  let s = raw.replace(/[\s\p{P}\p{S}]/gu, '');
  for (let previous = ''; previous !== s;) { previous = s; s = s.replace(ZH_RUN_FILLER, '').replace(ZH_RUN_TAIL, ''); }
  return ZH_RUN_ALL.has(s) ? 'all' : ZH_RUN_REST.has(s) ? 'rest' : null;
}
