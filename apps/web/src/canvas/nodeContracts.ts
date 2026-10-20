import type { UiLocale } from '../locale';
import { deliveryJsonSource } from './deliveryJson';

import { htmlDocumentSource, isCompleteHtmlDocument } from './htmlDeliverable';
import { canvasText } from './i18n';

/** Versioned, local input/output forms for an Agent session. File values are references. */
export type ContractFieldType = 'text' | 'markdown' | 'html' | 'number' | 'boolean' | 'file';

export interface ContractField {
  id: string;
  label: string;
  type: ContractFieldType;
  required: boolean;
  value: string;
  /** Guidance is display metadata, never a default input or a published output value. */
  help?: string;
  placeholder?: string;
}

export interface NodeContract {
  version: 1;
  inputs: ContractField[];
  outputs: ContractField[];
}

export function emptyContract(): NodeContract {
  return { version: 1, inputs: [], outputs: [] };
}

const FIELD_TYPES: ReadonlyArray<ContractFieldType> = ['text', 'markdown', 'html', 'number', 'boolean', 'file'];

/** Reject unknown versions and ambiguous field identities; never coerce a declared type. */
export function normalizeContract(value: unknown): NodeContract | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.inputs) || !Array.isArray(raw.outputs)) return undefined;
  const normalizeFields = (items: unknown[]): ContractField[] | undefined => {
    const fields: ContractField[] = [];
    const ids = new Set<string>();
    for (const item of items) {
      if (!item || typeof item !== 'object') return undefined;
      const f = item as Record<string, unknown>;
      if (
        typeof f.id !== 'string' || !f.id.trim() || ids.has(f.id)
        || typeof f.label !== 'string' || typeof f.value !== 'string' || typeof f.required !== 'boolean'
        || !FIELD_TYPES.includes(f.type as ContractFieldType)
      ) return undefined;
      ids.add(f.id);
      fields.push({
        id: f.id,
        label: f.label,
        type: f.type as ContractFieldType,
        required: f.required,
        value: f.value,
        ...(typeof f.help === 'string' ? { help: f.help } : {}),
        ...(typeof f.placeholder === 'string' ? { placeholder: f.placeholder } : {}),
      });
    }
    return fields;
  };
  const inputs = normalizeFields(raw.inputs);
  const outputs = normalizeFields(raw.outputs);
  return inputs && outputs ? { version: 1, inputs, outputs } : undefined;
}

/** Validate form values without changing their canonical text/Markdown serialization. The messages are in the
 *  reader's language; the default is the Chinese of the run engine's own notes, which quote them. */
export function validateContractFields(fields: ReadonlyArray<ContractField>, locale: UiLocale = 'zh'): string[] {
  const errors: string[] = [];
  for (const field of fields) {
    const label = field.label || field.id;
    const value = field.value.trim();
    if (!value) {
      if (field.required) errors.push(canvasText(locale, 'contract.requiredError', { label }));
      continue;
    }
    if (field.type === 'number' && !Number.isFinite(Number(value))) errors.push(canvasText(locale, 'contract.numberError', { label }));
    if (field.type === 'boolean' && value !== 'true' && value !== 'false') errors.push(canvasText(locale, 'contract.booleanError', { label }));
    if (field.type === 'html' && !isCompleteHtmlDocument(value)) errors.push(canvasText(locale, 'contract.htmlError', { label }));
  }
  return errors;
}

function notKeyedObject(contract: NodeContract, locale: UiLocale): string {
  const fields = contract.outputs.map((f) => f.label || f.id).join(locale === 'zh' ? '、' : ', ');
  return canvasText(locale, 'contract.outputJsonError', { fields });
}

export interface ContractOutputResult {
  /** Only declared fields are exposed to connected downstream inputs. */
  values: Record<string, string>;
  errors: string[];
}

/** One text/Markdown/HTML field may be its source; all other schemas use a keyed JSON object. Errors are in `locale`. */
export function parseContractOutput(contract: NodeContract, output: string, locale: UiLocale = 'zh'): ContractOutputResult {
  const values: Record<string, string> = Object.create(null);
  if (!contract.outputs.length) return { values, errors: [] };
  const single = contract.outputs.length === 1 ? contract.outputs[0] : undefined;
  const acceptsText = single && (single.type === 'text' || single.type === 'markdown' || single.type === 'html');
  let parsed: unknown;
  try {
    parsed = JSON.parse(deliveryJsonSource(output));
  } catch {
    if (!acceptsText) {
      return { values, errors: [notKeyedObject(contract, locale)] };
    }
  }
  const object = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  // JSON examples are valid plain Markdown too. A single text field is wrapped only when
  // the object actually names that field; otherwise preserve the user's whole text.
  if (acceptsText && (!object || !Object.hasOwn(object, single.id))) {
    const value = single.type === 'html' ? htmlDocumentSource(output) : output;
    values[single.id] = value;
    return { values, errors: validateContractFields([{ ...single, value }], locale) };
  }
  if (!object) {
    return { values, errors: [notKeyedObject(contract, locale)] };
  }

  const errors: string[] = [];
  for (const field of contract.outputs) {
    const value = Object.hasOwn(object, field.id) ? object[field.id] : undefined;
    // Optional files may be absent in older/Pi responses; match server materialization
    // without weakening required files or the declared types of other fields.
    if (!field.required && field.type === 'file' && (value === null || value === '')) continue;
    if (value === undefined) {
      if (field.required) errors.push(canvasText(locale, 'contract.outputRequiredError', { label: field.label || field.id }));
      continue;
    }
    const expected = field.type === 'number' || field.type === 'boolean' ? field.type : 'string';
    if (typeof value !== expected || (typeof value === 'number' && !Number.isFinite(value))) {
      errors.push(canvasText(locale, 'contract.outputTypeError', { label: field.label || field.id, type: field.type }));
      continue;
    }
    const serialized = field.type === 'html' && typeof value === 'string' ? htmlDocumentSource(value)
      : typeof value === 'string' ? value : String(value);
    values[field.id] = serialized;
    errors.push(...validateContractFields([{ ...field, value: serialized }], locale));
  }
  return { values, errors };
}
