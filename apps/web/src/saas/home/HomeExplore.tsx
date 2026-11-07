import { useId } from 'react';
import { ArrowRight, Clapperboard, Store } from 'lucide-react';
import { PRODUCTION_CASES } from '../productionCatalog';
import { useSaaSPreferences } from '../preferences';
import type { HomeSection } from './homeSections';
import './home.css';

/** 首页's 探索 row: a tile to each section that is a catalog rather than the workspace's own work, 制作案例 and (for a
 *  member, who can put an Agent on a canvas) Agent 市场. The sections themselves hold the grids. */
export function HomeExplore({ member, onSection }: { member: boolean; onSection: (section: HomeSection) => void }) {
  const { t } = useSaaSPreferences();
  const titleId = useId();
  const casesId = useId();
  const marketId = useId();
  const count = PRODUCTION_CASES.length;
  return <section className="saas-home-section saas-home-explore" aria-labelledby={titleId}>
    <div className="saas-home-section-header"><div className="saas-home-section-title"><h2 id={titleId}>{t('探索', 'Explore')}</h2></div></div>
    <ul className="saas-home-tiles">
      <li><button type="button" className="saas-home-tile" aria-label={t(`打开制作案例（${count} 个）`, `Open the production cases (${count})`)} aria-describedby={casesId} onClick={() => onSection('cases')}>
        <span className="saas-home-tile-icon" aria-hidden="true"><Clapperboard size={20} /></span>
        <span className="saas-home-tile-text"><strong>{t('制作案例', 'Production cases')}<span className="saas-library-count">{t(`${count} 个`, `${count}`)}</span></strong>
          <span id={casesId}>{member ? t('看一句需求怎样交给一队 Agent 做完，也可以复制画布直接用。', 'See one brief handed to a team of agents, and copy its canvas to use it.')
            : t('看一句需求怎样交给一队 Agent 做完。', 'See one brief handed to a team of agents.')}</span></span>
        <ArrowRight className="saas-home-tile-go" size={16} aria-hidden="true" />
      </button></li>
      {member && <li><button type="button" className="saas-home-tile" aria-label={t('打开 Agent 市场', 'Open the Agent market')} aria-describedby={marketId} onClick={() => onSection('market')}>
        <span className="saas-home-tile-icon" aria-hidden="true"><Store size={20} /></span>
        <span className="saas-home-tile-text"><strong>{t('Agent 市场', 'Agent market')}</strong>
          <span id={marketId}>{t('挑一个运行表现好的 Agent 用在节点上，排行只看真实运行。', 'Pick a well-performing Agent for a node, ranked by real runs only.')}</span></span>
        <ArrowRight className="saas-home-tile-go" size={16} aria-hidden="true" />
      </button></li>}
    </ul>
  </section>;
}
