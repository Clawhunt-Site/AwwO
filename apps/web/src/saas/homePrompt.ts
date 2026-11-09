/** A canvas created from the workspace home is named after the request that created it. */
export const CANVAS_NAME_MAX_CHARACTERS = 30;
/** The server bounds names in bytes; a derived name stays well inside that. */
const CANVAS_NAME_MAX_BYTES = 200;
// A clause ends at full-width sentence punctuation, or at ASCII punctuation followed by a space,
// so a version number or an abbreviation inside a clause does not end it.
const CLAUSE_END = /[。！？；：]|[.!?;:](?=\s|$)/u;
// Leading politeness carries no meaning in a title. A bare 请 is kept where it begins a word
// (请假、请求、请示…), so a request about leave approval is never renamed to 假审批.
const FILLERS: ReadonlyArray<RegExp> = [
  /^请(?:你|您)/u, /^请(?![假求柬示教客愿帖安命战])/u, /^麻烦(?:你|您)?/u, /^帮(?:我|忙)/u,
  /^please\b/iu, /^help me\b/iu,
];

function stripFillers(text: string): string {
  let current = text;
  for (let changed = true; changed;) {
    changed = false;
    for (const filler of FILLERS) {
      const next = current.replace(filler, '').replace(/^[\s,，、]+/u, '');
      if (next !== current && next) { current = next; changed = true; }
    }
  }
  return current === text ? current : current.replace(/^[a-z]/u, letter => letter.toUpperCase());
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** The first clause of the first non-empty line, without polite fillers, cut to a card-sized title.
 * Returns the fallback when nothing readable is left. */
export function canvasNameFromPrompt(prompt: string, fallback: string): string {
  const line = prompt.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
    .split(/\r?\n/u).map(value => value.trim()).find(Boolean) ?? '';
  const clause = line.split(CLAUSE_END).map(value => value.trim()).find(Boolean) ?? '';
  const text = stripFillers(clause.replace(/\s+/gu, ' ')).replace(/[\s,，、]+$/u, '');
  if (!text) return fallback;
  const characters = [...text];
  let name = text;
  if (characters.length > CANVAS_NAME_MAX_CHARACTERS) {
    let cut = characters.slice(0, CANVAS_NAME_MAX_CHARACTERS).join('');
    // A Latin word cut in half reads worse than a slightly shorter title. CJK text has no spaces
    // between words, so it is cut where it reaches the limit.
    const splitsWord = /[A-Za-z0-9]$/u.test(cut) && /^[A-Za-z0-9]/u.test(characters[CANVAS_NAME_MAX_CHARACTERS]);
    const space = cut.lastIndexOf(' ');
    if (splitsWord && space > CANVAS_NAME_MAX_CHARACTERS / 2) cut = cut.slice(0, space);
    name = `${cut.replace(/[\s,，、]+$/u, '')}…`;
  }
  while (byteLength(name) >= CANVAS_NAME_MAX_BYTES) name = `${[...name.replace(/…$/u, '')].slice(0, -1).join('')}…`;
  return name;
}

export type HomeDraftScope = { user: string; tenant: string };
const draftKey = ({ user, tenant }: HomeDraftScope) => `awwo.saas.home-draft.v2:${encodeURIComponent(user)}:${encodeURIComponent(tenant)}`;
// Drafts the old box saved (v1) could be cut mid-address (an input method's composition run past its limit). Read,
// one is moved under v2 whole and the tab is marked (untrustedKey, kept for the tab's session): an undo can fill the box
// with the old draft again, after it was emptied or even sent (a page the back/forward cache restores keeps the box's
// history). The requests the home hands over in that tab read none of their addresses as the person's (planHandoff's
// untrusted) until pasted again in the canvas.
const legacyDraftKey = ({ user, tenant }: HomeDraftScope) => `awwo.saas.home-draft.v1:${encodeURIComponent(user)}:${encodeURIComponent(tenant)}`;
const untrustedKey = ({ user, tenant }: HomeDraftScope) => `awwo.saas.home-draft-untrusted.v2:${encodeURIComponent(user)}:${encodeURIComponent(tenant)}`;

/** The browser can refuse storage entirely (policy, private mode); the prompt box then simply
 * does not survive a reload. */
function sessionStore(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** The unsent home prompt of this tab, for this account and workspace, as it was typed: never cut to a length (the
 * canvas reads each address in the home's request as the person's own, so a cut one would name another page; the
 * request's limit is checked when it is sent). */
export function readHomeDraft(scope: HomeDraftScope): string {
  try {
    const storage = sessionStore();
    const value = storage?.getItem(draftKey(scope));
    if (typeof value === 'string' || !storage) return value ?? '';
    const legacy = storage.getItem(legacyDraftKey(scope)) ?? '';
    if (!legacy) return '';
    // Marked before it is moved: an old draft is never taken as the person's own, even where storage then fails.
    storage.setItem(untrustedKey(scope), '1');
    storage.setItem(draftKey(scope), legacy);
    storage.removeItem(legacyDraftKey(scope));
    return legacy;
  } catch { return ''; }
}

/** Whether this tab restored a draft the old box saved (readHomeDraft): the requests the home hands over in it read
 *  their addresses only once they are pasted again (planHandoff's untrusted). */
export function homeDraftUntrusted(scope: HomeDraftScope): boolean {
  try { return sessionStore()?.getItem(untrustedKey(scope)) === '1'; }
  catch { return true; }
}

export function saveHomeDraft(scope: HomeDraftScope, value: string): void {
  try {
    const storage = sessionStore();
    if (!storage) return;
    if (value) storage.setItem(draftKey(scope), value);
    else { storage.removeItem(draftKey(scope)); storage.removeItem(legacyDraftKey(scope)); }
  } catch { /* The prompt stays in the box; it only would not survive a reload. */ }
}

export function clearHomeDraft(scope: HomeDraftScope): void {
  try { for (const key of [draftKey(scope), legacyDraftKey(scope)]) sessionStore()?.removeItem(key); }
  catch { /* Nothing was stored. */ }
}
