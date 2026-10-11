import type { CanvasDocument, SessionNode } from './canvasDoc';
import { mediaKindOf, replacementMediaModel, type MediaCatalogue } from './mediaCatalog';

/**
 * The document with every media node still set to a retired generator's model moved to the model this workspace is
 * offered instead (replacementMediaModel), its settings back to that model's defaults; null when no node needs it.
 * Nothing else of the node changes: its earlier results stay, and its next Send sets it up again for the new model.
 * Nothing announces it: the node simply shows the model it now uses (owner decision 2026-10-11).
 */
export function replaceRetiredMediaModels(doc: CanvasDocument, catalogue: MediaCatalogue | null | undefined): CanvasDocument | null {
  let changed = false;
  const nodes = doc.nodes.map(node => {
    if (node.kind !== 'session') return node;
    const kind = mediaKindOf(node.agentKind);
    const model = kind ? replacementMediaModel(catalogue, kind, node.model) : null;
    if (!model) return node;
    changed = true;
    // Another model has other settings: its own defaults apply, as when a model is picked by hand.
    const { mediaParams: _retired, ...rest } = node;
    const next: SessionNode = { ...rest, model };
    if (node.threads) next.threads = node.threads.map(thread => thread.model === node.model ? { ...thread, model } : thread);
    return next;
  });
  return changed ? { ...doc, nodes } : null;
}
