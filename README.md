# AwwO

AwwO 是以独立 Agent Session 为节点的协作画布。用户先描述目标，由 AI 规划节点、输入输出表单与连接；随后既可以通过对话调整画布，也可以人工编辑结构。每个节点内包含 Session 管理、对话与交付物，画布默认以紧凑卡片展示，展开一个节点进入工作台。

当前已发布版本：**0.3.0**（见 `VERSION`）。主仓库：[ClawHunt-Store/AwwO](https://git.clawhunt.store/ClawHunt-Store/AwwO)。Go + Pi SaaS 建设在独立功能分支上进行。

## Go 多运行时多租户 SaaS

新增的 SaaS 入口复用本项目画布，由 Go API 管理身份、租户成员、画布、Agent、持久会话、运行事件与平台后台，PostgreSQL 存储业务数据，Pi 与可选 OpenAI Agents JS worker 提供独立进程中的模型执行。节点和每位成员可选择运行时；1–8 位 Agent 可按顺序、并行汇总、多轮讨论或审核返工协作。Go 持久调度整图，关闭网页后继续执行。

```sh
npm run setup:saas
npm run dev:saas
```

本地用户入口 `http://127.0.0.1:5189/`，平台管理入口 `/admin`。需要 Node >=22.19、Go 自动工具链和 PostgreSQL 工具。首次启动生成独立的本地数据库与管理员配置；秘密保存在忽略的 `.local/awwo-saas/.env`。模型需配置服务端提供商，未配置时可使用账号和画布功能。

[OpenAI Agents JS 运行时](docs/awwo-openai-agents-runtime.md) · [节点团队架构与 API](docs/awwo-node-teams.md) · [架构与实施路线](docs/awwo-saas-architecture.md) · [设计与开发规范](docs/awwo-saas-design-standards.md) · [前端逐项对接清单](docs/awwo-saas-frontend-contract.md) · [API 契约](docs/awwo-saas-api.md) · [启动与部署](docs/awwo-saas-development.md) · [实际验收记录](docs/awwo-saas-verification.md)

这是本地 SaaS 基础版本，公网发布、付费、邮件、工程执行沙箱与分布式高可用调度的后续范围在架构文档中列明。

## 原本地 Codex 模式

需要 Node.js 22.13+（22.x）或 24+、npm、pnpm 9.15.4，以及可运行的本地 Codex CLI。首次安装和启动：

```sh
npm run setup
npm run dev
```

启动入口使用当前仓库的代码，默认仅监听本机；运行数据与运行时秘密保存在未入库的 `.local/awwo/`。启动不会自动执行 Agent。具体端口、依赖、环境配置与故障排查见 [本地开发指南](docs/awwo-development.md)。

打开画布后可以描述一个项目需求，再为节点选择并绑定真实 Agent。Codex 使用本机已有登录，每个 Agent 有独立工作目录，节点连接通过明确的输入/输出字段传递数据。生成后的图支持人工调整，交付物以富文本表单管理。

## 本版内容

- 七种个性化 Agent 模板：自定义、前端、后端、数据治理、用户系统、物料和交付验收。
- 对话规划、画布操作校验、节点编辑、连线、撤销、布局与输入输出契约。
- 独立 Session、新建/恢复会话、真实 Codex 绑定、图运行与上游结果传递。
- Codex 流式输出解析、完整结果校验、阻塞依赖提示及受控恢复。
- [真实运行验证](docs/superpowers/2026-09-05-awwo-codex-live-verification.md)：七节点执行成功，十二条输入匹配，修复返工与原 Session 复验通过。
- [知识库示例](examples/knowledge-workbench/README.md)：真实 Agent 生成的可运行前端示例，附源代码、测试、契约和 Unicode 数据许可。

这是一版可本地开发与验证的 Agent 画布。知识库示例的登录与数据是演示实现，真实身份服务、业务后端接入和生产部署不属于这次通过结论。桌面与旧 Python/集成模块源码继续保留；未重新打包桌面安装器。

## 仓库与迭代

本次实际远端基线为 `main@6e1dc158a79e2f18c7bdf82610a353883b883f31`，没有 `dev` 分支；SaaS 改动位于独立 `feat/awwo-go-pi-saas` worktree。修改后执行相关检查并记录实际结果，合并须取得业主对确切源/目标分支及 SHA 的批准。版本说明见 [CHANGELOG](CHANGELOG.md)，迁移来源与首版验证见 [仓库说明](docs/awwo-repository.md)。凭据、数据库、依赖安装目录和本机日志不入库。

原有集成源码及说明保留在下面，作为继承功能的资料。Go/Pi SaaS 与原本地 Codex 模式分别使用本页前面的独立启动命令。第三方代码保留各自许可，见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)；本仓库没有为自有代码新增开源授权。

---

## SuperClaw 历史与兼容模块说明

SuperClaw is a productized end-to-end delivery agent for ClawHunt. It collects the useful harness, loop, payment, verification, and dialog patterns from the existing OpenClaw/ClawHunt ecosystem into one deployable service.

The first implementation target is a gray-rollout capable system:

- Python core harness with typed goals, task graphs, worker leases, evidence, and verdicts.
- FastAPI service exposing agent-card, A2A, run, evidence, ClawHunt submit, and adversarial verification endpoints.
- React/Vite workbench surface for goal intake, live runs, evidence, and human gates.
- CLI smoke path for local and CI verification, including idempotent adversarial checks with `superclaw verify <run_id>`.
- Worker backends for `local`, `codex`, `claude` (Claude Code CLI), `hermes` (Hermes CLI oneshot), `bobo` (Bobo autonomous engineering CLI), `gemini` (native Google Gemini agent loop), `openclaw` (OpenClaw-compatible CLI), `anthropic` (direct Anthropic Messages API, single-shot), and `anthropic-agent` (native Claude Opus 4.8 tool-using agent loop) execution behind one orchestrator/state/evidence layer. The default worker model is **Claude Opus 4.8** (`claude-opus-4-8`): the `claude` backend is the default and runs Claude Code at Opus 4.8, while the `anthropic` backend calls `claude-opus-4-8` directly (`ANTHROPIC_API_KEY`). The `anthropic-agent` backend is the dependency-light way to run **real execution at Opus 4.8 in a headless container**: it drives the Anthropic Messages API in a tool-using loop (`run_shell`, `write_file`, `read_file`, `list_files`) inside the sandboxed repo checkout via stdlib HTTP only — no Node/agent-CLI install — and is the recommended cloud engine backend (configure via `ANTHROPIC_API_KEY`, `SUPERCLAW_ANTHROPIC_AGENT_MODEL`, `SUPERCLAW_ANTHROPIC_BASE_URL`, `SUPERCLAW_ANTHROPIC_AGENT_MAX_ITERATIONS`, `SUPERCLAW_ANTHROPIC_AGENT_MAX_TOKENS`). The `bobo` backend drives the local Bobo CLI's autonomous `run` loop (`bobo --print --full-auto run …`) to land real changes. The `gemini` backend is a **self-contained, dependency-light** tool-using agent loop: it drives Google Gemini through its OpenAI-compatible Chat Completions endpoint and executes the model's `tool_calls` for real (`run_shell`, `write_file`, `read_file`, `list_files`) inside the sandboxed repo checkout until it calls `finish` or exhausts its iteration/time budget — enabling intelligent real execution with only a Gemini API key and **no Node/agent-CLI install** (ideal for headless containers / Cloud Run). Override models via `SUPERCLAW_CLAUDE_MODEL` / `SUPERCLAW_ANTHROPIC_MODEL`; override Hermes via `SUPERCLAW_HERMES_EXECUTABLE`, `SUPERCLAW_HERMES_MODEL`, `SUPERCLAW_HERMES_PROVIDER`, `SUPERCLAW_HERMES_TOOLSETS`, and `SUPERCLAW_HERMES_SKILLS`; override Bobo via `SUPERCLAW_BOBO_EXECUTABLE`, `SUPERCLAW_BOBO_MODEL`, `SUPERCLAW_BOBO_EFFORT`, and `SUPERCLAW_BOBO_MAX_ITERATIONS`; configure Gemini via `SUPERCLAW_GEMINI_API_KEY` (or `GEMINI_API_KEY`), `SUPERCLAW_GEMINI_MODEL` (default `gemini-2.5-flash`), `SUPERCLAW_GEMINI_BASE_URL`, `SUPERCLAW_GEMINI_MAX_ITERATIONS`, and `SUPERCLAW_GEMINI_MAX_TOKENS`; override OpenClaw via `SUPERCLAW_OPENCLAW_EXECUTABLE`, `SUPERCLAW_OPENCLAW_ARGS`, and `SUPERCLAW_OPENCLAW_MODEL`.
- Session CLI parity layer: `superclaw chat`, `superclaw watch`, runtime inspection, permission policy normalization, and per-worker transcript artifacts.
- Harness portability layer adapted from `agents` and `claude-code/src`: capability matrix, task runtime profile, tool concurrency policy, and agent/skill degradation previews.
- Embedded capability atlas (`superclaw capabilities`, `/api/capabilities`): a typed catalog of 245 ecosystem capability units (self-built skills, vendored external skills, the wshobson plugin arsenal, OpenClaw built-ins, external tools/services) with provenance, trigger-based goal suggestions, availability-graded coverage reporting, and harness-adaptability flags. See `docs/capability-atlas.md`.
- Parallel subagent fan-out and dynamic orchestration: `spawn_child_runs` (and `superclaw fanout` / `POST /api/runs/{id}/fanout`) run child subagents concurrently and aggregate them by policy (`all_succeed`/`any_succeeds`/`best_effort`/`consensus`/`quorum`) with conflict detection and synthesized child evidence; `explore_fanout`/`review_consensus` topologies auto-expand a node into a subagent group; workers can grow the live task graph mid-run via discovered subtasks (`expand_task_graph` / `POST /api/runs/{id}/expand`).
- Async API/Web execution: `POST /api/runs` can return a queued run while workers continue in the background and stream live SSE events.
- Governed Pay-Switch hooks for health/config/payment-intent/human-gate status; payment is never part of the default run path.

## Local Run

```powershell
python -m pip install -e .
npm install --prefix apps/web
superclaw doctor
superclaw run --title "Local worker smoke" --description "Exercise local backend" --backend local --repo . --budget-seconds 30
superclaw run --title "Hermes worker smoke" --description "Exercise Hermes backend" --backend hermes --repo . --budget-seconds 60
superclaw run --title "OpenClaw worker smoke" --description "Exercise OpenClaw backend" --backend openclaw --repo . --budget-seconds 60
superclaw run --title "Explore fan-out" --description "Parallel exploration" --backend local --repo . --task-topology explore_fanout
superclaw fanout <run_id> --branches 3 --description "Investigate independently" --aggregation consensus
superclaw verify <run_id>
superclaw evidence <run_id>
superclaw events <run_id>
superclaw watch <run_id> --json
superclaw chat --message "Ship this goal" --backend local --repo . --json
superclaw models opencode            # REAL model catalog (live from the runtime; static hints are marked as such)
superclaw relay status               # clawwork relay-key chain state (always masked)
superclaw relay ensure-key           # auto-provision the device-scoped LLMgate key from the saved ClawHunt login
superclaw relay rotate-key           # rotate (new key first, old revoked server-side); recovery for lost plaintext
superclaw relay clear-key            # forget the locally cached relay key
superclaw runtime inspect
superclaw runtime compare
superclaw runtime context
superclaw runtime policy --permission-mode plan --allowed-tool Read --mcp-config .mcp.json
superclaw fusion status
superclaw fusion doctor --json
superclaw fusion start --profile all --execute --json
superclaw fusion test --profile all --json
superclaw appearance list-presets             # curated color-scheme presets + editable tokens (kernel contract)
superclaw appearance show --json              # active scheme + custom overrides (reads ~/.superclaw/appearance.json)
superclaw appearance set-preset emerald       # activate a preset (or 'custom' for your saved palette)
superclaw appearance set-color dark accent "#34d27f"   # set one custom token (switches scheme to 'custom')
superclaw appearance export theme.json        # export the active scheme + custom palette (importable bundle)
superclaw appearance import theme.json        # import a bundle (re-validated against the current preset catalog)
superclaw media doctor --live-metadata --json
superclaw media render text_to_image --prompt "studio product photo" --dry-run --run-id <run_id> --json
superclaw media render text_to_video --prompt "cinematic product launch reel" --input-json '{"duration":"4","size":"1280x720"}' --run-id <run_id> --json
superclaw validate --backends local,codex,claude,hermes,bobo,gemini,openclaw --repo . --budget-seconds 45 --fail-under 1.0
superclaw clawhunt capability-probe
superclaw capabilities summary
superclaw capabilities suggest "ship a payment webhook with idempotent capture"
superclaw capabilities coverage
superclaw capabilities adaptable --target codex
superclaw harness matrix
superclaw harness inventory "E:\Bobo's Coding cache\bo-work\agents"
superclaw harness adapt-agent path\to\agent.md --target codex --plugin demo
superclaw harness emit "E:\Bobo's Coding cache\bo-work\agents" .superclaw/generated-harness --target opencode --plugins agent-teams
superclaw harness validate .superclaw/generated-harness --target opencode
superclaw plugin import-skill path/to/SKILL.md --pack --dev-sign
superclaw plugin sync-skills --target codex --json
superclaw plugin uninstall com.example.tool --json
```

> **方向变更（2026-06-10）：Skill/Plugin 双轨拆分已拍板**，开发案见 `docs/clawwork-two-track-dev-plan.md`。目标语义：**Skill = 原生 markdown 工件**，导入后全文同步进各 runtime 原生 skill 目录，运行时零治理、零 MCP（治理只发生在分发/安装时：来源标识 + 一次性验签 + 分级标签 + executable 警告）；**Plugin = 受治理 MCP 能力**（签名 + 授权 + 撤销，未来登录态 + 加密分发）。PR‑2 foundation 已新增 native skill store/projection kernel；CLI/API alias and web surface remain follow-up work to avoid crossing integration streams.

`superclaw plugin import-skill` remains the legacy governed-plugin wrapper in this slice: it wraps a standard `SKILL.md` into a schema-valid `mcp_sidecar` plugin whose single tool returns the skill body through the SuperClaw MCP proxy. Native `superclaw skill import` is intentionally deferred to the CLI/API follow-up; the kernel foundation already provides `superclaw.skill_store.import_skill()`.

`superclaw plugin sync-skills` still projects installed, governed plugin skills as MCP proxy pointers and preserves the plugin runtime gate. In parallel, `superclaw.skill_sync.sync_native_skills()` copies native store entries as full `SKILL.md` + `assets/...` files with `tier="native"` ledger records, so proxy and native projections can coexist without widening plugin governance.

`superclaw fusion test` treats the native third-party report as a release gate: the report must include the current `source_fingerprint` for the imported upstream commits and required native command matrix, otherwise stale or legacy reports fail closed even if all recorded commands say `passed`.

Fusion action recording is fail-closed for active network intent. Known Osiris scanner tools, scan/probe/fingerprint aliases such as `nmap_scan`, and nested scan payload keys such as `scanType` or `targetPorts` require both a SuperClaw human gate and an approved permission result before any action artifact can be recorded.

Invalid fusion actions fail closed as structured API errors: `/api/fusion/actions` returns `FUSION_INVALID_ACTION` with a sanitized detail and writes no fusion artifact when a caller names an unknown imported component.

Fusion action artifacts are secret-safe across identifiers as well as payloads: artifact refs and permission result ids are checked with the canonical secret scanner before persistence, so token-shaped ids are replaced instead of landing in EvidenceBundle-linked JSON.

Fusion artifact downloads also require canonical artifact ids. `/api/fusion/artifacts/{artifact_id}` and EvidenceBundle-linked fusion artifact downloads reject noncanonical aliases instead of cleaning caller input into another persisted artifact.

Run artifact downloads are ownership-scoped: `/api/runs/{run_id}/artifacts/{artifact_id}` serves filesystem artifacts only from that run's artifact root, so a polluted EvidenceBundle cannot point the download endpoint at unrelated local files.

Eval artifact downloads use the same ownership rule: `/api/evals/{eval_id}/artifacts/{artifact_id}` serves report-listed files only from that eval directory, so a polluted eval report cannot point at unrelated local files.

`superclaw fusion start --execute` is the operator shortcut for the imported product stack. It runs `docker compose --profile <all|osiris|design|pencil> up --build -d` from the fusion root and reports a structured `started`, `failed`, `timeout`, `docker_unavailable`, or `compose_file_missing` result with command output redacted for secrets and local root paths.

## Plug-and-Play Eval App

Run the full local delivery-gap product with Docker:

```powershell
docker compose up --build
```

Open `http://127.0.0.1:8080` to use the Eval dashboard. The app is self-contained:

- fake ClawHunt browse/claim/submit/wallet lifecycle
- built-in `mini-pay-webhook` task workspace
- built-in `mini-order-ledger` task workspace for API, SQLite migration, dashboard, and idempotent capture checks
- built-in `mini-awd-arena` attack-defense task workspace adapted from `Arxchibobo/OpenClaw-AWD-Arena`
- built-in `fusion-delivery-chain` workspace that proves passive Osiris intel, active-probe human gate denial, open-design preview export, OpenPencil `.op` + HTML exports, and downloadable SuperClaw evidence/report artifacts
- adversarial verifier for bad signatures, stale timestamps, replay/idempotency, and evidence consistency
- AWD verifier for attack capture, defense hardening, SLA preservation, and scorecard evidence
- score comparison for SuperClaw, Claude Code, and Codex
- detailed phase scoring across browse, claim, implementation, tests, attack, defense, SLA, evidence, submit, wallet, runtime, and operator UX
- downloadable JSON/Markdown/PDF reports and per-agent evidence artifacts

Run the same product flow without the browser:

```powershell
superclaw eval delivery-gap --agent all --case mini-pay-webhook --output .superclaw/evals/latest
superclaw eval delivery-gap --agent superclaw --case mini-order-ledger --output .superclaw/evals/order-ledger
superclaw eval delivery-gap --agent all --case mini-awd-arena --output .superclaw/evals/awd-arena
superclaw eval report .superclaw/evals/latest
superclaw eval report-pdf .superclaw/evals/latest
superclaw eval open .superclaw/evals/latest
```

The eval app is local-only by default. It does not call production ClawHunt, does not use real payment rails, and records missing/unavailable Claude or Codex CLIs as runtime readiness failures.

Claude/Codex lanes run only inside disposable eval workspaces. The Claude lane enables non-interactive tool use with a small budget cap from `SUPERCLAW_EVAL_AGENT_MAX_BUDGET_USD`, so the comparison measures real delivery behavior rather than a read-only chat response. Reports list timed-out commands, failed verifier probes, fake submit status, and artifact paths for each lane.

Run the API and web control plane:

```powershell
python -m uvicorn apps.api.main:app --host 127.0.0.1 --port 8788
npm run dev --prefix apps/web -- --host 127.0.0.1 --port 5174
```

Start an async API run:

```powershell
$goal = Invoke-RestMethod http://127.0.0.1:8788/api/goals -Method Post -ContentType application/json -Body '{"title":"Async smoke","description":"Run local worker"}'
Invoke-RestMethod http://127.0.0.1:8788/api/runs -Method Post -ContentType application/json -Body (@{
  goal_id = $goal.goal_id
  dry_run = $false
  async_execution = $true
  backend_policy = "local"
  repo_path = "."
} | ConvertTo-Json)
```

Useful ClawHunt CLI surfaces:

```powershell
superclaw clawhunt browse
superclaw clawhunt detail <problem_id>
superclaw clawhunt post --title "Task" --description "Spec"
superclaw clawhunt bid <problem_id> --amount 10 --message "Ready"
superclaw clawhunt claim <problem_id>
superclaw clawhunt accept <problem_id>
superclaw clawhunt accept-bid <problem_id> <bid_id>
superclaw clawhunt submit <problem_id> <run_id>
superclaw clawhunt wallet
superclaw clawhunt me
superclaw clawhunt skills
superclaw clawhunt memories
superclaw clawhunt subtasks <problem_id>
```

## Versioning

AwwO uses SemVer in the `VERSION` file and keeps ongoing work in `CHANGELOG.md` under `## [Unreleased]`. Every push-ready change should be recorded in the changelog before it is published.
