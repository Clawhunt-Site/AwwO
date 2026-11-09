// A person's delivery drawers (交付物): which ones they opened or closed on a canvas, on their device. The drawer is
// view state: one person opening a node's drawer (which also widens it) changes nothing for anyone else, enters no
// change and no undo step, and is never saved into the shared document (docs/plans/2026-11-08-people-multiplayer-phase1.md,
// WS-D). The document's own `deliverablesOpen` stays as the default a choice overrides: a case copy opens its drawer,
// and so may an agent; a node nobody chose for shows its drawer by deliverablesShown's rule.
//
// One overlay holds the choices of the canvas this page shows, and deliverablesShown reads it, so every layout path
// (deliverablesShown, presentationNodes, openFrameFor's callers) sees the same drawer whichever copy of a node it holds.
// The canvas surface installs it as it draws and keeps it in the canvas's own storage (canvasStorage: the account's,
// the workspace's and the canvas's, which for a viewer is the page's memory).
import { canvasStorage } from './canvasStorage';

/** The key in the canvas's storage. */
export const DRAWER_CHOICES_KEY = 'awwo.view.drawers';
/** At most this many choices are kept (a canvas has at most 400 nodes). */
const KEPT = 400;

export type DrawerChoices = ReadonlyMap<string, boolean>;
const NONE: DrawerChoices = new Map();
let installed: DrawerChoices = NONE;
// The canvas surface that installed them: a surface going away takes away only its own (the next canvas's surface
// draws, and installs its own, before the last one's cleanup runs).
let installedBy: unknown = null;

/** This person's choice for a node's drawer on the canvas shown, if they made one. */
export function drawerChoice(nodeId: string): boolean | undefined {
  return installed.get(nodeId);
}

/** Makes these the choices every layout path reads (the canvas surface `by`, as it draws); null takes any away. */
export function installDrawerChoices(choices: DrawerChoices | null, by: unknown = null): void {
  installed = choices ?? NONE;
  installedBy = choices ? by : null;
}

/** Takes away the choices `by` installed, if they are still the ones installed. */
export function uninstallDrawerChoices(by: unknown): void {
  if (installedBy !== by) return;
  installed = NONE;
  installedBy = null;
}

/** The choices kept on this device for the canvas whose storage is configured now. */
export function readDrawerChoices(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  let raw: string | null = null;
  try { raw = canvasStorage().getItem(DRAWER_CHOICES_KEY); } catch { return out; }
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, open] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof open === 'boolean' && id && out.size < KEPT) out.set(id, open);
      }
    }
  } catch { /* an unreadable entry is no choice */ }
  return out;
}

/** Keeps the choices on this device; a failed write leaves them for this page only. */
export function writeDrawerChoices(choices: DrawerChoices): void {
  const entries = [...choices].slice(-KEPT);
  try {
    if (entries.length) canvasStorage().setItem(DRAWER_CHOICES_KEY, JSON.stringify(Object.fromEntries(entries)));
    else canvasStorage().removeItem(DRAWER_CHOICES_KEY);
  } catch { /* view state only */ }
}

/** The choices with one node's set (it goes last, so the oldest go first past KEPT), or the same map when unchanged. */
export function withDrawerChoice(choices: DrawerChoices, nodeId: string, open: boolean): DrawerChoices {
  if (choices.get(nodeId) === open) return choices;
  const next = new Map(choices);
  next.delete(nodeId);
  next.set(nodeId, open);
  return next;
}

/** The choices for nodes a document still holds (a deleted node's goes), or the same map when all are held. */
export function heldDrawerChoices(choices: DrawerChoices, nodeIds: ReadonlySet<string>): DrawerChoices {
  if ([...choices.keys()].every(id => nodeIds.has(id))) return choices;
  return new Map([...choices].filter(([id]) => nodeIds.has(id)));
}
