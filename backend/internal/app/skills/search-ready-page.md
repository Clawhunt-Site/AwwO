---
name: search-ready-page
title: Search-ready pages: what search engines and AI assistants can read, trust and cite
title_zh: 可被搜索引用的页面：让搜索引擎和 AI 助手读得到、信得过、引用得了
description: Use when a node builds a public web page that should be found and cited (a landing page, a product or comparison page, documentation, an article): put the answer in the raw HTML, give every page its title, description, one H1, a canonical and honest structured data, write decision pages the way assistants quote them, keep every fact sourced and dated, and list what only the owner can do (robots rules, search consoles, links). Numbers come from tools or fetched pages, never from memory.
description_zh: 节点做需要被搜到、被引用的公开网页（落地页、产品页或对比页、文档、文章）时使用：答案写进原始 HTML；每页有标题、描述、唯一 H1、canonical 和真实的结构化数据；按助手引用的方式写决策页；每个事实都有来源和日期；列出只有业主能做的事（robots 规则、搜索后台、外链）。数字来自工具或抓到的页面，绝不凭记忆。
category: writing
applies: html,writing,research
version: 1
attribution:
---
# Search-ready pages

Crawlers and assistants fetch a page, quote a passage from it and link it as a source. If its words are missing from the HTML the server returns, or its facts look unreliable, it is left out of the answer however polished it looks.

## Everything important arrives in the served HTML

- Many crawlers never execute JavaScript and read only the markup the server delivers. The headline, the body copy and the key facts belong in that markup; an app whose served HTML holds three words looks blank to such a crawler.
- On each page: a distinct `<title>` under 60 characters, a `<meta name="description">` under 160, a single `<h1>`, `<html lang>`, a `<link rel="canonical">` naming its one address, and no `noindex` unless the page is meant to stay hidden.
- One `<script type="application/ld+json">` block of structured data: Organization plus WebSite on the home page, Product or SoftwareApplication on a product page, Article on an article. Mark up only true things: rating stars need genuine reviews behind them, and FAQ or HowTo markup earns almost nothing in today's results.
- `alt` text on images; a sitemap listing the pages meant to be indexed and nothing else; a 404 for addresses that do not exist. A server that answers every unknown path with 200 and the app's shell (a soft 404) makes a sitemap or a text file appear to exist when it does not.

## Which crawlers may come in (the owner decides)

Appearing in assistants' web answers depends on their search crawlers, which robots.txt names by their user-agent tokens (PerplexityBot, OAI-SearchBot, bingbot, Claude-SearchBot, Googlebot); GPTBot and ClaudeBot govern training use; Google-Extended governs both training and the grounding of some assistants' answers, so blocking it also leaves those answers; and fetchers that act on one person's request (ChatGPT-User, Claude-User, Perplexity-User) are separate tokens again. These tokens are identifiers the file needs, not brands to promote. Robots rules control crawling, not removal: shutting out a search crawler stops new fetches, but a page it already indexed, or one an assistant reaches through another index, can still appear; taking a page out needs a `noindex` the crawler is allowed to fetch, or the service's own removal tool. The page has no control over the robots.txt file or a CDN's bot rules. When a tool or an input gives you the live file, hand the owner its relevant lines, read with a matcher that understands `*` and `$` (the most specific rule wins and Allow beats Disallow on a tie); without one, list the lines for the owner to check, marked "not checked".

## Decision pages, the ones assistants cite

- These are what people look at just before they decide: one product against another, alternatives to a product, the best option for a stated kind of buyer, a pricing comparison.
- Give the verdict early (within roughly forty to eighty words of the top) and mention the product by name, because assistants quote short passages rather than whole pages.
- Compare between five and eight options: three looks like an advertisement and twenty-five like a directory. Every option, yours too, gets one honest weakness, and yours does not lead the list by default.
- Quote each price from the seller's own site with the date you looked ("checked 2026-11-11"); every figure carries its source; anything unverified is marked "not checked".
- Contribute something the competing pages lack (a measurement, a test, a screenshot of your own) and explain how you made it.

## Facts and claims

- Never make up a keyword volume, a ranking, a citation count, a customer or a quotation.
- A dated sheet of plain facts (prices, plans, platforms) helps assistants describe the product correctly; when they repeat an error, correct it on the source page, and consider it fixed only once the error stops reappearing.

## The owner's list, outside the page

Registering the site in the search engines' webmaster consoles (including the one whose index several assistants use), submitting the sitemap, listing the product in 20 to 30 directories under the same name, tagline and logo, outreach, and a video wherever the results for a query show video. Edits to robots.txt, canonical tags, redirects or noindex need a person's approval and a diff shown first; pages are never deleted automatically.

## Before you hand over

1. Title, description, a single H1, lang, canonical and truthful structured data, all present in the served HTML.
2. The verdict inside the first 80 words; each fact sourced and dated; "not checked" wherever it was not.
3. No rating stars without reviews, no FAQ or HowTo markup, no invented numbers.
4. The owner's list: crawler rules to read, consoles, the sitemap, unknown addresses returning 404.
