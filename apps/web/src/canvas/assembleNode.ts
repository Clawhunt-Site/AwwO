// An assemble node makes its deliverable from its inputs without a model: every {{in:<field id>}} slot of its template
// takes that input's exact text — the upstream output its wire carries, or the field's own value. An agent team
// delivers a program as modules; before this node, a model call re-typed every module into the page, which spent most
// of a 32,000-token call on copying and capped a delivered page at about 42 KB.
//
// The API runs the same algorithm for cloud runs (backend/internal/app/graph_assemble.go); both are checked against
// backend/internal/app/testdata/assemble_vectors.json.

import { nodeContract, type AssembleNode, type CanvasEdge, type CanvasNode } from './canvasDoc';
import { parseContractOutput } from './nodeContracts';

export const MAX_ASSEMBLE_TEMPLATE_BYTES = 64 * 1024;
/** The page preview's own limit (MAX_ARTIFACT_PREVIEW_BYTES); a larger document could not be shown anyway. */
export const MAX_ASSEMBLE_OUTPUT_BYTES = 2 * 1024 * 1024;
export const ASSEMBLE_DEFAULT_FILE = 'index.html';

const SLOT = /\{\{in:([A-Za-z0-9_-]{1,64})\}\}/g;

interface Region { start: number; end: number; tag: 'script' | 'style' }

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** The content of every <script> and <style> element of a template, HTML comments skipped. */
function regions(template: string): Region[] {
  // A-Z only: toLowerCase can change the length of non-ASCII text, and HTML tag names fold in ASCII only.
  const lower = template.replace(/[A-Z]/g, c => c.toLowerCase());
  const found: Region[] = [];
  for (let i = 0; i < template.length;) {
    if (lower.startsWith('<!--', i)) {
      const end = lower.indexOf('-->', i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    let tag: Region['tag'] | null = null;
    for (const name of ['script', 'style'] as const) {
      if (lower.startsWith(`<${name}`, i)) {
        const next = lower[i + 1 + name.length];
        if (next === undefined || ' \t\r\n\f/>'.includes(next)) tag = name;
      }
    }
    if (!tag) { i += 1; continue; }
    const open = template.indexOf('>', i);
    if (open < 0) break;
    const start = open + 1;
    const closing = lower.indexOf(`</${tag}`, start);
    const end = closing < 0 ? template.length : closing;
    found.push({ start, end, tag });
    i = end;
  }
  return found;
}

/** The body of a value that is exactly one Markdown code fence (a model often wraps a module in one); any other value
 *  is returned unchanged. */
export function unfenceAssembleValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('```')) return value;
  const lines = trimmed.replace(/\r\n/g, '\n').split('\n');
  if (lines.length < 2 || lines[lines.length - 1].trim() !== '```') return value;
  if (lines[0].slice(3).trim().includes('`')) return value;
  const body = lines.slice(1, -1);
  if (body.some(line => line.trim().startsWith('```'))) return value;
  return body.join('\n');
}

/** Keep inserted text inside its element: a script or style sheet may not end itself. */
function escapeValue(value: string, tag: Region['tag'] | null): string {
  if (tag === 'script') return value.replace(/<\/([sS][cC][rR][iI][pP][tT])/g, '<\\/$1').split('<!--').join('<\\!--');
  if (tag === 'style') return value.replace(/<\/([sS][tT][yY][lL][eE])/g, '<\\/$1');
  return value;
}

export interface AssembleResult { ok: true; text: string }
export interface AssembleFailure { ok: false; error: string }

/** Fill every slot in one left-to-right pass; inserted text is never scanned for slots again. */
export function assembleTemplate(template: string, values: Readonly<Record<string, string>>): AssembleResult | AssembleFailure {
  const spans = regions(template);
  let text = '';
  let last = 0;
  for (const match of template.matchAll(SLOT)) {
    const id = match[1];
    const at = match.index ?? 0;
    if (!Object.hasOwn(values, id)) return { ok: false, error: `Template slot {{in:${id}}} names no input` };
    const tag = spans.find(region => at >= region.start && at + match[0].length <= region.end)?.tag ?? null;
    text += template.slice(last, at) + escapeValue(unfenceAssembleValue(values[id]), tag);
    last = at + match[0].length;
  }
  text += template.slice(last);
  if (utf8Length(text) > MAX_ASSEMBLE_OUTPUT_BYTES) return { ok: false, error: 'The assembled result exceeds 2 MiB' };
  return { ok: true, text };
}

/** Every input id a template's slots name, in first-use order. */
export function templateSlots(template: string): string[] {
  const ids: string[] = [];
  for (const match of template.matchAll(SLOT)) if (!ids.includes(match[1])) ids.push(match[1]);
  return ids;
}

/** What one input of an assemble node holds right now, for its card: where it comes from and how much is there. */
export interface AssembleInputView {
  id: string;
  label: string;
  required: boolean;
  /** The upstream node's title for a wired input; null for one typed into the node. */
  source: string | null;
  /** UTF-8 bytes it would insert now (the upstream's published delivery, or the typed value). */
  bytes: number;
  /** Whether any slot of the template names it. */
  used: boolean;
}

export function assembleInputViews(node: AssembleNode, nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<CanvasEdge>): AssembleInputView[] {
  const used = new Set(templateSlots(node.template));
  return node.contract.inputs.map(field => {
    const edge = edges.find(item => item.toNode === node.id && item.toPort === `in:${field.id}` && item.kind !== 'feedback');
    const upstream = edge ? nodes.find(item => item.id === edge.fromNode) : undefined;
    let value = field.value;
    if (edge) {
      const delivered = upstream?.lastOutput && !upstream.lastOutput.partial ? upstream.lastOutput.text : '';
      const contract = upstream && nodeContract(upstream);
      value = contract ? parseContractOutput(contract, delivered).values[edge.fromPort.slice('out:'.length)] ?? '' : delivered;
    }
    return { id: field.id, label: field.label || field.id, required: field.required,
      source: edge ? upstream?.title ?? edge.fromNode : null, bytes: utf8Length(unfenceAssembleValue(value)), used: used.has(field.id) };
  });
}

/** Problems that keep a template from running, the same ones the API refuses at admission. */
export function templateIssues(template: string, inputIds: ReadonlyArray<string>): string[] {
  const issues: string[] = [];
  if (!template.trim() || utf8Length(template) > MAX_ASSEMBLE_TEMPLATE_BYTES) issues.push(`An assemble node needs a template of 1–${MAX_ASSEMBLE_TEMPLATE_BYTES} bytes`);
  for (const id of templateSlots(template)) if (!inputIds.includes(id)) issues.push(`Template slot {{in:${id}}} names no input`);
  return issues;
}
