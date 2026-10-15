---
name: product-spec
title: Product spec from a vague request
title_zh: 把模糊需求写成产品规格
description: Use when a request is vague and a node must turn it into a buildable specification: goal, users, scope and non-goals, numbered requirements with acceptance criteria, constraints, risks, assumptions and open questions.
description_zh: 需求模糊、需要整理成可执行的产品规格时使用：目标、用户、范围与不做的事、带验收标准的编号需求、约束、风险、假设和待确认问题。
category: business
applies: plan,writing
version: 1
attribution:
---
# Product spec

A spec is good when two different teams would build the same thing from it. Replace every adjective you can with a number, a list or an example.

## Structure

1. **Goal** — one sentence: who gets what outcome, and how we will know.
2. **Users and situations** — the two or three main users, what they are trying to do, where and on what device.
3. **Scope** — what is in this version.
4. **Non-goals** — what is explicitly out, so nobody builds it by accident.
5. **Requirements** — numbered, one behaviour each:

   | ID | Requirement | Acceptance criterion | Priority |
   | --- | --- | --- | --- |
   | R1 | The user can export a report as PDF | Export of a 20-page report finishes in under 10 s and opens in common viewers | Must |

   Priorities: Must, Should, Could. Each acceptance criterion is something a tester can check with a yes or no.
6. **Constraints** — platforms, budgets, deadlines, regulations, existing systems that must not change.
7. **Data** — what is stored, for how long, who can see it.
8. **Risks** — what could make this fail, with a mitigation each.
9. **Assumptions** — what you assumed because the request did not say; mark each so someone can confirm it.
10. **Open questions** — what only the requester can answer, phrased so a one-line reply settles it.

## Rules

- Do not invent facts about the business (prices, user counts, legal requirements); write them as assumptions or questions.
- Keep the user's own words for names and terms; define new terms once.
- If the request is too large, propose a first version and list the rest as later phases.
- Exactly, at least and at most are different requirements; keep the one the requester stated.

## Checklist

- Every requirement has a testable acceptance criterion.
- Non-goals exist.
- Assumptions and open questions are separated and short.
