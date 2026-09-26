import { RuntimeError } from './errors.mjs';

// Structured delivery output. Go derives the contract from a node's frozen output
// fields; this module only ever turns that closed grammar into a fixed JSON schema.
// A request can never supply schema text, descriptions or keywords of its own.
export const CONTRACT_LIMITS = Object.freeze({ fields: 32, fileFields: 8, keyBytes: 64, schemaBytes: 8192 });
// Shared with Go (backend/internal/app/testdata/output_contract_v1_vectors.json):
// ASCII only, so JSON serialization never expands a byte of an ID.
export const FIELD_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Names that plain-object handling can silently drop or confuse.
const RESERVED_IDS = Object.freeze(['__proto__', 'prototype', 'constructor']);
export const FIELD_TYPES = Object.freeze(['text', 'markdown', 'html', 'number', 'boolean', 'file']);
export const DELIVERY_VIOLATIONS = Object.freeze(['not_object', 'unknown_field', 'missing_required', 'wrong_type', 'invalid_file', 'empty_delivery']);

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
// Own keys only, symbols included, never looked up through the prototype chain.
const exactKeys = (value, keys) => {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
};
const ownValue = (value, key) => Object.getOwnPropertyDescriptor(value, key);

export const validFieldID = id => typeof id === 'string' && FIELD_ID.test(id) && !RESERVED_IDS.includes(id);

// Accepts only {version:1, fields:[{id, type, required}]}. Anything else, a raw
// JSON Schema object included, is refused.
export function validateOutputContract(value) {
  if (!plainObject(value) || !exactKeys(value, ['version', 'fields']) || value.version !== 1) throw new Error('Invalid output contract');
  const { fields } = value;
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > CONTRACT_LIMITS.fields) throw new Error('Invalid output contract fields');
  const ids = new Set();
  let files = 0;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!plainObject(field) || !exactKeys(field, ['id', 'type', 'required'])
      || !validFieldID(field.id) || ids.has(field.id)
      || !FIELD_TYPES.includes(field.type) || typeof field.required !== 'boolean') throw new Error('Invalid output contract field');
    ids.add(field.id);
    if (field.type === 'file' && ++files > CONTRACT_LIMITS.fileFields) throw new Error('Too many output contract file fields');
  }
  return value;
}

function fieldSchema(type) {
  switch (type) {
    case 'number': return { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'file': return { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'], additionalProperties: false };
    default: return { type: 'string' };
  }
}

// The SDK maps this to Chat Completions response_format and Responses text.format.
// Strict decoding is only requested when every field is required, because strict
// providers reject optional properties.
export function deliveryOutputType(contract) {
  const { fields } = validateOutputContract(contract);
  return {
    type: 'json_schema',
    name: 'awwo_delivery',
    strict: fields.every(field => field.required),
    schema: {
      type: 'object',
      properties: Object.fromEntries(fields.map(field => [field.id, fieldSchema(field.type)])),
      required: fields.filter(field => field.required).map(field => field.id),
      additionalProperties: false,
    },
  };
}

// Bytes the response-format envelope adds to a provider request. The Chat
// Completions wrapper is larger than the Responses one, so it bounds both.
export function deliverySchemaBytes(contract) {
  const { name, strict, schema } = deliveryOutputType(contract);
  return Buffer.byteLength(JSON.stringify({ type: 'json_schema', json_schema: { name, strict, schema } }));
}

// The delivered text must be exactly one JSON object: no fences, prose or arrays.
export function parseDeliveryText(text) {
  let value;
  try { value = typeof text === 'string' ? JSON.parse(text) : undefined; } catch { value = undefined; }
  if (!plainObject(value)) throw new RuntimeError('OUTPUT_CONTRACT_INVALID');
  return value;
}

// Structural checks only. Value rules (blank text, complete HTML, file names, sizes
// and counts) stay with Go, which validates every completed delivery again.
export function deliveryViolation(contract, value) {
  const { fields } = validateOutputContract(contract);
  if (!plainObject(value)) return 'not_object';
  const declared = new Set(fields.map(field => field.id));
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !declared.has(key))) return 'unknown_field';
  let delivered = 0;
  for (const field of fields) {
    const descriptor = ownValue(value, field.id);
    if (!descriptor || descriptor.value === null) {
      if (field.required) return 'missing_required';
      continue;
    }
    if (!Object.hasOwn(descriptor, 'value')) return 'wrong_type';
    const item = descriptor.value;
    if (field.type === 'file') {
      if (!plainObject(item) || !exactKeys(item, ['name', 'content'])
        || typeof ownValue(item, 'name').value !== 'string' || typeof ownValue(item, 'content').value !== 'string') return 'invalid_file';
    } else if (field.type === 'number' ? typeof item !== 'number' || !Number.isFinite(item)
      : field.type === 'boolean' ? typeof item !== 'boolean' : typeof item !== 'string') return 'wrong_type';
    delivered++;
  }
  return delivered === 0 ? 'empty_delivery' : null;
}

// A local, pure output guardrail. It never calls a model, and its outputInfo names
// only the violation, so no delivered content reaches errors or diagnostics.
export function deliveryGuardrail(contract) {
  const checked = validateOutputContract(contract);
  return {
    name: 'awwo_delivery_contract',
    async execute({ agentOutput }) {
      const violation = deliveryViolation(checked, agentOutput);
      return { tripwireTriggered: violation !== null, outputInfo: { violation } };
    },
  };
}
