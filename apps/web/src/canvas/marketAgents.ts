// A node that uses an Agent of the Agent market (docs/awwo-agent-market.md). The document names the Agent and the version
// the node is locked to; its instructions and skills stay on the server. The node keeps its own persona and skills,
// unused while the Agent is attached, so taking the Agent off gives them back. A market Agent is a text Agent: a coding
// node takes one as a text node, and a sandbox computer node takes none (the server runs no market Agent in a sandbox,
// and only the node's own switch moves it off one).
import { createAgentTemplate } from './agentTemplates';
import type { SessionNode } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';
import type { ModelPaletteSelection } from './modelPalette';
import { SANDBOX_RUNTIME } from './nodeRuntime';
import type { UiLocale } from '../locale';
import type { MarketAgentSummary } from '../saas/marketApi';
import type { MarketModelDecision } from '../saas/market/marketModel';

/** What a node's settings may do with the market, where the workspace has it (canvasMarket.tsx). */
export interface InspectorMarket {
  /** Opens the market for the settings' draft; `apply` puts the chosen Agent (or its removal) on the draft. */
  pick: (draft: SessionNode, apply: (next: SessionNode) => void) => void;
  /** Opens the publish form on the draft's persona, skills and model. */
  publish: (draft: SessionNode) => void;
  /** The workspace's chat models, which decide the model an Agent brings (null: not read). */
  catalogue: ReadonlyArray<ModelPaletteSelection> | null;
}

/** What a node takes when given a market Agent: the Agent at its listed version, and a model where the decision applies one. */
export interface MarketNodeChoice {
  agent: Pick<MarketAgentSummary, 'id' | 'name' | 'version' | 'kind'>;
  model?: { runtime: string; model: string; effort: string };
}

export function marketChoice(agent: Pick<MarketAgentSummary, 'id' | 'name' | 'version' | 'kind'>, decision: MarketModelDecision): MarketNodeChoice {
  return { agent: { id: agent.id, name: agent.name, version: agent.version, kind: agent.kind },
    ...(decision.kind === 'apply' ? { model: { runtime: decision.runtime, model: decision.model, effort: decision.effort } } : {}) };
}

/** Whether a node can take a market Agent: a text or coding node, not a team, not a sandbox computer, not set to one of
 *  the workspace's Agents. */
export function marketUsable(node: SessionNode): boolean {
  return marketPublishable(node) && node.runtime !== SANDBOX_RUNTIME;
}

/** Whether a node's persona, skills and model can be published as a market Agent: a text or coding node (a sandbox one
 *  too: the Agent suggests its model on a text runtime), not a team, not set to one of the workspace's Agents. */
export function marketPublishable(node: SessionNode): boolean {
  return !mediaKindOf(node.agentKind) && !node.team && node.agentRef?.source !== 'workspace';
}

/** The node with the Agent on it (a text node, as the Agent is), its own persona and skills kept for later. */
export function withMarketAgent(node: SessionNode, choice: MarketNodeChoice): SessionNode {
  return { ...node, agentKind: 'llm',
    agentRef: { source: 'market', agentId: choice.agent.id, version: choice.agent.version },
    ...(choice.model ? { runtime: choice.model.runtime, model: choice.model.model, effort: choice.model.effort } : {}) };
}

/** The node without its market Agent: its own persona and skills apply again. */
export function withoutMarketAgent(node: SessionNode): SessionNode {
  return { ...node, agentRef: undefined };
}

/** A new node for the Agent: a general template (its inputs and deliverable) named after the Agent, with no persona of
 *  its own, since the Agent's instructions are what it runs. */
export function createMarketAgentNode(choice: MarketNodeChoice, pos: { x: number; y: number }, locale: UiLocale): SessionNode {
  const node = createAgentTemplate('general', pos, locale);
  return withMarketAgent({ ...node, title: choice.agent.name, persona: '' }, choice);
}
