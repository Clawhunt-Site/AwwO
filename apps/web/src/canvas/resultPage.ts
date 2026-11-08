// A session that declares no deliverables (no output fields) delivers whatever it returns, and every view read that as
// text. Since 多人同屏 (2026-11-06) such sessions are common: an outside agent (Claude Code, Codex) adds its nodes over
// MCP, and only a person may give a node a contract (docs/awwo-canvas-live-collaboration.md). When what one of them
// returned is a complete HTML document (isCompleteHtmlDocument: the whole result, or one complete html fence; never a
// fragment, nor a document with words around it), it is the page it is, shown through one html field wherever a page
// is shown: the deliverables panel, an enlarged card, the results studio, a preview display and the 成果 view. Each
// of them runs it, and the page check sends it back to its node once when it fails (pageRepair.ts). The card already
// said so ("HTML 文档 · 打开预览", SessionTile publishedPreview), and each view opened text: on 2026-11-07 a multiplayer
// case's game, which threw at its first frame, was caught and repaired only after a person gave its node a Game
// deliverable. So does a JSON object whose one key is `result` holding such a document, the envelope earlier results
// came in, which the card reads as a document too.
//
// Nothing is declared. The field is read from the result where it is shown and stored nowhere, so the node keeps its
// context and result ports and its wires, its run is asked for no format and checked against none, and a wire carries
// the result downstream as it was. Text, Markdown and any other JSON stay as they are.
import { nodeContract, type CanvasNode } from './canvasDoc';
import { deliveryJsonSource } from './deliveryJson';
import { isCompleteHtmlDocument } from './htmlDeliverable';
import { mediaKindOf } from './mediaCatalog';
import { emptyContract, type ContractField, type NodeContract } from './nodeContracts';

/** The page's field: named after the one output port such a session has, `result`, whose text the page is. */
export const RESULT_PAGE_FIELD = 'result';

/** A session that declares no deliverables and makes no media: what it returned is its delivery, as it is. */
export function undeclaredSession(node: CanvasNode): boolean {
  return node.kind === 'session' && !node.contract?.outputs.length && !mediaKindOf(node.agentKind);
}

/** `{"result": <a complete HTML document>}` and nothing else, read as a delivery is (deliveryJsonSource), so that
 *  parseContractOutput reads the page out of it. With any other key beside it, it stays JSON: no word of it is hidden. */
function wrappedPage(text: string): boolean {
  const start = text.trimStart();
  if (!start.startsWith('{') && !start.startsWith('```')) return false;
  let value: unknown;
  try { value = JSON.parse(deliveryJsonSource(text)); } catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const page = (value as Record<string, unknown>)[RESULT_PAGE_FIELD];
  return keys.length === 1 && keys[0] === RESULT_PAGE_FIELD && typeof page === 'string' && isCompleteHtmlDocument(page);
}

/** The last answer for each node, by its text: a large page is read once, not on every render of every view that shows
 *  it (the check walks the whole document). Keyed by the node object, which an edit replaces, so it holds no old node. */
const pageTexts = new WeakMap<CanvasNode, { text: string; page: boolean }>();

function isPageText(node: CanvasNode, text: string): boolean {
  const known = pageTexts.get(node);
  if (known && known.text === text) return known.page;
  const page = isCompleteHtmlDocument(text) || wrappedPage(text);
  pageTexts.set(node, { text, page });
  return page;
}

/**
 * The page an undeclared session's result is, when it is a complete HTML document; null for any other node or text. It
 * is labelled with the node's title, which names the page wherever it becomes a file (the studio's `<title>.html`, a
 * download).
 */
export function resultPage(node: CanvasNode, text: string | null | undefined): ContractField | null {
  if (!undeclaredSession(node) || typeof text !== 'string' || !isPageText(node, text)) return null;
  const title = typeof node.title === 'string' ? node.title.trim() : '';
  return { id: RESULT_PAGE_FIELD, label: title || node.id, type: 'html', required: true, value: '' };
}

/**
 * The form a node's result is read by wherever it is shown: its declared deliverables, or, for an undeclared session
 * whose result is a complete HTML document, that page alone; otherwise none. For display, the page check and its repair
 * only: a run, a wire, an edit and a publication keep to the node's own contract.
 */
export function displayContract(node: CanvasNode, text: string | null | undefined): NodeContract {
  const declared = nodeContract(node) ?? emptyContract();
  const page = resultPage(node, text);
  return page ? { ...declared, outputs: [page] } : declared;
}
