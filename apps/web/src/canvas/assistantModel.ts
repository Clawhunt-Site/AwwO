// The canvas assistant's model (chosen under its composer) for the components a plan adds: a canvas the assistant
// builds then runs on the model the reader picked there, the same one its direct tasks use. Only the Agent nodes the
// plan itself created and left unset take it ('' runtime and model, canvasDoc.ts: never back-filled, the picker
// fills); media nodes keep their media model, nodes on a team or bound to an Agent keep theirs, and Jev's own choices
// stand (the host does not call this for a Jev plan). The runtime is not the assistant's: its direct tasks run on Pi
// (the only worker that serves them Bedrock), but a node runs the model where AwwO runs every node (nodeRuntime.ts).
import type { CanvasDocument } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';
import { automaticEntry } from './nodeRuntime';
import { DEFAULT_NEW_NODE_MODEL } from './planNewNodeModel';

/** The model the reader chose for the canvas assistant, as its direct tasks name it. */
export interface AssistantComponentModel { runtime: string; model: string }

/** One chat model the workspace offers a node (the palette's catalogue): requiresUpgrade, a model the workspace's plan
 *  does not include; userChosen, one only a user may choose (modelPalette.ts). */
export interface ComponentModelChoice { runtime: string; model: string; effort?: string; available: boolean; requiresUpgrade?: boolean; userChosen?: boolean }

/** The workspace's entry for the chosen model on a node: the runtime AwwO runs that model on (automaticEntry); none
 *  when the workspace offers it to no node, no runtime offering it is ready, or the workspace's plan does not include it
 *  now (a run on it would wait for a paid plan). The reader's own choice never names such a model (useManagedExecution);
 *  a canvas plan resumed after the workspace's paid plan ended may. */
export function componentModelEntry(chosen: AssistantComponentModel | undefined, choices: ReadonlyArray<ComponentModelChoice>): ComponentModelChoice | undefined {
  if (!chosen?.model) return undefined;
  const entry = automaticEntry(chosen.model, choices);
  return entry?.requiresUpgrade ? undefined : entry;
}

/** The model the Agent nodes a plan adds without set_model take (withAssistantModel): the one its planner sized them for
 *  (canvasPlan.ts planNewNodeModel), the workspace default (none) for "default", and the reader's choice now where the
 *  plan names none (a request stored before requests named one) or one its nodes cannot take now. A model only a user
 *  may choose (userChosen, DeepSeek) is taken only while the reader still has it chosen: the privacy clause sends a
 *  request there only when it is selected, and the reader may have switched away from it since the plan was asked for. */
export function planComponentModel(sizedFor: string | undefined, current: AssistantComponentModel | undefined,
  choices: ReadonlyArray<ComponentModelChoice>): AssistantComponentModel | undefined {
  if (sizedFor === DEFAULT_NEW_NODE_MODEL) return undefined;
  const entry = sizedFor === undefined ? undefined : componentModelEntry({ runtime: '', model: sizedFor }, choices);
  if (!entry || (entry.userChosen && current?.model !== sizedFor)) return current;
  return { runtime: entry.runtime, model: entry.model };
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
