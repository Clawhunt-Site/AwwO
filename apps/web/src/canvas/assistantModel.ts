// The canvas assistant's model (chosen under its composer) for the components a plan adds: a canvas the assistant
// builds then runs on the model the reader picked there, the same one its direct tasks use. Only the Agent nodes the
// plan itself created and left unset take it ('' runtime and model, canvasDoc.ts: never back-filled, the picker
// fills); media nodes keep their media model, nodes on a team or bound to an Agent keep theirs, and Jev's own choices
// stand (the host does not call this for a Jev plan).
import type { CanvasDocument } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';

/** The model the reader chose for the canvas assistant, as its direct tasks name it. */
export interface AssistantComponentModel { runtime: string; model: string }

/** One chat model the workspace offers a node (the palette's catalogue). */
export interface ComponentModelChoice { runtime: string; model: string; effort?: string; available: boolean }

/** The workspace's entry for the chosen model: on the same runtime when it is offered there, otherwise on the first
 *  runtime that offers it; none when the workspace offers it to no node. */
export function componentModelEntry(chosen: AssistantComponentModel | undefined, choices: ReadonlyArray<ComponentModelChoice>): ComponentModelChoice | undefined {
  if (!chosen?.model) return undefined;
  const offered = choices.filter(choice => choice.available && choice.model === chosen.model && choice.runtime);
  return offered.find(choice => choice.runtime === chosen.runtime) ?? offered[0];
}

/** The document with the chosen model on the unset Agent nodes among `addedNodeIds`; the same document when there is
 *  nothing to set. */
export function withAssistantModel(doc: CanvasDocument, addedNodeIds: ReadonlyArray<string>, chosen: AssistantComponentModel | undefined,
  choices: ReadonlyArray<ComponentModelChoice>): CanvasDocument {
  const entry = componentModelEntry(chosen, choices);
  if (!entry || !addedNodeIds.length) return doc;
  const added = new Set(addedNodeIds);
  let changed = false;
  const nodes = doc.nodes.map(node => {
    if (!added.has(node.id) || node.kind !== 'session' || mediaKindOf(node.agentKind) || node.team
      || node.runtime || node.model || node.binding?.agentId) return node;
    changed = true;
    return { ...node, runtime: entry.runtime, model: entry.model, effort: entry.effort ?? '' };
  });
  return changed ? { ...doc, nodes } : doc;
}
