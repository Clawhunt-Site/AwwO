---
name: before-you-build
title: Before You Build
title_zh: 动手之前的风险评估
description: Before building an MVP, landing page, SaaS product, agent workflow or major feature: give a risk verdict, name the riskiest assumption, the smallest validation step and what to delay.
description_zh: 在开发 MVP、落地页、SaaS 产品、智能体工作流或重要功能之前使用：给出风险结论，指出最可能出错的假设、最小的验证步骤和应暂缓的部分。
category: business
applies: plan,review
version: 1
attribution: From wshobson/agents@7257c27 (MIT, Copyright (c) 2024 Seth Hobson); author bin1874; trimmed for AwwO
---
# Before You Build

Run a compact pre-mortem before implementation. The goal is not to block building; it is to identify the highest-risk assumption, the smallest validation step, and the build scope that should be delayed until evidence improves.

## When To Use

Use this skill when a user asks to build or ship:

- A new product, MVP, prototype, landing page, SaaS app, marketplace, content site, agent workflow, or internal tool
- A major feature with unclear adoption, revenue, retention, trust, or distribution impact
- A public launch asset where weak positioning could waste development or promotion effort

Skip this skill when the task is a narrow implementation fix, refactor, test repair, dependency update, or already-validated change with clear acceptance criteria.

## Risk Checklist

Review the idea across these risks:

- **Demand:** Is there evidence that a specific buyer or user urgently wants this?
- **Positioning:** Can the target user understand what it is and why it matters in one sentence?
- **Monetization:** Is there a credible path to payment, budget, or strategic value?
- **Retention:** Is there a reason users would return after the first try?
- **Trust:** Does the product require credibility, data access, integrations, or behavior change that users may resist?
- **Distribution:** Is there a repeatable way to reach the target user?
- **Feature adoption:** For feature work, will the feature change user behavior or just add surface area?

## Output Format

Keep the response short and decision-oriented:

1. **Risk verdict:** Low, medium, or high risk, with one sentence explaining why.
2. **Main assumption:** The single assumption most likely to break the project.
3. **Evidence to find first:** The smallest useful signal before building more.
4. **Do next:** One concrete validation step or reduced build scope.
5. **Delay:** What not to build yet.

## Guidance

- Be direct about weak evidence, but avoid dismissing the user's idea.
- Prefer smaller validation steps over large research plans.
- Separate product risk from engineering difficulty.
- If the idea is already validated, say what evidence makes it lower risk and suggest the smallest implementation slice.
- If facts are missing, name the missing evidence instead of inventing market claims.

# Risk Checklist

Use these questions when the basic verdict is not obvious.

## Demand

- Who has the painful problem today?
- What workaround are they using now?
- What behavior shows urgency: payment, repeated manual work, switching tools, or asking for the same outcome more than once?

## Positioning

- Can the target user say what this is for without hearing the implementation details?
- Is the promise tied to a concrete outcome rather than a broad category?
- Does the idea have a clear alternative it must beat?

## Monetization

- Who controls the budget or time savings?
- Is the value large enough to support the required build and maintenance cost?
- Would the first useful version create enough value to justify payment, adoption, or internal sponsorship?

## Retention

- What makes the product useful after the first session?
- Does it create a saved workflow, history, collaboration loop, or recurring decision?
- Would users remember to come back without reminders?

## Trust

- What data, permissions, integrations, or behavior changes does this require?
- What proof would make a cautious user comfortable trying it?
- What failure would make the product feel unsafe or unserious?

## Distribution

- Where can the exact target user be reached repeatedly?
- What existing channel, community, workflow, or integration can expose the product?
- Is there a realistic path beyond one launch post?

## Feature Adoption

- What existing user behavior will this feature change?
- Is the feature tied to an active user pain or just a product idea?
- Can adoption be measured with one clear event?
