import type { CanvasEdge, CanvasNode, SessionNode } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';
import { validateContractFields } from './nodeContracts';
import { reconcileEdges } from './ports';
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
  | { kind: 'results' };

/** Why those steps, in one line the host words. */
export type NextSituation =
  | { kind: 'quota'; nodeTitle: string }
  | { kind: 'premium'; nodeTitle: string }
  | { kind: 'failed'; nodeTitle: string; count: number }
  /** Required inputs nothing feeds: `fields` in all, over `nodes` Agents; then a run of the whole canvas spends `calls`. */
  | { kind: 'inputs'; nodes: number; fields: number; calls: number }
  | { kind: 'fresh'; calls: number }
  | { kind: 'partial'; count: number }
  | { kind: 'complete' };

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

/** What to do next with this canvas, worked out from the canvas alone, so the assistant can offer it unasked and
 * without spending a call. The most urgent situation wins: a failure, then everything a run would refuse for want of
 * an input, then what has not run yet, then the results. Nothing is offered while a run is going, or when no step
 * could act. */
export function nextSteps(input: NextStepsInput): NextSteps | null {
  const { nodes, edges, runs, running, canRun, resultsAvailable, upgradeAvailable, isPremiumRefusal, isQuotaRefusal } = input;
  if (running) return null;
  const agents = agentNodes(nodes);
  if (!agents.length) return null;
  const offer = (situation: NextSituation, steps: NextStep[], cap = MAX_STEPS): NextSteps | null =>
    steps.length ? { situation, steps: steps.slice(0, cap) } : null;

  const failed = agents.filter(node => runs[node.id]?.state === 'failed');
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
    return offer({ kind: 'failed', nodeTitle: first.title, count: failed.length }, [{ kind: 'open-failed', nodeId: first.id }, ...rerun]);
  }

  const wired = reconcileEdges(nodes, edges.filter(edge => edge.kind !== 'feedback'));
  const missing = missingInputs(agents, wired);
  if (missing.length) {
    // Every node a run would refuse is listed at once, so nothing has to be found one failed run at a time.
    return offer({ kind: 'inputs', nodes: missing.length, fields: missing.reduce((sum, item) => sum + item.fields.length, 0), calls: callsOf(agents) },
      missing.map(({ node, fields }) => ({ kind: 'fill-inputs' as const, nodeId: node.id, fields })), missing.length);
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
  return offer({ kind: 'complete' }, resultsAvailable ? [{ kind: 'results' }] : []);
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
