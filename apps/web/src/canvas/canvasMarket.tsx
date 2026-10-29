// The Agent market on a canvas (docs/awwo-agent-market.md): where the open workspace has it, a node's composer chip
// and its settings choose the node's market Agent, the canvas bar adds a node with one, and a node's settings publish its
// persona as one. Choosing changes the node through the canvas's own save, as its model picker does, so a node already
// set up opens a new conversation for the new Agent and is set up again before its next turn (nodeThreads.ts).
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Store } from 'lucide-react';
import { AgentMarket } from '../saas/market/AgentMarket';
import { PublishAgentDialog } from '../saas/market/PublishAgentDialog';
import { formFromNode } from '../saas/market/publishForm';
import type { MarketAgentDetail, MarketSettings } from '../saas/marketApi';
import type { MarketModelDecision } from '../saas/market/marketModel';
import { isMarketReference, type CanvasNode, type SessionNode } from './canvasDoc';
import type { ModelPaletteSelection } from './modelPalette';
import { createMarketAgentNode, marketChoice, marketUsable, withMarketAgent, withoutMarketAgent, type InspectorMarket } from './marketAgents';
import { useCanvasI18n } from './i18n';

type Opened =
  /** A node's composer chip: the choice is saved on the node. */
  | { kind: 'node'; nodeId: string }
  /** A node's settings: the choice goes on the settings' draft. */
  | { kind: 'draft'; draft: SessionNode; apply: (next: SessionNode) => void }
  /** The canvas bar: a node with the Agent is added. */
  | { kind: 'canvas' }
  | { kind: 'publish'; draft: SessionNode };

export interface CanvasMarketOptions {
  /** The open workspace's market; null where it is off. */
  settings: MarketSettings | null;
  tenantId: string | null;
  /** No edits now (a reader's canvas): no market controls. */
  readOnly: boolean;
  /** The workspace's chat models as the canvas holds them. */
  catalogue: ReadonlyArray<ModelPaletteSelection> | undefined;
  /** A node as the document holds it now. */
  nodeOf: (id: string) => CanvasNode | undefined;
  /** Saves a node's new configuration through the canvas's own save. */
  saveNode: (next: SessionNode) => void;
  /** Adds a node made at the position given (the middle of the view); false when the canvas takes no edit now. */
  addNode: (create: (pos: { x: number; y: number }) => SessionNode) => boolean;
}

export interface CanvasMarket {
  /** Stable for the canvas's memoised cards; absent where the market is off. */
  openForNode?: (nodeId: string) => void;
  detachNode?: (nodeId: string) => void;
  inspector?: InspectorMarket;
  /** The canvas bar's button that opens the market to add a node. */
  tool: ReactNode;
  /** The market's dialog or the publish form, while one is open. */
  dialogs: ReactNode;
}

export function useCanvasMarket(options: CanvasMarketOptions): CanvasMarket {
  const { locale } = useCanvasI18n();
  const text = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const [opened, setOpened] = useState<Opened | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const { settings, tenantId, catalogue } = options;
  const enabled = Boolean(settings && tenantId && !options.readOnly);
  const openForNode = useCallback((nodeId: string) => setOpened({ kind: 'node', nodeId }), []);
  const detachNode = useCallback((nodeId: string) => {
    const live = latest.current.nodeOf(nodeId);
    if (live?.kind === 'session' && isMarketReference(live.agentRef)) latest.current.saveNode(withoutMarketAgent(live));
  }, []);
  const inspector = useMemo<InspectorMarket | undefined>(() => enabled ? {
    pick: (draft, apply) => setOpened({ kind: 'draft', draft, apply }),
    publish: draft => setOpened({ kind: 'publish', draft }),
    catalogue: catalogue ?? null,
  } : undefined, [enabled, catalogue]);
  const close = () => setOpened(null);

  let dialogs: ReactNode = null;
  if (enabled && settings && tenantId && opened?.kind === 'publish') {
    dialogs = <PublishAgentDialog tenantId={tenantId} settings={settings} initial={formFromNode(opened.draft, tenantId)} catalogue={catalogue} onClose={close} />;
  } else if (enabled && tenantId && opened) {
    const live = opened.kind === 'node' ? options.nodeOf(opened.nodeId) : opened.kind === 'draft' ? opened.draft : undefined;
    const node = live?.kind === 'session' && marketUsable(live) ? live : undefined;
    const current = node && isMarketReference(node.agentRef) ? node.agentRef : undefined;
    const use = (agent: MarketAgentDetail, decision: MarketModelDecision) => {
      const choice = marketChoice(agent, decision);
      if (opened.kind === 'canvas') {
        // The dialog stays open with the reason (its page shows a rejection), rather than closing as if it had added it.
        if (!latest.current.addNode(pos => createMarketAgentNode(choice, pos, locale))) {
          throw new Error(text('画布现在不能改动（有任务在运行或在准备节点），稍后再添加。', 'The canvas cannot be changed right now (a task is running or nodes are being prepared). Add it later.'));
        }
      } else if (opened.kind === 'draft') opened.apply(withMarketAgent(opened.draft, choice));
      else if (opened.kind === 'node') {
        const now = latest.current.nodeOf(opened.nodeId);
        if (now?.kind === 'session' && marketUsable(now)) latest.current.saveNode(withMarketAgent(now, choice));
      }
      close();
    };
    const detach = () => {
      if (opened.kind === 'draft') opened.apply(withoutMarketAgent(opened.draft));
      else if (opened.kind === 'node') detachNode(opened.nodeId);
      close();
    };
    // A node deleted (or made a team or a media node) while the market was open leaves nothing to choose for.
    if (opened.kind === 'canvas' || node) dialogs = <AgentMarket tenantId={tenantId} catalogue={catalogue}
      target={opened.kind === 'canvas' || !node ? { kind: 'canvas' } : { kind: 'node', title: node.title, current }}
      onUse={use} onDetach={current ? detach : undefined} onClose={close} />;
  }
  const tool = enabled ? <button type="button" className="awwo-knowledge-tool" aria-label={text('Agent 市场', 'Agent market')}
    title={text('Agent 市场：挑一个表现好的 Agent 加到画布上', 'Agent market: add a well-performing Agent to the canvas')} onClick={() => setOpened({ kind: 'canvas' })}>
    <Store size={15} aria-hidden="true" /><span>{text('Agent 市场', 'Agent market')}</span></button> : null;
  return { openForNode: enabled ? openForNode : undefined, detachNode: enabled ? detachNode : undefined, inspector, tool, dialogs };
}
