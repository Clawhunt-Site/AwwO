import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import BottomSheet from './BottomSheet';
import { useHaptic } from '../hooks/useTelegram';
import { useEnergy } from '../contexts/EnergyContext';
import { estimateEnergyCost } from '../services/api';
import { trackEvent } from '../services/tracking';
import {
  DEFAULT_SCENE,
  SceneDuration,
  SceneOptions,
  SceneQuality,
  getCombinationCost,
  hasVipSelection,
  isDurationVip,
  isQualityVip,
} from '../services/customizeScene';

interface Props {
  botId: string;
  slugId: string;
  /** Override VIP status for stories/harness; production reads from EnergyContext. */
  vipOverride?: boolean | null;
  onClose: () => void;
  onSubmit: (scene: SceneOptions) => void;
  /** Invoked when a non-VIP user picks a VIP combo and taps the CTA. */
  onRequestUpgrade?: () => void;
}

const QUALITY_ORDER: SceneQuality[] = ['low', 'medium', 'high'];
const DURATION_ORDER: SceneDuration[] = ['5s', '8s', '10s', '12s'];

export default function CustomizeSceneModal({
  botId,
  slugId,
  vipOverride,
  onClose,
  onSubmit,
  onRequestUpgrade,
}: Props) {
  const { t } = useTranslation('customizeScene');
  const haptic = useHaptic();
  const { isVip: ctxIsVip } = useEnergy();

  // `vipOverride` has priority so harness/stories can force a state without
  // mocking EnergyContext. Undefined = fall back to context.
  const isVip = vipOverride ?? ctxIsVip ?? false;

  const [scene, setScene] = useState<SceneOptions>(DEFAULT_SCENE);
  const localCost = useMemo(() => getCombinationCost(scene), [scene]);

  // Authoritative cost from /estimate_energy_cost; falls back to localCost.
  const [serverCost, setServerCost] = useState<{ energy: number; estMin: number } | null>(null);
  const [estimating, setEstimating] = useState(false);

  // Always cancel in-flight estimate when scene changes or modal closes.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setEstimating(true);
    (async () => {
      try {
        const resp = await estimateEnergyCost(slugId, scene);
        if (ctrl.signal.aborted) return;
        setServerCost({
          energy: Number(resp.estimatedEnergyCost) || 0,
          estMin: resp.estimatedTimeMinutes,
        });
      } catch {
        if (!ctrl.signal.aborted) setServerCost(null);
      } finally {
        if (!ctrl.signal.aborted) setEstimating(false);
      }
    })();
    return () => ctrl.abort();
  }, [slugId, scene]);

  const displayCost = serverCost ?? localCost;
  const needsVipUpgrade = !isVip && hasVipSelection(scene);

  const trackOptionClick = useCallback(
    (field: string, value: string | number | boolean) => {
      trackEvent('miniapp_customize_scene_option_click', {
        bot_id: botId,
        slug_id: slugId,
        field,
        value,
        is_vip: isVip,
      });
    },
    [botId, slugId, isVip],
  );

  const handleQuality = useCallback(
    (q: SceneQuality) => {
      haptic('selection');
      setScene((prev) => ({ ...prev, quality: q }));
      trackOptionClick('quality', q);
    },
    [haptic, trackOptionClick],
  );

  const handleDuration = useCallback(
    (d: SceneDuration) => {
      haptic('selection');
      setScene((prev) => ({ ...prev, duration: d }));
      trackOptionClick('duration', d);
    },
    [haptic, trackOptionClick],
  );

  const handleAudioToggle = useCallback(() => {
    haptic('selection');
    setScene((prev) => {
      const next = !prev.audio;
      trackOptionClick('audio', next);
      return { ...prev, audio: next };
    });
  }, [haptic, trackOptionClick]);

  const handleRequestUpgrade = useCallback(() => {
    haptic('medium');
    trackEvent('miniapp_customize_scene_unlock_vip_click', {
      bot_id: botId,
      slug_id: slugId,
    });
    onRequestUpgrade?.();
  }, [botId, slugId, haptic, onRequestUpgrade]);

  const handleCreate = useCallback(() => {
    haptic('medium');
    trackEvent('miniapp_customize_scene_submit', {
      bot_id: botId,
      slug_id: slugId,
      quality: scene.quality,
      duration: scene.duration,
      audio: scene.audio,
      energy: displayCost.energy,
      est_min: displayCost.estMin,
    });
    onSubmit(scene);
  }, [botId, slugId, haptic, scene, displayCost, onSubmit]);

  const handlePrimary = needsVipUpgrade ? handleRequestUpgrade : handleCreate;

  return (
    <BottomSheet onClose={onClose}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5 px-1">
        <h2 className="text-[20px] font-semibold text-Cr-text-default-v2 leading-none">
          {t('title')}
        </h2>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="w-7 h-7 flex items-center justify-center text-Cr-text-subtle-v2 active:opacity-60 bg-transparent border-none p-0 cursor-pointer"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      <Segmented
        label={t('videoQuality')}
        items={QUALITY_ORDER.map((q) => ({
          key: q,
          label: t(`quality${q.charAt(0).toUpperCase() + q.slice(1)}`),
          vip: isQualityVip(q),
          active: scene.quality === q,
          onClick: () => handleQuality(q),
        }))}
        vipUnlocked={isVip}
      />

      <Segmented
        label={t('duration')}
        items={DURATION_ORDER.map((d) => ({
          key: d,
          label: d,
          vip: isDurationVip(d),
          active: scene.duration === d,
          onClick: () => handleDuration(d),
        }))}
        vipUnlocked={isVip}
      />

      {/* Audio */}
      <div className="mb-4 flex items-center justify-between bg-Cr-Bg-surface-subtle-v2 rounded-xl-v2 py-3 px-4">
        <label className="flex items-center gap-3 cursor-pointer select-none flex-1">
          <span
            className={`w-5 h-5 rounded-sm-v2 flex items-center justify-center transition-colors duration-150 ${
              scene.audio
                ? 'bg-dreamy-brand-hot-v2'
                : 'bg-transparent border border-Cr-text-subtler-v2'
            }`}
          >
            {scene.audio && (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-Cr-text-static-white-v2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </span>
          <input
            type="checkbox"
            className="sr-only"
            checked={scene.audio}
            onChange={handleAudioToggle}
          />
          <span className="text-[15px] text-Cr-text-default-v2 font-medium">{t('audio')}</span>
        </label>
        <span className="inline-flex items-center gap-1 py-1 px-2.5 rounded-full bg-linear-to-r from-dreamy-vip-pill-from-v2 to-dreamy-vip-pill-to-v2 text-Cr-text-static-white-v2 text-xs font-bold">
          <CrownIcon />
          {t('vipBadge')}
        </span>
      </div>

      {/* Info cards: EST. TIME + ENERGY COST */}
      <div className="mb-5 grid grid-cols-2 gap-3">
        <InfoCard
          icon={
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-dreamy-brand-hot-v2">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          }
          label={t('estTime')}
          value={estimating && !serverCost ? t('loadingCost') : `${displayCost.estMin} ${t('mins')}`}
        />
        <InfoCard
          icon={<BoltIcon />}
          label={t('energyCost')}
          value={
            estimating && !serverCost ? (
              <span className="text-Cr-text-subtler-v2">{t('loadingCost')}</span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <BoltIcon />
                {displayCost.energy}
              </span>
            )
          }
        />
      </div>

      {/* Primary CTA */}
      <button
        type="button"
        onClick={handlePrimary}
        className={`w-full py-3.5 rounded-xl-v2 text-[17px] font-semibold mb-2 border-none cursor-pointer transition-opacity duration-150 active:opacity-[0.85] ${
          needsVipUpgrade
            ? 'bg-linear-to-r from-dreamy-vip-pill-from-v2 to-dreamy-vip-pill-to-v2 text-Cr-text-static-white-v2'
            : 'bg-Cr-text-static-white-v2 text-Cr-text-static-black-v2'
        }`}
      >
        {needsVipUpgrade ? (
          <span className="inline-flex items-center justify-center gap-2">
            <CrownIcon />
            {t('unlockVipToCreate')}
          </span>
        ) : (
          t('createNow')
        )}
      </button>

      {/* Cancel */}
      <button
        type="button"
        onClick={onClose}
        className="w-full py-3 bg-transparent border-none text-[15px] text-Cr-text-subtle-v2 cursor-pointer active:opacity-70"
      >
        {t('cancel')}
      </button>
    </BottomSheet>
  );
}

interface SegmentedItem {
  key: string;
  label: string;
  vip: boolean;
  active: boolean;
  onClick: () => void;
}

function Segmented({
  label,
  items,
  vipUnlocked,
}: {
  label: string;
  items: SegmentedItem[];
  vipUnlocked: boolean;
}) {
  return (
    <div className="mb-4">
      <div className="text-sm text-Cr-text-subtle-v2 mb-2 px-1">{label}</div>
      <div className="flex gap-2 bg-Cr-Bg-surface-subtle-v2 rounded-xl-v2 p-1">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            onClick={it.onClick}
            className={`flex-1 relative py-2.5 rounded-lg-v2 text-[15px] transition-colors duration-150 active:opacity-80 border-none cursor-pointer ${
              it.active
                ? 'bg-dreamy-brand-hot-v2/30 text-Cr-text-static-white-v2 font-semibold'
                : 'bg-transparent text-Cr-text-subtle-v2 font-medium'
            }`}
          >
            {it.label}
            {it.vip && <VipBadge unlocked={vipUnlocked} className="absolute -top-1 -right-1" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function VipBadge({ unlocked, className = '' }: { unlocked: boolean; className?: string }) {
  return (
    <span
      className={`w-3.5 h-3.5 rounded-full flex items-center justify-center ${
        unlocked ? 'bg-dreamy-vip-gold-v2' : 'bg-dreamy-brand-hot-v2'
      } ${className}`}
    >
      <CrownIcon size={8} colorClass="text-Cr-text-static-white-v2" />
    </span>
  );
}

function CrownIcon({ size = 12, colorClass = 'text-dreamy-vip-gold-v2' }: { size?: number; colorClass?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={colorClass}
      aria-hidden="true"
    >
      <path d="M3 7l4 3 5-6 5 6 4-3-2 11H5L3 7zm3 13h12v2H6v-2z" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" className="text-dreamy-brand-hot-v2" aria-hidden="true">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  );
}

function InfoCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="bg-Cr-Bg-surface-subtle-v2 rounded-xl-v2 py-3 px-4 flex flex-col gap-1">
      <div className="flex items-center gap-1 text-[11px] font-semibold text-Cr-text-subtler-v2 tracking-wide uppercase">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-[20px] font-semibold text-Cr-text-default-v2 leading-tight">
        {value}
      </div>
    </div>
  );
}
