# 权限模式框架（Permission Mode Framework）

> 权威规范 + 开发规则。2026-06-09 定稿，取代早前的 Broker 大设计（见 `permission-broker-plan.md` 的"已废弃"说明）。
>
> **一句话**：SuperClaw 对外只暴露**两个权限态**（`Ask` / `Allow`）。每个 Agent Runtime backend
> **必须声明**自己把这两态分别映射到什么原生模式。这是一个**强制扩展点**——加新 runtime 时漏声明，
> 一致性测试会失败、CI 会红。

---

## 1. 核心概念：两个 Preset（唯一事实来源）

前端/CLI/API 对用户只暴露两态，定义在 `permissions.py`，由 `ui_contracts.py` 投射给所有表层：

```python
# permissions.py —— 唯一事实来源
PermissionPreset = Literal["ask", "allow"]

PRESET_LABELS = {
    # title 对当前行为诚实：max-permission 原则下 ask 也跑 max，不得自称"会询问/收紧"
    "ask":   {"label_key": "perm.ask",   "title": "Standard (max today)"},
    "allow": {"label_key": "perm.allow", "title": "Allow all actions"},
}
```

- **最大权限原则（业主 2026-06-22）**：`ask` 与 `allow` **两档都**映射到现有 mode
  **`bypassPermissions`**。底层 runtime 是纯执行引擎，一律授予最大权限——runtime 自带的保守
  headless 模式（如 claude `acceptEdits`/`default`）撞到需授权的工具会**静默自我拒绝**而非升迁，
  造成莫名 `Error` 且无处授权。治理上移到 SuperClaw 层（详见 §4 顶部说明 + `permissions.py`
  `PRESET_TO_MODE` 注释）。二态壳保留，但当前两档行为一致。
- **仍在治理（独立于本映射）**：低信任 containment floor 取最严者兜底（即便 max 也保持只读）；
  显式 `plan` mode → readonly；Pay-Switch / 扫描硬门在 fusion/plugins，preset 无关。
- **不新增 mode**；现有 6 mode 保留为高级/back-compat 的底层值，preset 是它们之上的统一外壳。

SuperClaw 内核**不做**逐动作裁决——它只负责"把 preset 翻译成 runtime 自带的设置"，纯传递。

---

## 2. 强制扩展点：每个 backend 必须声明映射

每个 backend 声明一张表，把两个 preset 映射成它的**原生实现**和一个**诚实的描述**：

```python
# permissions.py
@dataclass(frozen=True)
class PresetRealization:
    """一个 backend 对某个 preset 的兑现方式。"""
    native: str          # 后端原生表达，自由格式但要可读：
                         #   A: "sandbox=workspace-write; approval=on-request"
                         #   C: "--permission-mode default"
                         #   B: "posture=workspace"
    interactive: bool    # 这个 preset 下，会不会有"人"在运行中真的看到逐动作弹窗？
                         # 今天全部为 False：连 Codex app-server 的审批回调也是被
                         # SuperClaw 策略自动应答的（ask 下升级请求自动 decline），
                         # 没有任何人看到提示。只有未来真做了审批队列才可置 True。
    note_key: str        # i18n key，向用户诚实说明（尤其 interactive=False 时）
    preset_driven: bool = True  # 切换 preset 是否真的改变该 runtime 的行为？
                         # 无原生门的 backend（local/openclaw/anthropic 文本、bobo 的
                         # ask）必须显式声明 False；一致性测试要求 preset_driven 的
                         # 两态 native 必须真的不同，杜绝"空映射蒙混过关"。

# 类型别名：每个 backend 要给齐两个 preset
PresetMap = dict[PermissionPreset, PresetRealization]
```

**声明位置**：在 `WorkerBackend` Protocol 上加一个**必需**方法：

```python
class WorkerBackend(Protocol):
    name: str
    def available(self) -> BackendAvailability: ...
    def run(self, ...) -> WorkerResult: ...
    # 新增 —— 必需
    def permission_presets(self) -> PresetMap: ...
```

backend 在 `run()` 内部，应当**从这张表派生**自己实际传给 runtime 的参数
（而不是另写一套散落的 if/else），保证"声明的"与"执行的"是同一份事实。

---

## 3. 强制力：一致性测试（漏声明就红）

因为 `WorkerBackend` 是结构化 Protocol、不会在类定义时报错，强制力靠**遍历注册表的测试**：

```python
# tests/test_permission_presets.py
def test_every_backend_declares_both_presets():
    for name, backend in default_backends().items():
        presets = backend.permission_presets()
        assert set(presets) == {"ask", "allow"}, f"{name} 未声明完整两态"
        for p in presets.values():
            assert p.native and p.note_key   # 不许空声明
```

> **这就是"加新 runtime 必须考虑权限映射"的硬约束落点。** 新增 backend 不声明 `permission_presets()`，
> 这个测试立刻失败。把它写进 `pyproject.toml` 的测试门 / CI。

---

## 4. 当前各 backend 的映射（最大权限原则，业主 2026-06-22 拍板）

> **原则变更**：底层 runtime 是**纯执行引擎**，一律被授予其**最大权限**。治理**不**放在
> runtime 自带的权限系统里——对 C 类（CLI）backend，SuperClaw 根本拦不住其工具循环；而
> runtime 自带的 headless 权限模式（如 claude `acceptEdits`/`default`）撞到需授权的工具
> （WebSearch、MCP）时会**静默自我拒绝**而非向上升迁，表现为莫名的工具 `Error` 且无处授权。
> 因此 **`ask` 与 `allow` 两档都映射到 `bypassPermissions`**（各 backend 共同的 "max" 触发值），
> 二态壳保留但当前行为一致。
>
> **仍在治理（与本映射独立，故非一刀切 fail-open）**：低信任/未受信运行由
> `ContainmentPolicy.permission_mode_floor` 取「run mode 与 floor 的最严者」兜底——即便
> `bypassPermissions` 也保持只读；显式 `plan` mode → readonly 复审姿态；Pay-Switch / 扫描意图
> 硬门在 fusion/plugins，完全独立于 preset；未来人审 / Web 审批收件箱是带门「ask」回归之处。

| backend | 层 | `ask` 映射 | `allow` 映射 | preset_driven | interactive |
|---|---|---|---|---|---|
| **codex-app-server** | A 玻璃盒 | sandbox=danger-full-access, approval=never | 同 ask | ❌ | ❌（审批队列落地前无人看到弹窗） |
| **codex** (exec) | C | `--dangerously-bypass-approvals-and-sandbox` | 同 ask | ❌ | ❌ headless 不弹窗 |
| **claude** (CLI) | C | `--permission-mode bypassPermissions` | 同 ask | ❌ | ❌ |
| **hermes** | C | `--yolo` | 同 ask | ❌ | ❌ |
| **bobo** | C | `--print --full-auto --yolo` | 同 ask | ❌ | ❌ |
| **opencode** | C | `--dangerously-skip-permissions` | 同 ask | ❌ | ❌ |
| **cursor** | C | `--trust --force` | 同 ask | ❌ | ❌ |
| **openclaw** | C | 由 env 配置，无 preset 门 | 同 ask | ❌ | ❌ |
| **anthropic-agent** | B 自有 | posture=full | 同 ask | ❌ | ❌ 无 runtime 可问 |
| **gemini-agent** | B 自有 | posture=full | 同 ask | ❌ | ❌ 无 runtime 可问 |

**诚实标注（铁律要求）**：两档都→max 后，切换 preset 不再改变任何 runtime 行为，因此每个 backend
都诚实声明 `preset_driven=False`；`interactive=False` 表示无人会在运行中收到弹窗。表层必须如实呈现，
**不得**让用户以为 `ask` 会收紧权限或弹窗。

---

## 5. B 类（进程内自有）唯一要写的代码

B 类底下没有别的 runtime 可传递，SuperClaw 自己是 runtime。在 `backends.py:1504`
`_RealToolExecution._exec_tool()` 让它**按 preset/mode 的 posture 行事**（姿态式，不弹窗）：

- `posture=readonly`（当 mode=`plan`，或低信任 containment floor）→ 拒 `write_file`/`run_shell`，只放行 `read_file`/`list_files`。
- `posture=workspace`（显式 default/acceptEdits/auto；高级路径）→ 沙箱内读写+shell；reserved-path 写入仍走升迁门。
- `posture=full`（**ask / allow 两档**，均经 `bypassPermissions`）→ 照常执行，升迁门不触发。
- 先 `_safe_path()` 归一化再判；沙箱保留（叠加非替代）；拒绝信息明确，别让模型空转重试。
- 注：升迁门（`escalation_gate`）只在 `posture != full` 时触发；两档 preset 都→full 后，带门
  「ask」需待人审 / Web 审批收件箱落地（届时 ask 可重新映射或让门在 full 下也触发）。

这是全框架**唯一**新增的执行逻辑；A/C 类已映射，只需把现有散落映射收敛进 `permission_presets()` 声明。

---

## 6. 开发规则：加一个新的 Agent Runtime 时（必读 checklist）

1. 实现 `permission_presets() -> PresetMap`，给齐 `ask` 与 `allow` 两态。
2. 想清楚该 runtime 的两态分别用它的**哪个原生模式/参数**兑现；填 `native`。
3. 如实填 `interactive`：运行中会真的逐动作问人吗？多数 headless CLI = `False`。
4. `interactive=False` 时，`note_key` 要向用户讲清"ask = 保守姿态、不弹窗"。
5. `run()` 里实际传给 runtime 的参数**从这张表派生**，别另写一套。
6. 跑 `tests/test_permission_presets.py`——不补声明就会红。
7. 同步 `ui_contracts.py`（自动从 `permission_presets()` 投射，无需手抄）与文档本表。

---

## 7. 明确不做（守住简单，别再滑向过度设计）

- ❌ PermissionBroker 决策引擎 / PermissionAction taxonomy / reason-code 大表。
- ❌ ApprovalCoordinator 人审暂停（用户明确不要；ask 用 runtime 自带的）。
- ❌ 逐动作审计放大写库。
- ❌ pay-switch 不自动付 / 扫描 fail-closed / 插件验签——那是 **fusion 与 plugin 自己的治理**，
  与"权限模式"无关，本框架**不碰**。

---

## 8. 落地改动面

- `permissions.py`（新建）：`PermissionPreset`、`PRESET_LABELS`、`PresetRealization`、`PresetMap`。
- `backends.py`：`WorkerBackend` Protocol 加 `permission_presets()`；每个 backend 实现它；B 类 `_exec_tool` 按 posture 行事。
- `ui_contracts.py`：`build_agent_inventory()` 给每个 backend 附 `permission_presets`（含 interactive 位）。
- `tests/test_permission_presets.py`（新建）：注册表一致性 + B 类 posture golden（acceptEdits 现状不变）。
- 可选：CLI/Web 两态开关确认走同一契约。

净工作量：**一个声明式契约 + 每个 backend 几行声明 + B 类一处 posture 逻辑 + 一个一致性测试。**
