// A delivered page that fails when it runs goes back to the node that made it, once, with the error: the node's own
// model gets the page as delivered, the browser's message and the lines where it happened, and answers with the fixed
// page alone, which goes back into its field. It is what a person would do in the component's chat ("this page fails:
// …, fix it"), done for them the first time; a page the repair delivered is not repaired again. An explainer figure that
// runs but never moves goes back the same way, once, with what AwwO saw when it tried hovering and the keys; that once
// is its own, beside the once of a page that fails (pageRepairRecordKey). A session that declared no deliverables and
// returned a complete HTML document delivered a page too (resultPage.ts): it goes back the same way, its field named
// `result`, and the fixed page becomes its whole result.
//
// Pages report through pageErrors.ts from wherever they run (the card on the board, the deliverable drawer, the studio,
// the 成果 view). The report carries the page itself, so the node is found by what it published, not by which view
// happened to show it. The once-only record lives in the canvas's own browser storage: another tab of the same canvas
// sees it, a reload keeps it. A request the service refuses before anything runs (today's calls used up, every run
// slot busy) was no repair: the record says when the same delivery may go back (deferPageRepair). Another browser, another
// device or a collaborator has a record of its own, so the service holds them all to the same onces (page_repair.go): of a
// node's automatic repairs, at most one of each kind runs in a row, and none after that until another run of the node
// (a person's message, a canvas run), whether or not that run delivered a new page; it refuses the rest as
// page_repair_chained. It knows a repair by its first line (pageRepairMessage).
import { isMarketReference, type CanvasNode, type NodeOutput, type SessionNode } from './canvasDoc';
import { deliveryJsonSource } from './deliveryJson';
import { htmlDocumentSource, isCompleteHtmlDocument } from './htmlDeliverable';
import { parseContractOutput } from './nodeContracts';
import type { PageErrorReport } from './pageErrors';
import { displayContract, RESULT_PAGE_FIELD, undeclaredSession } from './resultPage';

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
 * The node that published `page` in an HTML field of its current, complete run result: a declared field, or the page a
 * session that declared none returned as its whole result (resultPage.ts, field `result`). A page that came from a case
 * recording, a hand-published value, a failed run or a past conversation is nobody's to repair, and neither is one a
 * market Agent made: each of its runs may cost its price, which only its caller decides to pay again. A node whose form
 * declares the page goes first: a session that declared none and passed the same page on (a builder wired into a
 * reviewer that returns it) is the node only where no declared one has it, as before such pages were read.
 */
export function pageRepairTarget(nodes: ReadonlyArray<CanvasNode>, page: string): PageRepairTarget | null {
  const wanted = normalized(page);
  if (!wanted || wanted.length > MAX_REPAIR_PAGE_CHARS) return null;
  let undeclared: PageRepairTarget | null = null;
  for (const node of nodes) {
    if (node.kind !== 'session' || isMarketReference(node.agentRef)) continue;
    const output = node.lastOutput;
    if (!output || output.source !== 'run' || output.partial) continue;
    const contract = displayContract(node, output.text);
    if (!contract.outputs.some(field => field.type === 'html')) continue;
    const parsed = parseContractOutput(contract, output.text);
    if (parsed.errors.length) continue;
    // A field's id goes into the repair's first line as it is (pageRepairMessage), so an id holding a line break, which
    // a stored contract may have, would end that line early: the page and the service would read another field or no
    // repair at all. Such a field is nobody's to repair automatically.
    const field = contract.outputs.find(item => item.type === 'html' && !item.id.includes('\n') && typeof parsed.values[item.id] === 'string'
      && normalized(parsed.values[item.id]) === wanted);
    if (!field) continue;
    const target = { node, output, fieldId: field.id, values: parsed.values };
    if (!undeclaredSession(node)) return target;
    undeclared ??= target;
  }
  return undeclared;
}

/**
 * When a node was last asked for a repair: of which delivery (`from`, its time) and when (`at`). `retryAfter` is set when
 * the service refused that request before anything ran, so it was no repair: from then on the same delivery may go back.
 */
export interface PageRepairRecord { from: number; at: number; retryAfter?: number }
type Records = Record<string, PageRepairRecord>;

export function loadPageRepairRecords(storage: Pick<Storage, 'getItem'>): Records {
  try {
    const value: unknown = JSON.parse(storage.getItem(PAGE_REPAIR_STORAGE_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const records: Records = {};
    for (const [nodeId, raw] of Object.entries(value as Record<string, unknown>)) {
      const record = raw as Partial<PageRepairRecord> | null;
      if (!record || !Number.isFinite(record.from) || !Number.isFinite(record.at)) continue;
      records[nodeId] = { from: record.from!, at: record.at!, ...Number.isFinite(record.retryAfter) ? { retryAfter: record.retryAfter! } : {} };
    }
    return records;
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
 * arrived soon after a repair was asked for, so it is the repair's own result; once is enough. A request the service
 * refused before it ran was no repair: its delivery may go back once `retryAfter` has passed, and a later one is new.
 */
export function pageRepairDecision(record: PageRepairRecord | undefined, output: NodeOutput, now = Date.now()): 'repair' | 'asked' | 'repaired' {
  if (!record) return 'repair';
  if (record.retryAfter !== undefined) return output.at > record.at || now >= record.retryAfter ? 'repair' : 'asked';
  if (output.at <= record.at) return 'asked';
  return output.at - record.at <= REPAIR_RESULT_WINDOW_MS ? 'repaired' : 'repair';
}

/** Refusals of today's allowance (the workspace's free premium calls, the service's free capacity, the plan's credits). */
const REFUSED_FOR_TODAY: ReadonlySet<string> = new Set(['premium_quota_exceeded', 'premium_capacity_exceeded', 'free_capacity_exceeded', 'credits_exhausted']);
/** Refusals that can clear within the hour: `quota_exceeded` means today's calls OR every run slot in use, `plan_busy` the latter. */
const REFUSED_FOR_NOW: ReadonlySet<string> = new Set(['quota_exceeded', 'plan_busy']);
/** How long a request refused for a busy slot (or calls that may be back) waits before its delivery may go again. */
export const REPAIR_RETRY_SOON_MS = 30 * 60_000;

/**
 * When a repair request the service refused before it ran (its code, ExecAgentResult.refusedCode) may go again: after
 * the next UTC midnight, when daily allowances reset, or half an hour on. Null for a refusal waiting does not change
 * (a model that cannot be billed, a malformed request, a repair of a repair: page_repair_chained): that request counts
 * as asked.
 */
export function pageRepairRetryAfter(code: string, now: number): number | null {
  if (REFUSED_FOR_TODAY.has(code)) {
    const day = new Date(now);
    return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
  }
  return REFUSED_FOR_NOW.has(code) ? now + REPAIR_RETRY_SOON_MS : null;
}

/** The node's last repair request was refused before it ran: its delivery may go back again from `retryAfter` on. */
export function deferPageRepair(storage: Pick<Storage, 'getItem' | 'setItem'>, nodeId: string, retryAfter: number): boolean {
  const record = loadPageRepairRecords(storage)[nodeId];
  return record ? savePageRepairRecord(storage, nodeId, { ...record, retryAfter }) : false;
}

/** The instruction's first line: it names the field, so the reply (just the fixed page) goes back into that field. The
 *  request for a figure that never moves ends it with " · still". The field's id goes in as it is, and an id may hold a
 *  quote (a plan's ids may, and a stored contract's may hold almost anything), so the id is the line up to its last quote
 *  (the service reads it the same way: page_repair.go). */
const PAGE_REPAIR_HEADER = /^AwwO page repair · field "([^\n]+)"( · still)?\n/;

/** Whether a component chat message is a page repair request (pageRepairMessage). */
export const isPageRepairMessage = (message: string | undefined): boolean => Boolean(message && PAGE_REPAIR_HEADER.test(message));

/** Where a node's repair is recorded: a figure that never moves has its own once, beside the once of a page that fails. */
export const pageRepairRecordKey = (nodeId: string, kind?: PageErrorReport['kind']): string => (kind === 'still' ? `${nodeId} · still` : nodeId);

/** The record a repair request belongs to (pageRepairRecordKey), read from the message's first line. */
export const pageRepairMessageKey = (nodeId: string, message: string | undefined): string =>
  pageRepairRecordKey(nodeId, message?.match(PAGE_REPAIR_HEADER)?.[2] ? 'still' : undefined);

/**
 * The instruction the node's model receives. The answer is only the fixed page: no JSON to escape a whole document
 * into, nothing else to copy. AwwO puts it back into the field and keeps the delivery's other fields (pageRepairDelivery).
 */
export function pageRepairMessage(target: PageRepairTarget, report: PageErrorReport): string {
  const contract = displayContract(target.node, target.output.text);
  const field = contract.outputs.find(item => item.id === target.fieldId)!;
  const page = htmlDocumentSource(target.values[target.fieldId]);
  const others = contract.outputs.some(item => item.id !== target.fieldId && Object.hasOwn(target.values, item.id));
  // A page no field was declared for is the session's whole result (resultPage.ts): its field is named by no one, so
  // the model hears of the page itself, and the fixed page takes its place.
  const undeclared = undeclaredSession(target.node);
  const where = undeclared ? '' : ` in "${field.label || field.id}"`;
  const back = undeclared ? 'AwwO puts it in place of the page you delivered.'
    : `AwwO puts it back in "${field.label || field.id}"${others ? ' and keeps the delivery\'s other fields as they are' : ''}.`;
  // The preview gives a page that uses storage a stand-in that lasts while the page is open (PREVIEW_STORAGE_SCRIPT), so
  // the model is told what it has there rather than asked to guard against what it no longer lacks.
  const sandbox = 'The page runs in a sandbox with no network access; localStorage, sessionStorage and cookies work there, kept only while the page is open.';
  // A figure that runs but never moves (pageErrors.ts): what AwwO tried and saw, and what moving means in the figure kit.
  const ask = report.kind === 'still' ? [
    `AwwO page repair · field "${field.id}" · still`,
    `AwwO ran the figure you delivered${where}, and it never moves, so the reader cannot use it:`,
    '',
    report.message,
    ...report.lines.length ? ['', 'What AwwO saw:', ...report.lines.map(line => `  ${line}`)] : [],
    '',
    'Make the figure move, so that it works the first time it opens: an idle tour plays when nobody touches it; hovering over the stage and its keys '
      + '(← → Home End, and Space or Enter for the main action) move its parts, eased; the loop\'s tick calls draw() and returns true while anything '
      + 'still moves; draw() sets the moving parts\' transform or d, refills a data-part group with el.innerHTML = …Parts(state), and writes the readout. '
      + 'Change nothing else: copy every line you do not need to change exactly as it is, character for character, so that its design and its parts, '
      + 'its words and their language, its numbers and its libraries stay as they are. ' + sandbox,
  ] : [
    `AwwO page repair · field "${field.id}"`,
    `AwwO ran the page you delivered${where}, and it failed with this error, so the reader cannot use it:`,
    '',
    report.message,
    ...report.lines.length ? ['', 'Where it happened, as AwwO ran the page:', ...report.lines.map(line => `  ${line}`)] : [],
    '',
    'Fix this error, and any other mistake you find that would stop the page from running, so that it works the first time it opens. '
      + 'Change nothing else: copy every other line exactly as it is, character for character and punctuation included, so that its design, '
      + 'its words and their language, its behaviour and its libraries stay as they are. ' + sandbox,
  ];
  return [
    ...ask,
    '',
    'The page as you delivered it, between the two marker lines:',
    '-----BEGIN PAGE-----',
    page,
    '-----END PAGE-----',
    '',
    'Reply with only the whole fixed HTML document, from <!doctype html> to </html>: no JSON, no Markdown fence, no other words. ' + back,
  ].join('\n');
}

/** A reply's JSON, read as a delivery is (deliveryJsonSource), or undefined for a reply that is no JSON. */
function replyJson(text: string): unknown {
  try { return JSON.parse(deliveryJsonSource(text)); } catch { return undefined; }
}

/** The field's string in a JSON value: undefined for a value that is no object, or has no string under that name. */
function fieldString(value: unknown, fieldId: string): string | undefined {
  const field = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[fieldId] : undefined;
  return typeof field === 'string' ? field : undefined;
}

/** The page in raw text, as a reply of the page alone gives it: unfenced, cut from `<!doctype html` to the last
 *  `</html>` (so words around it go), and only a complete document. Nothing in it is decoded. */
function rawReplyPage(text: string): string | null {
  const unfenced = htmlDocumentSource(text.trim()).trim();
  const start = unfenced.search(/<!doctype html/i);
  const end = unfenced.toLowerCase().lastIndexOf('</html>');
  const page = start >= 0 && end > start ? unfenced.slice(start, end + '</html>'.length) : unfenced;
  return isCompleteHtmlDocument(page) ? page : null;
}

/** Where the JSON object opened at `open` closes (its matching brace, strings and their escapes skipped), or -1 when the
 *  text ends first. Brackets are counted alike; JSON.parse judges the rest. */
function jsonObjectEnd(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const c = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth += 1;
    else if ((c === '}' || c === ']') && --depth === 0) return index;
  }
  return -1;
}

/** How deep a reply's JSON may hold the page: a JSON string or object, and one more inside its decoded value (a model
 *  that encoded its JSON twice). A page deeper than that is refused, never cut out encoded. */
const MAX_REPLY_DEPTH = 2;

/**
 * The fixed page a repair's reply holds for `fieldId`. The reply asks for the page alone, which comes raw: by itself,
 * fenced, or with words around it. A model may answer in JSON all the same, and a page cut out of a JSON string as it
 * stands keeps its escapes (`\"` in a script, a line's `\n`): it runs with a SyntaxError and, as the repair's own result,
 * never goes back again. So:
 * - a reply that is JSON (deliveryJsonSource: a fence and missing final closers allowed) gives its field's string, or a
 *   JSON string itself, decoded; any other JSON gives nothing;
 * - else, where a JSON object (`{` and a quoted key) opens before the page's `<!doctype html` and does not close before
 *   it, the page is inside that object: its field's string decoded, or nothing when the object does not read (cut short
 *   inside a string, a trailing comma) or holds no such field. Every object that closes before the page is words, and is
 *   passed over (each scan resumes past it, so the reply is read once);
 * - else the reply is raw, and its page is cut out as it is (rawReplyPage).
 * A decoded value is read the same way again, MAX_REPLY_DEPTH deep at most. Null for a reply that holds no complete
 * document for the field.
 */
function repairReplyPage(reply: string, fieldId: string, depth = 0): string | null {
  const json = replyJson(reply);
  if (json !== undefined) {
    if (depth >= MAX_REPLY_DEPTH) return null;
    const value = typeof json === 'string' ? json : fieldString(json, fieldId);
    return value === undefined ? null : repairReplyPage(value, fieldId, depth + 1);
  }
  const start = reply.search(/<!doctype html/i);
  if (start >= 0) {
    const opening = /\{\s*"/g;
    for (let match = opening.exec(reply); match && match.index < start; match = opening.exec(reply)) {
      const end = jsonObjectEnd(reply, match.index);
      if (end >= 0 && end < start) { opening.lastIndex = end + 1; continue; }
      if (depth >= MAX_REPLY_DEPTH) return null;
      const around = replyJson(reply.slice(match.index, end >= 0 ? end + 1 : undefined));
      const value = around === undefined ? undefined : fieldString(around, fieldId);
      return value === undefined ? null : repairReplyPage(value, fieldId, depth + 1);
    }
  }
  return rawReplyPage(reply);
}

/**
 * The delivery a repair's reply publishes, or null when it is no such reply: the node's current delivery with the
 * repaired field replaced by the page in the reply (repairReplyPage: a fenced page, one with words around it, or one in
 * JSON count; a fragment does not). A session that declared no deliverables delivered the page as its whole result
 * (resultPage.ts), and the fixed page alone is its new one. An ordinary chat message, a reply with no page for the field
 * or a field that is not a page leave this to the usual rules.
 */
export function pageRepairDelivery(node: CanvasNode, manualMessage: string | undefined, reply: string): string | null {
  const fieldId = manualMessage?.match(PAGE_REPAIR_HEADER)?.[1];
  if (!fieldId || node.kind !== 'session') return null;
  const undeclared = undeclaredSession(node);
  if (undeclared ? fieldId !== RESULT_PAGE_FIELD : !node.contract?.outputs.some(item => item.id === fieldId && item.type === 'html')) return null;
  const page = repairReplyPage(reply, fieldId);
  if (page === null) return null;
  if (undeclared) return page;
  const contract = node.contract;
  if (!contract) return null;
  const current = node.lastOutput && !node.lastOutput.partial ? parseContractOutput(contract, node.lastOutput.text) : null;
  const values: Record<string, string> = { ...current && !current.errors.length ? current.values : {}, [fieldId]: page };
  const typed = Object.fromEntries(contract.outputs.filter(item => Object.hasOwn(values, item.id)).map(item => [item.id,
    item.type === 'number' ? Number(values[item.id]) : item.type === 'boolean' ? values[item.id] === 'true' : values[item.id]]));
  const text = JSON.stringify(typed);
  return parseContractOutput(contract, text).errors.length ? null : text;
}

/** What the component's chat shows for the request (the full instruction stays out of the transcript). */
export function pageRepairDisplayText(report: PageErrorReport, locale: 'zh' | 'en'): string {
  if (report.kind === 'still') {
    return locale === 'zh' ? '原理图解不会动，AwwO 自动修复一次：悬停、按键后，图里的零件都没有动'
      : 'The figure never moves, so AwwO is fixing it once: hovering and keys moved none of its parts';
  }
  const message = report.message.replace(/^Uncaught\s+/, '');
  const short = message.length > 160 ? `${message.slice(0, 160)}…` : message;
  return locale === 'zh' ? `页面运行出错，AwwO 自动修复一次：${short}` : `The page failed to run, so AwwO is fixing it once: ${short}`;
}
