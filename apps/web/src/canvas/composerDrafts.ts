import type { SessionNode } from './canvasDoc';
import { canvasStorage } from './canvasStorage';
import { mediaKindOf } from './mediaCatalog';

/** What someone types into a chat node's message box and has not sent is theirs alone. It is kept on their device, under
 *  their account, workspace and canvas (canvasStorage), never in the shared document, where everyone on the canvas would
 *  read it, overwrite it and store it on the server. A media node's draft is different: it is the node's prompt, which a
 *  run or a Send generates from, set by the canvas assistant's plans and the official workflows (canvasPlan.ts
 *  setMediaPrompt), so it stays in the document for everyone. */
export function draftIsShared(node: Pick<SessionNode, 'agentKind'>): boolean {
  return mediaKindOf(node.agentKind) !== null;
}

const PREFIX = 'awwo.canvas.composer-draft.v1:';
/** A message box holds at most this much on the device; a longer text is cut (a paste of a whole document fits). */
export const COMPOSER_DRAFT_MAX = 200_000;
export const composerDraftKey = (nodeId: string, threadId: string) => `${PREFIX}${encodeURIComponent(nodeId)}:${encodeURIComponent(threadId)}`;

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The unsent message this person left in a node's conversation, or '' (nothing stored, or the storage unreadable).
 *  `storage`: a canvas's storage taken earlier (canvasStorage() resolves whichever canvas is open when it is called). */
export function readComposerDraft(nodeId: string, threadId: string, storage: DraftStorage = canvasStorage()): string {
  try { return storage.getItem(composerDraftKey(nodeId, threadId)) ?? ''; } catch { return ''; }
}

/** Keeps (or, for '', forgets) this person's unsent message in a node's conversation. False when the storage refused it
 *  (full, or unavailable): the box still holds the text, as before a reload, and a caller that must not lose a request
 *  (a send's acceptance) stops there. */
export function writeComposerDraft(nodeId: string, threadId: string, value: string, storage: DraftStorage = canvasStorage()): boolean {
  try {
    if (value) storage.setItem(composerDraftKey(nodeId, threadId), value.slice(0, COMPOSER_DRAFT_MAX));
    else storage.removeItem(composerDraftKey(nodeId, threadId));
    return true;
  } catch { return false; }
}
