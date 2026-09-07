import { normalizeContract, parseContractOutput, type ContractField } from './nodeContracts';
import type { Turn } from './sessions';

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
