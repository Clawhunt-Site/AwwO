import type { SessionNode } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';

/**
 * The node an inspector save writes. `base` is the live node with its thread rebound as the configuration requires;
 * the draft supplies what the inspector edits. A media node's settings are the draft's (texture, quality, size and
 * the rest reach the run and its price), and a media node runs no contract, template, team or task frame
 * (`withAgentKind` dropped them from the draft), so none comes back from the live node.
 */
export function inspectorSavedNode(base: SessionNode, draft: SessionNode, live: SessionNode,
  change: { binding: boolean; config: boolean }): SessionNode {
  const saved: SessionNode = { ...base, title: draft.title, agentKind: draft.agentKind, runtime: draft.runtime,
    model: draft.model, effort: draft.effort, persona: draft.persona, team: draft.team, agentRef: draft.agentRef,
    ...(Object.hasOwn(draft, 'taskFrame') ? { taskFrame: draft.taskFrame } : {}),
    binding: change.config ? null : draft.binding, bindAttempt: change.config ? null : draft.bindAttempt,
    issueId: change.binding || change.config ? null : live.issueId };
  if (draft.mediaParams) saved.mediaParams = draft.mediaParams; else delete saved.mediaParams;
  if (mediaKindOf(draft.agentKind)) {
    delete saved.contract; delete saved.templateId; delete saved.templateVersion; delete saved.team; delete saved.taskFrame;
  }
  return saved;
}
