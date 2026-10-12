import type { CanvasEdge, NodeOutput, SessionNode } from './canvasDoc';
import { parseContractOutput, type NodeContract } from './nodeContracts';
import { cleanTaskFrame, isTaskFrame, taskFrameError, TASK_FRAME_MAX_ENTRIES, TASK_FRAME_MAX_ENTRY_LENGTH, TASK_FRAME_MAX_TOTAL_LENGTH,
  type TaskFrame } from './taskFrame';

/** What a review node concluded about the delivery it checked, read from its latest complete output. */
export interface ReviewVerdict {
  approved: boolean;
  /** The verdict in the reviewer's own words ("不通过", "有条件通过", "Fail"); empty when it is a yes/no field. */
  verdict: string;
  /** The rest of the conclusion's first sentence, which says why. Empty when the reviewer gave none. */
  reason: string;
  /** The review's written findings, field by field, for whoever reworks the delivery. */
  findings: string;
}

// A node is read as a reviewer by its template or its title; a yes/no output counts only when it is named as approval.
const REVIEW_TITLE = /验收|评审|审核|审查|复核|质检|review|acceptance|audit|\bQA\b/i;
const APPROVAL_FIELD = /approv|pass|accept|verdict|通过|批准|合格|验收/i;
// "结论：不通过……", "**验收结论**：需修复", "Conclusion: Fail". The template's own report opens with 结论：.
const CONCLUSION = /^[ \t>*_#-]*(?:\*\*|__)?[ \t]*(?:验收结论|总体结论|最终结论|审核结论|评审结论|验收结果|结论|Overall verdict|Final verdict|Verdict|Conclusion)[ \t]*(?:\*\*|__)?[ \t]*[：:][ \t]*(?:\*\*|__)?(.*)$/im;
// "## 结论" with the verdict on the next line.
const CONCLUSION_HEADING = /^[ \t]*#{1,6}[ \t]*(?:验收结论|总体结论|最终结论|结论|Verdict|Conclusion)[ \t]*[：:]?[ \t]*\n+[ \t>*_-]*(.+)$/im;
const REJECTED = /不通过|未通过|没有通过|没通过|不予通过|暂不通过|无法通过|部分通过|有条件通过|不合格|驳回|退回|需要?(?:修复|返工|整改|修改|补充|完善)|证据不足|\bfail(?:ed|s|ing)?\b|\bnot (?:passed|pass|approved|accepted)\b|\brejected?\b|\bneeds? (?:fix(?:es)?|changes|rework|work)\b|\bchanges requested\b|\bconditional(?:ly)?\b/i;
const APPROVED = /通过|合格|批准|\bpass(?:ed)?\b|\bapproved?\b|\baccept(?:ed)?\b|\blgtm\b/i;
/** A verdict word further into the conclusion than this is part of its reason, not the verdict. */
const VERDICT_WITHIN = 40;
const REASON_MAX = 140;

const chars = (text: string) => Array.from(text).length;
function clip(text: string, max: number): string {
  const all = Array.from(text);
  return all.length <= max ? text : `${all.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** The first sentence of what follows the verdict word, without the punctuation and emphasis around it. */
function reasonOf(rest: string): string {
  const text = rest.replace(/\*\*|__/g, '').replace(/^[\s。，,.;；:：、!！)）\]】~—–-]+/u, '').trim();
  const end = text.search(/[。！？；\n]|[.!?;](?=\s|$)/u);
  return clip((end >= 0 ? text.slice(0, end + 1) : text).trim(), REASON_MAX);
}

/** The verdict a conclusion opens with, whichever of passing or failing words comes first. */
function classify(conclusion: string): { approved: boolean; verdict: string; reason: string } | null {
  const head = conclusion.slice(0, VERDICT_WITHIN + 20);
  const rejected = REJECTED.exec(head);
  const approved = APPROVED.exec(head);
  // 不通过 contains 通过 one character later, and 有条件通过 three: the failing word starts first and wins.
  const first = rejected && (!approved || rejected.index <= approved.index) ? rejected : approved;
  if (!first || first.index > VERDICT_WITHIN) return null;
  // "存在 3 个阻断问题，因此不通过。" gives its reason first.
  const before = conclusion.slice(0, first.index).replace(/\*\*|__/g, '').replace(/[\s，,、；;：:]*(?:因此|所以|故|则|判定为|结论为)?[\s，,、；;：:]*$/u, '').trim();
  const reason = reasonOf(conclusion.slice(first.index + first[0].length)) || clip(before, REASON_MAX);
  return { approved: first !== rejected, verdict: first[0], reason };
}

function conclusionIn(text: string): string | null {
  return CONCLUSION.exec(text)?.[1]?.trim() || CONCLUSION_HEADING.exec(text)?.[1]?.trim() || null;
}

const isReviewer = (node: SessionNode) => node.templateId === 'review' || REVIEW_TITLE.test(node.title);

function readVerdict(node: SessionNode, output: NodeOutput): ReviewVerdict | null {
  const contract: NodeContract | undefined = node.contract;
  const values = contract ? parseContractOutput(contract, output.text).values : {};
  const textFields = contract?.outputs.filter(field => (field.type === 'text' || field.type === 'markdown') && values[field.id]?.trim()) ?? [];
  const texts = textFields.length ? textFields.map(field => values[field.id]) : [output.text];
  const findings = textFields.length
    ? textFields.map(field => `### ${field.label || field.id}\n${values[field.id].trim()}`).join('\n\n')
    : output.text.trim();
  const flag = contract?.outputs.find(field => field.type === 'boolean' && APPROVAL_FIELD.test(`${field.id} ${field.label}`)
    && (values[field.id] === 'true' || values[field.id] === 'false'));
  const reviewer = isReviewer(node);
  if (!flag && !reviewer) return null;
  let conclusion: string | null = null;
  for (const text of texts) if ((conclusion = conclusionIn(text))) break;
  const read = reviewer && conclusion ? classify(conclusion) : null;
  if (flag) {
    const approved = values[flag.id] === 'true';
    // The yes/no field decides; a written conclusion that agrees with it lends its words.
    const agrees = read && read.approved === approved;
    return { approved, verdict: agrees ? read.verdict : '', reason: agrees ? read.reason : '', findings };
  }
  return read ? { ...read, findings } : null;
}

const cache = new WeakMap<NodeOutput, { node: Pick<SessionNode, 'title' | 'templateId' | 'contract'>; verdict: ReviewVerdict | null }>();

/** The verdict of a review node's latest complete output, or null when the node is not a review or its output says
 * neither way. Read per render, so it is kept per output: a replaced output is a new object. */
export function reviewVerdict(node: SessionNode): ReviewVerdict | null {
  const output = node.lastOutput;
  if (!output || output.partial || !output.text.trim()) return null;
  const hit = cache.get(output);
  if (hit && hit.node.title === node.title && hit.node.templateId === node.templateId && hit.node.contract === node.contract) return hit.verdict;
  const verdict = readVerdict(node, output);
  cache.set(output, { node: { title: node.title, templateId: node.templateId, contract: node.contract }, verdict });
  return verdict;
}

/** The Agents whose delivery the review checked: the one wired into its first required input (the delivery under
 * review), or else every Agent wired into it, in canvas order. */
export function reviewedProducers(review: SessionNode, agents: ReadonlyArray<SessionNode>, wired: ReadonlyArray<CanvasEdge>): SessionNode[] {
  const incoming = wired.filter(edge => edge.toNode === review.id && edge.kind !== 'feedback');
  const from = (edges: ReadonlyArray<CanvasEdge>) => agents.filter(agent => agent.id !== review.id && edges.some(edge => edge.fromNode === agent.id));
  const primary = review.contract?.inputs.find(field => field.required) ?? review.contract?.inputs[0];
  const delivering = primary ? from(incoming.filter(edge => edge.toPort === `in:${primary.id}`)) : [];
  return delivering.length ? delivering : from(incoming);
}

/**
 * The producer's task requirements with a review's findings added as one constraint, so its next run reworks the
 * delivery from them. `marker` opens that constraint and names the review: an earlier rework from the same review is
 * replaced rather than piled up. The findings are shortened to the room the requirements have left; null when the
 * node's requirements are a version this page cannot edit, or too full to say anything useful.
 */
export function reworkRequirements(frame: unknown, marker: string, header: string, findings: string): TaskFrame | null {
  const base: TaskFrame | null = frame === undefined || frame === null
    ? { version: 1, source: 'manual', constraints: [], acceptanceCriteria: [] }
    : isTaskFrame(frame) ? cleanTaskFrame(frame) : null;
  if (!base) return null;
  const kept = base.constraints.filter(item => !item.startsWith(marker));
  if (kept.length >= TASK_FRAME_MAX_ENTRIES) return null;
  const used = [...kept, ...base.acceptanceCriteria].reduce((sum, item) => sum + chars(item), 0);
  const head = `${marker}${header}`;
  const room = Math.min(TASK_FRAME_MAX_ENTRY_LENGTH, TASK_FRAME_MAX_TOTAL_LENGTH - used) - chars(head) - 1;
  // Below this the findings would be cut to a line or two, which is no rework instruction at all.
  if (room < 200) return null;
  const next: TaskFrame = { ...base, constraints: [...kept, `${head}\n${clip(findings.trim(), room)}`] };
  return taskFrameError(next) === null ? next : null;
}

/** A review's findings that a rework handed to an Agent, as its task requirements hold them. */
export interface ReworkFindings {
  /** The review node's title when the rework was made. */
  reviewer: string;
  /** What the Agent is told on each run: the instruction and the findings, after the marker. */
  text: string;
}

/**
 * The constraints a rework from a review added to these task requirements (reworkRequirements), in order. `markers`
 * are the marker texts in every language with `{node}` for the review's title: a canvas reworked in one language is
 * read in the other.
 */
export function reworkFindings(frame: unknown, markers: ReadonlyArray<string>): ReworkFindings[] {
  if (!isTaskFrame(frame)) return [];
  const forms = markers.flatMap(marker => {
    const at = marker.indexOf('{node}');
    return at > 0 ? [{ head: marker.slice(0, at), tail: marker.slice(at + '{node}'.length) }] : [];
  });
  const found: ReworkFindings[] = [];
  for (const item of frame.constraints) {
    for (const { head, tail } of forms) {
      const end = item.startsWith(head) && tail ? item.indexOf(tail, head.length) : -1;
      if (end <= head.length) continue;
      const text = item.slice(end + tail.length).trim();
      if (text) found.push({ reviewer: item.slice(head.length, end), text });
      break;
    }
  }
  return found;
}
