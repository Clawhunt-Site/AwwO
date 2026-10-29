// What the Agent market's surfaces call things, in both languages, and how they format its numbers. The market's views
// run in the hosted pages and over a canvas alike, so they take the locale from the canvas's provider (which the hosted
// pages also set) instead of requiring the hosted shell's.
import { useMemo } from 'react';
import { useCanvasI18n } from '../../canvas/i18n';
import type { MarketAgentStatus, MarketCallStatus, MarketCategory, MarketSort, MarketVersionState } from '../marketApi';

export type MarketT = (zh: string, en: string) => string;
export function useMarketI18n(): { locale: 'zh' | 'en'; t: MarketT } {
  const { locale } = useCanvasI18n();
  return useMemo(() => ({ locale, t: (zh: string, en: string) => locale === 'zh' ? zh : en }), [locale]);
}

const CATEGORY_NAMES: Record<MarketCategory, [string, string]> = {
  page: ['网页与界面', 'Pages and interfaces'], writing: ['写作与文案', 'Writing and copy'], research: ['研究与分析', 'Research and analysis'],
  code: ['编程与工程', 'Code and engineering'], design: ['设计与创意', 'Design and creative'], media: ['图像与视频提示', 'Image and video prompts'],
  business: ['商业与营销', 'Business and marketing'], education: ['教育与学习', 'Education and learning'], other: ['其他', 'Other'],
};
export const categoryName = (category: MarketCategory, t: MarketT) => t(...CATEGORY_NAMES[category]);

const SORT_NAMES: Record<MarketSort, [string, string]> = { score: ['综合', 'Overall'], calls: ['最多调用', 'Most used'], new: ['最新', 'Newest'], price: ['价格', 'Price'] };
export const sortName = (sort: MarketSort, t: MarketT) => t(...SORT_NAMES[sort]);

const STATUS_NAMES: Record<MarketAgentStatus, [string, string]> = { draft: ['草稿', 'Draft'], listed: ['已上架', 'Listed'], unlisted: ['已下架', 'Unlisted'], suspended: ['已停用', 'Suspended'] };
export const agentStatusName = (status: MarketAgentStatus, t: MarketT) => t(...STATUS_NAMES[status]);

const STATE_NAMES: Record<MarketVersionState, [string, string]> = { draft: ['草稿', 'Draft'], pending: ['待审核', 'In review'], approved: ['已通过', 'Approved'],
  rejected: ['已驳回', 'Rejected'], superseded: ['已被新版本替换', 'Replaced by a newer version'] };
export const versionStateName = (state: MarketVersionState, t: MarketT) => t(...STATE_NAMES[state]);

// A fee is held at admission and settled as the run ends: taken when it completes (or the Agent's text is the caller's
// all the same, market_use.go marketChargedRun), and given back otherwise.
const CALL_NAMES: Record<MarketCallStatus, [string, string]> = { reserved: ['预扣（运行结束时结算）', 'Held (settled when the run ends)'], charged: ['已扣', 'Charged'],
  released: ['未扣', 'Not charged'] };
export const callStatusName = (status: MarketCallStatus, t: MarketT) => t(...CALL_NAMES[status]);

const PAYOUT_NAMES: Record<string, [string, string]> = { pending: ['待转入', 'Waiting to transfer'], sent: ['已转入', 'Transferred'], held: ['暂缓', 'On hold'], failed: ['失败', 'Failed'] };
export const payoutStatusName = (status: string, t: MarketT) => PAYOUT_NAMES[status] ? t(...PAYOUT_NAMES[status]) : status;

export const priceText = (price: number, t: MarketT) => price > 0 ? t(`每次 ${price} 点`, `${price} ${price === 1 ? 'credit' : 'credits'} a call`) : t('免费', 'Free');
export const authorText = (agent: { official: boolean; author: { name: string } | null }, t: MarketT) =>
  agent.official ? t('AwwO 官方', 'AwwO official') : agent.author?.name || t('作者未署名', 'Unnamed author');
export const percentText = (rate: number | null) => rate === null ? '—' : `${Math.round(rate * 100)}%`;
export const numberText = (value: number, locale: 'zh' | 'en') => new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US').format(value);
/** Credits with at most two decimals (an author's share of a call can be a fraction of one). */
export const creditsText = (value: number, locale: 'zh' | 'en') => new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 2 }).format(value);
export function secondsText(seconds: number | null, t: MarketT): string {
  if (seconds === null) return '—';
  const rounded = Math.round(seconds);
  return rounded < 60 ? t(`${rounded} 秒`, `${rounded}s`) : t(`${Math.floor(rounded / 60)} 分 ${rounded % 60} 秒`, `${Math.floor(rounded / 60)}m ${rounded % 60}s`);
}
export const dateText = (value: string | null, locale: 'zh' | 'en') => {
  if (!value) return '—';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'numeric', day: 'numeric' }) : '—';
};
