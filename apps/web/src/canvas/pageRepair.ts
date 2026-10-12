// A delivered page that fails when it runs goes back to the node that made it, once, with the error: the node's own
// model gets the page as delivered, the browser's message and the lines where it happened, and answers with the fixed
// page alone, which goes back into its field. It is what a person would do in the component's chat ("this page fails:
// …, fix it"), done for them the first time; a page the repair delivered is not repaired again.
//
// Pages report through pageErrors.ts from wherever they run (the card on the board, the deliverable drawer, the studio,
// the 成果 view). The report carries the page itself, so the node is found by what it published, not by which view
// happened to show it. The once-only record lives in the canvas's own browser storage: another tab of the same canvas
// sees it, a reload keeps it.
import type { CanvasNode, NodeOutput, SessionNode } from './canvasDoc';
import { htmlDocumentSource, isCompleteHtmlDocument } from './htmlDeliverable';
import { parseContractOutput } from './nodeContracts';
import type { PageErrorReport } from './pageErrors';

/** A larger page is not sent back to its model in one message (and would not fit the chat's recovery store). */
export const MAX_REPAIR_PAGE_CHARS = 200_000;
/** A page delivered this soon after its node was asked for a repair is that repair's result, and is not repaired again. */
export const REPAIR_RESULT_WINDOW_MS = 30 * 60_000;
export const PAGE_REPAIR_STORAGE_KEY = 'awwo.canvas.page-repair.v1';
const MAX_RECORDS = 50;

/** The node whose published page failed, the delivery it is in, and that delivery's field values. */
export interface PageRepairTarget {
  node: SessionNode;
  output: NodeOutput;
  fieldId: string;
  values: Record<string, string>;
}

const normalized = (page: string) => htmlDocumentSource(page).replace(/^\uFEFF/, '').trim();

/**
 * The node that published `page` in an HTML field of its current, complete run result. A page that came from a case
 * recording, a hand-published value, a failed run or a past conversation is nobody's to repair.
 */
export function pageRepairTarget(nodes: ReadonlyArray<CanvasNode>, page: string): PageRepairTarget | null {
  const wanted = normalized(page);
  if (!wanted || wanted.length > MAX_REPAIR_PAGE_CHARS) return null;
  for (const node of nodes) {
    if (node.kind !== 'session' || !node.contract?.outputs.some(field => field.type === 'html')) continue;
    const output = node.lastOutput;
    if (!output || output.source !== 'run' || output.partial) continue;
    const parsed = parseContractOutput(node.contract, output.text);
    if (parsed.errors.length) continue;
    const field = node.contract.outputs.find(item => item.type === 'html' && typeof parsed.values[item.id] === 'string'
      && normalized(parsed.values[item.id]) === wanted);
    if (field) return { node, output, fieldId: field.id, values: parsed.values };
  }
  return null;
}

/** When a node was last asked for a repair: of which delivery (`from`, its time) and when (`at`). */
export interface PageRepairRecord { from: number; at: number }
type Records = Record<string, PageRepairRecord>;

export function loadPageRepairRecords(storage: Pick<Storage, 'getItem'>): Records {
  try {
    const value: unknown = JSON.parse(storage.getItem(PAGE_REPAIR_STORAGE_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, PageRepairRecord] => {
      const record = entry[1] as Partial<PageRepairRecord> | null;
      return Boolean(record) && Number.isFinite(record!.from) && Number.isFinite(record!.at);
    }));
  } catch { return {}; }
}

/** Keep the newest records only: a record older than the result window no longer decides anything. */
export function savePageRepairRecord(storage: Pick<Storage, 'getItem' | 'setItem'>, nodeId: string, record: PageRepairRecord): boolean {
  const records = { ...loadPageRepairRecords(storage), [nodeId]: record };
  const kept = Object.entries(records).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_RECORDS);
  try { storage.setItem(PAGE_REPAIR_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept))); return true; }
  catch { return false; }
}

/**
 * 'repair': ask the node. 'asked': this delivery (or an older one) was already sent back. 'repaired': this delivery
 * arrived soon after a repair was asked for, so it is the repair's own result; once is enough.
 */
export function pageRepairDecision(record: PageRepairRecord | undefined, output: NodeOutput): 'repair' | 'asked' | 'repaired' {
  if (!record) return 'repair';
  if (output.at <= record.at) return 'asked';
  return output.at - record.at <= REPAIR_RESULT_WINDOW_MS ? 'repaired' : 'repair';
}

/** The instruction's first line: it names the field, so the reply (just the fixed page) goes back into that field. */
const PAGE_REPAIR_HEADER = /^AwwO page repair · field "([^"\n]+)"\n/;

/**
 * The instruction the node's model receives. The answer is only the fixed page: no JSON to escape a whole document
 * into, nothing else to copy. AwwO puts it back into the field and keeps the delivery's other fields (pageRepairDelivery).
 */
export function pageRepairMessage(target: PageRepairTarget, report: PageErrorReport): string {
  const contract = target.node.contract!;
  const field = contract.outputs.find(item => item.id === target.fieldId)!;
  const page = htmlDocumentSource(target.values[target.fieldId]);
  const others = contract.outputs.some(item => item.id !== target.fieldId && Object.hasOwn(target.values, item.id));
  return [
    `AwwO page repair · field "${field.id}"`,
    `AwwO ran the page you delivered in "${field.label || field.id}", and it failed with this error, so the reader cannot use it:`,
    '',
    report.message,
    ...report.lines.length ? ['', 'Where it happened, as AwwO ran the page:', ...report.lines.map(line => `  ${line}`)] : [],
    '',
    'Fix this error, and any other mistake you find that would stop the page from running, so that it works the first time it opens. '
      + 'Change nothing else: copy every other line exactly as it is, character for character and punctuation included, so that its design, '
      + 'its words and their language, its behaviour and its libraries stay as they are. '
      + 'The page runs in a sandbox without storage or network: guard any use of localStorage, sessionStorage or cookies with try/catch.',
    '',
    'The page as you delivered it, between the two marker lines:',
    '-----BEGIN PAGE-----',
    page,
    '-----END PAGE-----',
    '',
    'Reply with only the whole fixed HTML document, from <!doctype html> to </html>: no JSON, no Markdown fence, no other words. '
      + `AwwO puts it back in "${field.label || field.id}"${others ? ' and keeps the delivery\'s other fields as they are' : ''}.`,
  ].join('\n');
}

/**
 * The delivery a repair's reply publishes, or null when it is no such reply: the node's current delivery with the
 * repaired field replaced by the page in the reply (a fenced page, or one with words around it, counts; a fragment
 * does not). An ordinary chat message, a JSON reply or a field that is not a page leave this to the usual rules.
 */
export function pageRepairDelivery(node: CanvasNode, manualMessage: string | undefined, reply: string): string | null {
  const fieldId = manualMessage?.match(PAGE_REPAIR_HEADER)?.[1];
  if (!fieldId || node.kind !== 'session' || !node.contract) return null;
  const contract = node.contract;
  if (!contract.outputs.some(item => item.id === fieldId && item.type === 'html')) return null;
  const unfenced = htmlDocumentSource(reply.trim()).trim();
  const start = unfenced.search(/<!doctype html/i);
  const end = unfenced.toLowerCase().lastIndexOf('</html>');
  const page = start >= 0 && end > start ? unfenced.slice(start, end + '</html>'.length) : unfenced;
  if (!isCompleteHtmlDocument(page)) return null;
  const current = node.lastOutput && !node.lastOutput.partial ? parseContractOutput(contract, node.lastOutput.text) : null;
  const values: Record<string, string> = { ...current && !current.errors.length ? current.values : {}, [fieldId]: page };
  const typed = Object.fromEntries(contract.outputs.filter(item => Object.hasOwn(values, item.id)).map(item => [item.id,
    item.type === 'number' ? Number(values[item.id]) : item.type === 'boolean' ? values[item.id] === 'true' : values[item.id]]));
  const text = JSON.stringify(typed);
  return parseContractOutput(contract, text).errors.length ? null : text;
}

/** What the component's chat shows for the request (the full instruction stays out of the transcript). */
export function pageRepairDisplayText(report: PageErrorReport, locale: 'zh' | 'en'): string {
  const message = report.message.replace(/^Uncaught\s+/, '');
  const short = message.length > 160 ? `${message.slice(0, 160)}…` : message;
  return locale === 'zh' ? `页面运行出错，AwwO 自动修复一次：${short}` : `The page failed to run, so AwwO is fixing it once: ${short}`;
}
