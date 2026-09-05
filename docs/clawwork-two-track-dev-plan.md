# ClawWork + Skill/Plugin 双轨重构：开发案

> 状态：分期实施中（2026-06-17 dev/roadmap：PR-1/3/4 已落；PR-2 native store/projection + CLI/API + Web Skills tab 已落；PR-5 daemon broker/session/materialization primitives + local CLI/API control surface + POSIX Unix-domain socket JSONL IPC server/client 已落；local distribution policy foundation 已落。剩余为 Windows named-pipe、生产 daemon service packaging/soak、hosted distribution 上传/签名/鉴权/加密分发硬化）。
> 决策来源：用户拍板 + 三方会诊（Claude 代码测绘 / Codex GPT‑5.5 / Gemini，转写见 `.codex-cli-advisor/` 与 `.gemini-cli-advisor/` 的 `skill-plugin-rearch*` 会话）+ Paperclip / Pi 源码实证（参考克隆 `/tmp/paperclip-analysis`、`/tmp/pi-analysis`）。
> 关联文档：[plugin-runtime-projection.md](plugin-runtime-projection.md)（现行 proxy 架构，仍然有效）、[plugin-ecosystem-framework.md](plugin-ecosystem-framework.md)、[agent-team-kernel-paperclip-adoption-plan.md](agent-team-kernel-paperclip-adoption-plan.md)。
> 铁律不变：能力先进 Python 内核经 CLI 暴露；表层零分叉；治理（pay-switch / 扫描 fail-closed / 验签）由内核统一裁决。

---

## 0. 决策记录（一页纸）

| # | 决策 | 内容 | 推翻了什么 |
|---|---|---|---|
| D1 | **Skill/Plugin 双轨拆分** | Skill = 原生 markdown，全文同步进 runtime 原生 skill 目录，**运行时零治理、零 MCP**；Plugin = 治理 MCP（签名+授权+撤销，未来登录态+加密分发），独立运行 | 推翻"import-skill 包装成 mcp_sidecar 插件"（方案B）与"按能力面分层投射" |
| D2 | **分发时治理底线**（三方共识） | 运行时零门，但商城分发的 skill 必须：来源标识入台账 + install 时一次性验签（复用 Ed25519 基建）+ 官方/已审核/社区分级标签 + 含脚本者标 `executable` 强警告 | "完全零治理"的说法——skill 可带脚本，是真实供应链入口 |
| D3 | **ClawWork = Pi 薄 fork** | fork `earendil-works/pi`（MIT，pin 版本），表面重品牌（bin 名 / `~/.clawwork` / banner），内部不动以便 rebase；作为模型中转站裸模型的默认 harness；以 RPC 子进程接成 SuperClaw backend | Gemini 的"PydanticAI 自建薄 harness"主张（重造 runtime，违背"runtime is hard"判断） |
| D4 | **治理走 policy snapshot，不做跨语言同步回调** | Python 内核生成签名的 policy snapshot（JSON），ClawWork 的 TS governance extension 启动时加载、`tool_call` 钩子本地判定；仅 pay/账号态做短 TTL HTTP 查本地 API | per-call TS→Python 同步 RPC（IPC 链路过脆） |
| D5 | **能力面指纹 ↔ 分级 resume 守卫**（三方一致） | 指纹 = skill 内容 digest 集 + plugin catalog digest + **权限模式** + backend/model + 撤销 epoch；分级动作（见 PR‑1），反对全量硬拒 | 无 |
| D6 | **MCP proxy 演进方向** | stdio aggregate proxy 保留为薄前端（现行架构正确，见 plugin-runtime-projection.md）；登录态/密钥解封/授权裁决未来上移常驻 daemon；catalog 维持"每会话冻结"语义，与 D5 守卫配套 | 无（远期项） |
| D7 | **Backend 矩阵扩容** | 移植 Paperclip adapter 矩阵的知识（非代码）：补 opencode / cursor / grok / http 通用 backend，硬化现有 hermes / openclaw / gemini；并把 Paperclip 的契约配件（testEnvironment / sessionCodec / capability flags / model profiles）补进 `WorkerBackend` | 无 |

命名：取 **ClawWork**（与 SuperClaw / ClawHunt / OpenClaw 同族；"superWork" 与 SuperClaw 视觉撞名且过于泛化）。如改名，仅涉及 fork 仓库名 + backend `name` 常量 + 配置目录三处。

---

## 1. PR‑1：分级 resume 守卫（P0，最小改动，先落）

**目标**：会话档案存"能力面指纹"，resume 前比对，按变化类型分级处理。同时为 plugin catalog 的"每会话冻结"语义补上另一半。

**技术栈**：纯 Python stdlib（`hashlib`/`json`），SQLite（经 `state.py` 现有通道），无新依赖。

### Spec

新增 `packages/superclaw/src/superclaw/capability_surface.py`：

```python
@dataclass(frozen=True)
class CapabilitySurface:
    skill_digests: dict[str, str]      # 受管投射文件 path -> render_digest（来自 projections.lock）
    plugin_catalog_digest: str         # aggregate proxy catalog: sorted (tool_name, schema_digest, plugin_id, version) 的 sha256
    permission_mode: str               # "ask" | "allow"
    backend: str                       # backend name
    model: str | None
    revocation_epoch: str              # 撤销列表文件的 digest（不存 token 值，存 epoch）
    combined: str                      # 以上各项 canonical-JSON 后的 sha256

def compute_capability_surface(*, permission_mode, backend, model, projection_lock=None, plugin_set=None) -> CapabilitySurface: ...

class SurfaceDiffAction(str, Enum):
    HARD_BLOCK = "hard_block"      # 权限模式变宽(ask→allow)、安全门状态降级
    CONFIRM = "confirm"            # 工具 schema 变更 / skill 内容变更
    INJECT_NOTICE = "inject_notice" # plugin 撤销 / skill 删除 → 续接但注入 CRITICAL 提示
    SILENT_NOTE = "silent_note"    # 纯新增 / 描述微调 → 静默注入一行通知

def classify_surface_diff(old: CapabilitySurface, new: CapabilitySurface) -> list[SurfaceDiff]: ...
```

接线：

- `state.py`：`ChatSession` 增可选字段 `capability_surface: dict | None`（与 `codex_thread_id` 同级）；新增 `set_chat_capability_surface(session_id, surface)`。
- resume 路径（`desktop_runtime.py` 聊天续接 + orchestrator run resume）：比对 → 按 `SurfaceDiffAction` 执行；`INJECT_NOTICE` 的注入文案模板：`CRITICAL: capability "<name>" was revoked since this session started. Do NOT attempt to use it.`
- CLI：`superclaw chat --resume <id> [--strict-resume]`（strict 把 INJECT_NOTICE 升级为 HARD_BLOCK）。
- `ui_contracts.py`：resume 接口响应增 `surface_diff` 字段（action + 人类可读 diff），Web/Desktop 据此渲染确认对话框（纯表现层）。

### 测试与验收

- `tests/test_capability_surface.py`：指纹稳定性（同输入同 digest）、分级矩阵全覆盖（4 类动作 × 各变化源）、**权限提权场景**（ask 会话在 allow 环境 resume → HARD_BLOCK）。
- `tests/test_desktop_runtime.py` 增 resume 守卫端到端（撤销插件后 resume → 注入提示且会话可续）。
- 验收：`python -m pytest tests/test_capability_surface.py tests/test_desktop_runtime.py` 全绿；`superclaw chat --resume` 在指纹不变时行为与现状完全一致（零回归）。

---

## 2. PR‑2：Skill 原生轨（D1+D2 落地）

> **状态（2026-06-16 dev/roadmap）：本地闭环已落地。**
> Native `skill_store.py` 与 `skill_sync.py` native projection 已完成：导入归一化、provenance/source digest/label/executable 检测、非 `local-dev` 标签验签 fail-closed、全文 `SKILL.md` + `assets/...` 复制投射、`tier="native"` ledger 与安全 reconcile。CLI/API 已提供 native skill import/list/sync 与旧 alias 兼容警示；Web Skills tab 已消费 native skill store，展示 label/executable 状态，并保留 plugin/company catalog 流程。现有 plugin MCP/proxy projection 保持 `tier="proxy"` 与原治理门不变。2026-06-17 补齐了本地 distribution policy foundation：同一 capability/version 绑定 immutable digest、对象引用 opaque、publish/revoke/replace/sign 写 append-only audit；生产 hosted upload/signing/auth/encrypted distribution 仍是 follow-up。

**目标**：skill 脱离 plugin 治理管线，成为独立工件：导入归一化 → skill store → 全文投射原生目录；治理只发生在 install 时（验签/来源/标签），运行时零开销。

**技术栈**：Python stdlib；签名复用现有 Ed25519 基建（`plugins.py` 的验签函数）；前端 React（`apps/web` 技能 tab 改造）。

### Spec

**Skill store**（新增 `packages/superclaw/src/superclaw/skill_store.py`）：

```
~/.superclaw/skills/<slug>/
  SKILL.md            # 归一化后的正文（frontmatter: name/description 强制）
  assets/...          # 附带脚本/参考文件（如有）
  .provenance.json    # {publisher, source_url, source_digest, signature?,
                       #  label: official|reviewed|community|local-dev,
                       #  executable: bool, imported_at, importer}
```

- `import_skill(path, *, source=None, signature=None) -> SkillImportRecord`：归一化 frontmatter、检测 `executable`（assets 含任何非 .md 文件，或正文含带 shebang 的 fenced block）、写 provenance。
- **install 门（一次性）**：`label != local-dev` 时必须验签通过否则拒装（fail-closed）；`executable=True` 时 CLI 要求显式确认并展示脚本清单（`--yes-executable` 跳过，供脚本化）。
- `skill_import.py` 反转：`import_skill_as_plugin` 删除，CLI `superclaw plugin import-skill` 改为 `superclaw skill import`（在 `cli.py` 保留旧命令别名一版，打印迁移提示后转调）。

**skill_sync.py 改造**：

- 投射体从指针改为**全文复制**（`SKILL.md` + assets；**复制而非 symlink**——Paperclip 用 symlink 导致内容变更静默穿透、指纹失效，这是它的缺陷不抄）。
- 台账/受管标记/reconcile 全部保留，但语义降级为**卫生层**（干净卸载、不覆盖用户手改），`tier` 字段值 `"native"`；plugin 工具的 proxy 指针投射保留现状不动。
- 枚举来源从 `available_plugins()` 改为 skill store（skill 不再是 plugin，治理门不适用；plugin 指针投射仍走治理门）。
- docstring 重写（现 docstring 中"native tier 被否决"的论述已被 D1+D5 取代：撤销残留问题由 resume 守卫处理）。

**表层**：

- API：`/v1/skills` 改读 skill store（含 provenance/label/executable 字段）；`POST /v1/skills/import`。
- Web 技能 tab：从"plugin 过滤视图"改为 skill store 视图；label 徽章 + executable 警告角标（纯表现层）。

### 测试与验收

- `tests/test_skill_store.py`（新）：导入归一化、executable 检测、验签 fail-closed、provenance 完整性。
- `tests/test_skill_import.py` / `tests/test_skill_sync.py`：按新语义翻转（投射全文、卫生层 reconcile、用户手改不覆盖）。
- `tests/test_api.py`：`/v1/skills` 新契约。
- README 第 49–56 行语义同步翻转（本 PR 内完成，见 §6）。
- 验收：导入一个含脚本的第三方 skill → 警告确认 → 投射到 `~/.claude/skills` 与 `~/.agents/skills` → Claude Code / Codex 原生发现并可用，全程无 MCP hop；卸载后投射文件被精确回收。

---

## 3. PR‑3：ClawWork（Pi fork）+ backend 接入（D3+D4）

> **状态（2026-06-11）：已落地。** ClawWork = `earendil-works/pi` v0.79.1 的 config-only 白标 fork（`../clawwork`，零源码改动）；`ClawWorkBackend(_AgentCliBackend)` 经 RPC JSONL 接入，`clawwork_policy.py` 签发 HMAC 签名快照、`extensions/superclaw-governance.ts` 进程内同 posture 判定（fail-closed 全覆盖）。4 个 spike 门 + 7 个 Python 测试 + 真机端到端冒烟全过；矩阵 15→16，标 `maturity: experimental`。Codex+Gemini 验收见提交记录。

**目标**：把 Pi 整体拿为己用、重品牌为 ClawWork，作为模型中转站裸模型的默认 harness，接成 SuperClaw 的一个 backend；治理经 governance extension 落地权限模式传递与 pay-switch 硬门。

**技术栈**：TypeScript（ClawWork fork：Node 20+ / npm monorepo，沿用 Pi 工具链）；Python（backend 接入：`backends.py` JSONL RPC 客户端，复用 `CodexAppServerBackend` 的子进程 JSONL 模式）。

### 3a. Fork 策略（薄 fork，最小 diff）

- 新仓库 `clawwork` = fork `earendil-works/pi` @ **pin 到具体 tag**（当前 v0.79.x 线；上游发版频繁，靠 rebase 跟进，所以 diff 必须小）。
- 只改品牌面：bin `pi`→`clawwork`、配置目录 `~/.pi/`→`~/.clawwork/`、banner/名称常量；**agent-core / ai / 协议层一行不动**。
- 预置 `~/.clawwork/agent/models.json` 种子模板：

```json
{
  "providers": {
    "clawrelay": {
      "baseUrl": "${SUPERCLAW_RELAY_BASE_URL}",
      "api": "openai-completions",
      "apiKey": "${SUPERCLAW_RELAY_API_KEY}",
      "models": [ { "id": "<由中转站下发>" } ]
    }
  }
}
```

（Pi 原生支持 provider 级 baseUrl + `compat` 开关，OpenAI 兼容/Anthropic 协议中转站均可直配，无需改源码。）

### 3b. Spike 门（合入前必须全过，每项一个最小复现脚本入 `clawwork` 仓库 `spikes/`）

1. `--mode rpc` headless 下 extension 是否加载、`tool_call` 的 `{block, reason}` 是否端到端生效；
2. `tool_call` 钩子 **mutate input 后 Pi 不重新验证**——governance extension 若改参必须自己重跑校验（安全坑，写进 extension 的合约测试）；
3. headless 无 `ctx.ui.confirm`——需人审时返回 block 并把审批请求经本地 API 路由回 SuperClaw human gate；
4. pin 版本 + contract tests：锁定钩子事件名/语义，上游升级时先跑合约再 rebase。**合约 pin 必须钉在 SuperClaw 实际消费面**（`tool_call`/`block+reason`、`tool_execution_end`、`agent_end`、`prompt` 命令）——2026-06 审计抓出过 pin 钉错事件名（`toolcall_end`）导致门禁虚假通过；
5. 权限姿态投影（2026-06 审计补）：headless 永远无法 ASK，所以任何"会询问"的姿态必须投影成硬 block——`acceptEdits`/`auto` 禁 bash、`default`/未知 mode 全 read-only、仅 `bypassPermissions`/`dontAsk` 放开；显式 allowlist = 预批集合。CLI `--tools` 硬门与 extension 双层同 posture（`spike-posture-governance.mjs`）。

### 3c. Governance extension（`clawwork` 仓库 `extensions/superclaw-governance.ts`，随 backend 部署进 `~/.clawwork/agent/extensions/`）

- 启动：读 `SUPERCLAW_POLICY_SNAPSHOT`（指向内核签发的 JSON 文件：权限模式、工具白名单/黑名单、pay-switch 状态、snapshot 签名），验签失败 → **fail-closed 全 block**。
- `pi.on("tool_call")`：本地判定（零网络 hop）；命中 pay/扫描类意图 → block 并 POST 本地 API 创建审批项；账号/pay 实时态做短 TTL（≤30s）缓存查询。
- 这是 [pydantic-ai-provider-channel] 里 GovernedToolExecutor 的可序列化形态：**策略一处定义（Python 内核），两处执行（Python backends / TS extension）**。

### 3d. SuperClaw backend（`backends.py` 新增 `ClawWorkBackend(_AgentCliBackend)`）

```python
class ClawWorkBackend(_AgentCliBackend):
    name = "clawwork"
    executable_name = "clawwork"
    # 解析顺序：constructor → SUPERCLAW_CLAWWORK_EXECUTABLE → shutil.which（铁律：不硬编码路径）
    # run(): spawn `clawwork --mode rpc --session-dir <run_dir>`，JSONL prompt/事件流（复用 CodexAppServerBackend 客户端模式）
    # 启动前：写 policy snapshot 文件 + 注入 SUPERCLAW_POLICY_SNAPSHOT / SUPERCLAW_RELAY_* env
    # permission_presets(): ask/allow 均映射到 policy snapshot 字段（extension 判定），CLI 参数不带权限语义
```

- 注册进 `default_backends()`，**标记 experimental**（`ui_contracts.py` availability 增 `maturity: experimental` 字段，Web 显示徽章）；不改默认 backend。

### 测试与验收

- `tests/test_backends.py` 增 ClawWorkBackend（fake executable 模式，沿用现有套路）；contract test 用真 clawwork（CI 可选 job）跑通"假 policy snapshot → tool_call 被 block"。
- 验收：`superclaw run --backend clawwork`（指向一个真实中转站端点）完成 smoke 任务；权限模式 ask 下危险工具被 extension block 且审批项出现在 SuperClaw；`superclaw doctor` 报告 clawwork 可用性。

---

## 4. PR‑4：Backend 矩阵扩容 + 契约补件（D7）

**目标**：对齐 Paperclip adapter 矩阵的覆盖面与契约丰富度。移植的是**知识**（命令构造、流解析、失败分类、会话续接、环境探测），不是 TS 代码。

**技术栈**：纯 Python，`backends.py` + `ui_contracts.py` + `tests/`。

### 4a. `WorkerBackend` Protocol 扩展（先行，单独可合）

```python
class WorkerBackend(Protocol):
    # 现有：available() / run() / permission_presets()
    def test_environment(self) -> EnvironmentTestResult: ...   # 分级 checks: ok|warn|error，含修复提示
    def session_codec(self) -> SessionCodec | None: ...        # 会话参数 serialize/deserialize（统一 codex_thread_id 这类散落字段）
    def models(self) -> list[ModelInfo]: ...                   # 可选：静态/探测的模型清单
    def capabilities(self) -> BackendCapabilities: ...         # flags: supports_mcp / supports_streaming / supports_resume / supports_skills_dir
    def model_profiles(self) -> list[ModelProfile]: ...        # 可选：cheap lane 等成本档位
```

- 全部带默认实现（mixin），存量 backend 零强制改动；`ui_contracts.py` 把 `test_environment` / `capabilities` / `maturity` 透出给表层（Web setup dialog 直接消费，替代硬编码分支）。

### 4b. 矩阵清单（按优先级）

| backend | 状态 | 动作（移植自 Paperclip 对应 adapter 的知识点） |
|---|---|---|
| claude / codex / codex-app-server | 成熟 | 补 `test_environment`（CLI 在位/登录态/ANTHROPIC_API_KEY 警告）、`models()`、session_codec |
| hermes | 已有，待硬化 | 失败分类对齐（provider credentials/exhausted providers 已有）、会话 ID 规则（Paperclip 有 HERMES_SESSION_ID_REGEX 经验）、env 探测 |
| openclaw | 已有，待硬化 | gateway 模式补充：`SUPERCLAW_OPENCLAW_GATEWAY_URL` 走 HTTP（对齐 Paperclip openclaw_gateway adapter），CLI 模式保留 |
| gemini | 已有，待硬化 | 环境探测 + 失败分类 |
| clawwork | PR‑3 | — |
| **opencode** | 缺 | 新增 `OpenCodeCliBackend`（`opencode` CLI，stream 解析参考 Paperclip opencode-local） |
| **cursor** | 缺 | 新增 `CursorCliBackend`（cursor background/agent 模式；Paperclip cursor-local 有 stdout 解析与 remote-command 经验） |
| **http** | 缺 | 新增 `HttpBackend`（通用外部 HTTP 端点契约：POST prompt/context → result/usage，对齐 Paperclip http adapter 的请求/响应形状）——这是未来第三方自带 runtime 的最低接入门槛 |
| grok | 缺，低优 | 视用户需要 |
| process | 已有 | `LocalShellBackend` 即 Paperclip 的 process adapter，补 `test_environment` 即可 |

- 每个 backend：`SUPERCLAW_<NAME>_EXECUTABLE` env 解析、失败 markers、permission_presets 映射（ask/allow → 原生 sandbox 姿态，参照 [permission-mode-framework.md](permission-mode-framework.md)）。
- **明确不抄**：Paperclip 的 `--dangerously-skip-permissions` 默认放行姿态（与权限模式框架冲突）；npm 热装 adapter（SuperClaw 的第三方扩展走 plugin/HttpBackend，不开任意代码热装口）。

### 测试与验收

- 每 backend 一组 fake-executable 测试（现有模式）；`superclaw validate --backends ...` 矩阵跑通；`superclaw doctor` 输出全矩阵环境探测。

---

## 5. PR‑5：proxy → daemon 演进（D6，远期，做登录鉴权功能时启动）

> **状态（2026-06-17 dev/roadmap）：本地 broker/control surface 与 POSIX IPC server 已落地，生产 daemon service 未宣称完成。**
> 已新增 daemon-side scoped session/token/materialization primitives：短期 scoped token、审计安全 status、过期/错 scope/陈旧 session fail-closed、0700 临时目录与 0600 文件物化、manifest secret scrub、unsafe path 拒绝、close cleanup、被动 reaping 与锁保护。随后新增 local persistent broker control surface，经 CLI `daemon broker ...` 和 API `/api/team/daemon/broker/*` 暴露生命周期控制。2026-06-17 继续补齐 POSIX Unix-domain socket JSONL server/client over `LocalDaemonBrokerControl`，覆盖安全 socket path、断开客户端容错、bad request fail-closed、token/status 脱敏、物化清理。Windows named-pipe、生产 daemon service packaging/launchd/soak 与 hosted signing/auth/storage 仍是生产化 follow-up。

- `superclaw daemon`：常驻进程持有登录态/refresh token/密钥解封；本地 POSIX Unix socket 已有 JSONL control transport；Windows named pipe 与 production service packaging 仍待补；stdio proxy 退化为透传 pipe，只持短期 scoped token。
- 加密 plugin：daemon 完成授权检查 + 解封 + 物化到受控临时目录（0700，run 结束清理），sidecar 只见最小视图。
- 生产 daemon service（启动/守护、Windows named pipe、升级/恢复、真实登录态与密钥解封、soak）仍需单独设计文档与 soak 测试。先决条件：PR‑1（冻结+守卫语义）已落地。

---

## 6. 文档同步清单（本开发案随附完成）

| 文档 | 问题 | 动作 |
|---|---|---|
| `README.md:54-56` | import-skill 描述的是被推翻的方案B；且宣称代码中不存在的 native tier（skill_sync.py 只有 proxy 层） | 重写为双轨语义 + 落地状态标注 ✅（本次） |
| `docs/agent-team-kernel-paperclip-adoption-plan.md` | "丢掉 adapter"的论述与 D7 冲突 | 加状态更新注记 ✅（本次） |
| `docs/plugin-ecosystem-framework.md` | skill 经 plugin 管线进商城的隐含假设 | 加双轨注记（skill 走分发时治理，不进 plugin 运行时管线）✅（本次） |
| `skill_sync.py` docstring | "native tier 被否决"论述已被 D1+D5 取代 | PR‑2 内随代码改 |
| `docs/plugin-runtime-projection.md` | 经核查仍准确（per-run proxy + 冻结 + daemon 远期注记） | 不动 |

---

## 7. 实施顺序与依赖

```
PR-1 resume 守卫 ──────────────┐
PR-2 skill 原生轨 ─────────────┼──→ PR-5 daemon（远期）
PR-3 ClawWork spike → backend ─┤
PR-4a 契约补件 → PR-4b 矩阵 ───┘
```

PR‑1/2/3 互相独立可并行；PR‑4a 是 PR‑4b 的前置；PR‑3 的 spike 不过门就停在 experimental 分支不合入。

---

## 8. 实施进度（2026-06-10 更新）

**已合入（分支 `feat/skill-plugin-two-track`）**，每个渠道走 test → Codex+Gemini 对抗验收 → 真机 smoke → commit 的门控：

| commit | 内容 | 验证 |
|---|---|---|
| `f4743ae` | PR‑1 分级 resume 守卫 + 本开发案 | 21 单测 |
| `4a48114` | **OpenCode** backend（`opencode run --format json --pure`） | 真机 smoke（opencode 1.16.2）抓出并修复 exit‑0 假成功 bug |
| `02fcfbb` | **HTTP** 通用 backend（第三方自带 runtime 接入门槛） | 真 server smoke；3 轮安全门控修复 OOM/SSRF/redirect-绕过/URL+usage 凭证泄漏/CGNAT |
| `b7fe561` | **Grok** backend（`grok -p`） | 真机 smoke（grok 1.0.1） |
| `ffcf822` | **Cursor** backend（`cursor-agent -p --output-format stream-json`）+ CHANGELOG | 真机 smoke（cursor-agent 2026.06.04）；修正 plugin-dir 误述、ask 安全诚实化、argv guard、IndexError |

backend 矩阵 10→14。附带全局加固：`_transcript_safe_policy_dict`（transcript 不再泄漏 mcp/plugin 路径，惠及所有 backend）+ `_first_line_version`（修 blank‑version IndexError）。**hermes**（用户点名）真机 smoke 验证现有实现已通，无需硬化。

### 两个 follow-up（用户 2026-06-10 拍板降级）

1. **openclaw gateway**（降级 follow-up）：Paperclip 的 `openclaw-gateway` 是 **WebSocket 有状态 RPC（req/res/event）+ ECDH 公私钥握手（SPKI/PKCS8）+ scopes 授权**，需引入 websocket + 加密两个重依赖（违背 SuperClaw stdlib 内核倾向），且 openclaw 本机未装、gateway 是远程服务、open-design 也无 openclaw def/mock → **无任何真机/mock 验证手段**，门控无法满足。**先决条件**：可访问的 OpenClaw gateway 服务 + 依赖引入的架构决策。现有 `openclaw` CLITX 模式 backend 仍可用。

2. **open-design 权威参考 + mock 测试体系**（重大发现，建议作为后续加固基础）：仓库内 `third_party/open-design/` 是一个完整 vendored agent harness，`apps/daemon/src/runtimes/defs/` 下有 **cursor-agent / opencode / grok / claude / codex / gemini / 等的权威 `RuntimeAgentDef`**（如 cursor def 用 **stdin 传 prompt + `--stream-partial-output`**，比位置参数更优、无 argv 上限），且 `mocks/bin/` 有 **replay-based mock CLIs**（从匿名 Langfuse traces 构建，PATH-overlay drop-in）。建议后续：(a) 用 open-design defs 校准已合入的 4 个渠道（尤其 cursor/opencode 改 stdin 传 prompt，需扩展 `run_command` 的 DEVNULL stdin）；(b) 用 mocks 跑**成功路径** smoke（本会话所有渠道的成功路径都被 auth 阻挡，只验证了失败路径——mocks 能补上）。这会把验证从"命令构造对 + 失败捕获对"升级到"成功路径端到端通"。
