/** Results a person took off the home's 最近的成果, per workspace, kept in this browser. Only the list
 * changes: the canvas, its steps and its deliveries stay as they are. Each entry names one delivery (the
 * canvas and the time its result was delivered), so a canvas that later delivers something new shows again.
 * A view preference, never a security boundary; nothing here reaches the server. */
export type HiddenResult = { canvasId: string; at: number };

/** Older entries drop off first; a person rarely hides more than a few dozen results. */
export const HIDDEN_RESULTS_MAX = 200;
const MAX_STORED_CHARACTERS = 32 * 1024;
const MAX_CANVAS_ID_LENGTH = 200;
const storageKey = (userId: string, tenantId: string) =>
  `awwo.saas.results-hidden.v1:${encodeURIComponent(userId)}:${encodeURIComponent(tenantId)}`;

/** The one string an entry is compared by. */
export const hiddenResultKey = (entry: HiddenResult) => `${entry.at}:${entry.canvasId}`;

/** A delivery time as stored: a legacy or corrupt time still names the delivery, as 0. */
export const hiddenResultTime = (at: unknown) => typeof at === 'number' && Number.isFinite(at) ? at : 0;

export function readHiddenResults(userId: string | undefined, tenantId: string): HiddenResult[] {
  if (!userId || !tenantId) return [];
  try {
    const raw = window.localStorage.getItem(storageKey(userId, tenantId));
    if (!raw || raw.length > MAX_STORED_CHARACTERS) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.flatMap<HiddenResult>(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const { c, a } = item as Record<string, unknown>;
      if (typeof c !== 'string' || !c || c.length > MAX_CANVAS_ID_LENGTH || typeof a !== 'number' || !Number.isFinite(a)) return [];
      const entry = { canvasId: c, at: a };
      if (seen.has(hiddenResultKey(entry))) return [];
      seen.add(hiddenResultKey(entry));
      return [entry];
    }).slice(-HIDDEN_RESULTS_MAX);
  } catch { return []; }
}

/** Returns false when the browser refuses storage: the list still hides them until the page reloads. */
export function saveHiddenResults(userId: string | undefined, tenantId: string, entries: ReadonlyArray<HiddenResult>): boolean {
  if (!userId || !tenantId) return false;
  try {
    const kept = entries.slice(-HIDDEN_RESULTS_MAX);
    if (kept.length) window.localStorage.setItem(storageKey(userId, tenantId), JSON.stringify(kept.map(entry => ({ c: entry.canvasId, a: entry.at }))));
    else window.localStorage.removeItem(storageKey(userId, tenantId));
    return true;
  } catch { return false; }
}
