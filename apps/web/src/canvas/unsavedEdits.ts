// Edits that are on screen but not in the canvas document yet, such as a node inspector's changes before its Save: a
// save of the canvas does not include them, so whoever offers a reload asks here first (saas/staleBuild.ts).
const sources = new Set<() => boolean>();

/** Reports, while it is registered, whether its edits are still outside the document. Returns the unregister call. */
export function registerUnsavedEdits(source: () => boolean): () => void {
  sources.add(source);
  return () => { sources.delete(source); };
}

export function hasUnsavedEdits(): boolean {
  for (const source of sources) if (source()) return true;
  return false;
}
