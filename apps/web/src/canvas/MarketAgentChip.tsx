// The market Agent a node's chat runs, chosen where the conversation is: a pill beside the composer's model picker, in
// either view (the simple view has no Configure panel, so this is where it chooses one). It opens the Agent market for
// the node, and takes the Agent off again. The Agent's name is read from the market (the document names only its id).
import { Store, X } from 'lucide-react';
import { useCanvasI18n } from './i18n';
import type { MarketAgentReference } from './canvasDoc';
import { useMarketAgentInfo } from '../saas/market/useMarket';
import './market-agent.css';

export function MarketAgentChip({ agentRef, disabled, disabledReason, onOpen, onDetach }: {
  agentRef?: MarketAgentReference; disabled: boolean; disabledReason?: string; onOpen: () => void; onDetach: () => void;
}) {
  const { locale } = useCanvasI18n();
  const text = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const info = useMarketAgentInfo(agentRef);
  const name = info.pinned?.name || info.listed?.name;
  const label = agentRef ? name || text('市场 Agent', 'Market Agent') : text('选择 Agent', 'Choose an Agent');
  return <span className={`awwo-market-chip${agentRef ? ' is-attached' : ''}${disabled ? ' is-disabled' : ''}`}>
    <button type="button" disabled={disabled} onClick={onOpen}
      aria-label={agentRef ? text(`Agent：${label}，点击更换`, `Agent: ${label}, change it`) : text('选择 Agent', 'Choose an Agent')}
      title={disabled ? disabledReason : agentRef ? text(`这个节点用的是市场 Agent「${label}」`, `This node uses the market Agent “${label}”`)
        : text('从 Agent 市场挑一个 Agent 用在这个节点', 'Pick an Agent from the Agent market for this node')}>
      <Store size={13} aria-hidden="true" /><span className="awwo-market-chip-label">{label}</span>
    </button>
    {agentRef && <button type="button" className="awwo-market-chip-detach" disabled={disabled} aria-label={text('不用 Agent', 'No Agent')}
      title={text('不用 Agent：节点回到它自己的人设和技能', 'No Agent: the node goes back to its own persona and skills')} onClick={onDetach}><X size={12} aria-hidden="true" /></button>}
  </span>;
}

/** Whether the node's market Agent locks its model (its own version's setting where the page knows it, else the listed
 *  one's): its model picker is then read-only, since the server runs the Agent's model regardless. */
export function useMarketModelLocked(agentRef: MarketAgentReference | undefined): boolean {
  const info = useMarketAgentInfo(agentRef);
  return Boolean((info.pinned ?? info.listed)?.model.locked);
}
