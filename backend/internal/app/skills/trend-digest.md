---
name: trend-digest
title: Trend digest from feed items
title_zh: 资讯摘要：从订阅条目写日报
description: Use when turning imported news or feed items into a daily or weekly digest: score each item blind against a fixed rubric, select the strongest, and write summaries and an overview that add no names or numbers the items lack.
description_zh: 把导入的新闻或订阅条目整理成日报或周报时使用：按固定标准盲评打分，选出最重要的条目，摘要与导语不得加入条目里没有的名字或数字。
category: research
applies: research,writing
version: 1
attribution: Scoring rubric adapted from AIHOT (MIT, Copyright 2026 数字生命卡兹克); modified for AwwO
---
# Trend digest

Input: feed items or pages from the knowledge base (title, link, date, summary or text). Output: a digest a busy reader can scan in two minutes, where every line can be traced to an item.

## 1. Clean the list

- Merge items that report the same event; keep the most direct source and list the others as "also reported by".
- A date more than an hour in the future is not trusted; an item first seen long after its publication date is backfill and does not count as news for this period.
- Drop pure marketing, job posts and duplicates of earlier digests.

## 2. Classify and score each item blind

Judge the content, not the outlet's fame. Classify the item, rate five axes from 0 to 10, and weight them (each row sums to 10):

| Type | Significance | New information | Evidence | Reach | Usefulness now |
| --- | --- | --- | --- | --- | --- |
| Model release | 3 | 2 | 2 | 2 | 1 |
| Product launch | 2 | 2 | 1 | 2 | 3 |
| Tool or technique | 1 | 2 | 1 | 2 | 4 |
| Research paper | 5 | 3 | 1 | 0 | 1 |
| Industry event | 3 | 1 | 2 | 4 | 0 |
| Opinion or analysis | 1 | 3 | 1 | 4 | 1 |
| Tutorial | 1 | 1 | 1 | 3 | 4 |

Score = Σ(axis × weight), out of 100. Caps: a customer case study or routine release has significance at most 3–4; marketing at most 2; a teaser has new information at most 3 and evidence at most 4; a title that oversells its body scores at most 30.

## 3. Select

Keep items scoring at least about 65 for first-party sources and 75 for second-hand reporting, at most two lead items from one source, about 8–12 main entries per digest; put the rest worth keeping as one-line flashes.

## 4. Write

- Each main entry: a plain title, 2–3 sentences (what happened, why it matters, what is still unknown), the link.
- Flashes: one line each with the link.
- The overview at the top: 2–4 sentences. It may only mention names, figures and products that appear in the entries below it.
- No hype words ("revolutionary", "game-changing"), no invented context, relative dates copied as written.

## Checklist

- Every entry links to its item; every number appears in that item.
- The overview introduces nothing new.
- Duplicates are merged and backfill is marked.
- Scores are shown in an appendix table so a reader can audit the selection.
