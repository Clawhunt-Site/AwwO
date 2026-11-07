// The live data a written request names: web research, SEO numbers, social data, company and people data, market prices,
// ad research. AwwO's own Agents have no live web (they reach no address of their own choosing), so where a request
// names one, the home's composer says that a person can bring their own Agent with a tool registry to the canvas
// (saas/home/ToolAdvice.tsx), and a canvas's Next card says so too. It is advice for the person only: nothing a canvas
// plans or runs reads it, and both say "may": a match is a guess from words, never a judgement of the request.
//
// Only words that ask for data count. Everyday ones that name no data on their own (最新, 新闻, 热门, 趋势, 招聘,
// 联系方式, 线索, 投放, latest, news, trend, ranking, lead, hiring, enrich, a bare "ads") were left out after a review
// found them flagging ordinary build requests (a company site with its contact details, a recruiting site, a game's
// ranking board). A platform's name counts only where the request also asks for data from it: "a YouTube-style player"
// asks for none.

export type LiveDataNeed = 'web' | 'seo' | 'social' | 'company' | 'market' | 'ads';

/** Each need, in the order the advice names them, with the words that name it. A word in Latin letters matches as a
 *  whole word, case-insensitively, with a plural -s or -es allowed: "prospect" is not "prospective". Any other word
 *  (Chinese, or Chinese with Latin letters, as B站) matches wherever it appears. */
const NEED_WORDS: ReadonlyArray<readonly [LiveDataNeed, ReadonlyArray<string>]> = [
  ['web', ['调研', '竞品', '竞争对手', '竞争分析', '行业报告', '市场分析', '抓取', '爬取', '搜索结果', '实时数据', '实时信息', '舆情',
    'competitor', 'competitive analysis', 'market research', 'scrape', 'scraping', 'scraper', 'crawl', 'crawler', 'crawling',
    'search the web', 'real-time data']],
  ['seo', ['SEO', '关键词', '外链', '搜索排名', '搜索量', 'keyword', 'backlink', 'SERP', 'search volume']],
  ['social', ['社媒', '爆款', '达人', '网红', 'hashtag', 'influencer']],
  ['company', ['融资信息', '融资情况', '潜在客户', '客户名单', '销售线索', '企业信息', '公司信息', 'prospect', 'lead generation', 'company data', 'funding round']],
  ['market', ['股价', '股票', '行情', '汇率', '加密货币', 'stock price', 'crypto', 'Bitcoin', 'exchange rate', 'market data']],
  ['ads', ['广告库', '竞品广告', 'ad library']],
];

/** Platforms whose data a request may ask for: social data only where a data cue is there as well. */
const PLATFORMS = ['小红书', '抖音', '微博', 'B站', '知乎', '公众号', 'TikTok', 'Instagram', 'YouTube', 'Reddit', 'Twitter', 'LinkedIn', 'Facebook'];
const DATA_CUES = ['查', '搜', '抓', '统计', '分析', '数据', '热度', '趋势', '热门', '榜单', '评论', '粉丝', '播放量', '点赞',
  'find', 'look up', 'track', 'search', 'data', 'analytics', 'trending', 'trends', 'comments', 'followers', 'views'];

const LATIN = /^[A-Za-z0-9 -]+$/;
const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A test for a list of words: its Latin words as one whole-word pattern (the spaces of a phrase match any run of white
 *  space), and its other words as plain text. */
function matcher(words: ReadonlyArray<string>): (text: string) => boolean {
  const latin = words.filter(word => LATIN.test(word));
  const other = words.filter(word => !LATIN.test(word)).map(word => word.toLowerCase());
  const pattern = latin.length ? new RegExp(`\\b(?:${latin.map(word => escape(word).replace(/ +/g, '\\s+')).join('|')})(?:e?s)?\\b`, 'i') : null;
  return text => other.some(word => text.includes(word)) || Boolean(pattern?.test(text));
}
const MATCHERS = NEED_WORDS.map(([need, words]) => [need, matcher(words)] as const);
const platformNamed = matcher(PLATFORMS);
const dataAsked = matcher(DATA_CUES);

/** The live data a request may need, each need once, in LIVE_DATA_NEEDS order; [] for a request that names none. */
export function liveDataNeed(text: string): LiveDataNeed[] {
  const lower = text.toLowerCase();
  const social = platformNamed(lower) && dataAsked(lower);
  return MATCHERS.filter(([need, matches]) => matches(lower) || (need === 'social' && social)).map(([need]) => need);
}

export const LIVE_DATA_NEEDS: ReadonlyArray<LiveDataNeed> = NEED_WORDS.map(([need]) => need);
