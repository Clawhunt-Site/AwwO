import type { SessionNode } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';

/**
 * The node an inspector save writes. `base` is the live node with its thread rebound as the configuration requires;
 * the draft supplies what the inspector edits. A media node's settings are the draft's (texture, quality, size and
 * the rest reach the run and its price), and a media node runs no contract, template, team or task frame
 * (`withAgentKind` dropped them from the draft), so none comes back from the live node. A hand-in stays published
 * through the conversation a rebinding opens.
 */
export function inspectorSavedNode(base: SessionNode, draft: SessionNode, live: SessionNode,
  change: { binding: boolean; config: boolean }): SessionNode {
  const saved: SessionNode = { ...base, title: draft.title, agentKind: draft.agentKind, runtime: draft.runtime,
    model: draft.model, effort: draft.effort, persona: draft.persona, team: draft.team, agentRef: draft.agentRef,
    ...(Object.hasOwn(draft, 'taskFrame') ? { taskFrame: draft.taskFrame } : {}),
    ...(Object.hasOwn(draft, 'skills') ? { skills: draft.skills } : {}),
    binding: change.config ? null : draft.binding, bindAttempt: change.config ? null : draft.bindAttempt,
    issueId: change.binding || change.config ? null : live.issueId };
  // A result handed in by hand (an agent's over MCP, a person's, or one a person picked out of a conversation) is the
  // node's, not a conversation's run, so the conversation a rebinding opens beside the old (rebindNodeThread, which
  // starts it with no result) leaves it published. invalidateOutputs then keeps it through the engine's settings and
  // takes it back for a change of what the node is asked, as on a node not bound. A run's result stays the old
  // conversation's.
  if ((change.binding || change.config) && !base.lastOutput && live.lastOutput?.source === 'manual') saved.lastOutput = live.lastOutput;
  if (draft.mediaParams) saved.mediaParams = draft.mediaParams; else delete saved.mediaParams;
  if (mediaKindOf(draft.agentKind)) {
    delete saved.contract; delete saved.templateId; delete saved.templateVersion; delete saved.team; delete saved.taskFrame;
    // An empty list clears skills the node had; without the key the server would keep them for an older client.
    if (live.skills?.length) saved.skills = []; else delete saved.skills;
  }
  return saved;
}
