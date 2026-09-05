# Capability Atlas Scan Notes

Data-quality warnings captured during the 2026-06-10 source scan that produced
`capability_atlas.json` v1.0.0. Re-verify these when regenerating the atlas.

> **2026-06-10 resolution pass.** The gap units below were located against the
> Arxchibobo GitHub account; see [declared-skill-sources.md](declared-skill-sources.md)
> for the full mapping. 22 units were resolved to real repos and re-graded from
> `declared`/empty-`vendored` to `availability: external` with a corrected
> `source_url` (17 dedicated repos + 5 in `gtm-claw-capability`). The three empty
> orphan submodules with no GitHub source found — `comfyui-skill-openclaw`,
> `infographic-skill`, `slides` — were honestly downgraded from `vendored` to
> `declared`. The remaining 52 declared units exist only as git symlinks to the
> OpenClaw host's `company-skills/` workspace and stay `declared` until exported
> from that host.

- 18 of 62 skill directories in the vendored clone (C:\Users\Administrator\AppData\Local\Temp\openclaw-arxchibo-latest\skills) are completely empty: adversarial-verification, away-summary, buddy-pet, clawsec-suite, comfyui-skill-openclaw, context-budget-analyzer, context-compressor, designclaw, github-explorer, html-ppt, infographic-skill, lightweight-explorer, self-rationalization-guard, skill-auto-improver, slides, team-tasks, undercover-mode, worker-prompt-craft. GitHub API confirms they are orphan git submodules (type 'submodule' with null submodule_git_url, no .gitmodules entry), so their SKILL.md could not be read; entries for them are best-effort inferences from directory names and workspace context.
- Lowest-confidence inferred entries: buddy-pet, undercover-mode, lightweight-explorer, designclaw, away-summary — descriptions/triggers/categories are guesses from the name only and should be re-verified once the submodules are restored.
- Some frontmatter 'name' fields differ from directory names and were kept as the entry name: openclaw-backup -> myclaw-backup, pexoai-agent -> pexo-agent, pua-skill -> pua, scrapling -> scrapling-official, runninghub-skills -> runninghub, proactive-self-improving -> proactive-self-improving-agent, uzi-* -> deep-analysis/investor-panel/lhb-analyzer/trap-detector. hyperframes-gsap and hyperframes-tailwind declare generic names ('gsap', 'tailwind'); the directory-based names were used instead for disambiguation.
- diandian-aso, grok-api, html-artifacts, ios-growth, and the mp-* skills have no YAML frontmatter (plain markdown headers only); descriptions were derived from their body text.
- plugin-eval (E:\Bobo's Coding cache\bo-work\agents\plugins\plugin-eval\.claude-plugin\plugin.json) has no description or author field — only name and version 0.1.1. Description in catalog entry is best-effort inferred from the plugin name.
- 3 of the 14 declared skills (acp-router, clawflow, clawflow-inbox-triage) are not present in the local node_modules skills directory; entries for them are best-effort with availability 'declared'.
- The local openclaw skills directory contains ~53 skill folders beyond the 14 canonical ones (e.g. discord, obsidian, spotify-player); per task scope only the declared 14 were cataloged.
- ljg-x-download was NOT found in lijigang/ljg-skills (enumerated skills/ directory on master branch, 21 dirs). Emitted a best-effort entry assuming an X/Twitter content downloader; it may have been removed or renamed upstream.
- ljg-skills contains 21 skills, not the expected 15. Added 8 skills beyond the caller's expected list: ljg-book, ljg-paper-river, ljg-present, ljg-push, ljg-qa, ljg-read, ljg-relationship, ljg-think. README also notes ljg-paper-flow and ljg-word-flow are workflow-type skills.
- mempalace is cataloged as external per instructions, but mcp__mempalace__* MCP tools are actually connected in the current environment — effective availability may be local/connected.
- stitch-design is cataloged as an external service per instructions, but mcp__stitch__* MCP tools are connected in the current environment — effective availability may be local/connected.
- lanbow.com entry is based solely on its public marketing site; no GitHub or technical docs were found to verify capabilities.
- Gap count is 56, well above the 25-35 estimate in the brief: section 三 declares 90 skills, only 34 exist as directories in the clone (C:\Users\Administrator\AppData\Local\Temp\openclaw-arxchibo-latest\skills).
- 55 of the 56 gap skills exist in the clone only as broken Unix symlink placeholder files (plain text pointing to /home/lobster/.openclaw/workspace/company-skills/<name>); skill content is not in the repo, so all are emitted as availability=declared.
- hermes-openai-codex-provider has neither a directory nor a symlink placeholder in the clone — fully absent despite being declared and linked.
- google-workspace and semrush (flagged 'check carefully' in the brief) DO exist as real directories in the clone and were therefore excluded from the gap list.
- Descriptions are inferred from terse Chinese 说明 entries (often 2-4 characters, e.g. 'ccp = 内部协议', 'qa-auth = QA 认证'); details such as exact scope and category for ambiguous skills (ccp, qa-auth, star-office, groupmind) are best-effort inferences.
