/** A canvas created from the workspace home is named after the request that created it. */
export const CANVAS_NAME_MAX_CHARACTERS = 30;
/** The server bounds names in bytes; a derived name stays well inside that. */
const CANVAS_NAME_MAX_BYTES = 200;
/** The prompt box and the planner share this bound. */
export const HOME_PROMPT_MAX_CHARACTERS = 8000;

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
const draftKey = ({ user, tenant }: HomeDraftScope) => `awwo.saas.home-draft.v1:${encodeURIComponent(user)}:${encodeURIComponent(tenant)}`;

/** The browser can refuse storage entirely (policy, private mode); the prompt box then simply
 * does not survive a reload. */
function sessionStore(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** The unsent home prompt of this tab, for this account and workspace. */
export function readHomeDraft(scope: HomeDraftScope): string {
  try { return (sessionStore()?.getItem(draftKey(scope)) ?? '').slice(0, HOME_PROMPT_MAX_CHARACTERS); }
  catch { return ''; }
}

export function saveHomeDraft(scope: HomeDraftScope, value: string): void {
  try {
    const storage = sessionStore();
    if (!storage) return;
    if (value) storage.setItem(draftKey(scope), value.slice(0, HOME_PROMPT_MAX_CHARACTERS));
    else storage.removeItem(draftKey(scope));
  } catch { /* The prompt stays in the box; it only would not survive a reload. */ }
}

export function clearHomeDraft(scope: HomeDraftScope): void {
  try { sessionStore()?.removeItem(draftKey(scope)); }
  catch { /* Nothing was stored. */ }
}
