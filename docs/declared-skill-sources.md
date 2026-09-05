# Declared Skill Source Resolution

Where the 74 capability-atlas gap units (the `declared` skills + the empty orphan submodules) actually live, resolved against the **Arxchibobo** GitHub account on 2026-06-10.

Method: name-variant match across 152 repos + git-tree inspection. The placeholders in `openclaw-arxchibo/skills/<name>` are git symlinks (mode 120000) pointing at `/home/lobster/.openclaw/workspace/company-skills/<name>` on the OpenClaw runtime host.

## A. Resolved — dedicated repo (17)

Real content lives in its own repo; can be re-vendored directly.

| skill | source repo |
|---|---|
| `adversarial-verification` | [Arxchibobo/adversarial-verification](https://github.com/Arxchibobo/adversarial-verification) |
| `away-summary` | [Arxchibobo/openclaw-away-summary](https://github.com/Arxchibobo/openclaw-away-summary) |
| `buddy-pet` | [Arxchibobo/openclaw-buddy-pet](https://github.com/Arxchibobo/openclaw-buddy-pet) |
| `clawsec-suite` | [Arxchibobo/openclaw-clawsec-suite](https://github.com/Arxchibobo/openclaw-clawsec-suite) |
| `context-budget-analyzer` | [Arxchibobo/context-budget-analyzer](https://github.com/Arxchibobo/context-budget-analyzer) |
| `context-compressor` | [Arxchibobo/context-compressor](https://github.com/Arxchibobo/context-compressor) |
| `designclaw` | [Arxchibobo/openclaw-designclaw](https://github.com/Arxchibobo/openclaw-designclaw) |
| `github-explorer` | [Arxchibobo/openclaw-github-explorer](https://github.com/Arxchibobo/openclaw-github-explorer) |
| `html-ppt` | [Arxchibobo/html-ppt-skill](https://github.com/Arxchibobo/html-ppt-skill) |
| `lightweight-explorer` | [Arxchibobo/lightweight-explorer](https://github.com/Arxchibobo/lightweight-explorer) |
| `self-rationalization-guard` | [Arxchibobo/self-rationalization-guard](https://github.com/Arxchibobo/self-rationalization-guard) |
| `skill-auto-improver` | [Arxchibobo/openclaw-skill-auto-improver](https://github.com/Arxchibobo/openclaw-skill-auto-improver) |
| `star-office` | [Arxchibobo/Star-Office-UI](https://github.com/Arxchibobo/Star-Office-UI) |
| `structured-decision-alignment` | [Arxchibobo/openclaw-structured-decision-alignment](https://github.com/Arxchibobo/openclaw-structured-decision-alignment) |
| `team-tasks` | [Arxchibobo/openclaw-team-tasks](https://github.com/Arxchibobo/openclaw-team-tasks) |
| `undercover-mode` | [Arxchibobo/openclaw-undercover-mode](https://github.com/Arxchibobo/openclaw-undercover-mode) |
| `worker-prompt-craft` | [Arxchibobo/worker-prompt-craft](https://github.com/Arxchibobo/worker-prompt-craft) |

## B. Resolved — aggregate repo (5)

| skill | source repo |
|---|---|
| `gtm-asc-auto-recovery` | [Arxchibobo/gtm-claw-capability](https://github.com/Arxchibobo/gtm-claw-capability) |
| `gtm-bot-selection` | [Arxchibobo/gtm-claw-capability](https://github.com/Arxchibobo/gtm-claw-capability) |
| `gtm-image-gen` | [Arxchibobo/gtm-claw-capability](https://github.com/Arxchibobo/gtm-claw-capability) |
| `gtm-indexing-checker` | [Arxchibobo/gtm-claw-capability](https://github.com/Arxchibobo/gtm-claw-capability) |
| `gtm-noindex-monitor` | [Arxchibobo/gtm-claw-capability](https://github.com/Arxchibobo/gtm-claw-capability) |

## C. Unresolved on GitHub (52)

Present in `openclaw-arxchibo` only as a git symlink to the runtime host's `company-skills/` workspace (or as an empty submodule pointer). No real content exists in any Arxchibobo GitHub repo — the source is on the OpenClaw server, not pushed. To recover: pull from `/home/lobster/.openclaw/workspace/company-skills/<name>` on that host and vendor it in.

- `apify`
- `approval-flow`
- `appsflyer`
- `appstore-connect`
- `backend-organics-coding-workflow`
- `base44`
- `bot-monitor`
- `bottleneck-reporting`
- `browser-cdp`
- `ccp`
- `cms-landing-page-optimizer`
- `coding-workflow`
- `comfyui-skill-openclaw`
- `cron-scripts`
- `deep-research`
- `figma-mcp`
- `finance-dashboard`
- `github-cli`
- `glm`
- `goal-ops-self-remind`
- `goal-participant`
- `groupmind`
- `guance`
- `hermes-openai-codex-provider`
- `heygen`
- `honeycomb`
- `image-uploader`
- `infographic-skill`
- `modal`
- `myshell-image-gen`
- `mysql`
- `non-blocking-wait`
- `notion-image-bots`
- `notion-standup`
- `notion-task-sync`
- `pm-agent-loop`
- `proactive-task-engine`
- `prod-release-ci`
- `qa-auth`
- `quick-data-dashboard`
- `remotion-gpu`
- `s3-file`
- `self-improving`
- `skill-contribution`
- `slack-canvas`
- `slack-todo-agent`
- `slides`
- `task-autopilot`
- `tg-automation`
- `topic-page-optimizer`
- `user-profile-query`
- `weekly-report`

---
**Totals:** 17 dedicated-repo + 5 aggregate + 52 unresolved = 74 units.
