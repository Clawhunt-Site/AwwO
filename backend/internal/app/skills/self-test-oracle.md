---
name: self-test-oracle
title: Self-test with planted failures
title_zh: 带植入缺陷的自测
description: When a page or program must prove that it works: give it a self-test that runs its real acceptance checks and also plants known-wrong variants the checks must reject; in the sandbox computer, run the page with awwo-check-page and fix what fails before delivering.
description_zh: 页面或程序需要证明自己可用时使用：内置自测运行真实验收检查，同时植入已知错误的变体，要求检查把它们识别出来；在沙箱电脑里用 awwo-check-page 实际运行页面，修好失败项再交付。
category: engineering
applies: code,review,html
version: 2
attribution:
---
# Self-test with planted failures

A test that has never failed proves nothing. Each check is paired with a planted failure, a deliberately wrong variant of the code it guards. The suite is trusted only when every real test passes and every plant is caught.

## The protocol

The page defines one async function:

```
window.awwoSelfTest = async () => ({
  tests: [{ name, ok, detail }],
  planted: [{ name, rejected, detail }],
});
```

- `tests`: every acceptance check, run against the real code with real inputs. `ok` is true only when the check's own assertion held. `detail` says what was compared, in under 200 characters.
- `planted`: for each plant, swap in the wrong variant, run the checks meant to catch it, restore the original, and set `rejected: true` only when at least one of those checks failed. Restore even when a check throws.
- The whole run finishes within 60 seconds, makes no network request and leaves the page as it found it.
- A visible self-test panel (a button or a key) shows people the same results: passed tests and caught plants in green, the rest in red, the counts on top.

## Choosing plants

Plant the mistakes a real builder makes, one in each area that matters: an off-by-one in a loop bound, a swapped sign or operand in a formula, a missing clamp, an undo that forgets one field, a handler attached twice, state not reset for a new document. Use three to six plants, each named after its mistake.

## In the sandbox computer

Where the sandbox instructions name `awwo-check-page`:

1. Run `awwo-check-page page.html --out check` on the page (yours or from /inputs).
2. Read `check/report.json`: its `verdict`, `reasons` and `heldClock` (see the sandbox instructions), page errors, self-test results, plants caught, blank flag.
3. Fix the cause of each failure and any `heldClock.note` in the source, rebuild the page and check again. Stop at verdict `pass` with no note, when the budget runs short, or at a second `error` or a second `unfinished`.
4. Publish the final page; report its last check as below.

Otherwise, write the self-test and say plainly what has not been run.

## Reporting

State only what a report or the inputs show: its numbers exactly, and any failure, `heldClock.note` or `unfinished` left. "Verdict pass: 12/12 tests passed, 4/4 plants caught, 0 page errors, not blank (awwo-check-page)" is a result; "the tests should pass" is not.

## Checklist

- Each plant names the test that catches it, and the suite restores every plant.
- The panel and `awwoSelfTest` report the same numbers.
