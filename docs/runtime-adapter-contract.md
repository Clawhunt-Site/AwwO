# Runtime Adapter 标准契约（Runtime Governance & Adapter Contract）

> 本文是 SuperClaw 的 **runtime 治理架构 + 适配器标准协议**：定义"加一个新 Agent Runtime 时，它的 adapter 必须包含什么、按什么标准做"。
>
> **出发点（硬约束）**：① 最佳性能实践；② **绝不影响原生 Agent Runtime 的运行效果**。
>
> **效力**：本文是**人读的标准**；真正的强制由代码里的 `AgentRuntimeAdapter` Protocol（`agent_runtime/adapter.py`）+ conformance 测试承载，**不是靠这份文档**（防漂移）。本文与各子契约的关系见 §6。
>
> 已并入并取代 [capability-workshop-impl-roadmap.md](capability-workshop-impl-roadmap.md) §8.2 / §12.6 中关于授权与容器的讨论；BUG-7（B 类 `_exec_tool` fail-open）见该文 §13。本文每条结论均经 Codex+Gemini 多轮对抗验收。

---

## 0. 一句话定调

> **统一"策略"，不统一"容器机制"。** SuperClaw 是控制面：定一套安全策略，投影到每个 runtime 的**原生 enforcement**；只在 SuperClaw 自己拥有执行权的地方（B 类工具、plugin sidecar）才亲自上物理沙箱。**绝不给自带沙箱的 runtime（codex/claude）外层再套一个 SuperClaw OS 容器**——那会双沙箱打架、把它们弄坏、且零性能收益。

---

## 1. 三轨分治（按"谁拥有工具执行权"分）

| 轨 | runtime | 谁执行工具 | SuperClaw 怎么管 | 隔离靠谁 | 性能 |
|---|---|---|---|---|---|
| **A 类** | codex / claude（自带沙箱的 CLI） | **runtime 自己**（在自己进程里） | 纯**策略翻译器**：拼 `--sandbox`/`--permission-mode` + PromptEnvelope + MCP 投影 + session 指纹 + 高危 intent 接入 | runtime **原生沙箱**；**SuperClaw 绝不外层套容器** | 投影 0ms |
| **B 类** | gemini-agent / anthropic-agent（裸模型，SuperClaw 自拥 loop） | **SuperClaw**（`_exec_tool`） | `_exec_tool` 前置 **GovernedToolExecutor**（按 tool+args fail-closed）；`run_shell` 危险时**只包这一个 shell 子进程** | SuperClaw 自己（瞬时动作沙箱） | per-call 门 微秒级，可忽略 |
| **Plugin** | 第三方 sidecar（独立进程，不可信） | sidecar 自己 | **物理硬隔离**（声明权限变硬墙） | 真容器：**WASI 优先**，macOS seatbelt / Linux bwrap·nsjail / Windows AppContainer 兜底 | 这里**才值得**付容器代价 |

**横切：intent 门（见 §3）** 是治理地板，但**对 A 类有边界**（§3 关键破绽）。

---

## 2. 容器 / 隔离模型

- **容器 = 给"会执行代码的进程"套的真笼子**，由 OS/WASM 在系统调用层强制；程序越界也越不出去（≠ 靠 prompt 自觉）。
- 笼子有多堵墙：**文件目录 · 网络地址 · 进程 spawn · 环境/凭证 · 资源/时限**。"只能在某文件夹操作"只是文件墙这一堵。
- **B 类动作沙箱 与 Plugin sidecar 沙箱是不同进程、不同实例、不同策略，但应复用同一套 `Sandbox` 原语**（同技术，两实例）。接口见 §4。
- **关键认知**：容器只管"**能不能**碰资源"，**看不懂"在干什么意图"**——一笔合法支付在笼子眼里就是"连了个声明过的网址"，它拦不住。意图级高危靠 §3 的 intent 门。

---

## 3. Intent 门（业务意图级人审，与容器/prompt 正交）

- **作用**：在**执行前**识别动作的**业务含义**（支付 / 主动扫描 / 凭证访问 / 浏览器登录支付 / 越界写 / 提权），命中则 **fail-closed 暂停 run、弹 Ask 等人审**，批准才继续。
- **机制**：`fusion.py` 的 `human_gate` / `_requires_human_gate` 持一张高危意图清单；命中即 RAISE。它**不是逐 syscall 拦（那是容器），是只在少数高危含义动作前拦**。
- **与容器/prompt 的分工**：容器看不懂意图、prompt 拦不住（模型可忽略）→ 只有 intent 门能在执行前按"含义"硬拦。

### ⚠️ 3.1 关键破绽：intent 门**不是 A 类天然的地板**
A 类自己跑工具时（`run_shell curl` 调支付 API / `base64` 解码执行 / 开浏览器会话），**SuperClaw 看不见 pay 意图**——只看到"启动了 codex/claude"。所以：

> **A 类的高危只有在以下情况才算 `kernel_enforced`**：① 高危能力被投影成 **SuperClaw MCP/plugin proxy 工具**（执行前回到 SuperClaw，如 pay-switch 走 proxy→fusion）；② runtime 原生 approval 回调给足语义且允许 SuperClaw suspend/deny。**否则该能力不该暴露给它，或必须 fail-closed。**

正确原则：**intent 门是地板，仅对"被强制绕回 SuperClaw 的能力"成立**；A 类纯原生执行 SuperClaw 看不见的部分，地板是**原生沙箱 + 不暴露拦不住的高危能力**。**契约必须把这个边界如实写死（见 `control_plane_coverage`/`high_risk_gate_coverage`），否则未来一定误报安全。**

---

## 4. Sandbox 原语（B 类动作 + plugin 共用）

```text
SandboxSpec(
  purpose: "b_run_shell" | "plugin_sidecar",
  executable, args, cwd, stdin,
  env_policy, secret_refs,
  fs_mounts, network_policy,
  resource_limits, timeout, allow_spawn,
  artifact_policy, audit_labels,
)
SandboxResult(exit_code, stdout, stderr, artifacts, violations, metrics)
```
- **B 类 `run_shell`（瞬时 / create_ephemeral）**：repo workspace 挂载、最小 env、默认无 secrets、危险命令先过 gate、写时复制。
- **Plugin sidecar（长驻 / spawn_resident）**：包只读、临时工作目录、只注入声明配置/作用域 token、网络只放 manifest host、WASI 优先。
- **共享 `ResourceConstraint`**：防 plugin 抢光动作沙箱 CPU；二者跑同一 `SandboxProvider`。

---

## 5. Adapter 契约字段（加 runtime 的"标准答题卡"）

| 字段 | 含义 | 必填 |
|---|---|---|
| `execution_model` | `native_loop`(A) / `superclaw_loop`(B) → 决定治理轨 | ✅ |
| `native_sandbox` | 有(级别+原生参数) / 无；**有 → 禁外层双沙箱** | ✅ |
| `permission_presets` | ask/allow → 原生真实映射（一致性测试）；指向 [permission-mode-framework](permission-mode-framework.md) | ✅ |
| **`control_plane_coverage`** | **SuperClaw 能在执行前拦哪些面**：native_tool_approval / mcp_proxy_tool / plugin_sidecar / browser_broker / shell_command / network_egress / credential_access | ✅ 没它=假地板 |
| `high_risk_gate_coverage` | 每类高危分级：`kernel_enforced` / `native_enforced` / `not_enforceable`（not_enforceable → 不暴露或 fail-closed） | ✅ |
| `tool_projection` | 受治理 plugin/skill MCP 工具怎么投影；不支持则 fail-closed | ✅ |
| `display_field_matrix` | 字段级（streaming_text/tool_lifecycle/tool_input/tool_output/reasoning/usage/approval）→ canonical DisplayEvent；指向 [display-protocol](agent-runtime-display-protocol.md) | ✅ |
| `prompt_projection` | 统一信封各层投到该 runtime 的 system/user 通道；指向 [prompt-envelope](prompt-envelope-roadmap.md) | ✅ |
| `approval_intercept` | 原生审批通道 有(格式)/无 + 怎么路由统一 Ask | ✅ |
| `session_lifecycle` | 一次性/长驻；session key 组成(repo/MCP/sandbox/model)；resume/suspend | ✅ |
| `cancel_timeout_heartbeat` | cancel / deadline / heartbeat（尤其挂起等审批时，防 sandbox 超时回收） | ✅ |
| `error_degradation` / `redaction_audit` | 失败降级语义 + 日志/输出脱敏 | ✅ |
| `workspace_mapping` | host↔guest 路径翻译（沙箱内外文件视图不一，UI 关联文件变更要它） | ✅ |
| `stdio_stream_encoding` | I/O 流编码（ANSI/行刷新/stream-json 处理） | ✅ |
| `conformance_fixtures` | 上面声明**必须能被测试证明** | ✅ |
| `usage_source` / cost | 计费来源（要展示计费才必填） | 可选 |

**MVP（先落这 7 项，"加 runtime 照着填"即生效）**：`execution_model` + `native_sandbox`(禁双沙箱) + `permission_presets` + **`control_plane_coverage`**(没它 MVP 是假的) + `tool_projection` + `display_field_matrix` + `conformance_fixtures`。

---

## 6. 防漂移：契约是代码，不是巨型总文档

- 强制由 **`agent_runtime/adapter.py` 的 `AgentRuntimeAdapter` Protocol（manifest schema + registry conformance gate）** 承载；新 adapter 必须实现，类型系统/conformance 测试强制。
- **已有子契约各管各的，本文只引用不重述**：`permission-mode-framework` 管 ask/allow；`agent-runtime-display-protocol` 管 DisplayEvent；`prompt-envelope-roadmap` 管内容投影；`fusion.py`/plugin-proxy 管高危执行门。
- **本契约只新增并强制**：`execution_model`、`native_sandbox`（禁双沙箱不变量）、`control_plane_coverage`/`high_risk_gate_coverage`、`workspace_mapping`、registry conformance。

```python
class AgentRuntimeAdapter(Protocol):
    runtime_id: str
    track: RuntimeTrack                  # CLASS_A | CLASS_B | PLUGIN
    native_sandbox: NativeSandboxSpec    # 有→禁外层双沙箱 / 无→必须 GovernedToolExecutor
    control_plane_coverage: CoverageSet  # 哪些执行面可被 SuperClaw 执行前拦截
    def permission_presets(self) -> PresetMap: ...        # → permission-mode-framework
    def display_field_matrix(self) -> DisplayMatrix: ...  # → display-protocol
    def prompt_projection(self) -> PromptProjection: ...  # → prompt-envelope
    def tool_projection(self) -> ToolProjection: ...      # → fusion/plugin-proxy
    def open_session(self, req: RuntimeSessionRequest) -> Any: ...
    def close_session(self, session: Any) -> None: ...
    def conformance_fixtures(self) -> list[Fixture]: ...
```

---

## 7. 性能 / 风险预算（项目核心决策框架）

| 预算 | 别花在 | 该花在 |
|---|---|---|
| **性能** | 给可信进程套沉重 OS 容器、逐 call 人审、容器冷启动、session churn | 保留 codex app-server session、少做逐 call 人审（风险分级）、避免冷启动；钱花在"意图识别 + 状态流转" |
| **风险** | 防备商业公司打磨过的 CLI 二进制本身 | B 类 `run_shell` 危险指令 + 第三方 plugin（WASI/OS 沙箱）+ host-owned 高危确认 |

- **0 开销**：声明、preset 映射、PromptEnvelope/display 投影、conformance（加载期静态读）。
- **有成本（仅真危险时触发）**：B 类危险动作 sandbox wrap、plugin sidecar 启动、human gate pause、脱敏、session resume。
- **优化**：intent 门可在模型 `thought` 阶段**预检高危 token、预热 human_gate**，而非工具执行那一刻硬卡。

**结论**：A 类最佳性能路径就是**纯原生**；代价是 SuperClaw 不能宣称拦住所有原生高危意图，只能拦"投影回 SuperClaw 的工具 + 可拦截的原生 approval"。契约把这个边界**如实写死**，就既保了 codex/claude 的原生性能、又不误报安全。
