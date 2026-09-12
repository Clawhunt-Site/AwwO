// Static trusted functions only. Requests select IDs; they never supply code,
// schemas, network destinations, filesystem paths, or command arguments.
const definitions = Object.freeze({
  calculator: Object.freeze({ name: 'calculator', description: 'Calculate bounded arithmetic with decimal numbers, + - * / and parentheses.',
    parameters: { type: 'object', properties: { expression: { type: 'string', maxLength: 256 } }, required: ['expression'], additionalProperties: false } }),
  current_time: Object.freeze({ name: 'current_time', description: 'Return the current ISO UTC timestamp and optionally a validated IANA timezone display.',
    parameters: { type: 'object', properties: { timeZone: { type: ['string', 'null'], maxLength: 80 } }, required: ['timeZone'], additionalProperties: false } }),
});
export function validateToolNames(names) {
  if (!Array.isArray(names) || names.length > 2 || new Set(names).size !== names.length
    || names.some(name => typeof name !== 'string' || !Object.hasOwn(definitions, name))) throw new Error('Invalid tool selection');
  return [...names];
}
export const toolMetadata = name => ({ id: name, name, type: 'function', readOnly: true, description: definitions[name].description, contextTextBytes: toolDefinitionBytes([name]) });
export const toolDefinitionBytes = names => names.reduce((bytes, name) => bytes + Buffer.byteLength(JSON.stringify(definitions[name])) + 128, 0);

export class ToolInputError extends Error { constructor() { super('Invalid registered tool input'); this.name = 'ToolInputError'; } }
export function parseToolArguments(name, serialized) {
  let input;
  try { input = JSON.parse(serialized); } catch { throw new ToolInputError(); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1) throw new ToolInputError();
  if (name === 'calculator' && Object.hasOwn(input, 'expression') && typeof input.expression === 'string') return input;
  if (name === 'current_time' && Object.hasOwn(input, 'timeZone') && (input.timeZone === null || typeof input.timeZone === 'string')) return input;
  throw new ToolInputError();
}
function bounded(value) { if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new ToolInputError(); return value; }
export function calculate(expression) {
  if (typeof expression !== 'string' || !expression.length || expression.length > 256 || /[^0-9. +*/()\-\t]/.test(expression)) throw new ToolInputError();
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+*/-]/g) ?? [];
  if (tokens.join('') !== expression.replace(/[ \t]/g, '') || tokens.length > 128) throw new ToolInputError();
  let at = 0;
  function atom(depth) {
    if (depth > 16) throw new ToolInputError();
    const token = tokens[at++];
    if (token === '+' || token === '-') return bounded((token === '-' ? -1 : 1) * atom(depth + 1));
    if (token === '(') { const value = sum(depth + 1); if (tokens[at++] !== ')') throw new ToolInputError(); return value; }
    if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) throw new ToolInputError();
    return bounded(Number(token));
  }
  function product(depth) {
    let value = atom(depth);
    while (['*', '/'].includes(tokens[at])) { const op = tokens[at++], rhs = atom(depth); value = bounded(op === '*' ? value * rhs : value / rhs); }
    return value;
  }
  function sum(depth) {
    let value = product(depth);
    while (['+', '-'].includes(tokens[at])) { const op = tokens[at++], rhs = product(depth); value = bounded(op === '+' ? value + rhs : value - rhs); }
    return value;
  }
  const value = sum(0); if (at !== tokens.length) throw new ToolInputError(); return Object.is(value, -0) ? 0 : value;
}
export function executeTool(name, input, now = () => new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ToolInputError();
  if (name === 'calculator' && Object.keys(input).length === 1 && Object.hasOwn(input, 'expression')) return JSON.stringify({ value: calculate(input.expression) });
  if (name === 'current_time' && Object.keys(input).length === 1 && Object.hasOwn(input, 'timeZone')) {
    const timeZone = input.timeZone ?? 'UTC';
    if (typeof timeZone !== 'string' || timeZone.length > 80 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+){0,2}$/.test(timeZone)) throw new ToolInputError();
    try {
      const date = now();
      const local = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short', timeStyle: 'long' }).format(date);
      return JSON.stringify({ iso: date.toISOString(), timeZone, local });
    } catch { throw new ToolInputError(); }
  }
  throw new ToolInputError();
}
export function registeredTools(names, tool, { signal, onTool } = {}) {
  return validateToolNames(names).map(name => tool({ ...definitions[name], strict: true, errorFunction: null,
    execute: input => {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const output = executeTool(name, input);
      onTool?.({ name }); // Metadata only; no arguments, clock output or user data in diagnostics.
      return output;
    },
  }));
}
