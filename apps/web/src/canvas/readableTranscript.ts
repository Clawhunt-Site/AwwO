import { normalizeContract, parseContractOutput, type ContractField } from './nodeContracts';
import type { CollaborationMessageContext, Turn } from './sessions';
import { isCompleteHtmlDocument } from './htmlDeliverable';

/** Match explicit transport metadata to this exact stored message and Session. */
export function collaborationMessageContext(value: unknown, runId: string | undefined, sessionId: string): CollaborationMessageContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const context = value as CollaborationMessageContext;
  if (!runId || context.runId !== runId || context.sessionId !== sessionId || typeof context.nodeId !== 'string' || !context.nodeId
    || !['proposal', 'review', 'synthesis'].includes(context.phase) || !Number.isInteger(context.round) || context.round < 1 || context.round > 3
    || typeof context.goal !== 'string' || !context.goal.trim() || context.goal.length > 4000) return undefined;
  return { nodeId: context.nodeId, sessionId, runId, phase: context.phase, round: context.round, goal: context.goal };
}

export function collaborationInputSummary(turn: Pick<Turn, 'role' | 'runId' | 'nativeRunId' | 'collaboration'>, locale: 'zh' | 'en'): string | null {
  if (turn.role !== 'user' || !turn.collaboration || (turn.runId && turn.nativeRunId && turn.runId !== turn.nativeRunId)) return null;
  const context = collaborationMessageContext(turn.collaboration, turn.runId || turn.nativeRunId, turn.collaboration.sessionId);
  if (!context) return null;
  const phase = { proposal: ['提案', 'Proposal'], review: ['互审', 'Peer review'], synthesis: ['汇总', 'Synthesis'] }[context.phase][locale === 'zh' ? 0 : 1];
  return `${locale === 'zh' ? `第 ${context.round} 轮` : `Round ${context.round}`} · ${phase}\n${context.goal}`;
}

/** Complete HTML is summarized as a document, without asserting run success or publishing it. */
export function htmlPreviewSummary(text: string, locale: 'zh' | 'en'): string | null {
  return isCompleteHtmlDocument(text) ? locale === 'zh' ? 'HTML 文档 · 打开预览' : 'HTML document · Open preview' : null;
}

export interface ReadableOutput {
  fields: Array<{ field: ContractField; value: string }>;
  invalid: boolean;
}

/** A display projection only. Never infers completion or uses the node's current contract. */
export function readableOutput(turn: Turn): ReadableOutput {
  const raw: ReadableOutput = { fields: [], invalid: false };
  if (turn.role !== 'agent' || turn.tone === 'error' || turn.tone === 'warn'
    || turn.presentation?.outputState !== 'final') return raw;
  const contract = normalizeContract(turn.presentation.outputContract);
  if (!contract?.outputs.length) return raw;

  const result = parseContractOutput(contract, turn.text);
  if (result.errors.length) return { fields: [], invalid: true };
  // A one-field text contract also accepts ordinary prose. Keep that text as it is;
  // only a complete keyed JSON object is a structured response worth projecting.
  const trimmed = turn.text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let object: unknown;
  try { object = JSON.parse(fenced ? fenced[1] : trimmed); } catch { return raw; }
  if (!object || typeof object !== 'object' || Array.isArray(object)) return raw;
  const fields = contract.outputs
    .filter(field => Object.hasOwn(object, field.id) && Object.hasOwn(result.values, field.id))
    .map(field => ({ field, value: result.values[field.id] }));
  return { fields, invalid: false };
}

/** Unknown old text stays whole: length controls disclosure, never content recognition. */
export function collapseHistoricalInput(turn: Turn): boolean {
  return turn.role === 'user' && !turn.presentation && turn.text.length >= 1200;
}
