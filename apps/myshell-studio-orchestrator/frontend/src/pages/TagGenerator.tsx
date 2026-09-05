/**
 * TagGenerator Page
 * Tag-Driven Generator — Self Director V2
 *
 * Single-step page: Tag selection → Generate
 * Receives slug_id and img URL params from upload flow
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CategoryTabBar } from '../components/generator/CategoryTabBar';
import { TagChipGroup } from '../components/generator/TagChipGroup';
import { SelectionTray } from '../components/generator/SelectionTray';
import { GenerateDock } from '../components/generator/GenerateDock';
import { CATEGORIES, TAG_OPTIONS, assemblePrompt, rollAllTags } from '../data/generatorTags';
import { useEnergy } from '../contexts/EnergyContext';
import { generate, fetchBotDetail, estimateEnergyCost, isNeedStoreRedirect } from '../services/api';
import { trackEvent } from '../services/tracking';
import { useTelegramBackButton } from '../hooks/useTelegram';
import { SegmentedControl } from '../components/generator/SegmentedControl';
import { CheckRow } from '../components/generator/CheckRow';
import { CostSummary } from '../components/generator/CostSummary';
import type { VideoCustomization, SceneQuality, SceneDuration } from '../types';

function DiceIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="3.5" />
      <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}


export function TagGenerator() {
  const navigate = useNavigate();
  const location = useLocation();
  const { energy, refresh: refreshEnergy } = useEnergy();
  const { t } = useTranslation('tagGenerator');

  // Parse query params
  const params = new URLSearchParams(location.search);
  const slugId = params.get('slug_id');
  const imgUrl = params.get('img');

  // Redirect back if img param is missing
  useEffect(() => {
    if (!imgUrl) {
      navigate(-1);
    }
  }, [imgUrl, navigate]);

  // State
  const [botId, setBotId] = useState<string>('');

  // Tag selection state
  const [activeCategory, setActiveCategory] = useState<string>(CATEGORIES[0].id);
  const [selections, setSelections] = useState<Record<string, string | undefined>>({});
  const [autoRolled, setAutoRolled] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  // Quality/Duration/Audio state
  const [quality, setQuality] = useState<string>('Medium');
  const [duration, setDuration] = useState<string>('5s');
  const [audio, setAudio] = useState(false);

  // Server-side cost estimate
  const [serverCost, setServerCost] = useState<{ energy: number; estMin: number } | null>(null);
  const estimateAbortRef = useRef<AbortController | null>(null);

  // Fetch botId on mount
  useEffect(() => {
    const fetchBot = async () => {
      try {
        // If slug_id provided, use it; otherwise default to 'ai-porn-generator'
        const slug = slugId || 'ai-porn-generator';
        const detail = await fetchBotDetail(slug);
        if (detail?.info?.botId) {
          setBotId(detail.info.botId);
        }
      } catch (error) {
        console.error('Failed to fetch bot detail:', error);
      }
    };
    fetchBot();
  }, [slugId]);

  // Cold start: auto-roll tags
  useEffect(() => {
    const rolled = rollAllTags();
    setSelections(rolled);
    setAutoRolled(true);
  }, []);

  // Back button handler
  useTelegramBackButton(() => {
    navigate(-1);
  });

  // Derived state
  const count = Object.values(selections).filter(Boolean).length;
  const isEmpty = count === 0;
  const filledIds = useMemo(() => {
    const set = new Set<string>();
    CATEGORIES.forEach((cat) => {
      if (selections[cat.id]) {
        set.add(cat.id);
      }
    });
    return set;
  }, [selections]);

  // Translated categories and tags for display (prompt uses original English)
  const translatedCategories = useMemo(() =>
    CATEGORIES.map((cat) => ({ ...cat, label: t(`cat_${cat.id}`) })),
    [t]
  );
  const translatedTagOptions = useMemo(() => {
    const result: Record<string, Array<{ id: string; label: string }>> = {};
    Object.entries(TAG_OPTIONS).forEach(([catId, tags]) => {
      result[catId] = tags.map((tag) => ({ id: tag.id, label: t(`tag_${tag.id}`) }));
    });
    return result;
  }, [t]);

  // Map UI values to VideoCustomization
  const customization: VideoCustomization = useMemo(() => ({
    quality: quality.toLowerCase() as SceneQuality,
    duration: duration as SceneDuration,
    audio,
  }), [quality, duration, audio]);

  // Fetch real cost from estimate API whenever options change
  useEffect(() => {
    estimateAbortRef.current?.abort();
    const ctrl = new AbortController();
    estimateAbortRef.current = ctrl;
    const slug = slugId || 'ai-porn-generator';
    (async () => {
      try {
        const resp = await estimateEnergyCost(slug, customization);
        if (!ctrl.signal.aborted) {
          setServerCost({
            energy: Number(resp.estimatedEnergyCost) || 0,
            estMin: resp.estimatedTimeMinutes ?? 0,
          });
        }
      } catch {
        if (!ctrl.signal.aborted) setServerCost(null);
      }
    })();
    return () => ctrl.abort();
  }, [slugId, customization]);

  // Fallback local cost calculation (used while server is loading)
  const qualityCost: Record<string, number> = { Low: 0, Medium: 6, High: 12 };
  const durationCost: Record<string, number> = { '5s': 0, '8s': 4, '10s': 8, '12s': 12 };
  const localEnergyCost = isEmpty ? 0 : 18 + (qualityCost[quality] || 0) + (durationCost[duration] || 0);
  const localMins: Record<string, number> = { '5s': 1, '8s': 2, '10s': 3, '12s': 4 };

  // Use server cost when available, fallback to local
  const energyCost = isEmpty ? 0 : (serverCost?.energy ?? localEnergyCost);
  const mins = isEmpty ? 0 : (serverCost?.estMin ?? (localMins[duration] || 1));

  // Tag selection handlers
  const handleCategorySelect = (categoryId: string) => {
    setActiveCategory(categoryId);
  };

  const handleTagSelect = (categoryId: string, tagId: string) => {
    setSelections((prev) => ({
      ...prev,
      [categoryId]: prev[categoryId] === tagId ? undefined : tagId,
    }));
    setAutoRolled(false);

    trackEvent('sd_tag_selected', {
      category: categoryId,
      tag_id: tagId,
    });
  };

  const handleRemove = (categoryId: string) => {
    setSelections((prev) => {
      const next = { ...prev };
      delete next[categoryId];
      return next;
    });
    setAutoRolled(false);
  };

  const handleClearAll = () => {
    setSelections({});
    setAutoRolled(false);
  };

  const handleRandom = () => {
    const rolled = rollAllTags();
    setSelections(rolled);
    setAutoRolled(true);

    trackEvent('sd_random_click');
  };

  const handleGenerate = async () => {
    if (isEmpty || !botId || !imgUrl) {
      return;
    }

    // Check energy
    const currentEnergy = energy ?? 0;
    if (currentEnergy < energyCost) {
      trackEvent('sd_energy_wall_shown');
      alert(t('notEnoughEnergy'));
      return;
    }

    trackEvent('sd_generate_click', {
      tag_count: count,
      energy_cost: energyCost,
    });

    setIsGenerating(true);

    try {
      const prompt = assemblePrompt(selections);


      // Call generate API - pass prompt as inputImg[1] (same as Description field in Upload)
      // articleId = slugId (backend uses it to look up PornSingle config)
      // Pass customization (quality/duration/audio) to backend
      const result = await generate(botId, [imgUrl, prompt], slugId || 'ai-porn-generator', undefined, undefined, customization);

      if (result?.outputJobId) {
        trackEvent('sd_generate_success', {
          job_id: result.outputJobId,
        });
        // Close miniapp immediately — bot will notify user when generation completes
        try { window.Telegram?.WebApp?.close(); } catch { /* noop */ }
      }
    } catch (error) {
      console.error('Generate error:', error);
      if (isNeedStoreRedirect(error)) {
        // Redirect to energy store for subscription/VIP required
        navigate('/energy');
      } else {
        trackEvent('sd_generate_failed', {
          error: String(error),
        });
        alert(t('generationFailed'));
      }
      setIsGenerating(false);
    }
  };

  // Don't render if no image URL (will redirect)
  if (!imgUrl) {
    return null;
  }

  return (
    <div className="w-full h-full flex flex-col relative bg-Cr-Bg-clean-v2 text-Cr-text-default-v2">
      {/* Sub-header */}
      <div className="h-12 grid items-center shrink-0" style={{ gridTemplateColumns: '44px 1fr 44px' }}>
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label="Back"
          className="ml-spacing-md-v2 w-9 h-9 rounded-full-v2 bg-transparent border-0 text-Cr-text-default-v2 cursor-pointer inline-flex items-center justify-center"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="text-base font-semibold text-center tracking-[-0.01em]">
          {t('title')}
        </div>
        {/* Thumbnail */}
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mr-spacing-md-v2 ml-auto w-9 h-9 rounded-full-v2 overflow-hidden border border-Cr-border-default-v2 cursor-pointer inline-flex items-center justify-center"
          aria-label="Change photo"
        >
          <img src={imgUrl} alt="Uploaded" className="w-full h-full object-cover" />
        </button>
      </div>

      {/* Helper line */}
      <div className="px-spacing-xl-v2 pb-spacing-lg-v2 text-center text-xs text-Cr-text-subtler-v2">
        {t('helperPick')}{' '}
        <span className="text-Cr-text-default-v2 font-semibold">{t('helperRandom')}</span> {t('helperSurprise')}
        <span className="text-Cr-text-warning-default-v2 ml-1 inline-block align-[-1px]">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2 L13.5 9.5 L21 11 L13.5 12.5 L12 20 L10.5 12.5 L3 11 L10.5 9.5 Z" />
          </svg>
        </span>
      </div>

      {/* Scroll body */}
      <div className="flex-1 overflow-y-auto pb-[120px] flex flex-col gap-spacing-xl-v2">
        {/* Category tab bar */}
        <CategoryTabBar
          items={translatedCategories}
          activeId={activeCategory}
          onSelect={handleCategorySelect}
          filledIds={filledIds}
        />

        {/* Section header + Random button */}
        <div className="flex items-center justify-between px-spacing-xl-v2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-Cr-text-subtler-v2">
            {translatedCategories.find((c) => c.id === activeCategory)?.label} · {t('selectOne')}
          </div>
          <button
            type="button"
            onClick={handleRandom}
            className="inline-flex items-center gap-spacing-sm-v2 h-7 px-spacing-lg-v2 rounded-full-v2 bg-Cr-beta-white-5-v2 border border-Cr-border-default-v2 text-Cr-text-default-v2 text-[10px] font-semibold uppercase tracking-[0.08em] cursor-pointer"
            aria-label="Roll random selections"
          >
            <DiceIcon size={12} />
            {t('randomButton')}
          </button>
        </div>

        {/* Tag chip group */}
        <TagChipGroup
          categoryId={activeCategory}
          options={translatedTagOptions[activeCategory] || []}
          selected={selections[activeCategory]}
          onSelect={handleTagSelect}
        />

        {/* Selection tray */}
        <SelectionTray
          selections={selections}
          total={CATEGORIES.length}
          onRemove={handleRemove}
          onClear={handleClearAll}
          autoRolled={autoRolled}
          categories={translatedCategories}
          tagOptions={translatedTagOptions}
        />

        {/* Controls */}
        <div className="pt-spacing-xs-v2 px-spacing-xl-v2 flex flex-col gap-spacing-xl-v2">
          {/* Quality */}
          <div>
            <div className="text-sm font-semibold mb-spacing-md-v2 text-Cr-text-default-v2">
              {t('quality')}
            </div>
            <SegmentedControl
              options={['Low', 'Medium', 'High']}
              labels={[t('qualityLow'), t('qualityMedium'), t('qualityHigh')]}
              value={quality}
              onChange={setQuality}
            />
          </div>

          {/* Duration */}
          <div>
            <div className="text-sm font-semibold mb-spacing-md-v2 text-Cr-text-default-v2">
              {t('duration')}
            </div>
            <SegmentedControl
              options={['5s', '8s', '10s', '12s']}
              value={duration}
              onChange={setDuration}
            />
          </div>

          {/* Audio */}
          <CheckRow
            checked={audio}
            onChange={setAudio}
            label={t('audio')}
          />

          {/* Cost Summary */}
          {!isEmpty && (
            <CostSummary
              estimatedMins={mins}
              energyCost={energyCost}
            />
          )}
        </div>

        {/* Scroll hint */}
        <div className="text-center pt-spacing-xs-v2 text-Cr-text-subtler-v2 text-[10px] font-semibold uppercase tracking-[0.1em] flex flex-col items-center gap-0.5 opacity-70">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 14l5-5 5 5" />
          </svg>
          {t('swipeUp')}
        </div>
      </div>

      {/* Bottom dock */}
      <GenerateDock
        isEmpty={isEmpty}
        energyCost={energyCost}
        onGenerate={handleGenerate}
        disabled={isGenerating}
      />
    </div>
  );
}
