---
name: handoff-summary
title: Handoff summary for the next node
title_zh: 交接摘要：交给下一个节点
description: Use when a node's output is mainly a summary another node or person will continue from: a fixed structure of goal, constraints, progress, decisions, next steps and critical context that keeps exact names, numbers and errors.
description_zh: 节点产出主要是给下一个节点或人员接手的摘要时使用：按固定结构写目标、约束、进展、决定、下一步和关键上下文，原样保留名称、数字和报错。
category: writing
applies: plan,writing
version: 1
attribution: Structure adapted from the Pi coding agent's session summary format (MIT); modified for AwwO
---
# Handoff summary

Whoever reads this has none of your context. Write so they can continue without asking you anything.

## Structure (use these headings)

## Goal
What is being achieved and for whom, in one or two sentences.

## Constraints & preferences
Requirements, limits and preferences that must keep holding (budget, deadline, style, "exactly 5 items", "no external services").

## Progress
- Done: what is finished, with where to find it.
- In progress: what is partly done and its exact state.
- Blocked: what cannot proceed and what it waits for.

## Key decisions
Each decision with its reason, so it is not reopened by accident.

## Next steps
Numbered, in order, each concrete enough to start immediately.

## Critical context
Facts the next person must not lose: exact names, identifiers, file or field names, numbers, links, error messages copied verbatim, open risks.

## Rules

- Preserve exact names, numbers, paths and error messages; never paraphrase them.
- Prefer lists to prose; no greetings, no recap of the conversation itself.
- Separate facts from guesses; label guesses.
- If something is unknown, say "unknown" instead of leaving it out.
- Keep it short: as long as needed for someone to continue, and no longer.
