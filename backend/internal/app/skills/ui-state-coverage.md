---
name: ui-state-coverage
title: UI states and the accessibility floor: loading, empty, error, edge
title_zh: 界面状态与无障碍底线：加载、空白、出错与极端情况
description: Use when a page, app prototype, dashboard, form or list shows data or takes input: the five states every surface must draw, how empty and error states are written, loading thresholds, form timing, focus and announcement rules, and the accessibility floor (contrast, target size, labels, keyboard, landmarks).
description_zh: 页面、应用原型、仪表盘、表单或列表需要展示数据或接收输入时使用：每个界面必须画出的五种状态、空白与出错状态的写法、加载时长阈值、表单校验时机、焦点与读屏播报规则，以及无障碍底线（对比度、点击区域、标签、键盘、页面地标）。
category: design
applies: html,design,code
version: 1
attribution: Adapted from open-design (Apache-2.0, Copyright 2026 Open Design contributors); modified for AwwO
---
# UI states and the accessibility floor

The most common silent failure of generated interfaces is drawing only the full, happy state.

## Five states for every surface that loads, filters or accepts data

| State | When | Must contain |
| --- | --- | --- |
| Loading | data in flight | a skeleton shaped like the result, or a labelled spinner; after 15 s, "taking longer than expected" |
| Empty | nothing yet, or a query found nothing | a headline, one plain sentence, one primary action |
| Error | a request or a check failed | what happened, why if known, what to do now; the user's input kept |
| Populated | the normal case | the state you drew first |
| Edge | huge counts, 200-character titles, missing optional fields, long words, mixed scripts | a layout that does not break |

A page with no backend still makes the states reachable: sample data with an empty list and a failed item, or a small state switch. Never fake success: a button that saves changes real page state. Edge cases to draw: 10,000 table rows (paged or virtual) sorted and filtered, a 200-character title with no avatar, every optional field empty and every required one at its maximum length, a one-character search and one with over 1,000 results.

## Empty and error states

- First use: a headline, the value in one sentence, the primary action. No results: repeat the query and suggest alternatives. Cleared: a short confirmation and the next action. An error is never drawn as empty.
- Every error answers, in order: what happened ("Your card was declined", never "Something went wrong"), why if knowable, and what the user can do (retry, another path, help).
- Match its scope: a field (red border, message beneath, focus moves there), a form (a summary at the top plus marks on each field), a section (an inline panel with retry; the rest keeps working), the page, the app (a banner that stays).
- Retry at once on the first click, then after 2, 4 and 8 s, showing when the last attempt was; after 3 failures offer help with an error code the user can copy.

## Loading thresholds

Under 300 ms show nothing; up to 2 s a subtle spinner or skeleton; up to 10 s a skeleton of the layout or a labelled spinner ("Loading payments"); up to 60 s a progress bar with Cancel; past 60 s stop the animation and show an error with retry, cancel or continue. Every request has a timeout, no spinner runs for ever, and only the section that is fetching shows loading.

## Forms

- Check a field when it is left, not at the first keystroke; once left, re-check it as the user types, and remove the error the moment it is fixed.
- On submit the button shows it is working and the fields lock against a second submit; a failed submit keeps every value.
- Every input has a visible label (a placeholder is not a label), `aria-describedby` pointing at its hint and its error, and `aria-invalid` while it is wrong. Never ask twice in one flow for what the user already entered.

## Announcements and focus

An error on submit: `role="alert"` on the message, focus to the first invalid field. A quiet confirmation or "loading": `role="status"`, focus stays put. A destructive confirmation: `role="alertdialog"`, focus into it. The live region exists in the page before text goes into it. Toasts always appear in one place, pause while hovered or focused, and colour is never the only signal: add an icon or words.

## Accessibility floor (WCAG 2.2 AA)

- Contrast, inclusive: text 4.5:1; large text (24 px, or 19 px bold) 3:1; controls, chart marks and focus indicators 3:1.
- Targets at least 24 x 24 px, and 44 px for primary touch actions.
- Never `outline: none` without a replacement; use `:focus-visible`.
- `<button>` for actions and `<a href>` for navigation, never a `div` with a click handler; no positive `tabindex`.
- `<html lang>` set (`zh-CN` for Chinese pages); `header`, `nav`, `main`, `footer`; one `h1`, no levels skipped.
- `alt` on content images, `alt=""` on decorative ones, `aria-label` on icon-only buttons, a text summary beside every chart.
- Focus stays inside an open dialog; Escape closes it and returns focus to what opened it.

## Checklist

1. Every list, table, card, form and panel can show all five states.
2. Every error says what, why and what next, and keeps the input.
3. Labels, focus rings, a keyboard path, `lang` and landmarks are in place.
