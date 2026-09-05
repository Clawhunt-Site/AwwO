import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { NavigationBar } from '../components/NavigationBar';
import { Sidebar } from '../components/Sidebar';
import { useEnergy } from '../contexts/EnergyContext';
import { useTelegramBackButton } from '../hooks/useTelegram';
import { fetchBotDetail } from '../services/api';
import type { BotDetailInfo, BotSingleText, PageDetail, UserScenarioItem } from '../types';
import { safeJsonParse } from '../utils/json';

function VideoWithLazyAutoplay({ src, className }: { src: string; className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            video.play().catch(() => {});
          } else {
            video.pause();
          }
        });
      },
      { threshold: 0.5 }
    );

    observer.observe(video);
    return () => {
      observer.unobserve(video);
      observer.disconnect();
    };
  }, []);

  return (
    <video
      ref={videoRef}
      className={className}
      src={src}
      loop
      muted
      playsInline
    />
  );
}

export default function BotDetail() {
  const { t } = useTranslation(['botDetail', 'common']);
  const [searchParams] = useSearchParams();
  const slugId = searchParams.get('slug_id') || '';
  const navigate = useNavigate();
  const { energy } = useEnergy();

  const [info, setInfo] = useState<BotDetailInfo | null>(null);
  const [recommend, setRecommend] = useState<BotDetailInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const goBack = useCallback(() => navigate(-1), [navigate]);
  useTelegramBackButton(goBack);

  useEffect(() => {
    if (!slugId) {
      setError(t('botDetail:missingSlug'));
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchBotDetail(slugId)
      .then(res => {
        setInfo(res.info);
        setRecommend(res.recommend || []);
        setLoading(false);
      })
      .catch(err => {
        setError(String(err));
        setLoading(false);
      });
  }, [slugId]);

  const parsed = useMemo(() => safeJsonParse<BotSingleText>(info?.singleText), [info?.singleText]);
  const pageDetail = useMemo(() => safeJsonParse<PageDetail>(info?.pageDetail), [info?.pageDetail]);

  useEffect(() => {
    if (!info?.schema) return;
    try {
      JSON.parse(info.schema);
    } catch {
      return;
    }
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = info.schema;
    document.head.appendChild(script);
    return () => {
      document.head.removeChild(script);
    };
  }, [info?.schema]);

  const handleTryIt = useCallback(() => {
    navigate(`/upload?slug_id=${slugId}`, {
      state: {
        botId: info?.botId,
        articleId: info?.slugId || slugId,
        singleText: parsed,
      },
    });
  }, [navigate, slugId, info, parsed]);

  // Display data
  const title = parsed?.title || info?.metaTitle || info?.botName || '';
  const description = parsed?.description || info?.metaDesc || '';
  const buttonText = parsed?.button_text || t('botDetail:tryIt');
  const mainVideo = [info?.templateImage, info?.templateImageh5].find(u => u?.endsWith('.mp4')) || '';
  const mainImage = info?.exploreImage || info?.exploreImageh5 || info?.templateImage || '';

  return (
    <div className="h-full overflow-y-auto pt-12 [-webkit-overflow-scrolling:touch]">
      <NavigationBar
        onMenuClick={() => setSidebarOpen(prev => !prev)}
        onEnergyClick={() => navigate('/energy')}
        energy={energy}
        sidebarOpen={sidebarOpen}
      />
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {loading ? (
        <div className="py-12 px-8 text-center text-Cr-text-subtler-v2 text-sm">{t('common:loading')}</div>
      ) : error ? (
        <div className="py-12 px-8 text-center text-Cr-text-critical-default-v2 text-sm">
          <div className="font-bold mb-2">{t('common:apiError')}</div>
          <div className="opacity-80 break-all">{error}</div>
        </div>
      ) : (
        <>
          {/* Title + Description */}
          <div className="pt-3 px-4 pb-4">
            <h1 className="text-2xl font-medium text-Cr-text-static-white-v2 leading-tight m-0 mb-2">{title}</h1>
            {description && <p className="text-sm font-normal text-Cr-text-subtler-v2 leading-normal m-0">{description}</p>}
          </div>

          {/* Main Media — prefer video, fall back to image */}
          {mainVideo ? (
            <div className="px-4 pb-4">
              <video
                className="w-full rounded-xl block"
                src={mainVideo}
                autoPlay
                loop
                muted
                playsInline
                poster={info?.exploreImage || info?.exploreImageh5 || ''}
              />
            </div>
          ) : mainImage && (
            <div className="px-4 pb-4">
              <img className="w-full rounded-xl block" src={mainImage} alt={title} />
            </div>
          )}

          {/* Related Works */}
          {recommend.length > 0 && (
            <div className="px-4 pb-4">
              <div className="flex items-center gap-3 mb-4">
                <span className="flex-1 h-px bg-white/10" />
                <span className="text-xs font-medium text-Cr-text-subtler-v2 whitespace-nowrap uppercase">{t('botDetail:relatedWorks')}</span>
                <span className="flex-1 h-px bg-white/10" />
              </div>
              <div className="flex gap-3 overflow-x-auto [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pb-1">
                {recommend.map((bot) => (
                  <div
                    key={bot.slugId}
                    className="flex-shrink-0 w-[100px] cursor-pointer"
                    onClick={() => navigate(`/bot?slug_id=${bot.slugId}`)}
                  >
                    <img
                      className="w-[100px] h-[133px] object-cover rounded-lg block mb-1.5"
                      src={bot.exploreImage || bot.exploreImageh5 || bot.templateImage}
                      alt={bot.botName}
                      loading="lazy"
                    />
                    <span className="text-xs font-normal text-Cr-text-subtler-v2 block whitespace-nowrap overflow-hidden text-ellipsis">{bot.botName}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {pageDetail?.user_scenarios?.items && pageDetail.user_scenarios.items.length > 0 && (
            <div className="px-4 pb-6 flex flex-col gap-8">
              {pageDetail.user_scenarios.items.map((item, index) => {
                const isVideo = item.media?.endsWith('.mp4');
                const isTextLeft = item.type === 'Text-Left';

                return (
                  <div key={index} className="flex flex-col md:flex-row md:gap-6 md:items-center">
                    {item.media && (
                      <div className={`mb-4 md:mb-0 md:flex-1 ${isTextLeft ? 'md:order-2' : 'md:order-1'}`}>
                        {isVideo ? (
                          <VideoWithLazyAutoplay src={item.media} className="w-full rounded-xl-v2 block" />
                        ) : (
                          <img src={item.media} alt={item.title} className="w-full rounded-xl-v2 block" loading="lazy" />
                        )}
                      </div>
                    )}
                    <div className={`md:flex-1 ${isTextLeft ? 'md:order-1' : 'md:order-2'}`}>
                      <h2 className="text-base font-semibold text-Cr-text-static-white-v2 leading-snug mb-2">{item.title}</h2>
                      <p className="text-sm font-normal text-Cr-text-subtler-v2 leading-relaxed">{item.description}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Spacer for bottom button */}
          <div className="h-28" />
        </>
      )}

      {/* Bottom Button */}
      {!loading && !error && (
        <div className="fixed bottom-0 left-0 right-0 py-3 px-4 pb-[max(12px,env(safe-area-inset-bottom))] bg-Cr-Bg-soft-v2 z-[100]">
          <button
            className="w-full h-14 border-none rounded-md-v2 bg-Cr-Bg-brand-alt-v2 text-Cr-text-static-white-v2 text-lg font-medium cursor-pointer flex items-center justify-center gap-2 transition-opacity duration-200 active:opacity-85"
            onClick={handleTryIt}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2z" />
            </svg>
            {buttonText}
          </button>
        </div>
      )}
    </div>
  );
}
