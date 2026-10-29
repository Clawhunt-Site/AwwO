// One Agent of the market, as a card: what it does, who made it, what a call costs and how its runs went. The numbers
// are the server's (the last 30 days of real runs); a card only shows them.
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { MarketAgentSummary } from '../marketApi';
import { authorText, numberText, percentText, priceText, useMarketI18n } from './marketText';

export function MarketAgentCard({ agent, selected = false, onSelect }: { agent: MarketAgentSummary; selected?: boolean; onSelect: (agent: MarketAgentSummary) => void }) {
  const { locale, t } = useMarketI18n();
  const stats = agent.stats;
  return <button type="button" className={`awwo-market-card${selected ? ' is-selected' : ''}`} aria-pressed={selected} data-agent-id={agent.id} onClick={() => onSelect(agent)}>
    <span className="awwo-market-card-head">
      <strong>{agent.name}</strong>
      <span className={`awwo-market-price${agent.price > 0 ? ' is-paid' : ''}`}>{priceText(agent.price, t)}</span>
    </span>
    {agent.tagline && <span className="awwo-market-card-tagline">{agent.tagline}</span>}
    <span className="awwo-market-card-author">{authorText(agent, t)}</span>
    <span className="awwo-market-card-stats">
      <span>{t(`成功率 ${percentText(stats.successRate)}`, `${percentText(stats.successRate)} succeeded`)}</span>
      <span>{t(`调用 ${numberText(stats.calls, locale)} 次`, `${numberText(stats.calls, locale)} calls`)}</span>
      <span>{t(`${numberText(stats.users, locale)} 人用过`, `${numberText(stats.users, locale)} users`)}</span>
      <span className="awwo-market-votes" aria-label={t(`好评 ${stats.up}，差评 ${stats.down}`, `${stats.up} up, ${stats.down} down`)}>
        <ThumbsUp size={12} aria-hidden="true" />{stats.up}<ThumbsDown size={12} aria-hidden="true" />{stats.down}
      </span>
    </span>
  </button>;
}
