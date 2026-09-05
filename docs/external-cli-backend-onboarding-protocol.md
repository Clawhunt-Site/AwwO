# 外部 CLI 接入协议规范（External CLI Backend Onboarding Protocol）

> **一句话目标**：任何一个"自己有 agent 循环、但原生没有模型驱动（或想改用我们 LLMgate 驱动）"的命令行工具，照本规范改造后，都能作为一个 **WorkerBackend** 套进 SuperClaw 内核，并自动获得 CLI / API / Web / Desktop 四个表层的统一能力——包括把 **LLMgate 的套餐列表 / 模型列表显示在选择器里**。

本规范是 SuperClaw "CLI 唯一事实来源 / 能力先进内核再上表层 / 契约集中 / 表层零偏差"铁律在 backend 接入面的落地约束。

> **行号说明**：本文给出的行号是写作时（基于当时 `main`）的快照，仅供定位；代码演进会漂移。**以函数/类/字段名为准，照抄前务必本地 `grep` 核验真实签名。** 文末 §8 的验收清单已把"核验签名"列为硬门。

适用对象：

- ✅ 一个外部 agent CLI，自带 agent loop（会自己规划、调工具、产出结果），缺的是"模型 endpoint"——想指向我们的 LLMgate relay。
- ✅ 一个外部 agent，能改造成监听端口的 HTTP 服务。
- ❌ 一个纯函数式工具（没有 agent 循环、只是个命令）——那不是 backend，应做成 **plugin / MCP 工具**，见 `docs/plugin-developer-guide.md`。

---

## 0. 先决判断：你接的是哪一类？

```
这个 CLI 自己有 agent 循环吗？
├─ 没有（纯工具/单次命令） ──────────────► 不要接 backend，做成 plugin/MCP（另一套协议）
└─ 有
   ├─ 它从哪里读模型凭据？
   │   ├─ 能改成监听端口的 HTTP 服务 ──► 档位 A：用现成的 `http` backend，零改内核
   │   ├─ 从 OpenAI/Anthropic 兼容的 base_url + api_key 环境变量读 ──► 档位 B：写 CLI backend
   │   │       子类，自管子进程把 relay env 注进去（⚠️ 不能复用 run_command，见 §2）
   │   └─ 用它自己的登录态（如 codex/claude 的 ambient auth） ──► 档位 B'：写 CLI backend
   │           子类复用 run_command，不注入 relay（它不经 relay）
   └─ 需要吃 SuperClaw 完整治理（策略快照 / 人审门 / HMAC 签名）吗？
       └─ 需要 ──► 档位 C：完整 RPC backend（参照 ClawWorkBackend）
```

成本与能力对比见 §2。**"想用 LLMgate 驱动"的核心场景落在档位 B——但请先读 §2 关于 `run_command` 的关键限制。**

---

## 1. 内核契约（唯一事实来源）

所有 backend 都实现 `WorkerBackend` 协议，定义在
[`packages/superclaw/src/superclaw/backends.py`](../packages/superclaw/src/superclaw/backends.py)（`class WorkerBackend(Protocol)`，约第 156 行）。

```python
class WorkerBackend(Protocol):
    name: str
    def available(self) -> BackendAvailability: ...
    def run(self, task, goal, session, limits: WorkerLimits) -> WorkerResult: ...
    def permission_presets(self) -> PresetMap: ...           # REQUIRED，有测试强制
    def supports_containment(self, policy) -> bool: ...       # 见 §4 注
```

> `supports_containment` 在 Protocol 里列出，但调用方 `backend_supports_containment()`（约 :183）是用 `getattr` 做兼容的：**不实现** ＝ 默认拒绝 low-trust 工作（fail-closed），标准 preset 仍放行。所以它"实际可省略"，但语义是"省略即拒绝低信任"，不是"省略无影响"。

### 1.1 `run()` 的入参——你能拿到什么

`run(self, task, goal, session, limits)`：

| 参数 | 类型（定义位置） | 你需要关心的 |
|---|---|---|
| `task` | `TaskNode`（`models.py:295`） | `task.task_id` / `task.role.value`（构造 `WorkerResult` 必填） |
| `goal` | `GoalSpec`（`models.py:253`） | `goal.description`（用户这一轮的真实指令）/ `goal.title` / `goal.acceptance_criteria` / `goal.metadata`（含 `chat_turn_intent`） |
| `session` | `RunSession`（`models.py:460`） | `session.execution_context`（团队身份 / agent_run_context）、`session.task_attempts` |
| `limits` | `WorkerLimits`（`backends.py:91`） | 见下表，**这是治理的核心载体** |

### 1.2 `WorkerLimits`——必须尊重的治理字段（`backends.py:91`）

| 字段 | 含义 | **你的 backend 必须怎么做（fail-closed）** |
|---|---|---|
| `repo_path` | 工作目录 | 在此目录执行 |
| `artifact_dir` | 证据/产物目录 | 落 transcript 等 |
| `budget_seconds` | 时间预算 | 传给子进程超时；超时置 `timed_out=True` |
| `permission_policy` | 权限策略（含 `mode` / `plugin_dirs` / `mcp_configs`） | 见下方两条：plugin/MCP 投影 + `mode` 决定权限姿态 |
| `protected_cwd` | repo_path 是受保护真实项目目录 | 为 True 时**不得自动重建 cwd**；目录不存在＝篡改信号，按失败处理 |
| `model_override` | 用户显式选的模型（CLI `--model` / 表层选择器） | **优先于一切。CLI 若无法切到该模型 → fail-closed 拒绝运行，绝不偷换模型**（注释 `backends.py:117-121`） |
| `cancel_check` | 取消回调 | 长任务定期查，取消时置 `cancelled=True` |
| `event_sink` | 流式事件汇 | 支持流式才调用；不支持就忽略 |
| `plugin_capabilities_note` | 注入提示词的 plugin 能力说明 | 传给 `_projected_cli_prompt(..., capabilities_note=...)` |
| `prompt_envelope` | 分层 prompt 信封（团队身份绑定时由内核构建） | **由 `_projected_cli_prompt` 自动消费**，别手搓 prompt 绕开它 |
| `escalation_gate` | 升级/人审门 | 仅 B 类进程内工具层需要；CLI 子进程一般不用 |
| `native_approval_broker` | codex app-server 的原生人审桥 | 仅 codex app-server 用 |
| `containment_policy` | T11 容器栅栏 | low-trust 且无法证明只读+无出网 → 由内核拒派（`supports_containment` 返 False） |
| `company_command_resolver` | B 类工具层的公司管理命令解析器 | 仅 B 类进程内工具层用 |

两条硬规则：

- **plugin/MCP 投影**：`permission_policy.plugin_dirs` 或 `mcp_configs` 非空、而你的 CLI 无法投影治理 → **拒绝运行**（synthetic 失败），绝不静默丢治理。范例：`OpenCodeCliBackend.run`（约 :2045）。
- **权限姿态由 `policy.mode` 落地**：`permission_presets()` 声明的是"两个 preset 各自如何实现"（注册期契约）；`run()` 里则按运行期的 `policy.mode` 决定实际旗标。OpenCode 的真实判断是 `if policy and policy.mode in {"bypassPermissions", "dontAsk"}: command.append("--dangerously-skip-permissions")`（约 :2080）——**不是无条件加旗**。两者由 orchestrator 把 preset 映射成 `policy.mode` 衔接。

**模型解析助手**：`_resolve_model(limits, "SUPERCLAW_YOURCLI_MODEL", default=...)`（`backends.py:204`）。优先级硬性 `model_override > 环境变量 > default`，**绝不硬编码模型名**。

### 1.3 `run()` 的返回——`WorkerResult`（`models.py:560`）

必填位置参数：`WorkerResult(task_id, role, backend, command, exit_code, output, duration_seconds)`。

关键语义：

- `exit_code != 0` 或命中 `failure_markers` ＝ 失败。**fake-success 反模式是头号大忌**：CLI"干净退出 0 但其实没干活/认证失败"必须被 `failure_markers` 捕获重判为失败（参照 ClawWork relay 401/403/5xx → model_error，及 OpenCode `"type":"error"` 标记）。`_synthetic_result` 内部会把"exit 0 但命中 failure_marker"重写为 126。
- `stdout` / `stderr` 分流：`None`＝未填充（消费端回退 merged `output`）；`""`＝填充了但真为空（**不得**回退 merged stream——只写了 stderr 的 CLI 等于没回答）。
- 复用 `_AgentCliBackend` 的两条产出路径（见 §2），能自动获得分流、redaction、超时、transcript 落盘。

---

## 2. 三个接入档位

### 档位 A：通用 `http` backend —— 零改内核

把你的 CLI 改造成监听端口的 HTTP 服务，直接用现成的 `HttpBackend`（`name="http"`），纯环境变量驱动：

```bash
export SUPERCLAW_HTTP_URL="http://127.0.0.1:9999/v1/chat/completions"   # 指向 chat 端点
export SUPERCLAW_HTTP_API_KEY="..."        # 可选
superclaw run --backend http --title "..." --repo .
```

- 请求体（POST JSON）：`prompt` / `goal` / `task` / `repo_path` / `run_id` / `task_id` / `permission_mode` / 可选 `model`。
- 响应体（JSON）：必填 `output`，可选 `exit_code`（默认 0）、`usage`。
- 内置 SSRF 防护（非公网 IP 需显式 opt-in）。
- **模型列表探测规则**（`_probe_http`，`model_discovery.py:262`）：从 `SUPERCLAW_HTTP_URL` **剥离** `/chat/completions`、`/completions`、`/responses` 尾段得到 `/v1` 根，再拼 `/models` 探测。所以 URL 要指向真正的 chat 端点（如 `.../v1/chat/completions`）；若填成 `.../agent` 这种非标准路径，会探到 `.../agent/models`，多半 404。
- **限制**：端点是独立信任边界，SuperClaw 不向它投影 plugin/MCP 治理。

适合：快速验证、第三方 agent 服务、不需要内核治理投影的场景。

### 档位 B：CLI 子类指向 relay —— ⚠️ 不能复用 `run_command`

> **关键限制（两路顾问验收阻断项）**：基类 `_AgentCliBackend.run_command()`（`backends.py:423`）的签名是
> `run_command(command, *, task, goal, session, limits, transcript_extra=None)` —— **它不接受 `env` 参数**，且内部写死 `popen_kwargs["env"] = trace_context.child_env()`（无参，:471）。
> 因此**无法通过 `run_command` 向子进程注入 relay base_url / api_key**。这是档位 B 的核心约束。

要把一个"从 OpenAI/Anthropic 兼容 env 读凭据"的 CLI 指向 relay，有两条真实路径：

**B-自管（当前唯一可直接落地）**：照 `ClawWorkBackend`（`backends.py:3041+`）的做法——**自己构造 env 并自管 `subprocess.Popen`**，不用 `run_command`。

> ⚠️ **`child_env(base)` 的语义是"从 base 起"，不是"叠加到 `os.environ`"**（`trace_context.py:133`，`env = dict(base) if base is not None else dict(os.environ)`）。**直接传一个只含 relay 两键的小 dict 会丢掉整个父环境**（`PATH`/`HOME`/`SSL_CERT_FILE`/CLI 自己的登录态目录等），子进程多半起不来或行为漂移。正确姿势是**先拷 `os.environ`、再 `update` 注入、最后过 `child_env`**（同 ClawWork `backends.py:3174`）：

```python
import os
from superclaw import trace_context
from superclaw import relay_key as _relay_key

# 0. 关键：ensure / base 解析都可能 raise RelayKeyError（未登录、bridge 失败、unsafe base）。
#    绝不让它裸抛出 run() —— 必须转成 synthetic 失败（带 transcript/WorkerResult），
#    照 ClawWork._ensure_relay_key_for_run()（backends.py:3377，返回错误串而非抛异常）。
def _ensure_key_or_fail() -> str | None:
    key, _src = _relay_key.resolve_relay_api_key()          # 先只读（owner-checked）
    if key:
        return None
    try:
        _relay_key.ensure_relay_key()                        # 已登录则自动 exchange+落盘
    except _relay_key.RelayKeyError as exc:
        return f"NO_RELAY_KEY: {exc}"
    except Exception as exc:                                 # 网络/bridge 失败仍 fail-closed
        return f"NO_RELAY_KEY: auto-provision failed: {type(exc).__name__}: {exc}"
    return None

# 1. 确保 + 只读解析（顺序铁律：ensure 在前、resolve 取用在后）：
err = _ensure_key_or_fail()
if err:
    return self._synthetic_result(..., output=err, exit_code=125, ...)  # 带全部计时参数

# 1b. ⚠️ ensure 成功后必须再 owner-checked resolve 并判空：ensure 可能与切号/登出竞态，
#     resolve_relay_api_key() 可能返回 (None, "unset")。把 None 塞进 env → Popen 报错或
#     无 key 起跑。照 ClawWork（backends.py:3190）：缺 owned key 立即 fail-closed。
api_key, _src = _relay_key.resolve_relay_api_key()
if not api_key:
    return self._synthetic_result(
        ..., exit_code=125,
        output="NO_RELAY_KEY: relay key missing or ownership changed after ensure (account switch?)",
        ...,
    )

# 2. base url 解析同样 fail-closed（SSRF/白名单），同样用 try/except 包成 synthetic 失败：
try:
    base_url = _relay_key.resolve_relay_base_url()
except _relay_key.RelayKeyError as exc:
    return self._synthetic_result(..., output=f"NO_RELAY_BASE_URL: {exc}", exit_code=125, ...)

# 3. 构造 child env：先拷父环境，再注入 relay，最后过 child_env 叠加 trace。
#    ⚠️ 绝不 child_env({...小 dict...})——那会丢掉 PATH/HOME/证书/登录态（见上方注）。
env = dict(os.environ)
env.update({
    "YOURCLI_OPENAI_BASE_URL": base_url,
    "YOURCLI_OPENAI_API_KEY": api_key,
})
env = trace_context.child_env(env)   # 从完整 base 起，scrub stale trace + 叠加当前 trace
# 4. 自己 Popen（参照 ClawWork 的子进程管理 + 超时 + 分流），不能用 run_command。
```

代价：要自己写子进程管理（超时、cancel、stdout/stderr 分流、transcript 落盘）——这部分 `run_command` 本来帮你做了。

**B-内核增强（推荐的长期形态，需先改内核）**：给 `run_command` 增加一个受控的 `env` 叠加参数（独立的内核改动 + 测试，单独 PR）。⚠️ **该增强内部必须 `base = dict(os.environ); base.update(extra_env); trace_context.child_env(base)`——绝不能 `child_env(extra_env)`**（同上方语义：`child_env` 从 base 起、不叠加 `os.environ`，传小 dict 会丢父环境）。落地后档位 B 就能复用 `run_command` 的全部设施。**在该增强合入前，文档不提供"`run_command(..., env=...)`"骨架——那是不存在的 API。**

### 档位 B'：CLI 子类，不经 relay（用 CLI 自己的 auth）

若 CLI 用自己的登录态（codex/claude/opencode 那样），不经 relay，则**可以直接复用 `run_command`**——它会自动处理子进程、分流、redaction、transcript。这是最省事的路径（§7 模板即此形态）。

### 档位 C：完整 RPC 治理 backend —— 最重，治理最严

要让外部 CLI 也吃策略快照、人审收件箱、HMAC 签名治理，照 `ClawWorkBackend`（`backends.py:2866+`）的 `--mode rpc` + policy snapshot + governance 扩展那套写。

---

## 3. 让 LLMgate 的「套餐列表 / 模型列表」显示在选择器里

模型选择器有**两条互斥的动态目录通道**，由 `ui_contracts.py` 的标志决定走哪条。

### 通道 ①：relay 套餐列表（core / plus / max）

LLMgate 官方动态目录，由 `relay_packages()` 拉取（`GET /api/v1/bridge/packages` → `/api/v1/groups` → 硬编码 floor，全程 fail-safe；未登录显示 floor 预览）。

**走这条**：在 `AGENT_CONTROL_SPECS["your-cli"]` 设 `"uses_relay_packages": True`（同时 `"supports_model_selection": True`）。`clawwork` 即此做法（`ui_contracts.py:244-249`、`_probe_clawwork` `model_discovery.py:248`）。

> ⚠️ **两道关卡，缺一接不通**：
> 1. **安全门**：套餐通道**绝不回显裸模型 ID**。`relay_packages._package_from_identifier()`（`relay_packages.py:67-103`）只接受**已知 tier 短名（`core`/`plus`/`max`，即 `SUPERCLAW_BRIDGE_TIER_SET`）或 `superclaw-*` 前缀 slug**——其余（catalog 回显的裸模型名）一律拒绝，绝不让外部数据变成路由键。注意标准档位的路由 slug 是契约常量，catalog **不得改写**（`plus`→恒 `superclaw-plus`）。想显示裸模型走通道②。
> 2. **套餐 id 归一**：用户选的套餐 id（如 `plus`）不能原样 `--model plus` 传给外部 CLI——必须归一成 relay group slug（如 `superclaw-plus`）。ClawWork 用私有 `self._translate_relay_package_model(...)` 做这件事（映射表 `relay_packages.SUPERCLAW_RELAY_GROUP_SLUGS`，:28+）。**你的 relay-backed backend 必须做等价归一**，否则套餐 id 透传会接不通/选错模型（`tests/test_worker_backends.py` 有覆盖）。

### 通道 ②：裸模型列表（具体模型名）

通过 model discovery 探测，带 60s 缓存（失败 10s）+ 凭证指纹（`model_discovery.py`）。

**走这条**：

1. 在 `model_discovery.py` 写探测函数并注册进 `_PROBERS`（:375）：
   ```python
   def _probe_yourcli(backend):
       # CLI 子命令式（参照 _probe_opencode, :224）：
       output = _run_cli([_resolve_cli_executable(backend, "yourcli"), "models"])
       return [ln.strip() for ln in output.splitlines() if ln.strip()]
       # 或 OpenAI 兼容 /v1/models（参照 _probe_http, :262）：
       # return _openai_models(relay_root, api_key=...)
   _PROBERS["your-cli"] = _probe_yourcli
   ```
2. 在 `ui_contracts.py` 设 `"uses_relay_packages": False`、**`"supports_model_selection": True`**（否则前端不渲染选择器），并给 `"suggested_models": [...]` 作探测失败时的静态兜底。

> **要显示 relay 背后的裸模型** → 让 `_probe_yourcli` 去打 relay 的 `/v1/models`（若你的 LLMgate 暴露该标准端点），用 `resolve_relay_base_url()` + `resolve_relay_api_key()`。

### 两条通道选择速查

| 你想在选择器里显示… | `uses_relay_packages` | `supports_model_selection` | 还需做 |
|---|---|---|---|
| 套餐档位（core/plus/max） | `True` | `True` | 套餐 id 归一（§3 关卡 2） |
| relay 背后的具体模型名 | `False` | `True` | 写 `_probe_yourcli` 打 `/v1/models` |
| CLI 自己的模型（不经 relay） | `False` | `True` | 写 `_probe_yourcli` 跑 `yourcli models` |
| 仅静态候选，不动态探测 | `False` | `True` | 只填 `suggested_models`，不进 `_PROBERS` |

### 前端如何消费（`AgentConfigDialog.tsx`）

前端**不是**"先看标志再只拉一个端点"。它的真实顺序（约 :224-257）是：并行/先拉 `/api/agents/{backend}/models`，再拉 `/api/agents` 读 `uses_relay_packages` 分类，relay-backed 时再拉 `/api/relay/packages`。**含义**：即便你走通道①（套餐），仍应保证 `/api/agents/{backend}/models` 路径返回合理（relay-backed 时 `_probe_clawwork` 返回的是套餐 id，不打 `/v1/models`）——别让该端点报错。三端都调同一内核 `discover_models()` + `relay_packages()`。

---

## 4. 必须实现的方法 + fail-closed 规则

| 方法 | 必需 | 要点 |
|---|---|---|
| `name` | ✅ | 全局唯一字符串，三处注册（§6）必须一致 |
| `available()` | ✅ | 返回 `BackendAvailability`；找不到可执行文件 → `available=False` + `reason`（参照 `_AgentCliBackend.available`，:839） |
| `run()` | ✅ | 见 §1；尊重 `model_override` / `permission_policy.mode` / plugin 投影 / `protected_cwd`，fail-closed |
| `permission_presets()` | ✅ **有测试强制** | 声明 `ask` / `allow` 两 preset 如何落地。用 `make_presets(...)` + `PresetRealization(...)`。按"max-permission doctrine"纯执行引擎一律 max（两 preset 都→bypass note），`preset_driven=False` 诚实标注。**注意区分**：这是注册期"声明"；`run()` 里实际加旗看运行期 `policy.mode`（§1.2）。参照 `OpenCodeCliBackend.permission_presets`（:2011） |
| `supports_containment()` | 见 §1 注 | 不实现＝默认拒绝 low-trust（fail-closed）；能证明只读+无出网才覆写返 True |

---

## 5. relay 接入要点（环境变量与 key）

| 用途 | 函数 / 变量 | 位置 | 语义 |
|---|---|---|---|
| relay base url | `resolve_relay_base_url()` | `relay_key.py:430` | 解析 + SSRF/白名单 fail-closed |
| **确保本地有 key（会自动发放）** | `ensure_relay_key()` | `relay_key.py:758` | env > 缓存 > **自动 exchange（已登录）** > fail-closed。**首次/缓存被清时必须先调它** |
| 只读解析 key | `resolve_relay_api_key() -> (key, source)` | `relay_key.py:673` | **只读** env/stored，**不发起网络发放**；带切号隔离闸门 |
| relay 套餐目录 | `relay_packages()` | `relay_packages.py` | catalog→groups→floor 降级 |
| 套餐→group slug 映射 | `SUPERCLAW_RELAY_GROUP_SLUGS` | `relay_packages.py:28` | `plus`→`superclaw-plus` 等 |
| base url 烤入（按 APP_ENV） | `environment.relay_base_url()` | `environment.py:39-44,245-254` | |

> **顺序铁律**：`ensure_relay_key()`（发放/确保）→ `resolve_relay_api_key()`（只读取用）。只调 `resolve_*` 会让"已登录但本地无缓存 key"的用户 fail-closed，破坏自动驱动闭环（两路顾问阻断项）。ClawWork 用 `_ensure_relay_key_for_run()` 封装这套 owner-checked resolve+ensure。

环境变量（全走 `SUPERCLAW_*`，不硬编码）：`SUPERCLAW_RELAY_BASE_URL`、`SUPERCLAW_RELAY_API_KEY`、`SUPERCLAW_YOURCLI_MODEL`。

**套餐权限提醒**（实测踩坑）：own-balance 裸模型 key 有余额但未必有 `superclaw-core/plus/max` 套餐权限（403 `package_not_permitted`）。要么 `SUPERCLAW_YOURCLI_MODEL` 设裸模型 id 直接透传，要么 LLMgate 侧给该 key 开套餐权限。

---

## 6. 注册三处（缺一不可）+ 一致性测试（teeth）

接一个新 backend 改**内核三个文件**，表层无需新增业务语义：

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `backends.py` → `default_backends()`（:5466） | 加 `"your-cli": YourCliBackend()` |
| 2 | `ui_contracts.py` → `AGENT_CONTROL_SPECS`（:67） | 加条目：至少 `label` / `kind` / `env` / `model_env` / `supports_model_selection` / `default_model` / `suggested_models` / `uses_relay_packages` / `maturity` / `strengths`（照现有条目补齐，别只写最小集） |
| 3 | `model_discovery.py` → `_PROBERS`（:375） | 走通道②才需要：加 `_probe_yourcli` |

**强制契约的测试（你的 backend 必须让它们绿）**：

- `tests/test_permission_presets.py` —— **缺 `permission_presets()` 直接挂**（注册表一致性）。
- `tests/test_model_discovery.py` —— 探测/缓存/降级。
- `tests/test_ui_contracts.py` —— 契约形状 + `build_agent_inventory` 投影。
- `tests/test_worker_backends.py` —— backend 行为（含套餐 id 归一）。
- `tests/test_cli_permission_preset.py` / `tests/test_api_permission_preset.py` —— CLI/API 表层对齐。
- relay 相关改动：`tests/test_relay_packages.py`、`tests/test_relay_key.py`。
- 选择器表层：`apps/web/tests/`（如 team-workbench 相关）。

改完后这些自动统一：`superclaw models your-cli` / `GET /api/agents/your-cli/models` / Web 选择器，因为三端都调同一份内核（表层零偏差）。

---

## 7. 最小骨架模板（档位 B'：CLI 用自身 auth，复用 `run_command`）

> 这是**当前可直接落地、真实可运行**的最省事形态（不经 relay，用 CLI 自己的登录态）。
> **想指向 relay（档位 B）请看 §2 的 B-自管骨架**——那条**不能用 `run_command`**，需自管 `Popen`。

```python
import os, shutil, subprocess, time
from pathlib import Path
# 文件顶部已有：from superclaw import trace_context

class YourCliBackend(_AgentCliBackend):
    name = "your-cli"
    executable_name = "yourcli"
    failure_markers = _AgentCliBackend.failure_markers + (
        "not authenticated", "quota exceeded",   # 你的 CLI 的"假成功"信号
    )

    def _resolve_executable(self) -> str | None:
        return (self.executable
                or os.environ.get("SUPERCLAW_YOURCLI_EXECUTABLE")
                or shutil.which(self.executable_name))

    def available(self) -> BackendAvailability:
        # ⚠️ 必须覆写：基类 _AgentCliBackend.available()（:839）只看
        # `self.executable or shutil.which(self.executable_name)`，**不调** _resolve_executable()。
        # 若你引入了 SUPERCLAW_YOURCLI_EXECUTABLE 这条 env 路径却不覆写 available()，
        # 则 run() 能找到 exe、但 inventory/API/选择器/select_backends() 会判 backend 不可用
        # （层间断点）。照 OpenCodeCliBackend.available()（:2033）走 _resolve_executable()。
        exe = self._resolve_executable()
        if not exe:
            return BackendAvailability(name=self.name, available=False,
                                       reason=f"{self.executable_name} executable not found")
        version = None
        try:
            done = subprocess.run([exe, "--version"], capture_output=True,
                                  text=True, timeout=5, check=False)
            version = (done.stdout or done.stderr or "").strip()[:120] or None
        except Exception as exc:  # pragma: no cover - defensive
            version = f"version check failed: {exc}"
        return BackendAvailability(name=self.name, available=True, executable=exe, version=version)

    def permission_presets(self) -> PresetMap:
        # 注册期声明；max-permission doctrine：两 preset 都映射 headless 放行旗标。
        # 注意：run() 里实际加旗仍看运行期 policy.mode（见 §1.2 / §4）。
        flag = "yourcli run --yes (max; both presets)"
        return make_presets(
            ask=PresetRealization(flag, False, "perm.note.yourcli.ask", preset_driven=False),
            allow=PresetRealization(flag, False, "perm.note.yourcli.allow", preset_driven=False),
        )

    def run(self, task, goal, session, limits) -> WorkerResult:
        exe = self._resolve_executable()
        if not exe:
            return WorkerResult(task.task_id, task.role.value, self.name,
                                "yourcli", 127, "yourcli executable not found", 0.0)

        # fail-closed：无法投影 plugin/MCP 治理就拒绝（带全部计时参数）。
        policy = limits.permission_policy
        if policy and (policy.plugin_dirs or policy.mcp_configs):
            started_at = time.time(); started = time.monotonic()
            return self._synthetic_result(
                task=task, session=session, limits=limits,
                command_repr="yourcli plugin policy projection",
                output="PLUGIN_RUNTIME_CONFIG_INVALID: 本 backend 暂不支持投影 plugin/MCP 治理",
                exit_code=1,
                started_at=started_at, finished_at=time.time(),
                duration=time.monotonic() - started,
            )

        model = _resolve_model(limits, "SUPERCLAW_YOURCLI_MODEL")   # model_override 优先
        # 当前的 prompt projection 路径（不是 _legacy_prompt）：
        prompt, _proj = self._projected_cli_prompt(
            task, goal,
            repo_path=limits.repo_path,
            capabilities_note=limits.plugin_capabilities_note,
            limits=limits, session=session,
        )

        command = [exe, "run", "--yes"]
        if policy and policy.mode in {"bypassPermissions", "dontAsk"}:
            command.append("--dangerously-skip-permissions")   # 看运行期 mode，非无条件
        if model:
            command += ["--model", model]
        command.append(prompt)

        # 复用基类：自动子进程管理 + 分流 stdout/stderr + redaction + 超时 + transcript。
        # ⚠️ run_command 不接受 env；它内部固定 trace_context.child_env()。
        return self.run_command(command, task=task, goal=goal,
                                session=session, limits=limits)
```

> 配套 `ui_contracts.py` 加 `"your-cli"` 条目（照现有条目补齐字段，含 `supports_model_selection: True`），并 `default_backends()` 注册。

---

## 8. 验收清单（提交前自检）

- [ ] **照抄前已本地 `grep` 核验**所有引用的签名（尤其 `run_command` 不收 `env`、`_synthetic_result` 必传 `started_at/finished_at/duration`、`_projected_cli_prompt` 返回 `(str, PromptProjectionResult)`）。
- [ ] `name` 在 `default_backends()` / `AGENT_CONTROL_SPECS` /（如适用）`_PROBERS` 三处一致。
- [ ] `available()` 找不到可执行文件时返回 `available=False` + 清晰 `reason`。
- [ ] `model_override` 被尊重；CLI 无法切到该模型时 **fail-closed 拒绝运行**（不偷换模型）。
- [ ] `permission_policy` 带 plugin/MCP 而无法投影治理时 **拒绝运行**（synthetic 失败，带全部计时参数）。
- [ ] 权限旗标按运行期 `policy.mode` 加，与 `permission_presets()` 声明语义自洽。
- [ ] `protected_cwd=True` 时不自动重建 cwd。
- [ ] prompt 走 `_projected_cli_prompt`（不绕开 projection / 不直接用 `_legacy_prompt`）。
- [ ] "干净退出但没干活/认证失败"被 `failure_markers` 捕获重判为失败（**无 fake-success**）。
- [ ] `permission_presets()` 已实现，`tests/test_permission_presets.py` 绿。
- [ ] 选模型方式明确：`supports_model_selection: True`；套餐（`uses_relay_packages=True` + **id 归一**）或裸模型（写 `_probe_*` + 静态 `suggested_models` 兜底）二选一；裸模型未走套餐安全门。
- [ ] **指向 relay 时**：先 `ensure_relay_key()` 再 `resolve_relay_api_key()` **且二次 resolve 判空**（缺 owned key→fail-closed 125，防切号竞态）；env 构造是 `dict(os.environ)` → `update({...})` → `trace_context.child_env(env)`（**绝不** `child_env({小 dict}）`，否则丢父环境 PATH/HOME/证书）；自管 `Popen`（`run_command` 不收 env）；无硬编码 url/key/model。
- [ ] 四个表层行为零偏差——都走同一内核，未在前端硬编码。
- [ ] 全量 `ruff check` + `pytest` 绿（远端 CI 暂停期：本地跑通 `ci.yml` 全步骤，见 CLAUDE.md）。
- [ ] 经 Codex（`--model gpt-5.5`）+ Gemini/agy 双路批判性验收"通过"后，再原子化 commit（项目铁律）。

---

## 9. 关联文档

- 内核架构与 CLI 唯一事实源：项目 `CLAUDE.md`
- 共享契约：`packages/superclaw/src/superclaw/ui_contracts.py`
- 权限 preset 框架：`docs/permission-mode-framework.md`
- runtime 治理：`docs/runtime-governance-architecture.md`、`docs/runtime-adapter-contract.md`（如存在）
- plugin/MCP（非 backend 的工具接入）：`docs/plugin-developer-guide.md`
- relay key / 账号隔离：`relay_key.py`、记忆 `relay-account-isolation`
- 完整范例：`ClawWorkBackend`（relay-backed RPC，`backends.py:2866+`）、`OpenCodeCliBackend`（最小 CLI，`backends.py:1942+`）
