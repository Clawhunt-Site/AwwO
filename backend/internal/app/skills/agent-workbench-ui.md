---
name: agent-workbench-ui
title: Agent workbench UI: live runs, tool steps, approvals, trees, traces and changes
title_zh: Agent 工作台界面：实时运行、工具步骤、审批、调用树、追踪与改动
description: Use when a page, prototype or dashboard shows AI agents at work: the live status line of a run, tool calls collapsed into one summary, questions and approval cards, an orchestrator's tree of sub-agents with time and cost, lanes and traces, diffs and an undoable record of changes, background task notices, context and budget gauges, editable plans, with the states each needs and a calm visual system that keeps colour and motion for feedback.
description_zh: 页面、原型或仪表盘需要展示 AI Agent 工作过程时使用：一次运行的实时状态行、折叠成一行摘要的工具调用、提问与审批卡片、编排者与子 Agent 的树（含耗时与成本）、泳道与追踪、改动对比与可撤销的变更记录、后台任务通知、上下文与预算用量、可编辑的计划；写明每种组件需要的状态，以及把颜色和动效只留给反馈的克制视觉体系。
category: design
applies: html,design
version: 1
attribution:
---
# Agent workbench UI

Someone watching agents wants three answers: what is happening now, what has already happened, and what is waiting on them. Each component below answers one of those. Use the run data the inputs give; where there is none, build the view on sample runs and mark the whole view as sample data.

## A calm system

- Neutral surfaces and one accent; layers told apart by depth (panel, card, popover), not by hue. Colour and motion go only to state.
- One status vocabulary, each with a colour and always a word or icon beside it: running (the accent), needs you (amber, the loudest thing on screen), failed (red), done (a quiet green), queued and stopped (muted). Use the `--warn`, `--danger` and `--success` tokens where they are bound. Nothing is shown by colour or motion alone.
- Fold with `details` and `summary`, which open with no script, or a button carrying `aria-expanded`.
- Figures in a mono face with tabular numerals: `4.2s`, `1m 08s`, `86.3k tokens`, `$0.042`. Times are relative while live (`12s ago`) and exact in the trace or on hover.

## Components

**Status line.** The last line of a running turn: an activity mark, what is happening in words ("Running tests", "Reading 3 files"), elapsed time and output so far. Timing starts when the request leaves but no number shows before the first second. Each activity has its own movement (thinking turns in a circle, searching spreads outward, running travels a loop, writing steps along a row); when the activity changes, the mark travels into its next shape instead of cutting. On a long run it rests a few seconds in each shape between moves, so nothing moves without pause. With reduced motion the mark stays still and the words say the state.

**Tool steps.** A batch of calls collapsed into one summary ("Read 4 files, ran the tests, edited 2 files", with the total time) that expands to a row per call. Label a row with the outcome in plain words ("Read config.yaml", "Tests: 12 passed"), not a tool name with arguments. A row holds status, label and duration, and opens to its input, its output (20 lines, then "show all") or its diff. A failed row starts open and puts its error's first line in the summary.

**Questions and approvals.** A decision handed to the person: which agent asks, what exactly will happen (the command, the recipients, the diff), why, and a risk level with its reason. Two to four choices as buttons, the safe one first. Keys work only while the card has focus, and no single key approves a high-risk action. A card that times out says what happens at zero (normally nothing is done), and its countdown stops while the card is hovered or focused. Once answered, the card shrinks to a one-line record ("You approved, 14:02: send 3 emails") with nothing left to press. Several waiting: a stack, the one due now on top, the rest counted.

**Agent tree.** Which agent launched which: the lead agent and every sub-agent it started, each card with status, current step, time and cost; costs add up each branch; a finished branch closes to one line; the path down to anything needing a person stays open and marked.

**Lanes and trace.** A lane per agent on one time axis, tasks as bars growing up to a "now" line, hand-offs as arrows labelled with what was passed on, approvals sitting on the bar they paused. The trace nests spans with start offset and duration; choosing one shows what went in and what came out.

**Changes.** A diff marks added and removed lines with a sign as well as a tint, keeps line numbers and the file name as a header, and closes unchanged runs ("12 unchanged lines"). A record of what agents changed in outside systems gives each row its old and new value, with an undo that first says what else it would undo and what can no longer be undone.

**Background work.** When a task finishes away from the conversation, a notice: a dot for the outcome, one line naming the task, a short note ("ran 18s, 3 files"). An inbox lists all tasks with filter tabs and live counts; a row opens to its last steps with Approve, Retry or Open.

**Limits.** Context in use as a ring or bar with its number: the accent while there is room, amber from 70%, red from 90%; opened, it shows what is filling it. Budgets and rate limits follow the same pattern.

**Plans and steering.** A plan shown before it runs, whose steps the person may rename, reorder, remove or add; then each step runs with its timer, and a failure can be retried from that step. A note written mid-run waits in a queue and joins the plan at the moment the agent takes it up; interrupting now is a separate control.

## States to build

For each component: empty (nothing has run, plus one line on how to start), loading, live, waiting on a person, failed (the error and a retry), done, and oversized (a 200-step run, a 5,000-line diff, a tree of 40 agents) still readable. Streaming text holds its place: reserve the line height so nothing below it jumps.

## Before you hand over

1. Every screen answers now, before and waiting-on-you, and waiting-on-you is the loudest.
2. Every state has words as well as colour or motion; reduced motion keeps each one readable.
3. Steps say what they did, approvals spell out their effect, and long runs, diffs and trees fold.
4. Figures come from the inputs, or sit in a view plainly marked as sample data.
