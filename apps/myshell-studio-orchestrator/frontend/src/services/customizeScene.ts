// Customize Scene — video bots quality/duration/audio picker.
// Authoritative cost/time comes from the estimate RPC; `getCombinationCost`
// is the local preview used while the RPC is in flight to avoid flicker.

import { generate } from './api';
import type { VideoCustomization, SceneDuration, SceneQuality } from '../types';

export type { VideoCustomization, SceneDuration, SceneQuality };

// Alias kept so existing call sites (modal, upload, harness) stay stable.
export type SceneOptions = VideoCustomization;

export interface SceneCost {
  energy: number;
  estMin: number;
}

// Whitelist of video bots that show the Customize Scene modal.
// Keyed by slug_id (stable) rather than bot_id (changes when bot rev is swapped).
export const CUSTOMIZE_SCENE_SLUG_IDS: readonly string[] = [
  'ai-blowjob',
  'undress-generator',
  'ai-cumshot',
  'ai-celebrity-porn',
  'squirting-porn',
  'ai-deepthroat',
  'faceswap-porn',
  'pov-porn',
];

export function shouldShowCustomizeScene(slugId: string | undefined): boolean {
  if (!slugId) return false;
  return CUSTOMIZE_SCENE_SLUG_IDS.includes(slugId);
}

// VIP gating — quality/duration above the free tier, or audio, require VIP.
export const FREE_QUALITY: SceneQuality = 'low';
export const FREE_DURATION: SceneDuration = '5s';

export function isQualityVip(q: SceneQuality): boolean {
  return q !== FREE_QUALITY;
}
export function isDurationVip(d: SceneDuration): boolean {
  return d !== FREE_DURATION;
}
export function hasVipSelection(opts: SceneOptions): boolean {
  return isQualityVip(opts.quality) || isDurationVip(opts.duration) || opts.audio;
}

export const DEFAULT_SCENE: SceneOptions = {
  quality: FREE_QUALITY,
  duration: FREE_DURATION,
  audio: false,
};

// Local cost preview — mirrors the server formula for instant option-tap feedback.
const QUALITY_BASE_COST: Record<SceneQuality, number> = {
  low: 15,
  medium: 30,
  high: 60,
};
const QUALITY_BASE_MIN: Record<SceneQuality, number> = {
  low: 2,
  medium: 4,
  high: 6,
};
const AUDIO_ENERGY_SURCHARGE = 5;

export function getCombinationCost(opts: SceneOptions): SceneCost {
  const durationSec = parseInt(opts.duration, 10);
  const base = QUALITY_BASE_COST[opts.quality];
  const baseMin = QUALITY_BASE_MIN[opts.quality];
  return {
    energy: Math.round((base * durationSec) / 5) + (opts.audio ? AUDIO_ENERGY_SURCHARGE : 0),
    estMin: Math.round((baseMin * durationSec) / 5),
  };
}

interface SubmitArgs {
  botId: string;
  slugId: string;
  inputImg: string[];
  scene: SceneOptions;
  articleId?: string;
  shellJson?: string;
}

// Backend returns SUBSCRIPTION_REQUIRED when a non-VIP user submits a VIP combo;
// callers rely on `isNeedStoreRedirect` to route the user to the energy store.
export async function submitGenerateWithOptions(args: SubmitArgs): Promise<void> {
  const { botId, slugId, inputImg, scene, articleId, shellJson } = args;
  if (import.meta.env.DEV) {
    console.debug('[customizeScene] submit', { botId, slugId, scene });
  }
  await generate(botId || slugId, inputImg, articleId, shellJson, undefined, scene);
}
