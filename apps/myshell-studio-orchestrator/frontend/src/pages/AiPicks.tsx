import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { NavigationBar } from '../components/NavigationBar';
import { Sidebar } from '../components/Sidebar';
import Skeleton from '../components/Skeleton';
import { useEnergy } from '../contexts/EnergyContext';
import { fetchRecommendations } from '../services/api';
import { trackEvent } from '../services/tracking';
import { useCardImpression } from '../hooks/useCardImpression';
import type { Recommendation } from '../types';

const MATCH_SEQ = [95, 91, 88, 85, 82, 80, 78, 75, 73, 70, 68, 65, 63, 60];
const VIEW_SEQ = [45.2, 32.1, 18.7, 12.5, 9.4, 7.6, 6.1, 4.3, 3.8, 2.9, 2.4, 1.8, 1.3, 0.87];
const LIKE_SEQ = [12.3, 8.7, 5.2, 3.9, 2.8, 2.1, 1.5, 0.98, 0.85, 0.62, 0.48, 0.31, 0.22, 0.14];

function formatCount(n: number): string {
  return n >= 1 ? `${n.toFixed(1)}k` : Math.round(n * 1000).toString();
}

function mockStats(idx: number) {
  return {
    match: MATCH_SEQ[idx % MATCH_SEQ.length],
    views: formatCount(VIEW_SEQ[idx % VIEW_SEQ.length]),
    likes: formatCount(LIKE_SEQ[idx % LIKE_SEQ.length]),
  };
}

export default function AiPicks() {
  const { t } = useTranslation('explore');
  const navigate = useNavigate();
  const { energy, init } = useEnergy();
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    fetchRecommendations()
      .then(res => setRecommendations(res.recommendations || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Fire category_view once the list lands (listContext-style category for AI Picks).
  useEffect(() => {
    if (loading) return;
    trackEvent('miniapp_category_view', {
      category: 'ai_picks',
      slug_count_seen: recommendations.length,
    });
  }, [loading, recommendations.length]);

  const getSlugFromLink = (gotoLink: string) => {
    if (!gotoLink) return '';
    const lastSlash = gotoLink.lastIndexOf('/');
    return lastSlash >= 0 ? gotoLink.substring(lastSlash + 1) : gotoLink;
  };

  const showGetEnergyButton = init
    ? init.energy.freeGenerationsLeft === 0 && init.energy.balance === 0
    : false;

  const cardClass = "rounded-[10px] overflow-hidden relative bg-Cr-Bg-surface-default-v2 cursor-pointer transition-transform duration-150 ease-out flex flex-col active:scale-[0.97]";
  const gridClass = "grid grid-cols-2 gap-3 pt-1 px-4 pb-6";

  return (
    <div className="h-full overflow-y-auto pt-12 bg-Cr-Bg-soft-v2 [-webkit-overflow-scrolling:touch]">
      <NavigationBar
        onMenuClick={() => setSidebarOpen(prev => !prev)}
        onEnergyClick={() => navigate('/energy')}
        energy={energy}
        showGetEnergyButton={showGetEnergyButton}
        sidebarOpen={sidebarOpen}
      />

      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex items-center gap-3 m-4 py-[13px] px-3.5 rounded-xl bg-Cr-Bg-surface-default-v2 border border-white/5">
        <div className="flex-shrink-0 w-7 h-7 rounded-md-v2 bg-Cr-marketing-candlelight-500-v2 flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="#0e0e0f" aria-hidden="true">
            <path d="M12 2l2.9 6.9L22 10l-5.5 4.8L18 22l-6-3.6L6 22l1.5-7.2L2 10l7.1-1.1L12 2z"/>
          </svg>
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="text-sm font-semibold leading-[18px] text-Cr-text-default-v2">{t('explore:personalizedForYou')}</div>
          <div className="text-xs font-normal leading-[15px] text-Cr-text-subtlest-v2">{t('explore:basedOnPreferences')}</div>
        </div>
      </div>

      {loading ? (
        <div className={gridClass}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={`skeleton-${i}`} className={cardClass}>
              <div className="aspect-[3/4]">
                <Skeleton height="100%" />
              </div>
            </div>
          ))}
        </div>
      ) : recommendations.length === 0 ? (
        <div className="flex flex-col items-center justify-center pt-16 px-4">
          <div className="text-5xl mb-3">✨</div>
          <div className="text-sm text-Cr-text-subtlest-v2">{t('explore:noRecommendations')}</div>
        </div>
      ) : (
        <div className={gridClass}>
          {recommendations.map((rec, idx) => {
            const slug = getSlugFromLink(rec.gotoLink);
            const stats = mockStats(idx);
            const name = rec.title || rec.botName;
            return (
              <AiPickCard
                key={`${slug}-${idx}`}
                cardClass={cardClass}
                slug={slug}
                position={idx}
                onClick={() => slug && navigate(`/bot?slug_id=${slug}`, {
                  state: {
                    image: {
                      imageUrl: rec.imageUrl,
                      gotoLink: rec.gotoLink,
                      title: rec.title || rec.botName,
                      templateUrl: rec.templateUrl,
                      imagePosterUrl: rec.imagePosterUrl,
                      templatePosterUrl: rec.templatePosterUrl,
                    },
                  },
                })}
              >
                <div className="relative w-full aspect-[3/4]">
                  <img
                    className="w-full h-full object-cover block"
                    src={rec.imagePosterUrl || rec.imageUrl}
                    alt={name}
                    loading="lazy"
                  />
                  <div className="absolute top-2 right-2 bg-black/60 [backdrop-filter:blur(6px)] [-webkit-backdrop-filter:blur(6px)] rounded-md-v2 py-[3px] px-[7px] text-xs font-bold text-Cr-marketing-candlelight-500-v2 leading-none tracking-[0.2px]">
                    {t('explore:matchPercent', { percent: stats.match })}
                  </div>
                </div>
                <div className="pt-2.5 px-2.5 pb-3 flex flex-col gap-1">
                  <div className="text-sm font-semibold leading-[18px] text-Cr-text-default-v2 overflow-hidden text-ellipsis whitespace-nowrap">{name}</div>
                  <div className="flex items-center gap-3 text-xs leading-[15px] text-Cr-text-subtlest-v2">
                    <span className="inline-flex items-center gap-1">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                      {stats.views}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 21s-7-4.35-9.5-8.5C.85 9.64 2.64 6 6 6c2 0 3.5 1 4.5 2.5C11.5 7 13 6 15 6c3.36 0 5.15 3.64 3.5 6.5C19 16.65 12 21 12 21z"/>
                      </svg>
                      {stats.likes}
                    </span>
                  </div>
                </div>
              </AiPickCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface AiPickCardProps {
  cardClass: string;
  slug: string;
  position: number;
  onClick: () => void;
  children: ReactNode;
}

function AiPickCard({ cardClass, slug, position, onClick, children }: AiPickCardProps) {
  const ref = useCardImpression({ slugId: slug, position, listContext: 'ai_picks' });
  return (
    <div ref={ref} className={cardClass} onClick={onClick}>
      {children}
    </div>
  );
}
